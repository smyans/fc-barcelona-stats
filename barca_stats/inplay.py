"""In-game win probability: the pre-match expected goals, scaled to the time left and the live situation.

Each side's remaining goals are Poisson with mean = pre-match expected goals x share of a match's goals
still to come at this minute (from real goal timings) x a red-card adjustment. Add them to the current
score and you have the probability of each final result. At kick-off it reproduces the pre-match model.
"""

import numpy as np
import pandas as pd
from scipy.stats import poisson

from .data import load_events, load_lineups, load_matches
from .prematch import MAX_GOALS

LAST_MINUTE = 100  # inputs beyond 90 are stoppage time


def _goal_and_red_minutes():
    """Clock minute of every goal and red card in the StatsBomb Barça matches (first-half stoppage -> 45)."""
    goals, reds = [], []
    for match_id in load_matches()["match_id"]:
        events = load_events(match_id)
        scored = events[(events["type"] == "Shot") & (events["shot_outcome"] == "Goal") & (events["period"] <= 4)]
        goals += [45 if period == 1 and minute >= 45 else minute
                  for period, minute in zip(scored["period"], scored["minute"])]
        for cards in load_lineups(match_id)["cards"]:
            reds += [int(c["time"].split(":")[0]) for c in cards
                     if c.get("card_type") in ("Red Card", "Second Yellow")]
    return np.array(goals), np.array(reds)


def goal_time_cdf(goal_minutes):
    """cdf[m] = share of a match's goals already scored at clock minute m (m = 45 means half-time)."""
    cdf = np.array([(goal_minutes < m).mean() for m in range(LAST_MINUTE + 1)])
    cdf[45] = (goal_minutes <= 45).mean()
    return np.maximum.accumulate(cdf)


def remaining_share(cdf, minute):
    return 1 - cdf[int(np.clip(minute, 0, LAST_MINUTE))]


def estimate_red_card_effects(results, lam_home, lam_away, cdf, red_minutes):
    """How much a red card changes each side's scoring rate, from ~8,000 La Liga matches.

    football-data doesn't record when a card was shown, so the average share of the match left after a
    red (from the StatsBomb timelines) converts the whole-match effect into a per-minute multiplier.
    """
    after_red = np.mean([remaining_share(cdf, m) for m in red_minutes])
    df = results.assign(lam_h=lam_home, lam_a=lam_away)
    clean = df[(df["hr"] == 0) & (df["ar"] == 0)]
    base_h, base_a = clean["hg"].sum() / clean["lam_h"].sum(), clean["ag"].sum() / clean["lam_a"].sum()
    home_red = df[(df["hr"] == 1) & (df["ar"] == 0)]
    away_red = df[(df["ar"] == 1) & (df["hr"] == 0)]
    # Goals by the side that lost a player, and by its opponent, relative to expectation.
    short = (home_red["hg"].sum() + away_red["ag"].sum()) / (home_red["lam_h"].sum() + away_red["lam_a"].sum())
    opp = (home_red["ag"].sum() + away_red["hg"].sum()) / (home_red["lam_a"].sum() + away_red["lam_h"].sum())
    base = (base_h + base_a) / 2
    return {
        "own": 1 + (short / base - 1) / after_red,
        "opponent": 1 + (opp / base - 1) / after_red,
        "matches": int(len(home_red) + len(away_red)),
        "share_left_after_red": float(after_red),
    }


def live_probs(lam_home, lam_away, minute, home_goals, away_goals, home_reds, away_reds, cdf, red_effects, rho=0.0):
    """P(home win, draw, away win) from the current minute, score and red cards."""
    left = remaining_share(cdf, minute)
    own, opp = red_effects["own"], red_effects["opponent"]
    lam_h = lam_home * left * own ** home_reds * opp ** away_reds
    lam_a = lam_away * left * own ** away_reds * opp ** home_reds
    goals = np.arange(MAX_GOALS + 1)
    grid = np.outer(poisson.pmf(goals, lam_h), poisson.pmf(goals, lam_a))
    r = rho * left  # the Dixon-Coles low-score correction fades as the match runs out
    grid[0, 0] *= 1 - lam_h * lam_a * r
    grid[0, 1] *= 1 + lam_h * r
    grid[1, 0] *= 1 + lam_a * r
    grid[1, 1] *= 1 - r
    grid /= grid.sum()
    diff = (home_goals - away_goals) + goals[:, None] - goals[None, :]
    return np.array([grid[diff > 0].sum(), grid[diff == 0].sum(), grid[diff < 0].sum()])


def lambdas_from_probs(p_home, p_draw, p_away, rho=0.0):
    """Expected goals for each side that reproduce given win/draw/loss probabilities (e.g. from odds)."""
    from scipy.optimize import minimize

    target = np.array([p_home, p_draw, p_away])

    def loss(x):
        lam = np.exp(x)
        return ((live_probs(lam[0], lam[1], 0, 0, 0, 0, 0, np.zeros(LAST_MINUTE + 1),
                            {"own": 1, "opponent": 1}, rho) - target) ** 2).sum()

    fit = minimize(loss, np.log([1.4, 1.1]), method="Nelder-Mead", options={"xatol": 1e-5, "fatol": 1e-10})
    return tuple(np.exp(fit.x))


def barca_timelines(minutes=(0, 15, 30, 45, 60, 75, 85)):
    """Score and red cards at checkpoints in each StatsBomb Barça match, for validating the live model."""
    rows = []
    for _, match in load_matches().iterrows():
        events = load_events(match["match_id"])
        goals = events[(events["type"] == "Shot") & (events["shot_outcome"] == "Goal") & (events["period"] <= 4)]
        goal_minutes = [(team, 45 if p == 1 and mi >= 45 else mi)
                        for team, p, mi in zip(goals["team"], goals["period"], goals["minute"])]
        reds = []
        for team, cards in zip(load_lineups(match["match_id"])["team"], load_lineups(match["match_id"])["cards"]):
            reds += [(team, int(c["time"].split(":")[0])) for c in cards if c.get("card_type") in ("Red Card", "Second Yellow")]
        for m in minutes:
            count = lambda items, team: sum(1 for t, mi in items if t == team and (mi < m or (m == 45 and mi <= 45)))
            rows.append({
                "match_id": match["match_id"], "date": match["match_date"], "minute": m,
                "home": match["home_team"], "away": match["away_team"],
                "home_goals": count(goal_minutes, match["home_team"]), "away_goals": count(goal_minutes, match["away_team"]),
                "home_reds": count(reds, match["home_team"]), "away_reds": count(reds, match["away_team"]),
                "final": "H" if match["home_score"] > match["away_score"] else "D" if match["home_score"] == match["away_score"] else "A",
            })
    return pd.DataFrame(rows)


DIFF_RANGE = 12  # goal differences tracked: -12..+12


def live_probs_dp(lam_home, lam_away, minute, home_goals, away_goals, home_reds, away_reds, cdf, red_effects,
                  state_mult):
    """Minute-by-minute version: each side's scoring rate depends on whether it is trailing, level or leading.

    Vectorised over matches: every argument may be an array. Returns an (n, 3) array of
    P(home win), P(draw), P(away win).
    """
    lam_home, lam_away, minute = np.atleast_1d(lam_home), np.atleast_1d(lam_away), np.atleast_1d(minute)
    n = len(lam_home)
    own, opp = red_effects["own"], red_effects["opponent"]
    home_reds, away_reds = np.broadcast_to(home_reds, n), np.broadcast_to(away_reds, n)
    lam_h = lam_home * own ** home_reds * opp ** away_reds
    lam_a = lam_away * own ** away_reds * opp ** home_reds
    diffs = np.arange(-DIFF_RANGE, DIFF_RANGE + 1)
    dist = np.zeros((n, len(diffs)))
    start = np.clip(np.broadcast_to(home_goals, n) - np.broadcast_to(away_goals, n), -DIFF_RANGE, DIFF_RANGE)
    dist[np.arange(n), start + DIFF_RANGE] = 1
    # Multiplier for a side given the goal difference from its own point of view.
    mult_home = np.select([diffs < 0, diffs == 0], [state_mult["trailing"], state_mult["level"]], state_mult["leading"])
    mult_away = mult_home[::-1]
    minute = np.clip(minute.astype(int), 0, LAST_MINUTE)
    for t in range(int(minute.min()), LAST_MINUTE):
        share = cdf[t + 1] - cdf[t]
        active = (minute <= t)[:, None]
        p_h = 1 - np.exp(-lam_h[:, None] * share * mult_home[None, :])
        p_a = 1 - np.exp(-lam_a[:, None] * share * mult_away[None, :])
        up, down = p_h * (1 - p_a), p_a * (1 - p_h)
        new = dist * (1 - up - down)
        new[:, 1:] += (dist * up)[:, :-1]
        new[:, :-1] += (dist * down)[:, 1:]
        dist = np.where(active, new, dist)
    return np.stack([dist[:, diffs > 0].sum(1), dist[:, diffs == 0].sum(1), dist[:, diffs < 0].sum(1)], axis=1)


def fit_state_multipliers(results, lam_home, lam_away, cdf, red_effects):
    """Trailing/leading scoring multipliers that best predict full-time results from the half-time score."""
    df = results.assign(lam_h=lam_home, lam_a=lam_away)
    df = df[(df["hr"] == 0) & (df["ar"] == 0)]
    idx = df["result"].map({"H": 0, "D": 1, "A": 2}).values
    best, best_loss = None, np.inf
    for trailing in np.arange(1.0, 1.61, 0.05):
        for leading in np.arange(0.7, 1.01, 0.05):
            mult = {"trailing": trailing, "level": 1.0, "leading": leading}
            p = live_probs_dp(df["lam_h"].values, df["lam_a"].values, np.full(len(df), 45), df["hthg"].values,
                              df["htag"].values, 0, 0, cdf, red_effects, mult)
            loss = -np.log(np.clip(p[np.arange(len(idx)), idx], 1e-12, 1)).mean()
            if loss < best_loss:
                best, best_loss = mult, loss
    return {k: round(float(v), 2) for k, v in best.items()}, float(best_loss)


def fit_barca_goal_multiplier(timelines, cdf, red_effects, state_mult):
    """Barça games have had more goals than any rating predicts. Find the scaling of both sides' expected
    goals that best predicts final results from the Messi-era minute-by-minute timelines."""
    idx = timelines["final"].map({"H": 0, "D": 1, "A": 2}).values
    best, best_loss = 1.0, np.inf
    for k in np.arange(1.0, 1.41, 0.05):
        p = live_probs_dp(timelines["lam_h"].values * k, timelines["lam_a"].values * k, timelines["minute"].values,
                          timelines["home_goals"].values, timelines["away_goals"].values, timelines["home_reds"].values,
                          timelines["away_reds"].values, cdf, red_effects, state_mult)
        loss = -np.log(np.clip(p[np.arange(len(idx)), idx], 1e-12, 1)).mean()
        if loss < best_loss:
            best, best_loss = float(round(k, 2)), loss
    return best

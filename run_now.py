"""Refresh the "Barça now" page: recent-stats analysis, next-match forecast and the live-model parameters.

    python run_now.py

Downloads the latest La Liga results and fixtures from football-data.co.uk (current season refreshed
every 12 hours). Re-run after each matchday to update the forecast.
"""

from pathlib import Path

import numpy as np

from barca_stats.export_now import TEAM, calibration_table, write_now
from barca_stats.fd import current_season_start, load_fixtures, load_results
from barca_stats.inplay import (_goal_and_red_minutes, barca_timelines, estimate_red_card_effects,
                                fit_barca_goal_multiplier, fit_state_multipliers, goal_time_cdf, live_probs_dp)
from barca_stats.prematch import PreMatchModel, add_features, backtest, log_loss, outcome_probs
from barca_stats.recent import FIRST_SEASON, explain_surprises, standout_stats, team_games

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "docs" / "data" / "now.json"


def is_barca(df):
    return ((df["home"] == TEAM) | (df["away"] == TEAM)).values


def main():
    results, fixtures = load_results(), load_fixtures()
    features, upcoming, _ = add_features(results, fixtures)
    current = current_season_start()
    print(f"{len(results):,} La Liga matches through {results['date'].max():%Y-%m-%d}; {len(fixtures)} upcoming fixtures.")

    # Walk-forward predictions for every season we can check (2006/07 onwards).
    bt = backtest(features, list(range(2006, current + 1)))
    test = bt[bt["season_start"] >= FIRST_SEASON]

    # Live-model ingredients.
    goals, reds = _goal_and_red_minutes()
    cdf = goal_time_cdf(goals)
    full = PreMatchModel().fit(features)
    lam_h, lam_a = full.expected_goals(features)
    red = estimate_red_card_effects(features, lam_h, lam_a, cdf, reds)
    pre_test = features["season_start"] < FIRST_SEASON
    state_mult, _ = fit_state_multipliers(features[pre_test], lam_h[pre_test], lam_a[pre_test], cdf, red)

    timelines = barca_timelines()
    b_bt = bt[is_barca(bt)].assign(day=lambda d: d["date"].dt.strftime("%Y-%m-%d"))
    timelines = timelines.merge(b_bt[["day", "lam_h", "lam_a"]].rename(columns={"day": "date"}), on="date")
    barca_mult = fit_barca_goal_multiplier(timelines, cdf, red, state_mult)
    print(f"Red cards: own x{red['own']:.2f}, opponent x{red['opponent']:.2f}. Game state: {state_mult}. Barça goals x{barca_mult}.")

    # Pre-match scores on 2023/24 onwards (the Barça goal adjustment applies to Barça games only).
    adj = np.where(is_barca(test), barca_mult, 1.0)
    model_p = np.array([outcome_probs(h, a, r) for h, a, r in zip(test["lam_h"] * adj, test["lam_a"] * adj, test["rho"])])
    market_p = test[["mkt_h", "mkt_d", "mkt_a"]].values
    base = features[pre_test]["result"].value_counts(normalize=True)
    base_p = np.tile([base["H"], base["D"], base["A"]], (len(test), 1))
    bmask = is_barca(test)
    acc = lambda p, r: float((p.argmax(1) == r.map({"H": 0, "D": 1, "A": 2}).values).mean())
    summary = {
        "matches": len(test), "barca_matches": int(bmask.sum()),
        "log_loss": {"model": log_loss(model_p, test["result"]), "market": log_loss(market_p, test["result"]),
                     "base": log_loss(base_p, test["result"])},
        "accuracy": {"model": acc(model_p, test["result"]), "market": acc(market_p, test["result"])},
        "barca_log_loss": {"model": log_loss(model_p[bmask], test["result"][bmask]),
                           "market": log_loss(market_p[bmask], test["result"][bmask])},
        "barca_accuracy": {"model": acc(model_p[bmask], test["result"][bmask]),
                           "market": acc(market_p[bmask], test["result"][bmask])},
    }
    summary["share_of_market_edge"] = ((summary["log_loss"]["base"] - summary["log_loss"]["model"])
                                       / (summary["log_loss"]["base"] - summary["log_loss"]["market"]))
    print("Pre-match 2023/24-now:", {k: round(v, 4) for k, v in summary["log_loss"].items()})

    # Live-model checks: half-time on 2023/24-now (league and Barça), and Messi-era timelines by minute.
    ht = live_probs_dp(test["lam_h"].values * adj, test["lam_a"].values * adj, np.full(len(test), 45),
                       test["hthg"].values, test["htag"].values, 0, 0, cdf, red, state_mult)
    tl = live_probs_dp(timelines["lam_h"].values * barca_mult, timelines["lam_a"].values * barca_mult,
                       timelines["minute"].values, timelines["home_goals"].values, timelines["away_goals"].values,
                       timelines["home_reds"].values, timelines["away_reds"].values, cdf, red, state_mult)
    by_minute = [{"minute": int(m), "log_loss": log_loss(tl[(timelines["minute"] == m).values],
                                                         timelines["final"][timelines["minute"] == m])}
                 for m in sorted(timelines["minute"].unique())]
    inplay_checks = {
        "league_pre": summary["log_loss"]["model"], "league_ht": log_loss(ht, test["result"]),
        "barca_pre": summary["barca_log_loss"]["model"], "barca_ht": log_loss(ht[bmask], test["result"][bmask]),
        "timeline_matches": int(timelines["match_id"].nunique()), "by_minute": by_minute,
    }
    print("Half-time:", round(inplay_checks["league_ht"], 4), "| Barça:", round(inplay_checks["barca_ht"], 4))

    # Recent-stats analysis.
    games = team_games(results)
    games = games[games["season_start"] >= FIRST_SEASON]
    barca = games[games["team"] == TEAM]
    surprises = explain_surprises(barca)
    league = explain_surprises(games)

    def split(label, mask, frame):
        part = frame[mask]
        return {"label": label, "games": int(mask.sum()), "points": float(part["points"].mean()),
                "expected": float(part["expected_points"].mean()), "above": float(part["points_above_expected"].mean())}

    others = games[games["team"] != TEAM]
    splits = [split("Barça with 12+ fouls committed", barca["fouls"] >= 12, barca),
              split("Barça with 7 or fewer fouls", barca["fouls"] <= 7, barca),
              split("Barça with 9+ corners", barca["corners"] >= 9, barca),
              split("Barça with 4 or fewer corners", barca["corners"] <= 4, barca),
              split("Other teams with 9+ corners", others["corners"] >= 9, others),
              split("Other teams with 4 or fewer corners", others["corners"] <= 4, others)]
    seasons = (barca.groupby("season").agg(games=("points", "size"), points=("points", "sum"),
                                           expected=("expected_points", "sum")).reset_index().to_dict("records"))

    upcoming = upcoming.join(full.predict(upcoming)[["lam_h", "lam_a"]])
    write_now(OUT, fixtures=upcoming, rho=full.rho, barca_goal_mult=barca_mult, cdf=cdf, red_effects=red,
              state_mult=state_mult, backtest_summary=summary, calibration=calibration_table(model_p, test["result"]),
              inplay_checks=inplay_checks, surprises=surprises, league_surprises=league, splits=splits,
              season_table=seasons, recent_games=standout_stats(barca, 12),
              data_through=results["date"].max().strftime("%Y-%m-%d"))
    print(f"Wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

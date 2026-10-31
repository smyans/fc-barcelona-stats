"""Pre-match team features: Elo ratings, recent form and rest, computed strictly from earlier matches."""

import pandas as pd

ELO_START = 1500
ELO_NEW_TEAM = 1420  # promoted sides start below average
ELO_K = 20
ELO_HOME = 65  # home advantage in Elo points
ELO_SEASON_REGRESSION = 0.25  # pull ratings a quarter of the way back to 1500 each summer
FORM_GAMES = 6
STYLE_GAMES = 20  # longer window: how many goals a team scores and concedes as a habit
FORM_STATS = {"gf": ("hg", "ag"), "ga": ("ag", "hg"), "sot_for": ("hst", "ast"), "sot_against": ("ast", "hst")}


def _margin_multiplier(goal_diff):
    """World Football Elo: bigger wins move ratings more."""
    gd = abs(goal_diff)
    return 1.0 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8


def expected_home_score(home_elo, away_elo):
    return 1 / (1 + 10 ** ((away_elo - home_elo - ELO_HOME) / 400))


def add_elo(matches):
    """Adds pre-match `home_elo`/`away_elo`; returns the frame and the latest rating of every team."""
    ratings, season = {}, None
    home_elo, away_elo = [], []
    for row in matches.itertuples():
        if row.season_start != season:
            season = row.season_start
            ratings = {t: r + (ELO_START - r) * ELO_SEASON_REGRESSION for t, r in ratings.items()}
        rh, ra = ratings.get(row.home, ELO_NEW_TEAM), ratings.get(row.away, ELO_NEW_TEAM)
        home_elo.append(rh)
        away_elo.append(ra)
        actual = 1.0 if row.hg > row.ag else 0.5 if row.hg == row.ag else 0.0
        change = ELO_K * _margin_multiplier(row.hg - row.ag) * (actual - expected_home_score(rh, ra))
        ratings[row.home], ratings[row.away] = rh + change, ra - change
    return matches.assign(home_elo=home_elo, away_elo=away_elo), ratings


def team_rows(matches):
    """Long format: one row per team per match with that team's stats."""
    frames = []
    for side, other, venue in [("home", "away", 1), ("away", "home", 0)]:
        frame = pd.DataFrame({"match_idx": matches.index, "date": matches["date"], "team": matches[side],
                              "opponent": matches[other], "home": venue})
        for name, (home_col, away_col) in FORM_STATS.items():
            frame[name] = matches[home_col if side == "home" else away_col]
        frames.append(frame)
    return pd.concat(frames).sort_values(["date", "match_idx"]).reset_index(drop=True)


def add_form_and_rest(matches, upcoming=None):
    """Rolling averages of the last FORM_GAMES league matches and days since the last one, all pre-match.

    If `upcoming` fixtures are given, they get the same features from the latest completed matches.
    """
    long = team_rows(matches)
    league_means = long[list(FORM_STATS)].mean()
    grouped = long.groupby("team")
    for stat in FORM_STATS:
        long[f"form_{stat}"] = grouped[stat].transform(
            lambda s: s.shift().rolling(FORM_GAMES, min_periods=1).mean()).fillna(league_means[stat])
    for stat in ["gf", "ga"]:
        long[f"style_{stat}"] = grouped[stat].transform(
            lambda s: s.shift().rolling(STYLE_GAMES, min_periods=1).mean()).fillna(league_means[stat])
    long["rest"] = grouped["date"].diff().dt.days.clip(upper=10).fillna(7)

    feature_cols = [f"form_{s}" for s in FORM_STATS] + ["style_gf", "style_ga", "rest"]
    out = matches.copy()
    for venue, prefix in [(1, "home"), (0, "away")]:
        part = long[long["home"] == venue].set_index("match_idx")[feature_cols]
        out = out.join(part.add_prefix(f"{prefix}_"))

    if upcoming is None:
        return out
    latest = long.groupby("team").tail(FORM_GAMES).groupby("team")[list(FORM_STATS)].mean()
    style = long.groupby("team").tail(STYLE_GAMES).groupby("team")[["gf", "ga"]].mean()
    last_date = long.groupby("team")["date"].max()
    up = upcoming.copy()
    for prefix in ["home", "away"]:
        teams = up[prefix]
        for stat in FORM_STATS:
            up[f"{prefix}_form_{stat}"] = teams.map(latest[stat]).fillna(league_means[stat]).values
        for stat in ["gf", "ga"]:
            up[f"{prefix}_style_{stat}"] = teams.map(style[stat]).fillna(league_means[stat]).values
        up[f"{prefix}_rest"] = ((up["date"] - teams.map(last_date)).dt.days.clip(upper=10)).fillna(7).values
    return out, up

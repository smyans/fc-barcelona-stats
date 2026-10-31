"""Which match stats explain Barça beating, or falling short of, what the bookmakers expected? (2023/24 onwards)

The target is points above expectation: actual points minus the points implied by the closing market
odds (3 x P(win) + P(draw)). A stat only matters here if it explains results *beyond* how strong the
opponent was, which is already priced into the odds.
"""

import numpy as np
import pandas as pd
from scipy.stats import false_discovery_control, spearmanr

FIRST_SEASON = 2023
STATS = {
    "shots": "Shots", "sot": "Shots on target", "shots_against": "Shots conceded", "sot_against": "Shots on target conceded",
    "corners": "Corners won", "corners_against": "Corners conceded", "fouls": "Fouls committed", "fouls_against": "Fouls suffered",
    "yellows": "Yellow cards", "yellows_against": "Opponent yellow cards", "reds": "Red cards", "reds_against": "Opponent red cards",
    "kickoff_hour": "Kickoff time", "rest": "Days since last league game", "home": "Playing at home",
}
# Stats a fan wouldn't automatically connect to the result (shots obviously are).
UNLIKELY = ["corners", "corners_against", "fouls", "fouls_against", "yellows", "yellows_against",
            "kickoff_hour", "rest", "reds", "reds_against"]


def team_games(results):
    """One row per team per match (from that team's point of view) with points above market expectation."""
    frames = []
    for side, other in [("h", "a"), ("a", "h")]:
        team = results["home" if side == "h" else "away"]
        goals_for, goals_against = results[f"{side}g"], results[f"{other}g"]
        p_win, p_draw = results[f"mkt_{side}"], results["mkt_d"]
        frames.append(pd.DataFrame({
            "date": results["date"], "season": results["season"], "season_start": results["season_start"],
            "team": team, "opponent": results["away" if side == "h" else "home"], "home": int(side == "h"),
            "goals": goals_for, "goals_against": goals_against,
            "points": np.select([goals_for > goals_against, goals_for == goals_against], [3, 1], 0),
            "expected_points": 3 * p_win + p_draw, "p_win": p_win,
            "shots": results[f"{side}s"], "sot": results[f"{side}st"], "shots_against": results[f"{other}s"],
            "sot_against": results[f"{other}st"], "corners": results[f"{side}c"], "corners_against": results[f"{other}c"],
            "fouls": results[f"{side}f"], "fouls_against": results[f"{other}f"], "yellows": results[f"{side}y"],
            "yellows_against": results[f"{other}y"], "reds": results[f"{side}r"], "reds_against": results[f"{other}r"],
            "kickoff_hour": pd.to_numeric(results["time"].astype(str).str[:2], errors="coerce"),
            "xg": results[f"{side}xg"], "xg_against": results[f"{other}xg"],
        }))
    games = pd.concat(frames).sort_values(["date", "team"]).reset_index(drop=True)
    games["rest"] = games.groupby("team")["date"].diff().dt.days.clip(upper=14)
    games["points_above_expected"] = games["points"] - games["expected_points"]
    return games


def explain_surprises(games):
    """Spearman correlation of each stat with points above expectation, FDR-corrected."""
    rows = []
    for stat, label in STATS.items():
        pair = games[[stat, "points_above_expected"]].dropna()
        rho, p = spearmanr(pair[stat], pair["points_above_expected"]) if pair[stat].nunique() > 1 else (np.nan, 1.0)
        rows.append({"stat": stat, "label": label, "rho": rho, "p_value": p, "n": len(pair), "unlikely": stat in UNLIKELY})
    out = pd.DataFrame(rows)
    out["p_adjusted"] = false_discovery_control(out["p_value"].fillna(1))
    out["significant"] = out["p_adjusted"] < 0.05
    return out


def standout_stats(barca, last_n=12, threshold=1.3):
    """For each recent game, the stats furthest from Barça's normal (z-score vs 2023/24-now)."""
    numeric = [s for s in STATS if s not in ("home",)]
    mean, sd = barca[numeric].mean(), barca[numeric].std()
    rows = []
    for _, game in barca.tail(last_n).iterrows():
        z = ((game[numeric] - mean) / sd).dropna()
        notable = z[z.abs() >= threshold].sort_values(key=abs, ascending=False).head(3)
        rows.append({
            "date": game["date"].strftime("%Y-%m-%d"), "opponent": game["opponent"], "home": int(game["home"]),
            "score": f"{int(game['goals'])}–{int(game['goals_against'])}", "points": int(game["points"]),
            "expected_points": round(float(game["expected_points"]), 2), "p_win": round(float(game["p_win"]), 3),
            "xg": None if pd.isna(game["xg"]) else round(float(game["xg"]), 2),
            "xg_against": None if pd.isna(game["xg_against"]) else round(float(game["xg_against"]), 2),
            "standouts": [{"stat": s, "label": STATS[s], "value": float(game[s]), "typical": round(float(mean[s]), 1),
                           "z": round(float(z[s]), 2)} for s in notable.index],
        })
    return rows

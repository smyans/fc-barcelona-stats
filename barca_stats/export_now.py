"""Write docs/data/now.json: the next-match forecast, live-model parameters, model checks and the recent-stats analysis."""

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .prematch import score_grid

TEAM = "Barcelona"
DISPLAY_NAMES = {
    "Alaves": "Alavés", "Almeria": "Almería", "Ath Bilbao": "Athletic Club", "Ath Madrid": "Atlético Madrid",
    "Betis": "Real Betis", "Cadiz": "Cádiz", "Celta": "Celta Vigo", "Espanol": "Espanyol", "La Coruna": "Deportivo",
    "Leganes": "Leganés", "Malaga": "Málaga", "Santander": "Racing Santander", "Sociedad": "Real Sociedad",
    "Vallecano": "Rayo Vallecano",
}


def display(team):
    return DISPLAY_NAMES.get(team, team)


def _round(obj, digits=4):
    if isinstance(obj, dict):
        return {k: _round(v, digits) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_round(v, digits) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if np.isnan(obj) else round(float(obj), digits)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def fixture_payload(row, rho, barca_goal_mult):
    """Barça's next match from Barça's point of view: model and market probabilities, expected goals, likely scores."""
    barca_home = row["home"] == TEAM
    lam_h, lam_a = row["lam_h"] * barca_goal_mult, row["lam_a"] * barca_goal_mult
    grid = score_grid(lam_h, lam_a, rho)
    if not barca_home:
        grid = grid.T
    lam_b, lam_o = (lam_h, lam_a) if barca_home else (lam_a, lam_h)
    probs = [np.tril(grid, -1).sum(), np.trace(grid), np.triu(grid, 1).sum()]
    top = sorted(((grid[i, j], i, j) for i in range(6) for j in range(6)), reverse=True)[:5]
    market = [row["mkt_h"], row["mkt_d"], row["mkt_a"]] if barca_home else [row["mkt_a"], row["mkt_d"], row["mkt_h"]]
    side = "home" if barca_home else "away"
    other = "away" if barca_home else "home"
    return {
        "date": row["date"].strftime("%Y-%m-%d"), "time": row["time"] if isinstance(row["time"], str) else None,
        "opponent": display(row[other]), "venue": "Home" if barca_home else "Away",
        "model": {"win": probs[0], "draw": probs[1], "loss": probs[2]},
        "market": None if pd.isna(market[0]) else {"win": market[0], "draw": market[1], "loss": market[2]},
        "lam_barca": lam_b, "lam_opponent": lam_o,
        "elo_barca": row[f"{side}_elo"], "elo_opponent": row[f"{other}_elo"],
        "form": {"barca_gf": row[f"{side}_form_gf"], "barca_ga": row[f"{side}_form_ga"],
                 "opp_gf": row[f"{other}_form_gf"], "opp_ga": row[f"{other}_form_ga"]},
        "likely_scores": [{"barca": int(i), "opponent": int(j), "p": p} for p, i, j in top],
    }


def calibration_table(probs, results, bins=(0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.0001)):
    """Every (match, outcome) prediction binned by forecast probability vs how often it happened."""
    flat_p = probs.reshape(-1)
    happened = (results.map({"H": 0, "D": 1, "A": 2}).values[:, None] == np.arange(3)[None, :]).reshape(-1)
    df = pd.DataFrame({"p": flat_p, "hit": happened})
    out = df.groupby(pd.cut(df["p"], bins), observed=True).agg(n=("hit", "size"), predicted=("p", "mean"), actual=("hit", "mean"))
    return out.reset_index(drop=True).to_dict("records")


def write_now(path, *, fixtures, rho, barca_goal_mult, cdf, red_effects, state_mult, backtest_summary,
              calibration, inplay_checks, surprises, league_surprises, splits, season_table, recent_games, data_through):
    barca_fixtures = fixtures[(fixtures["home"] == TEAM) | (fixtures["away"] == TEAM)]
    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "data_through": data_through,
        "fixtures": [fixture_payload(row, rho, barca_goal_mult) for _, row in barca_fixtures.iterrows()],
        "live_model": {"cdf": list(cdf), "red": {"own": red_effects["own"], "opponent": red_effects["opponent"]},
                       "state": state_mult, "barca_goal_mult": barca_goal_mult, "rho": rho},
        "backtest": backtest_summary,
        "calibration": calibration,
        "inplay_checks": inplay_checks,
        "surprises": surprises.merge(league_surprises[["stat", "rho", "significant"]].rename(
            columns={"rho": "league_rho", "significant": "league_significant"}), on="stat").to_dict("records"),
        "splits": splits,
        "seasons": season_table,
        "recent_games": [{**g, "opponent": display(g["opponent"])} for g in recent_games],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_round(payload), ensure_ascii=False, separators=(",", ":")))

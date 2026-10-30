"""Write the compact JSON the interactive site (docs/) reads."""

import json

import numpy as np

from .features import POSITION_GROUPS
from .plots import LABELS

RESULT_NAMES = {0.0: "loss", 0.5: "draw", 1.0: "win"}


def _distributions(table):
    """Five-number summaries (10/25/50/75/90th pct) of each metric by group and result."""
    out = {}
    for group in POSITION_GROUPS:
        subset = table[table["position_group"] == group]
        out[group] = {
            metric: {
                RESULT_NAMES[result]: np.nanpercentile(rows[metric], [10, 25, 50, 75, 90]).round(3).tolist()
                for result, rows in subset.groupby("team_result")
            }
            for metric in LABELS
        }
    return out


def _columnar_shots(shots):
    """Shots as parallel arrays; repeated strings become indexes into lookup lists (much smaller JSON)."""
    out = {"lookups": {}}
    for col in ["match", "season", "player", "team", "outcome", "shot_type", "body_part"]:
        values = shots[col].fillna("Unknown")
        lookup = sorted(values.unique())
        index = {v: i for i, v in enumerate(lookup)}
        out["lookups"][col] = lookup
        out[col] = [index[v] for v in values]
    out["x"] = shots["x"].round(1).tolist()
    out["y"] = shots["y"].round(1).tolist()
    out["xg"] = shots["xg"].round(3).tolist()
    out["minute"] = shots["minute"].astype(int).tolist()
    out["for"] = (shots["side"] == "for").astype(int).tolist()
    out["goal"] = shots["goal"].astype(int).tolist()
    out["on_target"] = shots["on_target"].astype(int).tolist()
    out["result"] = shots["result"].tolist()
    return out


def _model_payload(scores, coefficients, predictions):
    return {
        # JSON has no NaN; the base-rate model's undefined AUC becomes null.
        "scores": scores.round(3).astype(object).where(scores.notna(), None).to_dict("records"),
        "coefficients": coefficients.round(3).to_dict("records"),
        "matches": [
            {"match": r.match, "date": r.date, "season": r.season, "opponent": r.opponent, "venue": r.venue,
             "result": r.result, "p_win": round(r.p_win, 3), "p_win_xg_only": round(r.p_win_xg_only, 3),
             "xg": round(r.xg, 2), "xg_opp": round(r.xg_opp, 2), "pass_share": round(r.pass_share, 1),
             "shots": int(r.shots), "shots_opp": int(r.shots_opp),
             "defensive_actions_diff": int(r.defensive_actions_diff)}
            for r in predictions.itertuples()
        ],
    }


def _season_summary(matches, predictions):
    stats = predictions.groupby("season").agg(xg=("xg", "mean"), xg_opp=("xg_opp", "mean"),
                                               pass_share=("pass_share", "mean"))
    rows = []
    for season, games in matches.groupby("season"):
        rows.append({
            "season": season, "matches": len(games),
            "wins": int((games["result"] == 1).sum()), "draws": int((games["result"] == 0.5).sum()),
            "losses": int((games["result"] == 0).sum()),
            "goals_for": int(games["goals_for"].sum()), "goals_against": int(games["goals_against"].sum()),
            **stats.loc[season].round(2).to_dict(),
        })
    return rows


def write_site_data(path, matches, table, corr, shots, touch_grids, model_results, n_events):
    win_grid, dropped_grid = touch_grids
    payload = {
        "summary": {
            "matches": len(matches),
            "seasons": int(matches["season"].nunique()),
            "wins": int((matches["result"] == 1).sum()),
            "draws": int((matches["result"] == 0.5).sum()),
            "losses": int((matches["result"] == 0).sum()),
            "goals_for": int(matches["goals_for"].sum()),
            "events": int(n_events),
            "player_matches": len(table),
            "shots_for": int((shots["side"] == "for").sum()),
        },
        "labels": LABELS,
        "groups": list(POSITION_GROUPS),
        "correlations": corr.assign(label=corr["metric"].map(LABELS)).round(4).to_dict("records"),
        "distributions": _distributions(table),
        "shots": _columnar_shots(shots),
        "touch_grid": {"win": win_grid.round(3).tolist(), "dropped": dropped_grid.round(3).tolist()},
        "model": _model_payload(*model_results),
        "seasons": _season_summary(matches, model_results[2]),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

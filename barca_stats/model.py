"""Can Barça's in-game stats tell a win from dropped points? A match-level logistic regression.

One row per match from Barça's point of view. Features are differentials (Barça minus opponent)
plus home/away. Barça won about three in four of these matches, so the model keeps an intercept
and is judged on ROC AUC and Brier score against the base rate, not just accuracy.

Cross-validation holds out one whole season at a time, so the model is always scored on a
season (and often a coach and squad) it never saw.
"""

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .data import TEAM, load_events, load_matches
from .features import SHOOTOUT_PERIOD, _player_counts, _prepare_events
from .pitch import match_label

STAT_FEATURES = {
    "xg": "xG",
    "shots": "Shots",
    "touches_in_box": "Touches in box",
    "pass_share": "Possession (share of passes)",
    "pass_completion_pct": "Pass completion %",
    "progressive_passes": "Progressive passes",
    "pressures": "Pressures",
    "defensive_actions": "Tackles + interceptions + blocks",
}
FEATURE_LABELS = {**{f"{k}_diff": v for k, v in STAT_FEATURES.items()}, "home": "Playing at home"}
BOOTSTRAP_SAMPLES = 1000


def _team_stats(team_events, shot_xg, total_passes):
    counts = _player_counts(team_events, shot_xg)
    return {
        "xg": counts["xg"],
        "shots": counts["shots"],
        "touches_in_box": counts["touches_in_box"],
        "pass_share": counts["passes"] / total_passes * 100,
        "pass_completion_pct": counts["pass_completion_pct"],
        "progressive_passes": counts["progressive_passes"],
        "pressures": counts["pressures"],
        "defensive_actions": counts["tackles"] + counts["interceptions"] + counts["blocks"],
    }


def team_match_table():
    """One row per match: Barça's team stats, the opponent's, and the differences."""
    rows = []
    for _, match in load_matches().iterrows():
        events = _prepare_events(load_events(match["match_id"]))
        events = events[events["period"] != SHOOTOUT_PERIOD]
        shots = events[events["type"] == "Shot"]
        shot_xg = dict(zip(shots["id"], shots["shot_statsbomb_xg"]))
        total_passes = (events["type"] == "Pass").sum()
        barca = _team_stats(events[events["team"] == TEAM], shot_xg, total_passes)
        opp = _team_stats(events[(events["team"] != TEAM) & events["team"].notna()], shot_xg, total_passes)
        rows.append({
            "match_id": match["match_id"],
            "match": match_label(match),
            "date": match["match_date"],
            "season": match["season"],
            "opponent": match["opponent"],
            "venue": match["venue"],
            "home": int(match["venue"] == "Home"),
            "result": match["result"],
            "won": int(match["result"] == 1.0),
            **barca,
            **{f"{k}_opp": v for k, v in opp.items()},
            **{f"{k}_diff": barca[k] - opp[k] for k in STAT_FEATURES},
        })
    return pd.DataFrame(rows)


def _model():
    return make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000))


def _out_of_fold(table, columns):
    X, y, groups = table[columns].values, table["won"].values, table["season"].values
    probs = np.empty(len(table))
    for train, test in LeaveOneGroupOut().split(X, y, groups):
        probs[test] = _model().fit(X[train], y[train]).predict_proba(X[test])[:, 1]
    return probs


def _base_rate_out_of_fold(table):
    """'Always predict the win rate': each season gets the win rate of all the other seasons."""
    probs = np.empty(len(table))
    for season in table["season"].unique():
        mask = (table["season"] == season).values
        probs[mask] = table.loc[~mask, "won"].mean()
    return probs


def _scores(name, y, probs, ranks=True):
    return {
        "model": name,
        "accuracy": accuracy_score(y, probs > 0.5),
        # A constant guess can't rank matches, so AUC is undefined for the base-rate model.
        "roc_auc": roc_auc_score(y, probs) if ranks else np.nan,
        "brier": brier_score_loss(y, probs),
        "log_loss": log_loss(y, probs, labels=[0, 1]),
    }


def evaluate():
    """Season-held-out scores, standardised coefficients with bootstrap CIs, and per-match predictions."""
    table = team_match_table()
    y = table["won"].values
    columns = list(FEATURE_LABELS)

    base_probs = _base_rate_out_of_fold(table)
    xg_probs = _out_of_fold(table, ["xg_diff"])
    full_probs = _out_of_fold(table, columns)
    scores = pd.DataFrame([
        _scores("Always predict the win rate", y, base_probs, ranks=False),
        _scores("xG difference only", y, xg_probs),
        _scores("All stat differences + venue", y, full_probs),
    ])

    final = _model().fit(table[columns].values, y)
    rng = np.random.default_rng(2009)
    boot = []
    for _ in range(BOOTSTRAP_SAMPLES):
        sample = rng.integers(0, len(table), len(table))
        boot.append(_model().fit(table[columns].values[sample], y[sample])[-1].coef_[0])
    low, high = np.percentile(boot, [2.5, 97.5], axis=0)
    coefficients = pd.DataFrame({
        "feature": columns, "label": list(FEATURE_LABELS.values()),
        "coefficient": final[-1].coef_[0], "ci_low": low, "ci_high": high,
    })

    predictions = table.assign(p_win=full_probs, p_win_xg_only=xg_probs)
    return scores, coefficients, predictions

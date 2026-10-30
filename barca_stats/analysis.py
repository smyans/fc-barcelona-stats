"""Which per-90 Barça player metrics move with the result, by position group?"""

import pandas as pd
from scipy.stats import false_discovery_control, spearmanr

from .features import POSITION_GROUPS, metric_columns

FDR_ALPHA = 0.05


def correlate_with_result(df):
    """Spearman correlation of every metric with the team result, per position group.

    Spearman is used because the result is ordinal (loss < draw < win). p-values are
    Benjamini-Hochberg adjusted within each group, since we test ~26 metrics at once.
    """
    frames = []
    for group in POSITION_GROUPS:
        subset = df[df["position_group"] == group]
        rows = []
        for metric in metric_columns(df):
            pair = subset[[metric, "team_result"]].dropna()
            rho, p = spearmanr(pair[metric], pair["team_result"])
            rows.append({"position_group": group, "metric": metric, "rho": rho, "p_value": p, "n": len(pair)})
        result = pd.DataFrame(rows)
        result["p_adjusted"] = false_discovery_control(result["p_value"])
        result["significant"] = result["p_adjusted"] < FDR_ALPHA
        frames.append(result)
    return pd.concat(frames, ignore_index=True)


def winners_vs_losers(df):
    """Median per-90 value of each metric for players on winning vs losing teams."""
    decided = df[df["team_result"] != 0.5]
    outcome = decided["team_result"].map({1.0: "won", 0.0: "lost"})
    return (
        decided.groupby(["position_group", outcome])[metric_columns(df)]
        .median()
        .round(2)
    )

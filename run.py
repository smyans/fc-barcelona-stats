"""Build the datasets, run the analyses, draw the charts and export data for the website.

    python run.py
"""

from pathlib import Path

from barca_stats.analysis import correlate_with_result, winners_vs_losers
from barca_stats.data import load_all, load_events
from barca_stats.export import write_site_data
from barca_stats.features import build_player_match_table
from barca_stats.model import evaluate
from barca_stats.pitch import load_shots, touch_share_grid
from barca_stats.plots import (
    correlation_heatmap,
    model_coefficients,
    shot_map,
    top_metrics_bars,
    touch_difference_map,
)

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
FIGURES = ROOT / "figures"
SITE_DATA = ROOT / "docs" / "data" / "site.json"


def main():
    RESULTS.mkdir(exist_ok=True)
    FIGURES.mkdir(exist_ok=True)

    matches = load_all()
    n_events = sum(len(load_events(match_id)) for match_id in matches["match_id"])
    print(f"{len(matches)} Barça matches across {matches['season'].nunique()} seasons.")

    # Player-level correlations
    table = build_player_match_table()
    table.round(3).to_csv(RESULTS / "player_match_stats.csv", index=False)
    corr = correlate_with_result(table)
    corr.round(4).to_csv(RESULTS / "correlations.csv", index=False)
    winners_vs_losers(table).to_csv(RESULTS / "wins_vs_losses_medians.csv")
    correlation_heatmap(corr, FIGURES / "correlation_heatmap.png")
    top_metrics_bars(corr, FIGURES / "top_metrics_by_position.png")
    for group, sub in corr.groupby("position_group"):
        hits = sub[sub["significant"]].sort_values("rho", ascending=False)
        found = ", ".join(f"{m} ({r:+.2f})" for m, r in zip(hits["metric"], hits["rho"])) or "none"
        print(f"{group}: significant metrics -> {found}")

    # Pitch views
    shots = load_shots()
    shots.to_csv(RESULTS / "shots.csv", index=False)
    touch_grids = touch_share_grid()
    shot_map(shots[shots["side"] == "for"], FIGURES / "shot_map.png")
    touch_difference_map(*touch_grids, FIGURES / "touch_difference.png")

    # Win vs dropped-points model
    scores, coefficients, predictions = evaluate()
    scores.round(3).to_csv(RESULTS / "model_scores.csv", index=False)
    coefficients.round(3).to_csv(RESULTS / "model_coefficients.csv", index=False)
    predictions.round(3).to_csv(RESULTS / "model_predictions.csv", index=False)
    model_coefficients(coefficients, FIGURES / "model_coefficients.png")
    print(scores.round(3).to_string(index=False))

    write_site_data(SITE_DATA, matches, table, corr, shots, touch_grids,
                    (scores, coefficients, predictions), n_events)
    print(f"Wrote {SITE_DATA.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

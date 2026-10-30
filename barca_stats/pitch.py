"""Location-based views: every shot for and against Barça, and where Barça have the ball in wins vs dropped points."""

import numpy as np
import pandas as pd

from .data import TEAM, load_events, load_lineups, load_matches
from .features import ON_BALL_TYPES, SHOOTOUT_PERIOD

ON_TARGET = {"Goal", "Saved", "Saved to Post"}
GRID_X, GRID_Y = 6, 4  # 20x20-unit zones on the 120x80 StatsBomb pitch


def match_label(match):
    return f"{match['home_team']} {match['home_score']}–{match['away_score']} {match['away_team']}"


def display_names():
    """Map StatsBomb's full legal names to the names fans know (e.g. 'Lionel Messi')."""
    names = {}
    for match_id in load_matches()["match_id"]:
        lineups = load_lineups(match_id)
        for full, nickname in zip(lineups["player_name"], lineups["player_nickname"]):
            names[full] = nickname or full
    return names


def load_shots():
    """Every non-shootout shot in Barça's matches, for and against."""
    names = display_names()
    frames = []
    for _, match in load_matches().iterrows():
        events = load_events(match["match_id"])
        shots = events[(events["type"] == "Shot") & (events["period"] != SHOOTOUT_PERIOD)]
        frames.append(pd.DataFrame({
            "match_id": match["match_id"],
            "match": match_label(match),
            "season": match["season"],
            "result": match["result"],
            "side": np.where(shots["team"] == TEAM, "for", "against"),
            "team": shots["team"],
            "player": shots["player"].map(names),
            "minute": shots["minute"],
            "x": shots["location"].str[0],
            "y": shots["location"].str[1],
            "xg": shots["shot_statsbomb_xg"],
            "outcome": shots["shot_outcome"],
            "shot_type": shots["shot_type"],
            "body_part": shots["shot_body_part"],
        }))
    shots = pd.concat(frames, ignore_index=True)
    shots["goal"] = shots["outcome"] == "Goal"
    shots["on_target"] = shots["outcome"].isin(ON_TARGET)
    return shots


def touch_share_grid():
    """Share of Barça's on-ball actions in each pitch zone, averaged over wins and over dropped points.

    Returns two (GRID_Y, GRID_X) arrays in percent, oriented so Barça attack left to right.
    """
    grids = {"win": [], "dropped": []}
    for _, match in load_matches().iterrows():
        events = load_events(match["match_id"])
        on_ball = events[(events["team"] == TEAM) & (events["period"] != SHOOTOUT_PERIOD)
                         & events["type"].isin(ON_BALL_TYPES) & events["location"].notna()]
        x = on_ball["location"].str[0].clip(0, 119.99)
        y = on_ball["location"].str[1].clip(0, 79.99)
        counts, _, _ = np.histogram2d(y, x, bins=[GRID_Y, GRID_X], range=[[0, 80], [0, 120]])
        grids["win" if match["result"] == 1.0 else "dropped"].append(counts / counts.sum() * 100)
    return np.mean(grids["win"], axis=0), np.mean(grids["dropped"], axis=0)

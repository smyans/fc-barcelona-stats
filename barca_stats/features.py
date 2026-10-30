"""Turn raw StatsBomb events into one row of metrics per Barça player per match.

StatsBomb pitch coordinates: x runs 0-120 toward the opponent's goal, y runs 0-80.
The penalty box is x >= 102 and 18 <= y <= 62.
"""

import numpy as np
import pandas as pd

from .data import TEAM, load_events, load_lineups, load_matches

SHOOTOUT_PERIOD = 5
MIN_MINUTES = 30  # drop cameo appearances; per-90 rates are too noisy below this

# Events where the player is actually on the ball (used for "touches in box").
ON_BALL_TYPES = {"Pass", "Carry", "Shot", "Dribble", "Ball Receipt*", "Miscontrol"}
TACKLE_WON_OUTCOMES = {"Won", "Success", "Success In Play", "Success Out"}

POSITION_GROUPS = {
    "Attackers": [
        "Center Forward", "Left Center Forward", "Right Center Forward",
        "Left Wing", "Right Wing", "Secondary Striker",
    ],
    "Midfielders": [
        "Center Attacking Midfield", "Left Attacking Midfield", "Right Attacking Midfield",
        "Center Midfield", "Left Center Midfield", "Right Center Midfield",
        "Center Defensive Midfield", "Left Defensive Midfield", "Right Defensive Midfield",
        "Left Midfield", "Right Midfield",
    ],
    "Defenders": [
        "Center Back", "Left Center Back", "Right Center Back",
        "Left Back", "Right Back", "Left Wing Back", "Right Wing Back",
    ],
}
POSITION_TO_GROUP = {pos: group for group, positions in POSITION_GROUPS.items() for pos in positions}

# Metrics that are rates/percentages already; everything else is converted to per 90 minutes.
RATE_METRICS = ["pass_completion_pct", "ground_pass_pct"]


PERIOD_START_CLOCK = {1: 0, 2: 45, 3: 90, 4: 105}  # match clock at kick-off of each period


def _clock_to_minutes(clock):
    minutes, seconds = clock.split(":")
    return int(minutes) + int(seconds) / 60


class MatchClock:
    """Converts (period, match clock) into minutes actually elapsed, counting stoppage time.

    The match clock restarts at 45:00 for the second half, so a 48-minute first half
    overlaps the second half's clock; we need the period to tell them apart.
    """

    def __init__(self, events):
        clock = events["minute"] + events["second"] / 60
        period_end = clock.groupby(events["period"]).max()
        self.lengths = {p: period_end[p] - PERIOD_START_CLOCK[p] for p in period_end.index}
        self.last_period = max(self.lengths)
        self.full_time = self.elapsed(self.last_period, period_end[self.last_period])

    def elapsed(self, period, clock_minutes):
        before = sum(length for p, length in self.lengths.items() if p < period)
        return before + clock_minutes - PERIOD_START_CLOCK[period]


def _xy(series):
    """Split a column of [x, y] lists into two float arrays (NaN where missing)."""
    coords = series.apply(lambda loc: loc if isinstance(loc, list) else [np.nan, np.nan])
    arr = np.array(coords.tolist(), dtype=float)[:, :2]
    return arr[:, 0], arr[:, 1]


def _prepare_events(events):
    events = events[events["period"] != SHOOTOUT_PERIOD].copy()
    events["x"], events["y"] = _xy(events["location"])
    for col in ["pass_end_location", "carry_end_location"]:
        prefix = col.split("_")[0]
        if col not in events:
            events[col] = np.nan
        events[f"{prefix}_end_x"], events[f"{prefix}_end_y"] = _xy(events[col])
    for col in ["pass_assisted_shot_id", "pass_cross", "under_pressure", "shot_statsbomb_xg",
                "dribble_outcome", "duel_type", "duel_outcome", "pass_height", "pass_length"]:
        if col not in events:
            events[col] = np.nan
    return events


def _minutes_and_position(lineups, clock):
    """Minutes played and primary (most-played) position for each player who got on the pitch.

    StatsBomb position spells can overlap, so minutes are measured from when the player
    came on to when they were substituted/sent off (or the final whistle), not summed per spell.
    """
    rows = []
    for _, player in lineups.iterrows():
        spells = player["positions"]
        if not spells:
            continue  # unused substitute

        def start(spell):
            return clock.elapsed(spell["from_period"], _clock_to_minutes(spell["from"]))

        def end(spell):
            if spell["to"] is None:
                return clock.full_time
            return clock.elapsed(spell["to_period"], _clock_to_minutes(spell["to"]))

        came_on = min(start(s) for s in spells)
        left = [end(s) for s in spells if s["end_reason"].startswith(("Substitution - Off", "Foul Committed (Red Card)"))]
        went_off = min(left) if left else clock.full_time

        time_by_position = {}
        for spell in spells:
            overlap = min(end(spell), went_off) - max(start(spell), came_on)
            time_by_position[spell["position"]] = time_by_position.get(spell["position"], 0) + max(overlap, 0)
        rows.append({
            "player": player["player_name"],
            "team": player["team"],
            "minutes": went_off - came_on,
            "position": max(time_by_position, key=time_by_position.get),
        })
    return pd.DataFrame(rows)


def _player_counts(p, shot_xg):
    """Raw counts for one player's events in one match."""
    passes = p[p["type"] == "Pass"]
    completed = passes[passes["pass_outcome"].isna()]
    carries = p[p["type"] == "Carry"]
    tackles = p[(p["type"] == "Duel") & (p["duel_type"] == "Tackle")]
    shots = p[p["type"] == "Shot"]

    # Progressive pass: moves the ball 30+ units forward from your own half, or 10+ in the opponent's half.
    pass_gain = completed["pass_end_x"] - completed["x"]
    progressive = ((completed["x"] < 60) & (pass_gain >= 30)) | ((completed["x"] >= 60) & (pass_gain >= 10))

    in_box = (p["x"] >= 102) & p["y"].between(18, 62)
    assisted = passes["pass_assisted_shot_id"].dropna()

    return {
        # Shooting
        "shots": len(shots),
        "xg": shots["shot_statsbomb_xg"].sum(),
        "touches_in_box": int((in_box & p["type"].isin(ON_BALL_TYPES)).sum()),
        # Passing and chance creation
        "passes": len(passes),
        "pass_completion_pct": len(completed) / len(passes) * 100 if len(passes) else np.nan,
        "ground_pass_pct": (passes["pass_height"] == "Ground Pass").mean() * 100 if len(passes) else np.nan,
        "chances_created": len(assisted),
        "xa": sum(shot_xg.get(shot_id, 0) for shot_id in assisted),
        "long_balls": int((passes["pass_length"] >= 35).sum()),
        "switches": int(((passes["pass_end_y"] - passes["y"]).abs() >= 40).sum()),
        "crosses": int((passes["pass_cross"] == True).sum()),  # noqa: E712 (column is True/NaN)
        "passes_into_final_third": int(((completed["x"] < 80) & (completed["pass_end_x"] >= 80)).sum()),
        "passes_into_box": int(((completed["pass_end_x"] >= 102) & completed["pass_end_y"].between(18, 62)).sum()),
        "progressive_passes": int(progressive.sum()),
        "progressive_carries": int(((carries["carry_end_x"] - carries["x"]) >= 10).sum()),
        # Ball retention
        "actions_under_pressure": int((p["under_pressure"] == True).sum()),  # noqa: E712
        "successful_dribbles": int((p["dribble_outcome"] == "Complete").sum()),
        "turnovers": int(p["type"].isin(["Miscontrol", "Dispossessed"]).sum()),
        # Defending
        "tackles": len(tackles),
        "tackles_won": int(tackles["duel_outcome"].isin(TACKLE_WON_OUTCOMES).sum()),
        "interceptions": int((p["type"] == "Interception").sum()),
        "pressures": int((p["type"] == "Pressure").sum()),
        "blocks": int((p["type"] == "Block").sum()),
        "clearances": int((p["type"] == "Clearance").sum()),
        "middle_third_recoveries": int(((p["type"] == "Ball Recovery") & p["x"].between(40, 80)).sum()),
        "fouls_committed": int((p["type"] == "Foul Committed").sum()),
    }


def _match_result(match, team):
    """1 for a win, 0.5 for a draw, 0 for a loss, from `team`'s point of view."""
    home, away = match["home_score"], match["away_score"]
    if home == away:
        return 0.5
    winner = match["home_team"] if home > away else match["away_team"]
    return 1.0 if team == winner else 0.0


def build_match_rows(match):
    events = _prepare_events(load_events(match["match_id"]))
    players = _minutes_and_position(load_lineups(match["match_id"]), MatchClock(events))

    shots = events[events["type"] == "Shot"]
    shot_xg = dict(zip(shots["id"], shots["shot_statsbomb_xg"]))
    events_by_player = dict(tuple(events[events["player"].notna()].groupby("player")))

    rows = []
    for _, info in players[players["team"] == TEAM].iterrows():
        player_events = events_by_player.get(info["player"], events.iloc[0:0])
        rows.append({
            "match_id": match["match_id"],
            "season": match["season"],
            "date": match["match_date"],
            "opponent": match["opponent"],
            "venue": match["venue"],
            **info.to_dict(),
            "team_result": _match_result(match, info["team"]),
            **_player_counts(player_events, shot_xg),
        })
    return rows


def build_player_match_table():
    """One row per player per match, with count metrics converted to per-90 rates."""
    matches = load_matches()
    rows = [row for _, match in matches.iterrows() for row in build_match_rows(match)]
    df = pd.DataFrame(rows)

    df["position_group"] = df["position"].map(POSITION_TO_GROUP).fillna("Goalkeeper/Other")
    df = df[df["minutes"] >= MIN_MINUTES].reset_index(drop=True)

    count_metrics = [c for c in metric_columns(df) if c not in RATE_METRICS]
    df[count_metrics] = df[count_metrics].div(df["minutes"], axis=0) * 90
    return df


def metric_columns(df):
    non_metrics = {"match_id", "season", "date", "opponent", "venue", "player", "team", "minutes",
                   "position", "position_group", "team_result"}
    return [c for c in df.columns if c not in non_metrics]

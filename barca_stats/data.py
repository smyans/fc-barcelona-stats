"""Load FC Barcelona's La Liga matches (2004/05-2020/21) from StatsBomb open data, cached on disk.

StatsBomb's free La Liga release covers the league matches Lionel Messi played for Barcelona,
so this is Barça's Messi era rather than every Barça match.
"""

from pathlib import Path

import pandas as pd
from statsbombpy import sb
from tqdm import tqdm

LA_LIGA = 11
TEAM = "Barcelona"
SEASONS = {  # StatsBomb season_id -> season label
    37: "2004/05", 38: "2005/06", 39: "2006/07", 40: "2007/08", 41: "2008/09", 21: "2009/10",
    22: "2010/11", 23: "2011/12", 24: "2012/13", 25: "2013/14", 26: "2014/15", 27: "2015/16",
    2: "2016/17", 1: "2017/18", 4: "2018/19", 42: "2019/20", 90: "2020/21",
}
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"

# Full StatsBomb events carry ~100 columns (freeze frames, tactics, ...); keep only what the analysis uses.
EVENT_COLUMNS = [
    "id", "type", "period", "minute", "second", "team", "player", "location",
    "pass_end_location", "pass_outcome", "pass_assisted_shot_id", "pass_cross", "pass_height", "pass_length",
    "carry_end_location", "under_pressure", "dribble_outcome", "duel_type", "duel_outcome",
    "shot_statsbomb_xg", "shot_outcome", "shot_type", "shot_body_part",
]


def _cached(name, fetch):
    path = CACHE_DIR / f"{name}.pkl"
    if path.exists():
        return pd.read_pickle(path)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    df = fetch()
    df.to_pickle(path)
    return df


def load_matches():
    """Every Barça La Liga match in the open data, with the result from Barça's point of view."""

    def fetch():
        frames = [sb.matches(competition_id=LA_LIGA, season_id=sid).assign(season=label)
                  for sid, label in SEASONS.items()]
        return pd.concat(frames, ignore_index=True)

    matches = _cached("matches", fetch)
    matches = matches[(matches["home_team"] == TEAM) | (matches["away_team"] == TEAM)].copy()
    home = matches["home_team"] == TEAM
    matches["venue"] = home.map({True: "Home", False: "Away"})
    matches["opponent"] = matches["away_team"].where(home, matches["home_team"])
    matches["goals_for"] = matches["home_score"].where(home, matches["away_score"])
    matches["goals_against"] = matches["away_score"].where(home, matches["home_score"])
    matches["manager"] = matches["home_managers"].where(home, matches["away_managers"])
    matches["result"] = (matches["goals_for"] > matches["goals_against"]).astype(float)
    matches.loc[matches["goals_for"] == matches["goals_against"], "result"] = 0.5
    return matches.sort_values("match_date").reset_index(drop=True)


def load_events(match_id):
    def fetch():
        events = sb.events(match_id=match_id)
        return events.reindex(columns=EVENT_COLUMNS)

    return _cached(f"events_{match_id}", fetch)


def load_lineups(match_id):
    """One row per player per team, with the time ranges they played each position."""

    def fetch():
        frames = [df.assign(team=team) for team, df in sb.lineups(match_id=match_id).items()]
        return pd.concat(frames, ignore_index=True)

    return _cached(f"lineups_{match_id}", fetch)


def load_all():
    """Download (or read from cache) every match, its events and lineups."""
    matches = load_matches()
    for match_id in tqdm(matches["match_id"], desc="Loading matches"):
        load_events(match_id)
        load_lineups(match_id)
    return matches

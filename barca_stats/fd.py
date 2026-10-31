"""La Liga results, match stats and bookmaker odds from football-data.co.uk (2005/06 to the current season).

Finished seasons are cached for good. The current season and the upcoming-fixtures file are
re-downloaded when the cached copy is more than 12 hours old, so predictions stay current.
"""

import io
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE = "https://www.football-data.co.uk"
DIVISION = "SP1"
FIRST_SEASON = 2005
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "fd"
REFRESH_SECONDS = 12 * 3600

COLUMNS = {
    "HomeTeam": "home", "AwayTeam": "away", "FTHG": "hg", "FTAG": "ag", "HTHG": "hthg", "HTAG": "htag",
    "HS": "hs", "AS": "as", "HST": "hst", "AST": "ast", "HF": "hf", "AF": "af", "HC": "hc", "AC": "ac",
    "HY": "hy", "AY": "ay", "HR": "hr", "AR": "ar", "HxG": "hxg", "AxG": "axg",
}
# Market-average odds: "BbAv*" until 2018/19, "Avg*" from 2019/20.
ODDS = [("AvgH", "AvgD", "AvgA"), ("BbAvH", "BbAvD", "BbAvA"), ("B365H", "B365D", "B365A")]


def current_season_start(today=None):
    today = today or date.today()
    return today.year if today.month >= 7 else today.year - 1


def season_code(start):
    return f"{start % 100:02d}{(start + 1) % 100:02d}"


def season_label(start):
    return f"{start}/{(start + 1) % 100:02d}"


def _download(url, path, refresh):
    if path.exists() and not (refresh and time.time() - path.stat().st_mtime > REFRESH_SECONDS):
        return path.read_bytes()
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(response.content)
    return response.content


def _parse(raw, season=None):
    df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig", on_bad_lines="skip")
    df = df.dropna(subset=["HomeTeam", "AwayTeam"])
    if "Div" in df:
        df = df[df["Div"] == DIVISION]
    out = df.rename(columns=COLUMNS).reindex(columns=list(COLUMNS.values()))
    out["date"] = pd.to_datetime(df["Date"], dayfirst=True, format="mixed")
    out["time"] = df["Time"] if "Time" in df else np.nan
    for h, d, a in ODDS:
        if h in df and df[h].notna().any():
            out["odds_h"], out["odds_d"], out["odds_a"] = df[h], df[d], df[a]
            break
    else:
        out["odds_h"] = out["odds_d"] = out["odds_a"] = np.nan
    if season is not None:
        out["season"] = season_label(season)
        out["season_start"] = season
    return out


def load_results():
    """Every La Liga match since 2005/06 with result, match stats and de-margined market probabilities."""
    current = current_season_start()
    frames = []
    for start in range(FIRST_SEASON, current + 1):
        code = season_code(start)
        raw = _download(f"{BASE}/mmz4281/{code}/{DIVISION}.csv", CACHE_DIR / f"{DIVISION}_{code}.csv",
                        refresh=start == current)
        frames.append(_parse(raw, start))
    df = pd.concat(frames, ignore_index=True)
    df = df.dropna(subset=["hg", "ag"]).sort_values(["date", "home"]).reset_index(drop=True)
    df[["hg", "ag"]] = df[["hg", "ag"]].astype(int)
    df["result"] = np.select([df["hg"] > df["ag"], df["hg"] == df["ag"]], ["H", "D"], "A")
    return add_market_probs(df)


def load_fixtures():
    """Upcoming La Liga fixtures (with market odds where published)."""
    raw = _download(f"{BASE}/fixtures.csv", CACHE_DIR / "fixtures.csv", refresh=True)
    return add_market_probs(_parse(raw)).sort_values("date").reset_index(drop=True)


def add_market_probs(df):
    """Bookmaker odds -> probabilities, with the bookmaker margin removed by normalising."""
    inv = 1 / df[["odds_h", "odds_d", "odds_a"]].astype(float)
    total = inv.sum(axis=1, min_count=3)
    for col, out in zip(inv.columns, ["mkt_h", "mkt_d", "mkt_a"]):
        df[out] = inv[col] / total
    return df

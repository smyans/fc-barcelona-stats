"""Pre-match model: expected goals for each side from Poisson regressions, then win/draw/loss probabilities.

Home and away goals each get a Poisson regression on Elo difference, recent form and rest. The two
expected-goal figures are turned into a score grid (independent Poisson with a Dixon-Coles adjustment
for 0-0, 1-0, 0-1 and 1-1, which plain Poisson gets wrong). The expected goals also seed the in-game model.
"""

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.linear_model import PoissonRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .ratings import ELO_HOME, add_elo, add_form_and_rest

MAX_GOALS = 10
HOME_FEATURES = ["elo_diff", "home_form_gf", "home_form_sot_for", "away_form_ga", "away_form_sot_against",
                 "home_style_gf", "away_style_ga", "home_rest", "away_rest"]
AWAY_FEATURES = ["elo_diff", "away_form_gf", "away_form_sot_for", "home_form_ga", "home_form_sot_against",
                 "away_style_gf", "home_style_ga", "home_rest", "away_rest"]


def add_features(matches, upcoming=None):
    """Elo and form features for completed matches (and upcoming fixtures, rated with the latest Elo)."""
    rated, latest_elo = add_elo(matches)
    rated["elo_diff"] = rated["home_elo"] + ELO_HOME - rated["away_elo"]
    if upcoming is None:
        return add_form_and_rest(rated)
    rated, up = add_form_and_rest(rated, upcoming)
    up["home_elo"] = up["home"].map(latest_elo)
    up["away_elo"] = up["away"].map(latest_elo)
    up["elo_diff"] = up["home_elo"] + ELO_HOME - up["away_elo"]
    return rated, up, latest_elo


def score_grid(lam_home, lam_away, rho):
    """P(home scores i, away scores j) with the Dixon-Coles low-score correction."""
    goals = np.arange(MAX_GOALS + 1)
    grid = np.outer(poisson.pmf(goals, lam_home), poisson.pmf(goals, lam_away))
    grid[0, 0] *= 1 - lam_home * lam_away * rho
    grid[0, 1] *= 1 + lam_home * rho
    grid[1, 0] *= 1 + lam_away * rho
    grid[1, 1] *= 1 - rho
    return grid / grid.sum()


def outcome_probs(lam_home, lam_away, rho):
    grid = score_grid(lam_home, lam_away, rho)
    return np.array([np.tril(grid, -1).sum(), np.trace(grid), np.triu(grid, 1).sum()])


class PreMatchModel:
    def __init__(self, alpha=1e-3):
        self.home_model = make_pipeline(StandardScaler(), PoissonRegressor(alpha=alpha, max_iter=1000))
        self.away_model = make_pipeline(StandardScaler(), PoissonRegressor(alpha=alpha, max_iter=1000))
        self.rho = 0.0

    def fit(self, train):
        self.home_model.fit(train[HOME_FEATURES], train["hg"])
        self.away_model.fit(train[AWAY_FEATURES], train["ag"])
        self.rho = self._fit_rho(train)
        return self

    def expected_goals(self, df):
        return self.home_model.predict(df[HOME_FEATURES]), self.away_model.predict(df[AWAY_FEATURES])

    def predict(self, df, rho=None):
        rho = self.rho if rho is None else rho
        lam_h, lam_a = self.expected_goals(df)
        probs = np.array([outcome_probs(h, a, rho) for h, a in zip(lam_h, lam_a)])
        return pd.DataFrame({"lam_h": lam_h, "lam_a": lam_a, "p_h": probs[:, 0], "p_d": probs[:, 1],
                             "p_a": probs[:, 2]}, index=df.index)

    def _fit_rho(self, train):
        """Pick the low-score correction that best predicts training results."""
        lam_h, lam_a = self.expected_goals(train)
        idx = train["result"].map({"H": 0, "D": 1, "A": 2}).values
        best, best_loss = 0.0, np.inf
        for rho in np.arange(-0.2, 0.21, 0.02):
            probs = np.array([outcome_probs(h, a, rho) for h, a in zip(lam_h, lam_a)])
            loss = -np.log(probs[np.arange(len(idx)), idx]).mean()
            if loss < best_loss:
                best, best_loss = rho, loss
        return float(best)


def log_loss(probs, results):
    idx = results.map({"H": 0, "D": 1, "A": 2}).values
    return float(-np.log(np.clip(probs[np.arange(len(idx)), idx], 1e-12, 1)).mean())


def backtest(features, test_seasons):
    """Walk forward: for each test season, train on every earlier season, then predict it."""
    frames = []
    for season in test_seasons:
        train = features[features["season_start"] < season]
        test = features[features["season_start"] == season]
        model = PreMatchModel().fit(train)
        frames.append(test.join(model.predict(test)).assign(rho=model.rho))
    return pd.concat(frames)

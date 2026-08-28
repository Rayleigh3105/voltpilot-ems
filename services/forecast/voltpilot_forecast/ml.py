"""The gradient-boosted (XGBoost) challenger models - SHADOW-ONLY by default.

Two challengers per the shadow-mode contract (docs/forecasting.md):

* :class:`XgbLoadForecaster` (``load-xgb``) - gradient-boosted load forecast on
  tabular features (calendar incl. German holiday flag, leakage-safe lags and
  windowed means, outdoor temperature from the stored weather forecast).
* :class:`PvResidualXgbForecaster` (``pv-residual-xgb``) - keeps the PHYSICAL
  PV model as the base and learns only the residual vs actuals given weather
  features; prediction = physical + learned residual. The physics stay the
  explainable backbone; the ML only corrects what the clear-sky/derate model
  systematically misses (soiling, horizon shading, sensor bias, ...).

Library choice: **xgboost** (the task's primary pick). LightGBM's wheels are no
friendlier - on macOS BOTH need the OpenMP runtime (``brew install libomp``);
Linux wheels need ``libgomp1`` (installed in the service Dockerfile) - so the
tiebreaker is xgboost's native NaN handling story and gain-based feature
importances feeding the explainability trail directly. The dependency stays
isolated behind the optional ``ml`` extra (the HiGHS-solver pattern): the rest
of the package imports and tests fine without it, and these classes lazy-import
``xgboost``/``numpy`` at first use.

Self-gating (the traceability requirement): a challenger refuses to train -
and therefore emits NO predictions - until a site has at least
:data:`MIN_TRAINING_DAYS` full days of telemetry. Below the gate it reports an
honest :class:`GateReport` ("sammelt Daten: Tag X von 21" in the portal)
instead of silently extrapolating from noise. Training is deterministic for a
fixed seed and dataset; every run yields a :class:`TrainingReport` (trained_at,
rows, top feature importances with plain-German labels) that is persisted as
the model's explainability trail.

There is NO automatic promotion. A challenger stays shadow until the captain
flips ``VOLTPILOT_ACTIVE_LOAD_MODEL`` / ``VOLTPILOT_ACTIVE_PV_MODEL``, informed
by the daily ``forecast_accuracy`` evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Sequence

from voltpilot_forecast import registry
from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    Horizon,
    Observation,
    ensure_utc,
)
from voltpilot_forecast.domain import SiteForecastConfig
from voltpilot_forecast.features import (
    FEATURE_LABELS_DE,
    LOAD_FEATURES,
    PV_RESIDUAL_FEATURES,
    WeatherHistory,
    bucket_15min,
    build_load_training_set,
    full_days,
    load_feature_row,
    pv_residual_feature_row,
)
from voltpilot_forecast.load import LoadForecaster
from voltpilot_forecast.pv import PhysicalPvForecaster, PvForecaster
from voltpilot_forecast.pvceiling import apply_clear_sky_ceiling

#: Minimum FULL telemetry days before a challenger may train (self-gate).
MIN_TRAINING_DAYS = 21

#: Deterministic default seed - reproducible training is part of traceability.
DEFAULT_SEED = 7

#: How many feature importances the explainability trail keeps.
TOP_IMPORTANCES = 5

# Native-API booster params (xgboost's sklearn wrapper would drag in
# scikit-learn as a hard dependency; the plain Booster API needs only xgboost
# itself). NaN inputs are handled natively (learned default split direction).
_XGB_PARAMS = {
    "max_depth": 6,
    "eta": 0.06,
    "subsample": 0.9,
    "colsample_bytree": 0.9,
    "min_child_weight": 2,
    "objective": "reg:squarederror",
    "nthread": 2,
}
_NUM_BOOST_ROUND = 300


class InsufficientHistory(Exception):
    """The self-gate is not met: too few full telemetry days to train."""

    def __init__(self, days_collected: int, days_required: int) -> None:
        super().__init__(
            f"needs {days_required} full telemetry days, has {days_collected}"
        )
        self.days_collected = days_collected
        self.days_required = days_required


class NotTrained(Exception):
    """forecast() was called before a successful train() in this process."""


@dataclass(frozen=True)
class FeatureImportance:
    feature: str
    label: str  # plain German, for the portal
    weight: float  # normalized share of total gain, 0..1


@dataclass(frozen=True)
class TrainingReport:
    """The explainability trail of one training run (persisted per site+model)."""

    model_id: str
    trained_at: datetime
    train_rows: int
    days_used: int
    feature_importance: tuple[FeatureImportance, ...] = field(default_factory=tuple)


def _lazy_ml():
    """Import numpy + xgboost on first use (optional ``ml`` extra)."""
    import numpy as np  # noqa: PLC0415
    import xgboost as xgb  # noqa: PLC0415

    return np, xgb


def _fit_booster(xs, ys, feature_names: Sequence[str], seed: int):
    """Train a deterministic booster on (xs, ys); returns it with its gains."""
    np, xgb = _lazy_ml()
    dtrain = xgb.DMatrix(
        np.array(xs, dtype=float),
        label=np.array(ys, dtype=float),
        feature_names=list(feature_names),
    )
    booster = xgb.train(
        {**_XGB_PARAMS, "seed": seed}, dtrain, num_boost_round=_NUM_BOOST_ROUND
    )
    return booster


def _predict(booster, rows, feature_names: Sequence[str]):
    np, xgb = _lazy_ml()
    dmatrix = xgb.DMatrix(
        np.array(rows, dtype=float), feature_names=list(feature_names)
    )
    return booster.predict(dmatrix)


def _top_importances(booster, feature_names: Sequence[str]) -> tuple[FeatureImportance, ...]:
    gains = booster.get_score(importance_type="gain")  # absent = never used
    total = float(sum(gains.values())) or 1.0
    ranked = sorted(gains.items(), key=lambda kv: kv[1], reverse=True)
    return tuple(
        FeatureImportance(
            feature=name,
            label=FEATURE_LABELS_DE.get(name, name),
            weight=round(float(gain) / total, 4),
        )
        for name, gain in ranked[:TOP_IMPORTANCES]
        if gain > 0
    )


class XgbLoadForecaster(LoadForecaster):
    """``load-xgb``: gradient-boosted site load challenger (shadow)."""

    method = "xgboost"
    model_id = registry.LOAD_XGB

    def __init__(
        self,
        weather: WeatherHistory | None = None,
        min_days: int = MIN_TRAINING_DAYS,
        seed: int = DEFAULT_SEED,
    ) -> None:
        self._weather = weather
        self.min_days = min_days
        self._seed = seed
        self._booster = None
        self.report: TrainingReport | None = None

    def update_weather(self, weather: WeatherHistory | None) -> None:
        """Refresh the weather lookup between cycles (the model itself is only
        retrained nightly, but each prediction should see current weather)."""
        self._weather = weather

    def _temperature_at(self, ts: datetime) -> float:
        if self._weather is None:
            return float("nan")
        return self._weather.temperature_at(ts)

    def training_days(self, history: Sequence[Observation]) -> int:
        return full_days(bucket_15min(history))

    def train(
        self, history: Sequence[Observation], run_at: datetime
    ) -> TrainingReport:
        """Fit on the site's history; raises :class:`InsufficientHistory` below
        the gate. Deterministic for a fixed seed + dataset."""
        by_slot = bucket_15min(history)
        days = full_days(by_slot)
        if days < self.min_days:
            raise InsufficientHistory(days, self.min_days)

        xs, ys = build_load_training_set(by_slot, self._temperature_at)
        if not xs:
            raise InsufficientHistory(0, self.min_days)
        self._booster = _fit_booster(xs, ys, LOAD_FEATURES, self._seed)
        self.report = TrainingReport(
            model_id=self.model_id,
            trained_at=ensure_utc(run_at),
            train_rows=len(xs),
            days_used=days,
            feature_importance=_top_importances(self._booster, LOAD_FEATURES),
        )
        return self.report

    def forecast(
        self,
        site_id: str,
        tenant_id: str,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime,
    ) -> ForecastSeries:
        if self._booster is None:
            raise NotTrained(f"{self.model_id}: train() must succeed before forecast()")
        by_slot = bucket_15min(history)
        timestamps = horizon.slot_starts(run_at)
        rows = [
            load_feature_row(ts, by_slot, self._temperature_at) for ts in timestamps
        ]
        predicted = _predict(self._booster, rows, LOAD_FEATURES)
        points = [
            ForecastPoint(ts, round(max(0.0, float(kw)), 4))
            for ts, kw in zip(timestamps, predicted)
        ]
        return ForecastSeries(
            kind=ForecastKind.LOAD,
            site_id=site_id,
            tenant_id=tenant_id,
            run_at=run_at,
            method=self.method,
            points=points,
            model=self.model_id,
        )


class PvResidualXgbForecaster(PvForecaster):
    """``pv-residual-xgb``: physical PV base + learned residual (shadow).

    ``physical`` should be constructed with the same weather provider the
    active ``pv-physical`` model uses, so the residual corrects the REAL
    baseline rather than a different physics run.
    """

    method = "physical+xgb-residual"
    model_id = registry.PV_RESIDUAL_XGB

    def __init__(
        self,
        physical: PhysicalPvForecaster | None = None,
        weather: WeatherHistory | None = None,
        min_days: int = MIN_TRAINING_DAYS,
        seed: int = DEFAULT_SEED,
    ) -> None:
        self._physical = physical or PhysicalPvForecaster()
        self._weather = weather
        self.min_days = min_days
        self._seed = seed
        self._booster = None
        self.report: TrainingReport | None = None

    def update_weather(
        self,
        weather: WeatherHistory | None,
        physical: PhysicalPvForecaster | None = None,
    ) -> None:
        """Refresh the weather lookup (and the physical base's provider)
        between cycles; the learned residual itself is only retrained nightly."""
        self._weather = weather
        if physical is not None:
            self._physical = physical

    def training_days(self, history: Sequence[Observation]) -> int:
        return full_days(bucket_15min(history))

    def train(
        self,
        config: SiteForecastConfig,
        pv_history: Sequence[Observation],
        run_at: datetime,
    ) -> TrainingReport:
        """Learn residual = actual - physical over the site's PV history."""
        by_slot = bucket_15min(pv_history)
        days = full_days(by_slot)
        if days < self.min_days:
            raise InsufficientHistory(days, self.min_days)

        slots = sorted(by_slot)
        physical = self._physical.power_series(config, slots)
        xs = [
            pv_residual_feature_row(ts, phys, self._weather)
            for ts, phys in zip(slots, physical)
        ]
        ys = [by_slot[ts] - phys for ts, phys in zip(slots, physical)]
        self._booster = _fit_booster(xs, ys, PV_RESIDUAL_FEATURES, self._seed)
        self.report = TrainingReport(
            model_id=self.model_id,
            trained_at=ensure_utc(run_at),
            train_rows=len(xs),
            days_used=days,
            feature_importance=_top_importances(self._booster, PV_RESIDUAL_FEATURES),
        )
        return self.report

    def forecast(
        self, config: SiteForecastConfig, horizon: Horizon, run_at: datetime
    ) -> ForecastSeries:
        if self._booster is None:
            raise NotTrained(f"{self.model_id}: train() must succeed before forecast()")
        timestamps = horizon.slot_starts(run_at)
        physical = self._physical.power_series(config, timestamps)
        rows = [
            pv_residual_feature_row(ts, phys, self._weather)
            for ts, phys in zip(timestamps, physical)
        ]
        residual = _predict(self._booster, rows, PV_RESIDUAL_FEATURES)
        capacity = config.plant.capacity_kwp if config.plant is not None else None
        raw: list[float] = []
        for phys, res in zip(physical, residual):
            kw = max(0.0, phys + float(res))
            if capacity is not None:
                kw = min(kw, capacity)
            raw.append(kw)
        # Nameplate alone is no physical bound: a learned residual is free to
        # add generation to a slot whose sun has set. The clear-sky ceiling is
        # the only thing that stops it (:mod:`voltpilot_forecast.pvceiling`),
        # and it binds AFTER the residual - clipping the base would just move
        # the same claim into the residual's lap.
        capped = apply_clear_sky_ceiling(config, list(timestamps), raw)
        points = [ForecastPoint(ts, round(kw, 4)) for ts, kw in zip(timestamps, capped)]
        return ForecastSeries(
            kind=ForecastKind.PV,
            site_id=config.site_id,
            tenant_id=config.tenant_id,
            run_at=run_at,
            method=self.method,
            points=points,
            model=self.model_id,
        )

"""XGBoost challengers: self-gating, determinism, and the skill sanity check.

Skips without the optional ``ml`` extra (xgboost/numpy) - the same pattern as
the optimizer's HiGHS-dependent tests. The sanity check constructs a load
pattern the persistence baseline MUST fail on (a strong weekday/weekend split:
"yesterday's value" is wrong every Monday) and proves the learner beats it
(skill > 0) - deterministically, fixed seed, no network, no DB.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("xgboost", reason="optional [ml] extra not installed")
pytest.importorskip("numpy", reason="optional [ml] extra not installed")

from voltpilot_forecast.domain import (
    ForecastKind,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.evaluation import forecast_metrics, skill_vs_baseline
from voltpilot_forecast.load import SeasonalPersistenceLoadForecaster
from voltpilot_forecast.ml import (
    InsufficientHistory,
    NotTrained,
    PvResidualXgbForecaster,
    XgbLoadForecaster,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.solar import solar_position

# Monday 2026-06-01: day-of-week arithmetic below is explicit.
T0 = datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc)
HORIZON_DAY = Horizon(slots=96)


def _weekly_load(ts: datetime) -> float:
    """Weekday 2.0 kW / weekend 0.5 kW base + a daily shape."""
    base = 0.5 if ts.weekday() >= 5 else 2.0
    return base + 0.3 * math.sin(2 * math.pi * (ts.hour * 4 + ts.minute // 15) / 96)


def _history(days: int, value=_weekly_load) -> list[Observation]:
    return [
        Observation(T0 + timedelta(days=d, minutes=15 * q), value(T0 + timedelta(days=d, minutes=15 * q)))
        for d in range(days)
        for q in range(96)
    ]


# ---- self-gating -----------------------------------------------------------------

def test_below_the_gate_training_refuses_with_honest_counts():
    forecaster = XgbLoadForecaster()
    with pytest.raises(InsufficientHistory) as exc:
        forecaster.train(_history(10), T0 + timedelta(days=10))
    assert exc.value.days_collected == 10
    assert exc.value.days_required == 21
    # And without a successful training there are NO predictions - ever.
    with pytest.raises(NotTrained):
        forecaster.forecast("s", "t", _history(10), HORIZON_DAY, T0 + timedelta(days=10))


def test_at_the_gate_training_succeeds_and_reports_the_trail():
    forecaster = XgbLoadForecaster()
    run_at = T0 + timedelta(days=21)
    report = forecaster.train(_history(21), run_at)
    assert report.train_rows > 0
    assert report.days_used == 21
    assert report.trained_at == run_at
    assert 1 <= len(report.feature_importance) <= 5
    top = report.feature_importance[0]
    assert top.label and top.label != top.feature  # plain-German label present
    assert abs(sum(fi.weight for fi in report.feature_importance)) <= 1.0001

    series = forecaster.forecast("s", "t", _history(21), HORIZON_DAY, run_at)
    assert len(series) == 96
    assert series.model == "load-xgb"
    assert all(p.value_kw >= 0 for p in series.points)


# ---- the skill sanity check --------------------------------------------------------

def test_load_challenger_beats_persistence_on_a_weekly_pattern():
    # 28 days of history ending Sunday night; forecast MONDAY. Persistence
    # repeats Sunday (0.5 kW base) while the truth is a 2.0 kW weekday.
    days = 28
    history = _history(days)
    run_at = T0 + timedelta(days=days)  # Monday 00:00
    assert run_at.weekday() == 0

    challenger = XgbLoadForecaster(seed=7)
    challenger.train(history, run_at)
    challenger_series = challenger.forecast("s", "t", history, HORIZON_DAY, run_at)
    baseline_series = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", history, HORIZON_DAY, run_at
    )

    actuals = {
        ts: _weekly_load(ts)
        for ts in HORIZON_DAY.slot_starts(run_at)
    }
    challenger_mae = forecast_metrics(
        {p.timestamp: p.value_kw for p in challenger_series.points}, actuals
    ).mae_kw
    baseline_mae = forecast_metrics(
        {p.timestamp: p.value_kw for p in baseline_series.points}, actuals
    ).mae_kw

    skill = skill_vs_baseline(challenger_mae, baseline_mae)
    assert baseline_mae > 1.0            # persistence really is wrong on Mondays
    assert challenger_mae < baseline_mae
    assert skill is not None and skill > 0.5  # the learner must clearly win


def test_training_is_deterministic_for_a_fixed_seed():
    history = _history(21)
    run_at = T0 + timedelta(days=21)
    a = XgbLoadForecaster(seed=7)
    b = XgbLoadForecaster(seed=7)
    a.train(history, run_at)
    b.train(history, run_at)
    fa = a.forecast("s", "t", history, HORIZON_DAY, run_at)
    fb = b.forecast("s", "t", history, HORIZON_DAY, run_at)
    assert [p.value_kw for p in fa.points] == [p.value_kw for p in fb.points]


# ---- PV residual challenger ---------------------------------------------------------

def _pv_config() -> SiteForecastConfig:
    return SiteForecastConfig(
        tenant_id="t",
        site_id="s",
        location=GeoLocation(52.52, 13.405),
        plant=PlantSpec(capacity_kwp=10.0),
    )


def test_pv_residual_gates_like_the_load_challenger():
    config = _pv_config()
    physical = PhysicalPvForecaster()
    slots = [T0 + timedelta(days=d, minutes=15 * q) for d in range(5) for q in range(96)]
    history = [
        Observation(ts, 0.5 * kw)
        for ts, kw in zip(slots, physical.power_series(config, slots))
    ]
    with pytest.raises(InsufficientHistory) as exc:
        PvResidualXgbForecaster(physical=physical).train(
            config, history, T0 + timedelta(days=5)
        )
    assert exc.value.days_collected == 5


def test_pv_residual_corrects_a_systematic_physical_bias():
    # The plant really delivers only half of what the physical model says
    # (shading/soiling). The residual learner must close most of that gap.
    config = _pv_config()
    physical = PhysicalPvForecaster()
    days = 21
    slots = [
        T0 + timedelta(days=d, minutes=15 * q) for d in range(days) for q in range(96)
    ]
    truth = {
        ts: 0.5 * kw for ts, kw in zip(slots, physical.power_series(config, slots))
    }
    history = [Observation(ts, v) for ts, v in truth.items()]
    run_at = T0 + timedelta(days=days)

    challenger = PvResidualXgbForecaster(physical=physical, seed=7)
    report = challenger.train(config, history, run_at)
    assert report.train_rows == len(slots)

    series = challenger.forecast(config, HORIZON_DAY, run_at)
    assert series.model == "pv-residual-xgb"
    target_slots = HORIZON_DAY.slot_starts(run_at)
    actuals = {
        ts: 0.5 * kw
        for ts, kw in zip(target_slots, physical.power_series(config, target_slots))
    }
    physical_forecast = physical.forecast(config, HORIZON_DAY, run_at)

    challenger_mae = forecast_metrics(
        {p.timestamp: p.value_kw for p in series.points}, actuals
    ).mae_kw
    physical_mae = forecast_metrics(
        {p.timestamp: p.value_kw for p in physical_forecast.points}, actuals
    ).mae_kw
    assert physical_mae > 0.1  # the bias is real
    assert challenger_mae < 0.5 * physical_mae  # and mostly corrected
    assert all(p.value_kw >= 0 for p in series.points)
    assert all(p.value_kw <= config.plant.capacity_kwp for p in series.points)


def test_pv_residual_can_never_invent_generation_after_sunset():
    """Nameplate is no physical bound; the clear-sky ceiling is.

    Trained on a plant that ALWAYS makes 1.5 kW - including all night - the
    residual learner happily predicts night generation, because
    ``physical + residual`` is only clipped to capacity. The ceiling
    (:mod:`voltpilot_forecast.pvceiling`) is what makes a set sun mean zero,
    and it binds after the residual rather than before it.
    """
    config = _pv_config()
    physical = PhysicalPvForecaster()
    days = 21
    slots = [
        T0 + timedelta(days=d, minutes=15 * q) for d in range(days) for q in range(96)
    ]
    history = [Observation(ts, 1.5) for ts in slots]
    run_at = T0 + timedelta(days=days)

    challenger = PvResidualXgbForecaster(physical=physical, seed=7)
    challenger.train(config, history, run_at)
    series = challenger.forecast(config, HORIZON_DAY, run_at)

    night = [
        p
        for p in series.points
        if not solar_position(config.location, p.timestamp).is_daytime
    ]
    assert night, "the horizon must contain night slots for this to mean anything"
    assert all(p.value_kw == 0.0 for p in night), (
        "residual generation survived sunset: "
        f"{max(p.value_kw for p in night)} kW"
    )
    # Non-vacuous: the learner really did want to claim it.
    raw = [
        max(0.0, phys + 1.5)
        for phys in physical.power_series(
            config, [p.timestamp for p in night]
        )
    ]
    assert max(raw) > 1.0

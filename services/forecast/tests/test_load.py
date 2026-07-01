"""Tests for the baseline load forecasters (persistence + profile)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from voltpilot_forecast.domain import ForecastKind, Horizon, Observation
from voltpilot_forecast.load import (
    ProfileLoadForecaster,
    SeasonalPersistenceLoadForecaster,
)


def _slot_of_day(ts: datetime) -> int:
    return (ts.hour * 60 + ts.minute) // 15


def _history(start: datetime, end: datetime, value_fn) -> list[Observation]:
    step = timedelta(minutes=15)
    out: list[Observation] = []
    ts = start
    while ts < end:
        out.append(Observation(ts, float(value_fn(ts))))
        ts += step
    return out


def test_persistence_repeats_same_slot_from_previous_day():
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)  # Monday
    # Value depends only on the slot-of-day, so 1-day persistence is exact.
    history = _history(run_at - timedelta(days=2), run_at, _slot_of_day)
    series = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", history, Horizon.hours(24), run_at
    )
    assert series.kind is ForecastKind.LOAD
    assert series.method == "persistence"
    for point in series.points:
        assert point.value_kw == float(_slot_of_day(point.timestamp))


def test_persistence_empty_history_is_flat_zero():
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    series = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", [], Horizon.hours(24), run_at
    )
    assert len(series) == 96
    assert set(series.values) == {0.0}


def test_profile_reproduces_weekday_and_weekend_shape():
    run_at = datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc)  # Monday 00:00

    def value_fn(ts: datetime) -> float:
        base = _slot_of_day(ts)
        return base + (1000 if ts.weekday() >= 5 else 0)

    # Two full weeks so every (weekend?, slot) bucket is populated.
    history = _history(run_at - timedelta(days=14), run_at, value_fn)
    forecaster = ProfileLoadForecaster()

    # Forecast a weekday (Mon) - profile averages to the weekday shape.
    weekday = forecaster.forecast("s", "t", history, Horizon.hours(24), run_at)
    for point in weekday.points:
        assert abs(point.value_kw - _slot_of_day(point.timestamp)) < 1e-6

    # Forecast into a weekend (Sat) - profile picks up the +1000 offset.
    sat = datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)
    weekend = forecaster.forecast("s", "t", history, Horizon.hours(24), sat)
    for point in weekend.points:
        assert abs(point.value_kw - (_slot_of_day(point.timestamp) + 1000)) < 1e-6


def test_profile_empty_history_is_flat_zero():
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    series = ProfileLoadForecaster().forecast(
        "s", "t", [], Horizon.hours(24), run_at
    )
    assert set(series.values) == {0.0}


def test_forecasters_are_interchangeable_behind_the_interface():
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    history = _history(run_at - timedelta(days=3), run_at, _slot_of_day)
    horizon = Horizon.hours(48)
    for forecaster in (
        SeasonalPersistenceLoadForecaster(),
        ProfileLoadForecaster(),
    ):
        series = forecaster.forecast("s", "t", history, horizon, run_at)
        assert len(series) == 192
        assert all(v >= 0.0 for v in series.values)

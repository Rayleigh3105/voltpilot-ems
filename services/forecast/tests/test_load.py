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


def test_persistence_forecasts_the_slot_mean_not_a_single_sample():
    """A quarter-hour forecast is the MEAN of the slot's samples.

    The Pilsting shape (scout report vp-netzbezug-nacht-s3 section 3, link 3):
    telemetry arrives every ~10 s, so a quarter hour holds ~90 samples that swing
    within the slot. Keeping the LAST one made the forecast a random draw - there
    it measured 1.14 kW mean absolute error, 2.26 kW peak, purely from the choice
    of sample.
    """
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    slot = run_at + timedelta(minutes=30) - timedelta(days=1)  # yesterday 06:30

    # 90 samples in one slot: 89 around 10 kW, then a dip to 2 kW at the very end.
    history = [
        Observation(slot + timedelta(seconds=10 * i), 10.0) for i in range(89)
    ]
    history.append(Observation(slot + timedelta(seconds=890), 2.0))
    expected_mean = (89 * 10.0 + 2.0) / 90

    series = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", history, Horizon.hours(24), run_at
    )
    forecast_slot = next(p for p in series.points if p.timestamp == slot + timedelta(days=1))
    assert abs(forecast_slot.value_kw - expected_mean) < 1e-3
    assert forecast_slot.value_kw != 2.0  # not the last raw sample
    assert forecast_slot.value_kw != 10.0  # and not the first one either


def test_persistence_slot_mean_is_independent_of_sample_order():
    """Aggregation, not 'later wins' - so an unsorted history reads the same."""
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    slot = run_at + timedelta(minutes=15) - timedelta(days=1)
    values = [7.0, 12.5, 3.25, 9.0]
    history = [
        Observation(slot + timedelta(minutes=3 * i), v) for i, v in enumerate(values)
    ]
    horizon = Horizon.hours(24)

    ordered = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", history, horizon, run_at
    )
    shuffled = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", list(reversed(history)), horizon, run_at
    )
    assert ordered.values == shuffled.values
    target = slot + timedelta(days=1)
    point = next(p for p in ordered.points if p.timestamp == target)
    assert abs(point.value_kw - sum(values) / len(values)) < 1e-6


def test_persistence_fallback_is_the_last_slot_mean_not_the_last_sample():
    """Slots without a matching history slot fall back to the newest slot MEAN."""
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    slot = run_at - timedelta(minutes=15)  # the newest, and only, observed slot
    history = [Observation(slot, 8.0), Observation(slot + timedelta(minutes=14), 4.0)]

    series = SeasonalPersistenceLoadForecaster().forecast(
        "s", "t", history, Horizon.hours(24), run_at
    )
    # No slot one period back exists anywhere, so every point is the fallback.
    assert set(series.values) == {6.0}


def test_profile_weights_each_historical_slot_equally():
    """Days delivering more samples must not outweigh days delivering fewer."""
    run_at = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)  # Monday
    target_slot = run_at + timedelta(minutes=15)
    history: list[Observation] = []
    # Two prior weekdays, same slot-of-day: a chatty 2 kW day, a quiet 10 kW day.
    chatty = target_slot - timedelta(days=1)
    quiet = target_slot - timedelta(days=2)
    history += [Observation(chatty + timedelta(seconds=10 * i), 2.0) for i in range(80)]
    history += [Observation(quiet + timedelta(seconds=300 * i), 10.0) for i in range(2)]

    series = ProfileLoadForecaster().forecast(
        "s", "t", history, Horizon.hours(24), run_at
    )
    point = next(p for p in series.points if p.timestamp == target_slot)
    assert abs(point.value_kw - 6.0) < 1e-6  # (2 + 10) / 2, not sample-weighted 2.2


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

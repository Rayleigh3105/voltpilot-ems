"""Feature engineering: bucketing, gating currency, leakage-free lag features."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from voltpilot_forecast.domain import Observation
from voltpilot_forecast.features import (
    LOAD_FEATURES,
    FEATURE_LABELS_DE,
    PV_RESIDUAL_FEATURES,
    WeatherHistory,
    bucket_15min,
    build_load_training_set,
    full_days,
    load_feature_row,
    pv_residual_feature_row,
)
from voltpilot_forecast.openmeteo import WeatherPoint

T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)
NO_TEMP = lambda ts: float("nan")  # noqa: E731


def _obs_days(days: int, value=lambda ts: 1.0) -> list[Observation]:
    """Full 15-min telemetry days starting at T0."""
    out = []
    for d in range(days):
        for q in range(96):
            ts = T0 + timedelta(days=d, minutes=15 * q)
            out.append(Observation(ts, value(ts)))
    return out


def test_bucket_15min_averages_within_the_slot():
    obs = [
        Observation(T0, 1.0),
        Observation(T0 + timedelta(minutes=5), 2.0),
        Observation(T0 + timedelta(minutes=10), 3.0),
        Observation(T0 + timedelta(minutes=15), 10.0),
    ]
    by_slot = bucket_15min(obs)
    assert by_slot[T0] == 2.0
    assert by_slot[T0 + timedelta(minutes=15)] == 10.0


def test_full_days_requires_half_the_slots():
    # 47 slots on one day: not a full day; 48 slots: counts.
    sparse = [
        Observation(T0 + timedelta(minutes=15 * q), 1.0) for q in range(47)
    ]
    assert full_days(bucket_15min(sparse)) == 0
    sparse.append(Observation(T0 + timedelta(minutes=15 * 47), 1.0))
    assert full_days(bucket_15min(sparse)) == 1


def test_load_feature_row_lags_and_calendar():
    # value = hour of day, over 9 days -> lags are exact and known.
    history = _obs_days(9, value=lambda ts: float(ts.hour))
    by_slot = bucket_15min(history)
    # Target: noon UTC on the day AFTER the history ends (a real forecast slot).
    target = T0 + timedelta(days=9, hours=12)
    row = load_feature_row(target, by_slot, NO_TEMP)
    feat = dict(zip(LOAD_FEATURES, row))

    assert feat["lag_1d_kw"] == 12.0          # same slot yesterday: hour 12
    assert feat["lag_7d_kw"] == 12.0
    assert feat["same_slot_mean_7d_kw"] == 12.0
    # Mean over the 24h window (t-48h, t-24h]: full day of hourly values.
    assert abs(feat["prev_period_mean_kw"] - 11.5) < 0.01
    assert math.isnan(feat["temperature_c"])  # no weather -> NaN, never a fake 0
    # Calendar is Berlin-local: 12:00 UTC in June = 14:00 Berlin = slot 56.
    assert feat["slot_of_day"] == 56.0
    assert feat["is_holiday"] == 0.0


def test_training_set_drops_rows_without_the_1d_lag():
    history = _obs_days(2)
    by_slot = bucket_15min(history)
    xs, ys = build_load_training_set(by_slot, NO_TEMP)
    # Day 1 has no lag_1d -> only day 2's 96 slots survive.
    assert len(xs) == 96
    assert len(ys) == 96
    assert all(len(x) == len(LOAD_FEATURES) for x in xs)


def test_weather_history_lookup_and_temperature():
    points = [
        WeatherPoint(
            timestamp=T0 + timedelta(hours=h),
            temperature_c=20.0 + h,
            cloud_cover_pct=50.0,
            ghi_w_m2=300.0,
        )
        for h in range(3)
    ]
    weather = WeatherHistory(points)
    # 15-min timestamps resolve to their hour's point.
    assert weather.temperature_at(T0 + timedelta(hours=1, minutes=30)) == 21.0
    assert math.isnan(weather.temperature_at(T0 + timedelta(days=2)))


def test_pv_residual_feature_row_shape_and_weather():
    weather = WeatherHistory(
        [WeatherPoint(timestamp=T0, temperature_c=18.0, cloud_cover_pct=25.0, ghi_w_m2=400.0)]
    )
    row = pv_residual_feature_row(T0 + timedelta(minutes=15), 3.2, weather)
    feat = dict(zip(PV_RESIDUAL_FEATURES, row))
    assert feat["physical_kw"] == 3.2
    assert feat["ghi_w_m2"] == 400.0
    assert feat["cloud_cover_pct"] == 25.0
    assert feat["temperature_c"] == 18.0


def test_every_feature_has_a_german_label():
    for name in (*LOAD_FEATURES, *PV_RESIDUAL_FEATURES):
        assert name in FEATURE_LABELS_DE, name

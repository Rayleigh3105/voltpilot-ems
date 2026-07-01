"""Forecast-fallback tests: the persistence baseline is REUSED from
services/forecast (predict-then-optimize - no duplicated forecasting logic
in the optimizer). Skips when the sibling package is not installed."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip(
    "voltpilot_forecast",
    reason="sibling services/forecast not installed (pip install -e ../forecast)",
)

from voltpilot_optimization.domain import horizon_slot_starts
from voltpilot_optimization.fallback import persistence_forecast

T0 = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def test_repeats_yesterdays_same_slot_value():
    # Two days of 15-min history with a distinctive daily shape: value = hour.
    history = []
    for day in (2, 1):
        day_start = T0 - timedelta(days=day, hours=12)
        for quarter in range(96):
            ts = day_start + quarter * timedelta(minutes=15)
            history.append((ts, float(ts.hour)))
    slot_starts = horizon_slot_starts(T0, 96)
    values = persistence_forecast(history, slot_starts)
    assert len(values) == 96
    for start, value in zip(slot_starts, values):
        assert value == pytest.approx(float(start.hour)), start


def test_empty_history_yields_zeros():
    slot_starts = horizon_slot_starts(T0, 8)
    assert persistence_forecast([], slot_starts) == [0.0] * 8


def test_empty_horizon_yields_empty():
    assert persistence_forecast([(T0, 1.0)], []) == []

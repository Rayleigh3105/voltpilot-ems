import pytest

from voltpilot_forecast.baseline import persistence_forecast


def test_persistence_forecast_repeats_last_value():
    assert persistence_forecast([10.0, 12.0, 11.5], horizon=3) == [11.5, 11.5, 11.5]


def test_persistence_forecast_zero_horizon():
    assert persistence_forecast([1.0], horizon=0) == []


def test_persistence_forecast_rejects_empty_history():
    with pytest.raises(ValueError):
        persistence_forecast([], horizon=3)

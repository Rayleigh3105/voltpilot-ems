"""Tests for the physical PV forecaster and the weather adapter."""

from __future__ import annotations

from datetime import datetime, timezone

from voltpilot_forecast.domain import (
    ForecastKind,
    GeoLocation,
    Horizon,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.weather import (
    ClearSkyWeatherProvider,
    IrradianceSample,
    WeatherProvider,
)

BERLIN = GeoLocation(latitude=52.52, longitude=13.405)


def _config(plant: PlantSpec | None) -> SiteForecastConfig:
    return SiteForecastConfig(
        tenant_id="t", site_id="s", location=BERLIN, plant=plant
    )


def test_pv_series_covers_full_horizon_with_shared_run_at():
    run_at = datetime(2026, 6, 21, 3, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(24)
    series = PhysicalPvForecaster().forecast(
        _config(PlantSpec(capacity_kwp=10.0)), horizon, run_at
    )
    assert series.kind is ForecastKind.PV
    assert len(series) == 96
    assert series.run_at == run_at
    # Slots are the 15-min grid strictly after run_at.
    assert series.points[0].timestamp == datetime(
        2026, 6, 21, 3, 15, tzinfo=timezone.utc
    )


def test_pv_never_exceeds_capacity_and_is_zero_at_night():
    run_at = datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(24)
    cap = 10.0
    series = PhysicalPvForecaster().forecast(
        _config(PlantSpec(capacity_kwp=cap)), horizon, run_at
    )
    values = series.values
    assert max(values) <= cap
    assert min(values) == 0.0
    assert max(values) > 0.0  # some generation during the day

    # A slot around local midnight must be zero.
    midnight_slot = next(
        p for p in series.points if p.timestamp.hour == 23
    )
    assert midnight_slot.value_kw == 0.0


def test_no_plant_yields_all_zero_series():
    run_at = datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)
    series = PhysicalPvForecaster().forecast(_config(None), Horizon.hours(24), run_at)
    assert len(series) == 96
    assert set(series.values) == {0.0}


def test_summer_generates_more_than_winter():
    horizon = Horizon.hours(24)
    plant = PlantSpec(capacity_kwp=10.0)
    forecaster = PhysicalPvForecaster()
    summer = forecaster.forecast(
        _config(plant), horizon, datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)
    )
    winter = forecaster.forecast(
        _config(plant), horizon, datetime(2026, 12, 21, 0, 0, tzinfo=timezone.utc)
    )
    assert sum(summer.values) > sum(winter.values)


def test_method_records_weather_provider_name():
    series = PhysicalPvForecaster().forecast(
        _config(PlantSpec(capacity_kwp=5.0)),
        Horizon.hours(24),
        datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc),
    )
    assert series.method == "clear_sky_v1:clear_sky"


def test_weather_provider_is_swappable():
    """A custom provider (the ACL seam) changes the forecast without code edits."""

    class DoubleGhiProvider(WeatherProvider):
        name = "double"

        def __init__(self) -> None:
            self._inner = ClearSkyWeatherProvider()

        def irradiance(self, location, timestamps):
            return [
                IrradianceSample(ghi_w_m2=s.ghi_w_m2 * 2.0)
                for s in self._inner.irradiance(location, timestamps)
            ]

    run_at = datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(24)
    plant = PlantSpec(capacity_kwp=100.0)  # large so clipping does not mask the diff
    base = PhysicalPvForecaster().forecast(_config(plant), horizon, run_at)
    boosted = PhysicalPvForecaster(weather=DoubleGhiProvider()).forecast(
        _config(plant), horizon, run_at
    )
    assert sum(boosted.values) > sum(base.values)
    assert boosted.method == "clear_sky_v1:double"

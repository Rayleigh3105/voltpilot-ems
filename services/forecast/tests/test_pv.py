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
from voltpilot_forecast.pv import PhysicalPvForecaster, PhysicalPvForecasterLegacyDni
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


# ---- S0 (N1): pv-physical now reads the true DNI; the old reading lives on
# ---- as the never-active comparison candidate pv-physical-legacy-dni ------


def test_legacy_candidate_tags_its_series_with_its_own_model_id():
    series = PhysicalPvForecasterLegacyDni().forecast(
        _config(PlantSpec(capacity_kwp=5.0)),
        Horizon.hours(24),
        datetime(2026, 1, 20, 0, 0, tzinfo=timezone.utc),
    )
    assert series.model == "pv-physical-legacy-dni"
    assert series.method == "clear_sky_v1_legacy_dni:clear_sky"


def test_the_fixed_baseline_recovers_winter_generation_the_legacy_one_lost_to_n1():
    """Same winter GHI/DHI (20.01.2026, report section 4.2) - only the beam
    source differs, so the gap below is exactly what N1 cost before the fix.

    ``pv-physical`` (fed the true DNI) is now the one that recovers the
    winter yield; ``pv-physical-legacy-dni`` (fed the old, mislabeled
    horizontal reading) is kept only so the daily evaluation can keep
    comparing "alt gegen neu gegen gemessen".
    """

    class FixedIrradianceProvider(WeatherProvider):
        name = "fixed"

        def __init__(self, dni: float) -> None:
            self._dni = dni

        def irradiance(self, location, timestamps):
            return [
                IrradianceSample(ghi_w_m2=363.0, dni_w_m2=self._dni, dhi_w_m2=65.0)
                for _ in timestamps
            ]

    location = GeoLocation(48.7, 12.65)
    run_at = datetime(2026, 1, 20, 9, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(6)
    config = SiteForecastConfig(
        tenant_id="t", site_id="s", location=location, plant=PlantSpec(capacity_kwp=100.0)
    )

    legacy = PhysicalPvForecasterLegacyDni(weather=FixedIrradianceProvider(298.0)).forecast(
        config, horizon, run_at
    )
    fixed = PhysicalPvForecaster(weather=FixedIrradianceProvider(826.7)).forecast(
        config, horizon, run_at
    )
    assert legacy.model == "pv-physical-legacy-dni"
    assert fixed.model == "pv-physical"
    assert sum(fixed.values) > 2.0 * sum(legacy.values)


# ---- S4 (firstmate 2026-11-12): Bestandsanlagen bleiben byte-gleich -------


def test_single_face_plants_is_byte_identical_to_the_legacy_single_plant():
    # Form (a): a backfilled unit with its own face (direction/tilt known) -
    # one summand in the new `plants` path must equal the legacy `plant`
    # path exactly, slot for slot (IEEE754 "0.0 + x == x", no rounding).
    run_at = datetime(2026, 6, 21, 3, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(24)
    face = PlantSpec(capacity_kwp=8.4, azimuth_deg=180.0, tilt_deg=30.0)
    legacy = PhysicalPvForecaster().forecast(
        SiteForecastConfig(tenant_id="t", site_id="s", location=BERLIN, plant=face),
        horizon, run_at,
    )
    per_face = PhysicalPvForecaster().forecast(
        SiteForecastConfig(
            tenant_id="t", site_id="s", location=BERLIN, plant=None, plants=(face,)
        ),
        horizon, run_at,
    )
    assert per_face.values == legacy.values


def test_face_without_direction_falls_back_to_dach_defaults_byte_identical():
    # Form (a) variant: a confirmed unit without its own einheit_flaeche row
    # still gets ONE PlantSpec at full capacity with the DACH defaults
    # (south, 30 deg) - the exact same defaults load_sites applies when
    # asset.azimuth_deg/tilt_deg are NULL (forecast_collect.load_sites).
    run_at = datetime(2026, 6, 21, 3, 0, tzinfo=timezone.utc)
    horizon = Horizon.hours(24)
    legacy = PhysicalPvForecaster().forecast(
        SiteForecastConfig(
            tenant_id="t", site_id="s", location=BERLIN, plant=PlantSpec(capacity_kwp=8.4)
        ),
        horizon, run_at,
    )
    per_face = PhysicalPvForecaster().forecast(
        SiteForecastConfig(
            tenant_id="t", site_id="s", location=BERLIN, plant=None,
            plants=(PlantSpec(capacity_kwp=8.4),),
        ),
        horizon, run_at,
    )
    assert per_face.values == legacy.values


def test_clear_sky_ceiling_single_face_is_byte_identical_to_legacy_plant():
    from voltpilot_forecast.pvceiling import clear_sky_ceiling_kw

    at = datetime(2026, 6, 21, 10, 0, tzinfo=timezone.utc)
    face = PlantSpec(capacity_kwp=8.4, azimuth_deg=180.0, tilt_deg=30.0)
    legacy = clear_sky_ceiling_kw(
        SiteForecastConfig(tenant_id="t", site_id="s", location=BERLIN, plant=face), at
    )
    per_face = clear_sky_ceiling_kw(
        SiteForecastConfig(
            tenant_id="t", site_id="s", location=BERLIN, plant=None, plants=(face,)
        ),
        at,
    )
    assert per_face == legacy

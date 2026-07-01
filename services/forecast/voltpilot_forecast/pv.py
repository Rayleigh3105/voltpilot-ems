"""PV generation forecast - physical model (architecture section 12).

v1 is a physical model (irradiance + plant parameters), explicitly *not* ML: the
later "ML correction" stage plugs in behind :class:`PvForecaster` without touching
callers. The physical forecaster gets irradiance from a
:class:`~voltpilot_forecast.weather.WeatherProvider` (the anti-corruption layer),
transposes it onto the array plane and applies a PVWatts-style capacity/derate
model.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    Horizon,
    SiteForecastConfig,
)
from voltpilot_forecast.solar import poa_irradiance, solar_position
from voltpilot_forecast.weather import ClearSkyWeatherProvider, WeatherProvider

STC_IRRADIANCE_W_M2 = 1000.0  # standard-test-condition reference irradiance
DEFAULT_DIFFUSE_FRACTION = 0.15  # clear-sky diffuse share when only GHI is known


class PvForecaster(ABC):
    """Interface for PV generation forecasting over the optimization horizon.

    A future ML-corrected implementation implements this same method, so the
    optimizer and the forecast service never learn which variant they hold.
    """

    method: str = "pv"

    @abstractmethod
    def forecast(
        self, config: SiteForecastConfig, horizon: Horizon, run_at: datetime
    ) -> ForecastSeries:
        raise NotImplementedError


class PhysicalPvForecaster(PvForecaster):
    """Clear-sky/irradiance physical PV model.

    Pipeline per slot: solar position -> irradiance (from the weather adapter) ->
    plane-of-array transposition -> DC power via a linear capacity model with a
    PVWatts-style system derate, clipped to nameplate capacity. A site without a
    configured plant yields an all-zero series (still a valid optimizer input).
    """

    method = "clear_sky_v1"

    def __init__(
        self,
        weather: WeatherProvider | None = None,
        diffuse_fraction: float = DEFAULT_DIFFUSE_FRACTION,
    ) -> None:
        self._weather = weather or ClearSkyWeatherProvider()
        self._diffuse_fraction = diffuse_fraction

    def forecast(
        self, config: SiteForecastConfig, horizon: Horizon, run_at: datetime
    ) -> ForecastSeries:
        timestamps = horizon.slot_starts(run_at)
        method = f"{self.method}:{self._weather.name}"

        if config.plant is None or config.plant.capacity_kwp == 0.0:
            points = [ForecastPoint(ts, 0.0) for ts in timestamps]
            return ForecastSeries(
                kind=ForecastKind.PV,
                site_id=config.site_id,
                tenant_id=config.tenant_id,
                run_at=run_at,
                method=method,
                points=points,
            )

        plant = config.plant
        samples = self._weather.irradiance(config.location, timestamps)
        points: list[ForecastPoint] = []
        for ts, sample in zip(timestamps, samples):
            position = solar_position(config.location, ts)
            poa = poa_irradiance(
                position,
                sample.ghi_w_m2,
                tilt_deg=plant.tilt_deg,
                surface_azimuth_deg=plant.azimuth_deg,
                albedo=plant.albedo,
                diffuse_fraction=self._diffuse_fraction,
                dni_w_m2=sample.dni_w_m2,
                dhi_w_m2=sample.dhi_w_m2,
            )
            dc_kw = plant.capacity_kwp * (poa / STC_IRRADIANCE_W_M2)
            ac_kw = dc_kw * (1.0 - plant.system_loss_fraction)
            ac_kw = max(0.0, min(ac_kw, plant.capacity_kwp))
            points.append(ForecastPoint(ts, round(ac_kw, 4)))

        return ForecastSeries(
            kind=ForecastKind.PV,
            site_id=config.site_id,
            tenant_id=config.tenant_id,
            run_at=run_at,
            method=method,
            points=points,
        )

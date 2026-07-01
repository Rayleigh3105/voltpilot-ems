"""Voltpilot-EMS forecast service.

Responsibility (architecture section 8/12): Last-/PV-Prognose, Features.
Stateless. v1 is deliberately ML-free (architecture section 12):

- **Load**: baseline persistence/profile (:mod:`voltpilot_forecast.load`).
- **PV**: physical clear-sky/irradiance model (:mod:`voltpilot_forecast.pv`),
  fed by a swappable weather adapter (:mod:`voltpilot_forecast.weather`).

Every method sits behind an interface (``LoadForecaster``, ``PvForecaster``,
``WeatherProvider``, ``ForecastRepository``) so the later XGBoost/LightGBM load
model and a real EU-hosted weather API drop in without touching consumers. The
:class:`~voltpilot_forecast.service.ForecastService` façade is what the optimizer
calls; forecasts are exposed as timeseries via the ``forecast`` hypertable
(:class:`~voltpilot_forecast.repository.TimescaleForecastRepository`).
"""

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.load import (
    LoadForecaster,
    ProfileLoadForecaster,
    SeasonalPersistenceLoadForecaster,
)
from voltpilot_forecast.pv import PhysicalPvForecaster, PvForecaster
from voltpilot_forecast.repository import (
    ForecastRepository,
    InMemoryForecastRepository,
    TimescaleForecastRepository,
)
from voltpilot_forecast.service import ForecastService
from voltpilot_forecast.weather import (
    ClearSkyWeatherProvider,
    IrradianceSample,
    WeatherProvider,
)

__version__ = "0.1.0"

__all__ = [
    "ForecastKind",
    "ForecastPoint",
    "ForecastSeries",
    "GeoLocation",
    "Horizon",
    "Observation",
    "PlantSpec",
    "SiteForecastConfig",
    "LoadForecaster",
    "ProfileLoadForecaster",
    "SeasonalPersistenceLoadForecaster",
    "PvForecaster",
    "PhysicalPvForecaster",
    "WeatherProvider",
    "ClearSkyWeatherProvider",
    "IrradianceSample",
    "ForecastRepository",
    "InMemoryForecastRepository",
    "TimescaleForecastRepository",
    "ForecastService",
    "__version__",
]

"""Forecast service orchestrator - the façade the optimizer calls.

Wires the swappable pieces (a :class:`LoadForecaster`, a :class:`PvForecaster`
and an optional :class:`ForecastRepository`) into one call. Defaults give a
fully working v1 with zero configuration: profile load baseline, physical
clear-sky PV, in-memory storage. Swap any part - e.g. inject an XGBoost
``LoadForecaster`` or a real-weather ``PvForecaster`` - without changing callers.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastSeries,
    Horizon,
    Observation,
    SiteForecastConfig,
)
from voltpilot_forecast.load import LoadForecaster, ProfileLoadForecaster
from voltpilot_forecast.pv import PhysicalPvForecaster, PvForecaster
from voltpilot_forecast.repository import (
    ForecastRepository,
    InMemoryForecastRepository,
)


class ForecastService:
    """Produce and (optionally) persist load and PV forecasts for a site."""

    def __init__(
        self,
        load_forecaster: LoadForecaster | None = None,
        pv_forecaster: PvForecaster | None = None,
        repository: ForecastRepository | None = None,
    ) -> None:
        self._load = load_forecaster or ProfileLoadForecaster()
        self._pv = pv_forecaster or PhysicalPvForecaster()
        self._repo = repository or InMemoryForecastRepository()

    @property
    def repository(self) -> ForecastRepository:
        return self._repo

    def forecast_load(
        self,
        config: SiteForecastConfig,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime | None = None,
    ) -> ForecastSeries:
        run_at = _resolve_run_at(run_at)
        series = self._load.forecast(
            config.site_id, config.tenant_id, history, horizon, run_at
        )
        self._repo.save(series)
        return series

    def forecast_pv(
        self,
        config: SiteForecastConfig,
        horizon: Horizon,
        run_at: datetime | None = None,
    ) -> ForecastSeries:
        run_at = _resolve_run_at(run_at)
        series = self._pv.forecast(config, horizon, run_at)
        self._repo.save(series)
        return series

    def forecast_site(
        self,
        config: SiteForecastConfig,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime | None = None,
    ) -> dict[ForecastKind, ForecastSeries]:
        """Produce both forecasts in one run (shared ``run_at``) and store them."""
        run_at = _resolve_run_at(run_at)
        return {
            ForecastKind.LOAD: self.forecast_load(config, history, horizon, run_at),
            ForecastKind.PV: self.forecast_pv(config, horizon, run_at),
        }


def _resolve_run_at(run_at: datetime | None) -> datetime:
    if run_at is not None:
        return run_at
    return datetime.now(timezone.utc)

"""Persistence for the S4 week-ahead HOURLY outlook - the ``forecast_weekly``
hypertable, kept separate from the quarter-hour ``forecast`` table (report
``vp-prognosen-konzept`` section 9: "ab übermorgen einen Ausblick je Stunde
rechnen und GETRENNT von der Viertelstunden-Prognose speichern").

Unlike ``forecast``, this table is NOT compressed and carries RLS (schema
owned by the api Flyway migration, mirroring the ``weather_forecast``
precedent) - the portal reads it through the RLS-scoped app role exactly like
weather. This module only writes it, as the trusted backend role.

Two implementations, the same split as :mod:`voltpilot_forecast.repository`:

- :class:`InMemoryWeeklyForecastRepository` - default, dependency-free.
- :class:`TimescaleWeeklyForecastRepository` - writes via ``psycopg`` (optional
  ``db`` extra).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from voltpilot_forecast.domain import ForecastKind, ForecastSeries, ensure_utc
from voltpilot_forecast.kundenbereich import lebenden_bereich_sperren

logger = logging.getLogger(__name__)


class WeeklyForecastRepository(ABC):
    """Store a week-ahead hourly outlook run (all slots of one kind/model)."""

    @abstractmethod
    def save(self, series: ForecastSeries) -> None:
        """Persist a full outlook run, tagged with its model id."""
        raise NotImplementedError


class InMemoryWeeklyForecastRepository(WeeklyForecastRepository):
    """Non-durable reference implementation keyed by (site_id, kind, model)."""

    def __init__(self) -> None:
        self._store: dict[tuple[str, str, str], ForecastSeries] = {}

    def save(self, series: ForecastSeries) -> None:
        key = (series.site_id, series.kind.value, series.model)
        existing = self._store.get(key)
        if existing is None or ensure_utc(series.run_at) >= ensure_utc(
            existing.run_at
        ):
            self._store[key] = series

    def latest(self, site_id: str, kind: ForecastKind, model: str) -> ForecastSeries | None:
        """Test-only convenience read-back; production reads go through the
        api's RLS-scoped SQL, never this class."""
        return self._store.get((site_id, kind.value, model))


class TimescaleWeeklyForecastRepository(WeeklyForecastRepository):
    """psycopg-backed repository writing into ``forecast_weekly``.

    ``connection`` is a live ``psycopg.Connection`` (caller owns its lifecycle).
    """

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def save(self, series: ForecastSeries) -> None:
        run_at = ensure_utc(series.run_at)
        rows = [
            (
                ensure_utc(point.timestamp),
                series.tenant_id,
                series.site_id,
                series.kind.value,
                series.model,
                point.value_kw,
                run_at,
                series.method,
            )
            for point in series.points
        ]
        if not rows:
            return
        with self._conn.cursor() as cur:
            if not lebenden_bereich_sperren(cur, series.tenant_id):
                logger.info(
                    "forecast_weekly.bereich_ausgelassen site=%s model=%s",
                    series.site_id,
                    series.model,
                )
                self._conn.commit()
                return
            cur.executemany(
                """
                INSERT INTO forecast_weekly (
                    time, tenant_id, site_id, kind, model, value_kw,
                    run_at, method
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (site_id, kind, model, run_at, time)
                DO UPDATE SET value_kw = EXCLUDED.value_kw,
                              method = EXCLUDED.method
                """,
                rows,
            )
        self._conn.commit()

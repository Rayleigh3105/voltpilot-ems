"""Persistence for :class:`WeatherForecast` into the ``weather_forecast`` hypertable.

Weather forecasts are timeseries, so they live in a TimescaleDB hypertable
(schema owned by the api Flyway migration - the api owns tenant-scoped tables and
their RLS policies, and the ``weather_forecast`` table carries a ``tenant_id`` so
the portal reads are RLS-scoped exactly like telemetry). This collector writes as
the trusted backend role (superuser in dev, bypassing RLS) and stamps each row's
tenant_id from the owning site.

Like the forecast repository, this defines a small interface so callers/tests can
swap an in-memory fake for the psycopg-backed writer, which lazy-imports psycopg
(optional ``db`` extra).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from voltpilot_forecast.domain import ensure_utc
from voltpilot_forecast.kundenbereich import lebenden_bereich_sperren
from voltpilot_forecast.openmeteo import WeatherForecast, WeatherPoint

logger = logging.getLogger(__name__)


class WeatherForecastRepository(ABC):
    """Store a weather run and read back the latest run for a site."""

    @abstractmethod
    def save(self, forecast: WeatherForecast) -> int:
        """Persist every hourly point; return the number of rows written."""
        raise NotImplementedError

    @abstractmethod
    def latest(self, site_id: str) -> WeatherForecast | None:
        """Return the most recently issued forecast for ``site_id``."""
        raise NotImplementedError


class InMemoryWeatherForecastRepository(WeatherForecastRepository):
    """Non-durable reference implementation keyed by site_id (latest run wins)."""

    def __init__(self) -> None:
        self._store: dict[str, WeatherForecast] = {}
        self.rows: list[tuple] = []

    def save(self, forecast: WeatherForecast) -> int:
        existing = self._store.get(forecast.site_id)
        if existing is None or ensure_utc(forecast.run_at) >= ensure_utc(
            existing.run_at
        ):
            self._store[forecast.site_id] = forecast
        for p in forecast.points:
            self.rows.append(
                (forecast.site_id, p.timestamp.isoformat(), p.temperature_c,
                 p.cloud_cover_pct, p.ghi_w_m2)
            )
        return len(forecast.points)

    def latest(self, site_id: str) -> WeatherForecast | None:
        return self._store.get(site_id)


_UPSERT_SQL = """
INSERT INTO weather_forecast (
    time, tenant_id, site_id, run_at,
    temperature_c, cloud_cover_pct, ghi_w_m2, dni_w_m2, dhi_w_m2, source
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (site_id, run_at, time)
DO UPDATE SET
    temperature_c   = EXCLUDED.temperature_c,
    cloud_cover_pct = EXCLUDED.cloud_cover_pct,
    ghi_w_m2        = EXCLUDED.ghi_w_m2,
    dni_w_m2        = EXCLUDED.dni_w_m2,
    dhi_w_m2        = EXCLUDED.dhi_w_m2,
    source          = EXCLUDED.source;
"""

_LATEST_RUN_SQL = "SELECT max(run_at) FROM weather_forecast WHERE site_id = %s"

_LATEST_POINTS_SQL = """
SELECT time, temperature_c, cloud_cover_pct, ghi_w_m2, dni_w_m2, dhi_w_m2,
       tenant_id, source
FROM weather_forecast
WHERE site_id = %s AND run_at = %s
ORDER BY time
"""


class TimescaleWeatherForecastRepository(WeatherForecastRepository):
    """psycopg-backed repository writing into ``weather_forecast``.

    ``connection`` is a live ``psycopg.Connection`` (caller owns its lifecycle).
    """

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def save(self, forecast: WeatherForecast) -> int:
        run_at = ensure_utc(forecast.run_at)
        rows = [
            (
                ensure_utc(p.timestamp),
                forecast.tenant_id,
                forecast.site_id,
                run_at,
                p.temperature_c,
                p.cloud_cover_pct,
                p.ghi_w_m2,
                p.dni_w_m2,
                p.dhi_w_m2,
                forecast.source,
            )
            for p in forecast.points
        ]
        if not rows:
            return 0
        with self._conn.cursor() as cur:
            if not lebenden_bereich_sperren(cur, forecast.tenant_id):
                logger.info(
                    "weather.bereich_ausgelassen",
                    extra={"context": {"site_id": forecast.site_id}},
                )
                self._conn.commit()
                return 0
            cur.executemany(_UPSERT_SQL, rows)
        self._conn.commit()
        return len(rows)

    def latest(self, site_id: str) -> WeatherForecast | None:
        with self._conn.cursor() as cur:
            cur.execute(_LATEST_RUN_SQL, (site_id,))
            row = cur.fetchone()
            if row is None or row[0] is None:
                return None
            run_at = row[0]
            cur.execute(_LATEST_POINTS_SQL, (site_id, run_at))
            fetched = cur.fetchall()
        if not fetched:
            return None
        points = tuple(
            WeatherPoint(
                timestamp=r[0],
                temperature_c=None if r[1] is None else float(r[1]),
                cloud_cover_pct=None if r[2] is None else float(r[2]),
                ghi_w_m2=None if r[3] is None else float(r[3]),
                dni_w_m2=None if r[4] is None else float(r[4]),
                dhi_w_m2=None if r[5] is None else float(r[5]),
            )
            for r in fetched
        )
        return WeatherForecast(
            tenant_id=str(fetched[0][6]),
            site_id=site_id,
            latitude=0.0,
            longitude=0.0,
            run_at=run_at,
            points=points,
            source=fetched[0][7],
        )

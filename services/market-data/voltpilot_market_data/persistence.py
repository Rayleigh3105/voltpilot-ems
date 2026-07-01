"""Persist a :class:`PriceSeries` into the TimescaleDB ``day_ahead_prices``
hypertable.

Day-ahead prices are *timeseries* data, so they live in a hypertable (schema
owned by the Flyway migration under ``db/migration/`` - see AGENTS.md), not in a
relational table. Prices are market-wide **per bidding zone**, not per tenant, so
there is no ``tenant_id`` here (unlike telemetry): every tenant in a zone shares
the same public spot price.

The repository is defined as a small protocol so callers (and tests) can swap in
an in-memory fake. The psycopg-backed implementation lazy-imports ``psycopg`` so
the package imports cleanly without a DB driver installed.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Protocol

from voltpilot_market_data.model import PricePoint, PriceSeries, resolution_minutes

logger = logging.getLogger("voltpilot.market_data.persistence")


class DayAheadPriceRepository(Protocol):
    """Sink for (and last-good source of) fetched price series."""

    def upsert_series(self, series: PriceSeries) -> int:
        """Persist every point; return the number of rows written."""
        ...

    def latest_series(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries | None:
        """Return the stored series for ``zone`` over ``[start, end)``.

        Used to prime the resilient source's last-good cache before a fetch, so
        a short-lived cron run still has a fallback during an ENTSO-E outage.
        Returns ``None`` when nothing is stored for that window.
        """
        ...


class InMemoryPriceRepository:
    """Test/double repository: keeps the last series per zone in memory."""

    def __init__(self) -> None:
        self.by_zone: dict[str, PriceSeries] = {}
        self.rows: list[tuple[str, str, str, float]] = []

    def upsert_series(self, series: PriceSeries) -> int:
        self.by_zone[series.zone] = series
        for point in series.points:
            self.rows.append(
                (
                    series.zone,
                    series.resolution,
                    point.start.isoformat(),
                    point.price_eur_mwh,
                )
            )
        return len(series.points)

    def latest_series(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries | None:
        series = self.by_zone.get(zone)
        if series is None or series.start != start:
            return None
        return series


_UPSERT_SQL = """
INSERT INTO day_ahead_prices
    (ts, bidding_zone, resolution, price_eur_mwh, currency, source, fetched_at)
VALUES (%s, %s, %s, %s, %s, %s, now())
ON CONFLICT (bidding_zone, resolution, ts)
DO UPDATE SET
    price_eur_mwh = EXCLUDED.price_eur_mwh,
    currency      = EXCLUDED.currency,
    source        = EXCLUDED.source,
    fetched_at    = now();
"""


_LATEST_SERIES_SQL = """
SELECT ts, resolution, price_eur_mwh, currency, source
FROM day_ahead_prices
WHERE bidding_zone = %s AND ts >= %s AND ts < %s
ORDER BY ts;
"""


class TimescaleDayAheadPriceRepository:
    """psycopg-backed repository writing into ``day_ahead_prices``.

    ``dsn`` is a libpq connection string / URL, typically built from the same
    ``POSTGRES_*`` env the rest of the stack uses.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_series(self, series: PriceSeries) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = [
            (
                point.start,
                series.zone,
                series.resolution,
                point.price_eur_mwh,
                series.currency,
                series.source,
            )
            for point in series.points
        ]
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        logger.info(
            "persist.ok",
            extra={"context": {"zone": series.zone, "rows": len(rows)}},
        )
        return len(rows)

    def latest_series(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries | None:
        import psycopg  # lazy: optional [db] extra

        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(_LATEST_SERIES_SQL, (zone, start, end))
                rows = cur.fetchall()
        if not rows:
            return None

        resolution = rows[0][1]
        slot = timedelta(minutes=resolution_minutes(resolution))
        points = tuple(
            PricePoint(
                start=ts,
                end=ts + slot,
                price_eur_mwh=float(price),
            )
            for ts, _res, price, _currency, _source in rows
        )
        return PriceSeries(
            zone=zone,
            resolution=resolution,
            currency=rows[0][3],
            points=points,
            source=rows[0][4],
        )

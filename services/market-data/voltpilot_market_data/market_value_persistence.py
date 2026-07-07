"""Persist :class:`MonthlyMarketValue` rows into ``monthly_market_value``.

Market values are market-wide per technology (like ``day_ahead_prices``):
deliberately NO tenant_id, NO RLS. Unlike prices this is NOT a hypertable - a
technology gains twelve rows per YEAR, so time partitioning would be pure
overhead; a plain table with PK ``(technology, month)`` is the honest shape
(the migration header documents the same decision).

Upsert rule (load-bearing): a PUBLISHED value always overwrites, a PROVISIONAL
value never overwrites a published one. That makes the refresh idempotent in
any order - the provisional writer cannot clobber the official number even if
the two race.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Iterable, Protocol

from voltpilot_market_data.market_value import MonthlyMarketValue

logger = logging.getLogger("voltpilot.market_data.market_value_persistence")


class MarketValueRepository(Protocol):
    """Sink for monthly market values + the read the refresh loop needs."""

    def upsert_values(self, values: Iterable[MonthlyMarketValue]) -> int:
        """Persist values under the published-beats-provisional rule; return
        the number of rows written (skipped provisional-over-published rows do
        not count)."""
        ...

    def latest_published_month(self, technology: str) -> date | None:
        """The newest month holding a NON-provisional value, or ``None``."""
        ...


class InMemoryMarketValueRepository:
    """Test double keeping rows keyed by (technology, month)."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, date], MonthlyMarketValue] = {}

    def upsert_values(self, values: Iterable[MonthlyMarketValue]) -> int:
        written = 0
        for value in values:
            key = (value.technology, value.month)
            existing = self.rows.get(key)
            if existing is not None and not existing.provisional and value.provisional:
                continue
            self.rows[key] = value
            written += 1
        return written

    def latest_published_month(self, technology: str) -> date | None:
        months = [
            row.month
            for row in self.rows.values()
            if row.technology == technology and not row.provisional
        ]
        return max(months) if months else None


_UPSERT_SQL = """
INSERT INTO monthly_market_value
    (month, technology, value_ct_kwh, provisional, source, fetched_at)
VALUES (%s, %s, %s, %s, %s, now())
ON CONFLICT (technology, month)
DO UPDATE SET
    value_ct_kwh = EXCLUDED.value_ct_kwh,
    provisional  = EXCLUDED.provisional,
    source       = EXCLUDED.source,
    fetched_at   = now()
WHERE monthly_market_value.provisional OR NOT EXCLUDED.provisional;
"""

_LATEST_PUBLISHED_SQL = """
SELECT max(month) FROM monthly_market_value
WHERE technology = %s AND NOT provisional;
"""


class TimescaleMarketValueRepository:
    """psycopg-backed repository writing into ``monthly_market_value``."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_values(self, values: Iterable[MonthlyMarketValue]) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = [
            (v.month, v.technology, v.value_ct_kwh, v.provisional, v.source)
            for v in values
        ]
        if not rows:
            return 0
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        logger.info(
            "market_value_persist.ok", extra={"context": {"rows": len(rows)}}
        )
        return len(rows)

    def latest_published_month(self, technology: str) -> date | None:
        import psycopg  # lazy: optional [db] extra

        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(_LATEST_PUBLISHED_SQL, (technology,))
                row = cur.fetchone()
        return row[0] if row else None

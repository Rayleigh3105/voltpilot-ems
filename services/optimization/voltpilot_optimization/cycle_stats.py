"""Persist how long the last optimization cycle took.

The engine plans SEQUENTIALLY over every battery site (``engine.run_cycle``).
At 100 sites a cycle finishes in ~40-60 s, at 1.000 in ~5-8 min - still inside
the 15-min cadence, but without reserve. There was no metric for it (scout
``vp-scale-readiness-p4`` §5.4/§6.3): the tipping of the cadence would only show
up as *plan age* growing, i.e. once plans already go stale.

This writes the one number you see it BEFORE that: the wall-clock duration of
the last completed cycle, into the single-row ``optimizer_cycle_stat`` table
(api migration ``V20260859000000``). The api's ``/metrics`` collector reads that
row and exposes ``voltpilot_optimizer_cycle_seconds`` - so the signal rides the
*existing* metrics collector, no second ``/metrics`` endpoint and no new
dependency in this Python service.

ONE row, not a history: the question is "how long did the LAST cycle take", not
"how did it trend" (that would be a time series and would grow). The psycopg
implementation upserts on the fixed key ``id = 1``.

The write is BEST-EFFORT and never sinks a cycle: a monitoring write that fails
must not stop the fleet from being planned. The caller (``cli._run_one``)
catches and logs; the engine itself never touches this module.

Schema is owned by the api Flyway migration; the optimizer writes as the
trusted backend role (``POSTGRES_USER``, which owns the table) - the same
pattern as ``persistence.ScheduleRepository``. The psycopg implementation
lazy-imports the driver (optional ``db`` extra), mirroring the sibling
repositories.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

logger = logging.getLogger("voltpilot.optimization.cycle_stats")


@dataclass(frozen=True)
class CycleStat:
    """One completed cycle, as the metric sees it.

    ``finished_at`` is the anchor the api turns into
    ``voltpilot_optimizer_cycle_age_seconds`` at scrape time - so a dead
    optimizer shows a GROWING age instead of a frozen (healthy-looking)
    duration, the same honesty rule the fleet collector uses.
    """

    finished_at: datetime
    duration_seconds: float
    sites_planned: int
    sites_skipped: int
    horizon_slots: int | None = None


class CycleStatsRepository(Protocol):
    """Sink for the last cycle's stats."""

    def record(self, stat: CycleStat) -> None:
        """Persist the last cycle idempotently (single row)."""
        ...


class InMemoryCycleStatsRepository:
    """Test/double repository: keeps only the most recent stat."""

    def __init__(self) -> None:
        self.last: CycleStat | None = None

    def record(self, stat: CycleStat) -> None:
        self.last = stat


# Single-row upsert: the fixed key id=1 is enforced by the table's CHECK, so a
# second cycle overwrites the first instead of accumulating rows.
_UPSERT_SQL = """
INSERT INTO optimizer_cycle_stat
    (id, finished_at, duration_seconds, sites_planned, sites_skipped, horizon_slots)
VALUES (1, %s, %s, %s, %s, %s)
ON CONFLICT (id) DO UPDATE SET
    finished_at = EXCLUDED.finished_at,
    duration_seconds = EXCLUDED.duration_seconds,
    sites_planned = EXCLUDED.sites_planned,
    sites_skipped = EXCLUDED.sites_skipped,
    horizon_slots = EXCLUDED.horizon_slots
"""


def stat_row(stat: CycleStat) -> tuple:
    """The bind tuple for :data:`_UPSERT_SQL` - pure, so a test needs no driver."""
    return (
        stat.finished_at,
        float(stat.duration_seconds),
        int(stat.sites_planned),
        int(stat.sites_skipped),
        None if stat.horizon_slots is None else int(stat.horizon_slots),
    )


class TimescaleCycleStatsRepository:
    """psycopg-backed repository writing the single ``optimizer_cycle_stat`` row.

    ``dsn`` is the same libpq string the rest of the optimizer uses (the trusted
    backend role - see module docstring).
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def record(self, stat: CycleStat) -> None:
        import psycopg  # lazy: optional [db] extra

        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(_UPSERT_SQL, stat_row(stat))
            conn.commit()
        logger.info(
            "cycle_stats.ok",
            extra={
                "context": {
                    "duration_seconds": round(stat.duration_seconds, 3),
                    "sites_planned": stat.sites_planned,
                    "sites_skipped": stat.sites_skipped,
                }
            },
        )

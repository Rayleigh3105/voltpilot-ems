"""Fetch orchestration and the next-day window helper.

Glues the pieces the scheduled/manual entrypoint needs: compute the delivery-day
window in market-local time, fetch through the resilient source, and (optionally)
persist. Kept separate from the CLI so it is unit-testable and reusable by a
future in-process scheduler or a Spring/api-triggered job.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from voltpilot_market_data.model import PriceSeries
from voltpilot_market_data.persistence import DayAheadPriceRepository
from voltpilot_market_data.source import DayAheadPriceSource

logger = logging.getLogger("voltpilot.market_data.service")

# DE-LU/AT day-ahead delivery days are defined in Central European (market) time;
# ENTSO-E expects/returns UTC bounds. CH shares the same clock.
MARKET_TZ = ZoneInfo("Europe/Berlin")


def delivery_day_window(
    day: date, tz: ZoneInfo = MARKET_TZ
) -> tuple[datetime, datetime]:
    """UTC ``[start, end)`` covering the local delivery ``day`` (00:00-24:00)."""
    start_local = datetime.combine(day, time(0, 0), tzinfo=tz)
    end_local = datetime.combine(day + timedelta(days=1), time(0, 0), tzinfo=tz)
    return start_local, end_local


def next_delivery_day(today: date) -> date:
    """The day ENTSO-E publishes around 12:45 - i.e. tomorrow's prices."""
    return today + timedelta(days=1)


@dataclass
class FetchResult:
    series: PriceSeries
    rows_written: int


# Backfill chunk size: energy-charts serves arbitrary ranges, so a year is
# four quarter-sized calls (verified in the vp-sim-design-t6 scout run).
BACKFILL_CHUNK_DAYS = 92


def backfill_range(
    source: DayAheadPriceSource,
    zone: str,
    first_day: date,
    last_day: date,
    repository: DayAheadPriceRepository | None = None,
    tz: ZoneInfo = MARKET_TZ,
) -> list[FetchResult]:
    """Fetch + persist a whole historical day range (both bounds inclusive),
    chunked into :data:`BACKFILL_CHUNK_DAYS` windows.

    The Ersparnis-Simulation's prerequisite: ``day_ahead_prices`` only grows
    forward (the collector fetches today+tomorrow), so a reference year must
    be backfilled once per zone. The upsert is idempotent - re-running a
    backfill (or overlapping the collector's rows) never duplicates or
    corrupts anything; collector rows are simply overwritten with the same
    values.
    """
    if last_day < first_day:
        raise ValueError("backfill range is empty (--to before --from)")
    results: list[FetchResult] = []
    chunk_start = first_day
    while chunk_start <= last_day:
        chunk_end = min(chunk_start + timedelta(days=BACKFILL_CHUNK_DAYS - 1), last_day)
        start, _ = delivery_day_window(chunk_start, tz)
        _, end = delivery_day_window(chunk_end, tz)
        logger.info(
            "backfill.chunk",
            extra={
                "context": {
                    "zone": zone,
                    "from": chunk_start.isoformat(),
                    "to": chunk_end.isoformat(),
                }
            },
        )
        series = source.fetch_day_ahead_prices(zone, start, end)
        rows = repository.upsert_series(series) if repository is not None else 0
        results.append(FetchResult(series=series, rows_written=rows))
        chunk_start = chunk_end + timedelta(days=1)
    return results


def fetch_and_store(
    source: DayAheadPriceSource,
    zone: str,
    day: date,
    repository: DayAheadPriceRepository | None = None,
    tz: ZoneInfo = MARKET_TZ,
) -> FetchResult:
    """Fetch ``zone`` prices for delivery ``day`` and optionally persist them."""
    start, end = delivery_day_window(day, tz)
    logger.info(
        "fetch_and_store.start",
        extra={"context": {"zone": zone, "day": day.isoformat()}},
    )
    # Prime the resilient source's last-good cache from the DB so a short-lived
    # cron run still has a same-window fallback if ENTSO-E is down right now.
    prime = getattr(source, "prime_cache", None)
    if repository is not None and callable(prime):
        last_good = repository.latest_series(zone, start, end)
        if last_good is not None:
            prime(last_good)
    series = source.fetch_day_ahead_prices(zone, start, end)
    rows = repository.upsert_series(series) if repository is not None else 0
    return FetchResult(series=series, rows_written=rows)

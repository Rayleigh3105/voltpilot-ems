"""Reference-year data assembly: slot grid, spot prices, Monatsmarktwerte.

The simulation is DB-only and deterministic once the reference year's
day-ahead prices are backfilled (``python -m voltpilot_market_data backfill
--year <YYYY> --persist``, see services/market-data). Prices are read exactly
like the production optimizer (:mod:`voltpilot_optimization.inputs`): PT15M
rows map 1:1, PT60M rows expand to their four quarter hours, 15-min wins
where both are stored.

Gap policy: single missing slots up to :data:`MAX_GAP_SLOTS` (3 h) are filled
with the last known price (market data hiccups happen); anything larger
fails the job with a German message naming the backfill command - never a
silently invented price year.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")

SLOT_MINUTES = 15
SLOTS_PER_DAY = 96

# Fill price gaps up to 3 hours (12 slots) with the last known price.
MAX_GAP_SLOTS = 12

# The year must be essentially fully priced (>= 98% before gap filling).
MIN_COVERAGE = 0.98


class MissingPricesError(RuntimeError):
    """The reference year is not (sufficiently) present in day_ahead_prices."""


def year_slot_starts(year: int) -> list[datetime]:
    """The 15-min slot grid of the Berlin calendar ``year`` in UTC: from
    Jan 1 00:00 Berlin to the next Jan 1 00:00 Berlin (DST cancels out, so a
    non-leap year has exactly 35,040 slots)."""
    start = datetime(year, 1, 1, tzinfo=BERLIN)
    end = datetime(year + 1, 1, 1, tzinfo=BERLIN)
    slots = int((end - start).total_seconds() // (SLOT_MINUTES * 60))
    first = start.astimezone(ZoneInfo("UTC"))
    return [first + i * timedelta(minutes=SLOT_MINUTES) for i in range(slots)]


def expand_price_rows(
    rows: list[tuple[datetime, str, float]], slot_starts: list[datetime]
) -> list[float]:
    """Rows of ``(ts, resolution, price)`` -> one price per slot start.

    The production expansion rule (inputs._load_prices): PT60M covers four
    quarter hours, PT15M one; 15-min wins where both resolutions exist.
    Gaps are filled per the module docstring; insufficient coverage raises
    :class:`MissingPricesError`.
    """
    by_slot: dict[datetime, float] = {}
    for resolution_pass in ("PT60M", "PT15M"):  # 15-min wins
        for ts, resolution, price in rows:
            if resolution != resolution_pass:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=ZoneInfo("UTC"))
            slots_covered = 4 if resolution == "PT60M" else 1
            for i in range(slots_covered):
                by_slot[ts + i * timedelta(minutes=SLOT_MINUTES)] = float(price)

    covered = sum(1 for s in slot_starts if s in by_slot)
    coverage = covered / len(slot_starts)
    if coverage < MIN_COVERAGE:
        year = slot_starts[0].astimezone(BERLIN).year
        raise MissingPricesError(
            f"Für das Jahr {year} liegen nur {coverage:.0%} der Börsenpreise vor. "
            "Bitte zuerst die Preishistorie laden: "
            f"'python -m voltpilot_market_data backfill --year {year} --persist'."
        )

    prices: list[float] = []
    last: float | None = None
    gap = 0
    for start in slot_starts:
        price = by_slot.get(start)
        if price is None:
            gap += 1
            if last is None or gap > MAX_GAP_SLOTS:
                year = slot_starts[0].astimezone(BERLIN).year
                raise MissingPricesError(
                    f"Die Börsenpreise des Jahres {year} haben eine Lücke von mehr "
                    f"als {MAX_GAP_SLOTS * SLOT_MINUTES // 60} Stunden um "
                    f"{start.isoformat()}. Bitte die Preishistorie neu laden: "
                    f"'python -m voltpilot_market_data backfill --year {year} "
                    "--persist'."
                )
            price = last
        else:
            gap = 0
        prices.append(price)
        last = price
    return prices


def load_year_prices(dsn: str, zone: str, slot_starts: list[datetime]) -> list[float]:
    """The reference year's spot series from ``day_ahead_prices``."""
    import psycopg  # lazy: optional [db] extra

    start, end = slot_starts[0], slot_starts[-1]
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT ts, resolution, price_eur_mwh
            FROM day_ahead_prices
            WHERE bidding_zone = %s AND ts >= %s AND ts <= %s
            ORDER BY ts
            """,
            (zone, start - timedelta(minutes=45), end),
        )
        rows = [(ts, str(res), float(price)) for ts, res, price in cur.fetchall()]
    return expand_price_rows(rows, slot_starts)


def load_market_values(dsn: str, months: list) -> dict:
    """Monatsmarktwert Solar (ct/kWh) for the given first-of-month dates -
    the same query the production optimizer uses; absent months mean no
    premium for their slots (the pricing layer flags them)."""
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT month, value_ct_kwh FROM monthly_market_value
            WHERE technology = 'solar' AND month = ANY(%s)
            """,
            (months,),
        )
        return {month: float(value) for month, value in cur.fetchall()}

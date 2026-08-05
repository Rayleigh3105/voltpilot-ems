"""Monatsmarktwert refresh orchestration (published + provisional).

One call refreshes everything the earnings math needs:

  1. fetch the PUBLISHED solar market values for the previous and the current
     year from the source (two cheap requests; two years keep the api's
     range=year queries covered) and upsert them,
  2. for every month after the last published one up to and including the
     running month, compute the PROVISIONAL value from the stored DE-LU
     day-ahead prices, weighted by the Germany-wide solar generation of the
     same intervals (the official Anlage 1 Nr. 2.2 EEG 2023 formula - see
     :func:`voltpilot_market_data.market_value.provisional_solar_market_value`)
     and upsert it flagged ``provisional``.

The generation series is FETCHED PER MONTH here rather than persisted: it is
consumed immediately and no other consumer reads it, so a hypertable would be
pure overhead (rationale in
:mod:`voltpilot_market_data.solar_generation`). Without a ``generation_source``
- or when every source fails - the computation degrades to the weather-blind
clear-sky shape, which is the documented last resort, never a fabricated value.

The published upsert overwrites yesterday's provisional row the moment the
TSOs publish (the repository's published-beats-provisional rule keeps the
reverse impossible). A month with no stored prices yields NO provisional row -
the earnings then honestly credit no premium for it rather than inventing one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from voltpilot_market_data.market_value import (
    CLEAR_SKY_WEIGHTING,
    MARKET_TZ,
    TECHNOLOGY_SOLAR,
    MarketValueSource,
    MonthlyMarketValue,
    provisional_solar_market_value_weighted_by,
)
from voltpilot_market_data.market_value_persistence import MarketValueRepository
from voltpilot_market_data.persistence import DayAheadPriceRepository
from voltpilot_market_data.solar_generation import (
    SolarGenerationSeries,
    SolarGenerationSource,
    SolarGenerationSourceError,
)

logger = logging.getLogger("voltpilot.market_data.market_value_service")

# The provisional value approximates the GERMAN market value, so it always
# derives from DE-LU prices regardless of the serve loop's --zone.
PROVISIONAL_PRICE_ZONE = "DE-LU"
PROVISIONAL_SOURCE_TAG = "voltpilot-provisional"


@dataclass
class MarketValueRefreshResult:
    published_rows: int = 0
    provisional_rows: int = 0
    provisional_months: list[date] = field(default_factory=list)
    # Which quantity actually weighted each provisional month - the adapter's
    # source tag, or "clear-sky" when the chain fell all the way through. Kept
    # so the CLI/serve output says HOW exact today's value is.
    provisional_weighting: dict[date, str] = field(default_factory=dict)


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _next_month(month: date) -> date:
    return (month.replace(day=28) + timedelta(days=4)).replace(day=1)


def _month_window_utc(month: date, tz: ZoneInfo = MARKET_TZ) -> tuple[datetime, datetime]:
    """UTC ``[start, end)`` of the German calendar ``month``."""
    start_local = datetime.combine(month, time(0, 0), tzinfo=tz)
    end_local = datetime.combine(_next_month(month), time(0, 0), tzinfo=tz)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _solar_generation_for(
    generation_source: SolarGenerationSource | None,
    month: date,
    start: datetime,
    end: datetime,
) -> SolarGenerationSeries | None:
    """Fetch the month's generation series; ``None`` degrades to clear-sky.

    A generation outage must never sink the refresh: the provisional value has
    a documented last resort, and the official value overwrites it anyway.
    """
    if generation_source is None:
        return None
    try:
        return generation_source.fetch_solar_generation(start, end)
    except SolarGenerationSourceError as exc:
        logger.warning(
            "market_value.provisional.generation_unavailable",
            extra={"context": {"month": month.isoformat(), "error": str(exc)}},
        )
        return None


def refresh_market_values(
    source: MarketValueSource,
    market_value_repository: MarketValueRepository,
    price_repository: DayAheadPriceRepository | None,
    today: date | None = None,
    generation_source: SolarGenerationSource | None = None,
) -> MarketValueRefreshResult:
    """Refresh published + provisional solar market values (see module doc)."""
    today = today or datetime.now(MARKET_TZ).date()
    result = MarketValueRefreshResult()

    published: list[MonthlyMarketValue] = []
    for year in (today.year - 1, today.year):
        published.extend(source.fetch_monthly_market_values(year))
    result.published_rows = market_value_repository.upsert_values(published)

    published_months = {v.month for v in published}
    current_month = _month_start(today)
    # First candidate: the month after the newest published one (fetched or
    # already stored), never earlier than the previous month - older gaps have
    # no stored prices to compute from anyway.
    newest_published = max(published_months) if published_months else None
    stored_published = market_value_repository.latest_published_month(TECHNOLOGY_SOLAR)
    if stored_published and (not newest_published or stored_published > newest_published):
        newest_published = stored_published

    month = _next_month(newest_published) if newest_published else current_month
    provisional: list[MonthlyMarketValue] = []
    while month <= current_month:
        if price_repository is None:
            break
        start, end = _month_window_utc(month)
        series = price_repository.latest_series(PROVISIONAL_PRICE_ZONE, start, end)
        generation = (
            _solar_generation_for(generation_source, month, start, end)
            if series is not None
            else None
        )
        value, weighting = (
            provisional_solar_market_value_weighted_by(series.points, month, generation)
            if series is not None
            else (None, CLEAR_SKY_WEIGHTING)
        )
        if value is None:
            logger.info(
                "market_value.provisional.skipped_no_prices",
                extra={"context": {"month": month.isoformat()}},
            )
        else:
            provisional.append(
                MonthlyMarketValue(
                    month=month,
                    technology=TECHNOLOGY_SOLAR,
                    value_ct_kwh=round(value, 3),
                    provisional=True,
                    source=PROVISIONAL_SOURCE_TAG,
                )
            )
            result.provisional_months.append(month)
            result.provisional_weighting[month] = weighting
        month = _next_month(month)

    result.provisional_rows = market_value_repository.upsert_values(provisional)
    return result

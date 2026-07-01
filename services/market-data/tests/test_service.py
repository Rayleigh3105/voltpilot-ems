"""Window computation and the fetch_and_store orchestration (offline)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from urllib.parse import unquote, urlparse

from voltpilot_market_data.cli import _dsn_from_env
from voltpilot_market_data.entsoe import (
    EntsoeConfig,
    EntsoeDayAheadPriceSource,
)
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.model import PricePoint, PriceSeries
from voltpilot_market_data.persistence import InMemoryPriceRepository
from voltpilot_market_data.resilience import ResilientPriceSource, RetryPolicy
from voltpilot_market_data.service import (
    delivery_day_window,
    fetch_and_store,
    next_delivery_day,
)
from voltpilot_market_data.source import (
    DayAheadPriceSource,
    PriceSourceUnavailable,
)

from tests.conftest import FakeHttpClient


class _AlwaysDownSource(DayAheadPriceSource):
    def fetch_day_ahead_prices(self, zone, start, end):
        raise PriceSourceUnavailable("ENTSO-E is down")


def test_delivery_day_window_is_utc_midnight_local():
    # 2026-07-02 is CEST (UTC+2): local 00:00 -> 22:00Z the previous day.
    start, end = delivery_day_window(date(2026, 7, 2))
    assert start == datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    assert end == datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc)


def test_delivery_day_window_winter_offset():
    # January is CET (UTC+1): local 00:00 -> 23:00Z the previous day.
    start, end = delivery_day_window(date(2026, 1, 15))
    assert start == datetime(2026, 1, 14, 23, 0, tzinfo=timezone.utc)
    assert end == datetime(2026, 1, 15, 23, 0, tzinfo=timezone.utc)


def test_next_delivery_day():
    assert next_delivery_day(date(2026, 7, 1)) == date(2026, 7, 2)


def test_fetch_and_store_writes_rows(pt60m_xml):
    http = FakeHttpClient(response=HttpResponse(200, pt60m_xml))
    source = EntsoeDayAheadPriceSource(
        EntsoeConfig(security_token="t"), http_client=http
    )
    repo = InMemoryPriceRepository()

    result = fetch_and_store(source, "DE-LU", date(2026, 7, 2), repository=repo)

    assert result.rows_written == 24
    assert len(repo.rows) == 24
    assert repo.by_zone["DE-LU"].zone == "DE-LU"
    # The adapter received the delivery-day window as ENTSO-E period bounds.
    assert http.calls[0]["params"]["periodStart"] == "202607012200"


def test_fetch_and_store_primes_cache_from_repository_on_outage():
    # The repository already holds a stored series for this delivery day.
    day = date(2026, 7, 2)
    start, _end = delivery_day_window(day)
    stored = PriceSeries(
        zone="DE-LU",
        resolution="PT60M",
        currency="EUR",
        points=(PricePoint(start, start + timedelta(hours=1), 42.0),),
    )
    repo = InMemoryPriceRepository()
    repo.upsert_series(stored)

    # ENTSO-E is down now; the resilient source must fall back to the primed row
    # instead of raising, so a short-lived cron run still gets a usable series.
    source = ResilientPriceSource(
        delegate=_AlwaysDownSource(), retry=RetryPolicy(max_attempts=1)
    )
    result = fetch_and_store(source, "DE-LU", day, repository=repo)
    assert result.series.prices() == [42.0]


def test_dsn_from_env_url_encodes_credentials():
    dsn = _dsn_from_env({"POSTGRES_USER": "user@x", "POSTGRES_PASSWORD": "p@ss:w/rd#"})
    parsed = urlparse(dsn)
    # The special characters are percent-encoded, so host/db still parse
    # correctly and the raw credentials round-trip via unquote.
    assert parsed.hostname == "localhost"
    assert parsed.path == "/voltpilot"
    assert unquote(parsed.username) == "user@x"
    assert unquote(parsed.password) == "p@ss:w/rd#"

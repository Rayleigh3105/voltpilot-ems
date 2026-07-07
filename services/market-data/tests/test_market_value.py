"""Monatsmarktwert Solar: adapter parsing, provisional calc, refresh glue.

All offline. The netztransparenz fixtures under ``tests/fixtures/`` are
VERBATIM recordings of the live keyless endpoint
``POST /DesktopModules/LotesCharts/Services/HighchartService.asmx/GetMarketpremiumData``
taken on 2026-07-07 (netztransparenz_marketpremium_2025.json with the full
published year-to-May-2026 state, and _2026.json where Jun+Jul 2026 are still
unpublished - exactly the state the provisional value exists for).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import pytest

from tests.conftest import load_fixture
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.market_value import (
    MonthlyMarketValue,
    provisional_solar_market_value,
    solar_shape_weight,
)
from voltpilot_market_data.market_value_persistence import (
    InMemoryMarketValueRepository,
)
from voltpilot_market_data.market_value_service import refresh_market_values
from voltpilot_market_data.model import PricePoint, PriceSeries
from voltpilot_market_data.netztransparenz import (
    NetztransparenzMarketValueSource,
    parse_market_value_response,
)
from voltpilot_market_data.market_value import (
    MarketValueSourceError,
    MarketValueSourceUnavailable,
)


@dataclass
class FakePostClient:
    """Replays one canned response per request; records calls."""

    responses: dict[int, HttpResponse] = field(default_factory=dict)
    error: Exception | None = None
    calls: list[tuple[str, str]] = field(default_factory=list)

    def post_json(self, url: str, body: str, timeout: float) -> HttpResponse:
        self.calls.append((url, body))
        if self.error is not None:
            raise self.error
        year = int(json.loads(body)["dateFrom"][:4])
        return self.responses[year]


# ---------------------------------------------------------------------------
# Parsing the recorded fixtures
# ---------------------------------------------------------------------------


def test_parse_full_year_fixture_yields_twelve_published_months():
    values = parse_market_value_response(
        load_fixture("netztransparenz_marketpremium_2025.json"), 2025
    )
    assert len(values) == 12
    by_month = {v.month: v for v in values}
    # Hand-checked against the recorded chartData rows.
    assert by_month[date(2025, 1, 1)].value_ct_kwh == pytest.approx(11.511)
    assert by_month[date(2025, 12, 1)].month == date(2025, 12, 1)
    assert all(v.technology == "solar" for v in values)
    assert all(not v.provisional for v in values)
    assert all(v.source == "netztransparenz" for v in values)


def test_parse_partial_year_skips_unpublished_months():
    # Recorded on 2026-07-07: Jan-May published, Jun-Dec still empty cells.
    values = parse_market_value_response(
        load_fixture("netztransparenz_marketpremium_2026.json"), 2026
    )
    assert [v.month for v in values] == [date(2026, m, 1) for m in range(1, 6)]
    assert values[3].value_ct_kwh == pytest.approx(1.317)  # April 2026, MW Solar
    assert values[4].value_ct_kwh == pytest.approx(3.163)  # May 2026


def test_parse_reads_the_mw_solar_column_by_name_not_position():
    fixture = json.loads(load_fixture("netztransparenz_marketpremium_2026.json"))
    inner = json.loads(fixture["d"])
    header, *rows = inner["chartData"].split("\r\n")
    cols = header.split(";")
    # Swap MW Solar with the wind column; values must follow the header.
    solar_i, wind_i = cols.index("MW Solar"), cols.index("MW Wind an Land")
    cols[solar_i], cols[wind_i] = cols[wind_i], cols[solar_i]
    swapped_rows = []
    for row in rows:
        cells = row.split(";")
        if len(cells) > max(solar_i, wind_i):
            cells[solar_i], cells[wind_i] = cells[wind_i], cells[solar_i]
        swapped_rows.append(";".join(cells))
    inner["chartData"] = "\r\n".join([";".join(cols)] + swapped_rows)
    body = json.dumps({"d": json.dumps(inner)})

    values = parse_market_value_response(body, 2026)
    assert values[0].value_ct_kwh == pytest.approx(11.019)  # still MW Solar Jan


def test_parse_rejects_missing_solar_column():
    body = json.dumps(
        {"d": json.dumps({"chartData": "Monat;MW Wind an Land\r\n1767225600000;9.5"})}
    )
    with pytest.raises(MarketValueSourceError, match="MW Solar"):
        parse_market_value_response(body, 2026)


def test_parse_rejects_month_key_outside_requested_year():
    body = json.dumps(
        {"d": json.dumps({"chartData": "Monat;MW Solar\r\n1735689600000;5.0"})}
    )  # 2025-01-01 but we asked for 2026
    with pytest.raises(MarketValueSourceError, match="month key"):
        parse_market_value_response(body, 2026)


def test_parse_rejects_non_numeric_value_and_garbage_envelope():
    body = json.dumps(
        {"d": json.dumps({"chartData": "Monat;MW Solar\r\n1767225600000;abc"})}
    )
    with pytest.raises(MarketValueSourceError, match="not a number"):
        parse_market_value_response(body, 2026)
    with pytest.raises(MarketValueSourceError):
        parse_market_value_response("<html>maintenance</html>", 2026)


def test_source_fetches_and_maps_http_failures():
    client = FakePostClient(
        responses={
            2026: HttpResponse(200, load_fixture("netztransparenz_marketpremium_2026.json"))
        }
    )
    source = NetztransparenzMarketValueSource(http_client=client)
    values = source.fetch_monthly_market_values(2026)
    assert len(values) == 5
    url, body = client.calls[0]
    assert url.endswith("HighchartService.asmx/GetMarketpremiumData")
    assert json.loads(body)["dateFrom"] == "2026-01-01T00:00:00"

    down = NetztransparenzMarketValueSource(
        http_client=FakePostClient(responses={2026: HttpResponse(503, "down")})
    )
    with pytest.raises(MarketValueSourceUnavailable):
        down.fetch_monthly_market_values(2026)

    broken = NetztransparenzMarketValueSource(
        http_client=FakePostClient(error=ConnectionError("no route"))
    )
    with pytest.raises(MarketValueSourceUnavailable):
        broken.fetch_monthly_market_values(2026)


# ---------------------------------------------------------------------------
# Provisional value (solar-shape weighted average)
# ---------------------------------------------------------------------------


def _hourly_points(day: date, prices_by_hour: dict[int, float]) -> list[PricePoint]:
    return [
        PricePoint(
            start=datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc),
            end=datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc)
            + timedelta(hours=1),
            price_eur_mwh=price,
        )
        for h, price in prices_by_hour.items()
    ]


def test_solar_weight_is_zero_at_night_and_peaks_midday():
    night = solar_shape_weight(datetime(2026, 6, 15, 0, 30, tzinfo=timezone.utc))
    noon = solar_shape_weight(datetime(2026, 6, 15, 11, 15, tzinfo=timezone.utc))
    morning = solar_shape_weight(datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc))
    assert night == 0.0
    assert noon > morning > 0.0
    # Summer noon sun over central Germany: elevation ~62 deg -> sin ~0.88.
    assert 0.8 < noon < 0.95


def test_provisional_value_is_the_flat_price_on_a_flat_curve():
    # Weighting cannot invent a level: a flat 80 EUR/MWh curve = 8 ct/kWh.
    points = _hourly_points(date(2026, 6, 15), {h: 80.0 for h in range(24)})
    value = provisional_solar_market_value(points, date(2026, 6, 1))
    assert value == pytest.approx(8.0)


def test_provisional_value_weights_midday_below_average_prices():
    # Cheap midday (solar depresses prices), expensive evening - the classic
    # duck curve. The solar-weighted value must sit clearly BELOW the plain
    # average, because solar sells when it shines.
    prices = {h: 100.0 for h in range(24)}
    for h in (10, 11, 12, 13):
        prices[h] = 20.0
    points = _hourly_points(date(2026, 6, 15), prices)
    value = provisional_solar_market_value(points, date(2026, 6, 1))
    plain_average_ct = sum(prices.values()) / 24 / 10
    assert value is not None
    assert value < plain_average_ct
    assert value < 7.0  # midday dominance pulls it well under 70 EUR/MWh


def test_provisional_value_ignores_night_slots_entirely():
    # Absurd night prices must not move the value at all.
    base = {h: 50.0 for h in range(5, 21)}
    points = _hourly_points(date(2026, 6, 15), base)
    with_night = points + _hourly_points(date(2026, 6, 15), {0: 9999.0, 23: -9999.0})
    v1 = provisional_solar_market_value(points, date(2026, 6, 1))
    v2 = provisional_solar_market_value(with_night, date(2026, 6, 1))
    assert v1 == pytest.approx(v2)


def test_provisional_value_only_counts_the_requested_berlin_month():
    june = _hourly_points(date(2026, 6, 15), {12: 50.0})
    july = _hourly_points(date(2026, 7, 15), {12: 500.0})
    value = provisional_solar_market_value(june + july, date(2026, 6, 1))
    assert value == pytest.approx(5.0)


def test_provisional_value_none_without_daylight_data():
    night_only = _hourly_points(date(2026, 6, 15), {0: 42.0, 23: 42.0})
    assert provisional_solar_market_value(night_only, date(2026, 6, 1)) is None
    assert provisional_solar_market_value([], date(2026, 6, 1)) is None


# ---------------------------------------------------------------------------
# Refresh orchestration + upsert rules
# ---------------------------------------------------------------------------


@dataclass
class FakePriceRepository:
    """Serves one canned series regardless of window (records the windows)."""

    series: PriceSeries | None = None
    windows: list[tuple[datetime, datetime]] = field(default_factory=list)

    def upsert_series(self, series):  # pragma: no cover - unused here
        raise NotImplementedError

    def latest_series(self, zone, start, end):
        self.windows.append((start, end))
        if self.series is None:
            return None
        clipped = tuple(
            p for p in self.series.points if start <= p.start < end
        )
        if not clipped:
            return None
        return PriceSeries(
            zone=zone,
            resolution=self.series.resolution,
            currency="EUR",
            points=clipped,
            source="test",
        )


def _fixture_source() -> NetztransparenzMarketValueSource:
    return NetztransparenzMarketValueSource(
        http_client=FakePostClient(
            responses={
                2025: HttpResponse(
                    200, load_fixture("netztransparenz_marketpremium_2025.json")
                ),
                2026: HttpResponse(
                    200, load_fixture("netztransparenz_marketpremium_2026.json")
                ),
            }
        )
    )


def test_refresh_upserts_published_and_computes_provisional_gap_months():
    repo = InMemoryMarketValueRepository()
    june_and_july = _hourly_points(date(2026, 6, 20), {12: 60.0}) + _hourly_points(
        date(2026, 7, 3), {12: 90.0}
    )
    prices = FakePriceRepository(
        series=PriceSeries(
            zone="DE-LU",
            resolution="PT60M",
            currency="EUR",
            points=tuple(june_and_july),
            source="test",
        )
    )

    result = refresh_market_values(
        _fixture_source(), repo, prices, today=date(2026, 7, 7)
    )

    # 12 published 2025 months + 5 published 2026 months.
    assert result.published_rows == 17
    # Last published = May 2026 -> provisional for June AND July.
    assert result.provisional_months == [date(2026, 6, 1), date(2026, 7, 1)]
    june = repo.rows[("solar", date(2026, 6, 1))]
    july = repo.rows[("solar", date(2026, 7, 1))]
    assert june.provisional and july.provisional
    assert june.value_ct_kwh == pytest.approx(6.0)
    assert july.value_ct_kwh == pytest.approx(9.0)
    assert repo.rows[("solar", date(2026, 5, 1))].value_ct_kwh == pytest.approx(3.163)


def test_refresh_skips_provisional_months_without_prices():
    repo = InMemoryMarketValueRepository()
    result = refresh_market_values(
        _fixture_source(), repo, FakePriceRepository(series=None), today=date(2026, 7, 7)
    )
    assert result.provisional_rows == 0
    assert ("solar", date(2026, 6, 1)) not in repo.rows


def test_published_value_replaces_provisional_but_never_the_reverse():
    repo = InMemoryMarketValueRepository()
    provisional = MonthlyMarketValue(
        month=date(2026, 5, 1),
        technology="solar",
        value_ct_kwh=4.2,
        provisional=True,
        source="voltpilot-provisional",
    )
    published = MonthlyMarketValue(
        month=date(2026, 5, 1),
        technology="solar",
        value_ct_kwh=3.163,
        provisional=False,
        source="netztransparenz",
    )
    assert repo.upsert_values([provisional]) == 1
    assert repo.upsert_values([published]) == 1
    assert repo.rows[("solar", date(2026, 5, 1))].value_ct_kwh == pytest.approx(3.163)
    # A late provisional write must NOT clobber the official number.
    assert repo.upsert_values([provisional]) == 0
    assert repo.rows[("solar", date(2026, 5, 1))].value_ct_kwh == pytest.approx(3.163)
    assert not repo.rows[("solar", date(2026, 5, 1))].provisional

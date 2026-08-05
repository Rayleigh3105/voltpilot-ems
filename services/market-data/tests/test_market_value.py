"""Monatsmarktwert Solar: adapter parsing, provisional calc, refresh glue.

All offline. The netztransparenz fixtures under ``tests/fixtures/`` are
VERBATIM recordings of the live keyless endpoint
``POST /DesktopModules/LotesCharts/Services/HighchartService.asmx/GetMarketpremiumData``
taken on 2026-07-07 (netztransparenz_marketpremium_2025.json with the full
published year-to-May-2026 state, and _2026.json where Jun+Jul 2026 are still
unpublished - exactly the state the provisional value exists for).

The generation-weighted provisional value additionally uses the three VERBATIM
recordings of the German day 2026-06-15 taken on 2026-08-05 (DE-LU prices, ÜNB
Online-Hochrechnung Solar and energy-charts public_power - see
``tests/test_solar_generation.py`` for their provenance), so the official
Anlage 1 Nr. 2.2 EEG 2023 formula is exercised on real data, not only on
hand-built curves.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import pytest

from tests.conftest import load_fixture
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.energy_charts import (
    parse_price_response,
    parse_public_power_response,
)
from voltpilot_market_data.market_value import (
    CLEAR_SKY_WEIGHTING,
    MonthlyMarketValue,
    clear_sky_weighted_solar_market_value,
    generation_weighted_solar_market_value,
    generation_weights_by_slot,
    provisional_solar_market_value,
    provisional_solar_market_value_weighted_by,
    solar_shape_weight,
)
from voltpilot_market_data.netztransparenz_generation import (
    parse_online_hochrechnung_response,
)
from voltpilot_market_data.solar_generation import (
    GenerationPoint,
    SolarGenerationSeries,
    SolarGenerationSource,
    SolarGenerationSourceUnavailable,
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


# ---------------------------------------------------------------------------
# Generation weighting - the official Anlage 1 Nr. 2.2 EEG 2023 formula
# ---------------------------------------------------------------------------

UNB_FIXTURE = "netztransparenz_online_hochrechnung_solar_20260615.json"
EC_GEN_FIXTURE = "energy_charts_public_power_de_20260615.json"
PRICE_FIXTURE = "energy_charts_de_lu_20260615.json"


def _generation(day: date, power_by_hour: dict[int, float]) -> SolarGenerationSeries:
    """Hourly generation series (MW), aligned with ``_hourly_points``."""
    return SolarGenerationSeries(
        points=tuple(
            GenerationPoint(
                start=datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc),
                end=datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc)
                + timedelta(hours=1),
                power_mw=mw,
            )
            for h, mw in sorted(power_by_hour.items())
        ),
        source="test-generation",
    )


def test_generation_weighting_is_the_hand_computed_energy_weighted_average():
    # sum(p_i * E_i) / sum(E_i): (50*1000 + 10*4000 + 30*1000) / 6000
    #                          = 120000/6000 = 20 EUR/MWh = 2.0 ct/kWh.
    prices = _hourly_points(date(2026, 6, 15), {10: 50.0, 12: 10.0, 14: 30.0})
    generation = _generation(date(2026, 6, 15), {10: 1000.0, 12: 4000.0, 14: 1000.0})
    value = generation_weighted_solar_market_value(
        prices, generation, date(2026, 6, 1)
    )
    assert value == pytest.approx(2.0)
    # ...and provably NOT the plain average (30 EUR/MWh = 3 ct/kWh), because
    # the fleet sells most of its energy in the cheap noon hour.
    assert value < 3.0


def test_generation_weighting_drops_zero_generation_slots_entirely():
    # An absurd night price carries no weight - the fleet fed in nothing.
    prices = _hourly_points(date(2026, 6, 15), {2: 9999.0, 12: 40.0})
    generation = _generation(date(2026, 6, 15), {2: 0.0, 12: 5000.0})
    assert generation_weighted_solar_market_value(
        prices, generation, date(2026, 6, 1)
    ) == pytest.approx(4.0)


def test_generation_weighting_only_counts_the_requested_berlin_month():
    prices = _hourly_points(date(2026, 6, 15), {12: 50.0}) + _hourly_points(
        date(2026, 7, 15), {12: 500.0}
    )
    generation = SolarGenerationSeries(
        points=_generation(date(2026, 6, 15), {12: 1000.0}).points
        + _generation(date(2026, 7, 15), {12: 1000.0}).points,
        source="test-generation",
    )
    assert generation_weighted_solar_market_value(
        prices, generation, date(2026, 6, 1)
    ) == pytest.approx(5.0)


def test_join_assigns_a_sample_to_the_slot_containing_its_midpoint():
    # One PT60M price slot meeting four quarter-hourly generation samples: the
    # hour collects all four, i.e. its full share of the month's energy.
    hour_start = datetime(2026, 6, 15, 12, tzinfo=timezone.utc)
    slot = PricePoint(
        start=hour_start, end=hour_start + timedelta(hours=1), price_eur_mwh=40.0
    )
    quarters = SolarGenerationSeries(
        points=tuple(
            GenerationPoint(
                start=hour_start + timedelta(minutes=15 * i),
                end=hour_start + timedelta(minutes=15 * (i + 1)),
                power_mw=1000.0,
            )
            for i in range(4)
        ),
        source="test-generation",
    )
    weights = generation_weights_by_slot([slot], quarters)
    assert weights == {hour_start: pytest.approx(1000.0)}  # 4 x 250 MWh
    assert generation_weighted_solar_market_value(
        [slot], quarters, date(2026, 6, 1)
    ) == pytest.approx(4.0)


def test_join_leaves_uncovered_price_slots_unweighted():
    # Generation covers only the noon hour; the 14:00 price must not enter.
    prices = _hourly_points(date(2026, 6, 15), {12: 40.0, 14: 400.0})
    generation = _generation(date(2026, 6, 15), {12: 1000.0})
    weights = generation_weights_by_slot(prices, generation)
    assert list(weights) == [datetime(2026, 6, 15, 12, tzinfo=timezone.utc)]
    assert generation_weighted_solar_market_value(
        prices, generation, date(2026, 6, 1)
    ) == pytest.approx(4.0)


def test_generation_weighting_on_the_real_recorded_day_beats_the_clear_sky_shape():
    """Real prices x real ÜNB quantity on 2026-06-15 (all three verbatim)."""
    prices = parse_price_response(load_fixture(PRICE_FIXTURE), "DE-LU")
    unb = parse_online_hochrechnung_response(load_fixture(UNB_FIXTURE))
    energy_charts = parse_public_power_response(load_fixture(EC_GEN_FIXTURE))
    month = date(2026, 6, 1)

    official_style = generation_weighted_solar_market_value(prices.points, unb, month)
    substitute = generation_weighted_solar_market_value(
        prices.points, energy_charts, month
    )
    clear_sky = clear_sky_weighted_solar_market_value(prices.points, month)
    plain = sum(p.price_eur_mwh for p in prices.points) / len(prices) / 10

    assert official_style == pytest.approx(2.4981, abs=1e-3)
    assert substitute == pytest.approx(2.5901, abs=1e-3)
    assert clear_sky == pytest.approx(3.1136, abs=1e-3)
    # The whole point: every weighting sits below the plain average (solar sells
    # when it shines), and the weather-blind shape sits CLOSEST to it - i.e. it
    # systematically overstates what the fleet earned.
    assert official_style < substitute < clear_sky < plain == pytest.approx(7.4265, abs=1e-3)


def test_part_month_value_converges_as_the_month_fills_up():
    """A part-month value is a running average, not a month value."""
    # Cheap first half (the fleet's big days), expensive second half.
    prices = []
    generation_points = []
    for day in range(1, 31):
        price = 20.0 if day <= 15 else 80.0
        prices += _hourly_points(date(2026, 6, day), {12: price})
        generation_points += _generation(date(2026, 6, day), {12: 1000.0}).points
    month = date(2026, 6, 1)

    def value_after(days: int) -> float:
        partial = SolarGenerationSeries(
            points=tuple(p for p in generation_points if p.start.day <= days),
            source="test-generation",
        )
        return generation_weighted_solar_market_value(prices, partial, month)

    early, mid, full = value_after(5), value_after(20), value_after(30)
    # Early: only cheap days seen. Full month: 15 cheap + 15 expensive = 5 ct.
    assert early == pytest.approx(2.0)
    assert full == pytest.approx(5.0)
    # ...and the mid-month reading already sits between the two, converging.
    assert early < mid < full
    # The uncovered tail is NOT modelled - the covered part is all there is.
    assert value_after(15) == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# The fallback chain inside the provisional value
# ---------------------------------------------------------------------------


def test_provisional_prefers_generation_and_reports_which_quantity_it_used():
    prices = _hourly_points(date(2026, 6, 15), {10: 50.0, 12: 10.0, 14: 30.0})
    generation = _generation(date(2026, 6, 15), {10: 1000.0, 12: 4000.0, 14: 1000.0})
    value, weighting = provisional_solar_market_value_weighted_by(
        prices, date(2026, 6, 1), generation
    )
    assert value == pytest.approx(2.0)
    assert weighting == "test-generation"


def test_provisional_falls_back_to_clear_sky_without_generation_data():
    prices = _hourly_points(date(2026, 6, 15), {10: 50.0, 12: 10.0, 14: 30.0})
    expected = clear_sky_weighted_solar_market_value(prices, date(2026, 6, 1))

    for generation in (
        None,  # no source configured / every source down
        SolarGenerationSeries(points=(), source="test-generation"),  # empty answer
        _generation(date(2026, 7, 15), {12: 5000.0}),  # wrong month, no overlap
        _generation(date(2026, 6, 15), {10: 0.0, 12: 0.0, 14: 0.0}),  # nothing fed in
    ):
        value, weighting = provisional_solar_market_value_weighted_by(
            prices, date(2026, 6, 1), generation
        )
        assert value == pytest.approx(expected)
        assert weighting == CLEAR_SKY_WEIGHTING
    # The old positional call keeps working (clear-sky, unchanged behaviour).
    assert provisional_solar_market_value(prices, date(2026, 6, 1)) == pytest.approx(
        expected
    )


def test_provisional_is_none_when_even_the_clear_sky_fallback_has_nothing():
    night_only = _hourly_points(date(2026, 6, 15), {0: 42.0, 23: 42.0})
    generation = _generation(date(2026, 6, 15), {0: 0.0})
    assert provisional_solar_market_value(night_only, date(2026, 6, 1), generation) is None
    assert provisional_solar_market_value([], date(2026, 6, 1), generation) is None


# ---------------------------------------------------------------------------
# Refresh orchestration with a generation source
# ---------------------------------------------------------------------------


class _StubGenerationSource(SolarGenerationSource):
    """Serves one canned series; records the requested windows."""

    def __init__(self, series: SolarGenerationSeries | None) -> None:
        self.series = series
        self.windows: list[tuple[datetime, datetime]] = []

    def fetch_solar_generation(self, start, end):
        self.windows.append((start, end))
        if self.series is None:
            raise SolarGenerationSourceUnavailable("down")
        return SolarGenerationSeries(
            points=tuple(p for p in self.series.points if start <= p.start < end),
            source=self.series.source,
        )


def _june_july_prices() -> PriceSeries:
    points = _hourly_points(date(2026, 6, 20), {10: 100.0, 12: 20.0}) + _hourly_points(
        date(2026, 7, 3), {12: 90.0}
    )
    return PriceSeries(
        zone="DE-LU",
        resolution="PT60M",
        currency="EUR",
        points=tuple(points),
        source="test",
    )


def test_refresh_weights_the_provisional_months_by_generation():
    repo = InMemoryMarketValueRepository()
    prices = FakePriceRepository(series=_june_july_prices())
    generation = _StubGenerationSource(
        SolarGenerationSeries(
            points=_generation(date(2026, 6, 20), {10: 1000.0, 12: 3000.0}).points
            + _generation(date(2026, 7, 3), {12: 1000.0}).points,
            source="netztransparenz-online-hochrechnung",
        )
    )

    result = refresh_market_values(
        _fixture_source(),
        repo,
        prices,
        today=date(2026, 7, 7),
        generation_source=generation,
    )

    assert result.provisional_months == [date(2026, 6, 1), date(2026, 7, 1)]
    # (100*1000 + 20*3000) / 4000 = 40 EUR/MWh = 4.0 ct/kWh - the generation
    # weighting, NOT the clear-sky one (which would land above 5).
    assert repo.rows[("solar", date(2026, 6, 1))].value_ct_kwh == pytest.approx(4.0)
    assert repo.rows[("solar", date(2026, 7, 1))].value_ct_kwh == pytest.approx(9.0)
    assert repo.rows[("solar", date(2026, 6, 1))].provisional
    assert result.provisional_weighting == {
        date(2026, 6, 1): "netztransparenz-online-hochrechnung",
        date(2026, 7, 1): "netztransparenz-online-hochrechnung",
    }
    # One request per provisional month, over the German calendar month.
    assert len(generation.windows) == 2
    assert generation.windows[0] == prices.windows[0]


def test_refresh_survives_a_generation_outage_and_says_so():
    repo = InMemoryMarketValueRepository()
    result = refresh_market_values(
        _fixture_source(),
        repo,
        FakePriceRepository(series=_june_july_prices()),
        today=date(2026, 7, 7),
        generation_source=_StubGenerationSource(None),
    )
    # The value is still written - degraded to the documented last resort, and
    # the result names the weighting so nobody mistakes it for the exact one.
    assert result.provisional_rows == 2
    assert set(result.provisional_weighting.values()) == {CLEAR_SKY_WEIGHTING}
    assert repo.rows[("solar", date(2026, 6, 1))].provisional


def test_refresh_without_a_generation_source_is_the_old_clear_sky_behaviour():
    repo_old = InMemoryMarketValueRepository()
    repo_new = InMemoryMarketValueRepository()
    kwargs = dict(today=date(2026, 7, 7))
    refresh_market_values(
        _fixture_source(), repo_old, FakePriceRepository(series=_june_july_prices()), **kwargs
    )
    refresh_market_values(
        _fixture_source(),
        repo_new,
        FakePriceRepository(series=_june_july_prices()),
        generation_source=None,
        **kwargs,
    )
    assert {k: v.value_ct_kwh for k, v in repo_old.rows.items()} == {
        k: v.value_ct_kwh for k, v in repo_new.rows.items()
    }

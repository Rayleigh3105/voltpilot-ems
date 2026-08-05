"""Germany-wide solar generation: both adapters, the model and the chain.

All offline. Two fixtures under ``tests/fixtures/`` are VERBATIM recordings of
the live keyless endpoints, both covering the SAME German day 2026-06-15
(00:00-24:00 CEST, 96 quarter hours), taken on 2026-08-05:

  * ``netztransparenz_online_hochrechnung_solar_20260615.json`` -
    ``POST /DesktopModules/LotesCharts/Services/HighchartService.asmx/GetChartData``
    with ``dataType=4`` / ``productId=42145141`` (ÜNB Online-Hochrechnung Solar,
    the quantity Anlage 1 Nr. 2.2 EEG 2023 names),
  * ``energy_charts_public_power_de_20260615.json`` -
    ``GET https://api.energy-charts.info/public_power?country=de`` (the keyless
    fallback quantity).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pytest

from tests.conftest import load_fixture
from voltpilot_market_data.energy_charts import (
    EnergyChartsSolarGenerationSource,
    parse_public_power_response,
)
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.netztransparenz_generation import (
    NetztransparenzSolarGenerationSource,
    parse_online_hochrechnung_response,
)
from voltpilot_market_data.solar_generation import (
    FallbackSolarGenerationSource,
    GenerationPoint,
    SolarGenerationSeries,
    SolarGenerationSource,
    SolarGenerationSourceError,
    SolarGenerationSourceUnavailable,
)

UNB_FIXTURE = "netztransparenz_online_hochrechnung_solar_20260615.json"
EC_FIXTURE = "energy_charts_public_power_de_20260615.json"

# 2026-06-15 00:00 CEST.
DAY_START = datetime(2026, 6, 14, 22, 0, tzinfo=timezone.utc)
DAY_END = DAY_START + timedelta(days=1)


@dataclass
class FakePostClient:
    response: HttpResponse | None = None
    error: Exception | None = None
    calls: list[tuple[str, str]] = field(default_factory=list)

    def post_json(self, url: str, body: str, timeout: float) -> HttpResponse:
        self.calls.append((url, body))
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


@dataclass
class FakeGetClient:
    response: HttpResponse | None = None
    error: Exception | None = None
    calls: list[dict] = field(default_factory=list)

    def get(self, url, params, timeout) -> HttpResponse:
        self.calls.append({"url": url, "params": dict(params)})
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


def _unb_body(chart_data: str) -> str:
    return json.dumps({"d": json.dumps({"chartData": chart_data})})


# ---------------------------------------------------------------------------
# Domain model
# ---------------------------------------------------------------------------


def test_generation_point_energy_is_power_times_duration():
    quarter = GenerationPoint(
        start=DAY_START, end=DAY_START + timedelta(minutes=15), power_mw=40000.0
    )
    hour = GenerationPoint(
        start=DAY_START, end=DAY_START + timedelta(hours=1), power_mw=40000.0
    )
    assert quarter.energy_mwh == pytest.approx(10000.0)
    # Same power over four times the span carries four times the weight - the
    # reason the join uses energy, not MW.
    assert hour.energy_mwh == pytest.approx(4 * quarter.energy_mwh)
    assert quarter.midpoint == DAY_START + timedelta(minutes=7, seconds=30)


def test_generation_point_rejects_naive_and_inverted_intervals():
    with pytest.raises(ValueError):
        GenerationPoint(
            start=datetime(2026, 6, 15), end=datetime(2026, 6, 15, 1), power_mw=1.0
        )
    with pytest.raises(ValueError):
        GenerationPoint(start=DAY_END, end=DAY_START, power_mw=1.0)


# ---------------------------------------------------------------------------
# ÜNB Online-Hochrechnung adapter (the official quantity)
# ---------------------------------------------------------------------------


def test_unb_fixture_parses_a_full_quarter_hourly_german_day():
    series = parse_online_hochrechnung_response(load_fixture(UNB_FIXTURE))
    assert len(series) == 96
    assert series.source == "netztransparenz-online-hochrechnung"
    assert series.resolution == timedelta(minutes=15)
    assert series.points[0].start == DAY_START
    assert series.points[-1].end == DAY_END
    # Hand-checked against the recorded row 1781474400000;0;0;0;0 (midnight).
    assert series.points[0].power_mw == pytest.approx(0.0)
    # A June noon: tens of GW across the four control areas.
    noon = next(p for p in series.points if p.start.hour == 10)
    assert 20000.0 < noon.power_mw < 80000.0


def test_unb_parse_sums_the_four_tso_columns_located_by_name():
    body = _unb_body(
        "Zeit;TransnetBW;50Hertz;TenneT TSO;Amprion\r\n"
        "1781474400000;4;1;3;2\r\n"
    )
    series = parse_online_hochrechnung_response(body)
    # Order is irrelevant: the sum of all four control areas is Germany.
    assert series.points[0].power_mw == pytest.approx(10.0)


def test_unb_parse_skips_rows_whose_tso_cells_are_not_computed_yet():
    body = _unb_body(
        "Zeit;50Hertz;Amprion;TenneT TSO;TransnetBW\r\n"
        "1781474400000;1;1;1;1\r\n"
        "1781475300000;2;2;2;2\r\n"
        "1781476200000;;;;\r\n"  # newest interval, not computed yet
    )
    series = parse_online_hochrechnung_response(body)
    # Skipped, NOT read as zero generation (which would drag the average).
    assert [p.power_mw for p in series.points] == [4.0, 8.0]


def test_unb_parse_rejects_missing_columns_and_garbage():
    with pytest.raises(SolarGenerationSourceError, match="TSO column"):
        parse_online_hochrechnung_response(
            _unb_body("Zeit;50Hertz;Amprion\r\n1781474400000;1;1\r\n")
        )
    with pytest.raises(SolarGenerationSourceError, match="Zeit"):
        parse_online_hochrechnung_response(
            _unb_body("Stunde;50Hertz;Amprion;TenneT TSO;TransnetBW\r\n1;1;1;1;1\r\n")
        )
    with pytest.raises(SolarGenerationSourceError, match="non-numeric"):
        parse_online_hochrechnung_response(
            _unb_body(
                "Zeit;50Hertz;Amprion;TenneT TSO;TransnetBW\r\n"
                "1781474400000;abc;1;1;1\r\n"
            )
        )
    with pytest.raises(SolarGenerationSourceError, match="implausible"):
        parse_online_hochrechnung_response(
            _unb_body(
                "Zeit;50Hertz;Amprion;TenneT TSO;TransnetBW\r\n"
                "1781474400000;-5;1;1;1\r\n"
            )
        )
    with pytest.raises(SolarGenerationSourceError):
        parse_online_hochrechnung_response("<html>maintenance</html>")


def test_unb_parse_raises_unavailable_when_nothing_is_computed_yet():
    with pytest.raises(SolarGenerationSourceUnavailable):
        parse_online_hochrechnung_response(
            _unb_body("Zeit;50Hertz;Amprion;TenneT TSO;TransnetBW\r\n1781474400000;;;;\r\n")
        )


def test_unb_source_sends_german_wall_clock_bounds_and_maps_http_failures():
    client = FakePostClient(response=HttpResponse(200, load_fixture(UNB_FIXTURE)))
    series = NetztransparenzSolarGenerationSource(
        http_client=client
    ).fetch_solar_generation(DAY_START, DAY_END)
    assert len(series) == 96
    url, body = client.calls[0]
    assert url.endswith("HighchartService.asmx/GetChartData")
    sent = json.loads(body)
    # The service takes LOCAL wall clock - which is exactly the German calendar
    # month boundary the Marktwert needs.
    assert sent["dateFromCet"] == "2026-06-15T00:00:00"
    assert sent["dateToCet"] == "2026-06-16T00:00:00"
    assert (sent["dataType"], sent["productId"]) == ("4", "42145141")

    with pytest.raises(SolarGenerationSourceUnavailable):
        NetztransparenzSolarGenerationSource(
            http_client=FakePostClient(response=HttpResponse(503, "down"))
        ).fetch_solar_generation(DAY_START, DAY_END)
    with pytest.raises(SolarGenerationSourceUnavailable):
        NetztransparenzSolarGenerationSource(
            http_client=FakePostClient(error=ConnectionError("no route"))
        ).fetch_solar_generation(DAY_START, DAY_END)


# ---------------------------------------------------------------------------
# energy-charts adapter (the fallback quantity)
# ---------------------------------------------------------------------------


def test_energy_charts_fixture_parses_the_same_day_at_the_same_resolution():
    series = parse_public_power_response(load_fixture(EC_FIXTURE))
    assert len(series) == 96
    assert series.source == "energy-charts-public-power"
    assert series.points[0].start == DAY_START
    assert series.points[-1].end == DAY_END


def test_energy_charts_and_unb_agree_on_the_shape_but_not_on_the_number():
    """The whole reason energy-charts is only the fallback."""
    unb = parse_online_hochrechnung_response(load_fixture(UNB_FIXTURE))
    ec = parse_public_power_response(load_fixture(EC_FIXTURE))
    unb_total = sum(p.energy_mwh for p in unb.points)
    ec_total = sum(p.energy_mwh for p in ec.points)
    # Same day, same fleet, so the same order of magnitude...
    assert unb_total == pytest.approx(ec_total, rel=0.15)
    # ...but measurably different (376 049 vs 349 831 MWh on this day, ~7 %),
    # which is why the source RANKING matters and energy-charts is a fallback.
    assert abs(unb_total - ec_total) / unb_total > 0.01


def test_energy_charts_parse_locates_solar_by_name_and_skips_nulls():
    doc = json.loads(load_fixture(EC_FIXTURE))
    solar = next(e for e in doc["production_types"] if e["name"] == "Solar")
    solar["data"][0] = None
    series = parse_public_power_response(json.dumps(doc))
    assert len(series) == 95  # the null interval is skipped, not zeroed

    doc = json.loads(load_fixture(EC_FIXTURE))
    doc["production_types"] = [
        e for e in doc["production_types"] if e["name"] != "Solar"
    ]
    with pytest.raises(SolarGenerationSourceError, match="Solar"):
        parse_public_power_response(json.dumps(doc))


def test_energy_charts_parse_clips_to_the_window_and_rejects_garbage():
    body = load_fixture(EC_FIXTURE)
    half = parse_public_power_response(
        body, DAY_START + timedelta(hours=12), DAY_END
    )
    assert len(half) == 48
    assert half.points[0].start == DAY_START + timedelta(hours=12)

    with pytest.raises(SolarGenerationSourceUnavailable):
        parse_public_power_response(body, DAY_END, DAY_END + timedelta(days=1))
    with pytest.raises(SolarGenerationSourceError):
        parse_public_power_response("{}")


def test_energy_charts_source_requests_germany_and_maps_http_failures():
    client = FakeGetClient(response=HttpResponse(200, load_fixture(EC_FIXTURE)))
    series = EnergyChartsSolarGenerationSource(
        http_client=client
    ).fetch_solar_generation(DAY_START, DAY_END)
    assert len(series) == 96
    call = client.calls[0]
    assert call["url"].endswith("/public_power")
    assert call["params"]["country"] == "de"
    assert call["params"]["start"] == str(int(DAY_START.timestamp()))

    with pytest.raises(SolarGenerationSourceUnavailable):
        EnergyChartsSolarGenerationSource(
            http_client=FakeGetClient(response=HttpResponse(502, "bad gateway"))
        ).fetch_solar_generation(DAY_START, DAY_END)


# ---------------------------------------------------------------------------
# Fallback chain
# ---------------------------------------------------------------------------


class _Boom(SolarGenerationSource):
    def fetch_solar_generation(self, start, end):
        raise SolarGenerationSourceUnavailable("down")


class _Fixed(SolarGenerationSource):
    def __init__(self, tag: str) -> None:
        self._tag = tag

    def fetch_solar_generation(self, start, end):
        return SolarGenerationSeries(
            points=(GenerationPoint(start=start, end=end, power_mw=1.0),),
            source=self._tag,
        )


def test_chain_prefers_the_official_source_and_falls_back_loudly(caplog):
    chain = FallbackSolarGenerationSource(_Fixed("unb"), _Fixed("energy-charts"))
    assert chain.fetch_solar_generation(DAY_START, DAY_END).source == "unb"

    with caplog.at_level("WARNING"):
        degraded = FallbackSolarGenerationSource(
            _Boom(), _Fixed("energy-charts")
        ).fetch_solar_generation(DAY_START, DAY_END)
    assert degraded.source == "energy-charts"
    # A less exact quantity must not slip through silently.
    assert "solar_generation.fallback_used" in caplog.text


def test_chain_raises_when_every_source_is_down():
    with pytest.raises(SolarGenerationSourceUnavailable):
        FallbackSolarGenerationSource(_Boom(), _Boom()).fetch_solar_generation(
            DAY_START, DAY_END
        )
    with pytest.raises(ValueError):
        FallbackSolarGenerationSource()

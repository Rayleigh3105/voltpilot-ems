"""Adapter tests for the keyless energy-charts.info day-ahead price source.

No live HTTP: a :class:`FakeHttpClient` replays a recorded/synthetic response, so
the parse + mapping + window-clipping + rejection paths run offline (CI-safe),
and ``fetch_and_store`` proves the series lands in a repository.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_market_data.energy_charts import (
    EnergyChartsConfig,
    EnergyChartsDayAheadPriceSource,
    parse_price_response,
)
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.model import RESOLUTION_PT15M, RESOLUTION_PT60M
from voltpilot_market_data.persistence import InMemoryPriceRepository
from voltpilot_market_data.service import fetch_and_store
from voltpilot_market_data.source import PriceSourceError, PriceSourceUnavailable

from tests.conftest import FakeHttpClient, load_fixture


def _body(unix_seconds, prices, unit="EUR/MWh"):
    return json.dumps(
        {"unix_seconds": unix_seconds, "price": prices, "unit": unit}
    )


def _epochs(start: datetime, count: int, step_minutes: int) -> list[int]:
    return [
        int((start + timedelta(minutes=step_minutes * i)).timestamp())
        for i in range(count)
    ]


# ---- parsing -------------------------------------------------------------


def test_parses_15min_series_from_recorded_fixture():
    series = parse_price_response(
        load_fixture("energy_charts_de_lu_pt15m.json"), "DE-LU"
    )
    assert series.resolution == RESOLUTION_PT15M
    assert series.source == "energy-charts"
    assert series.currency == "EUR"
    assert series.prices() == [85.5, 82.1, 79.9, 88.3]
    # 15-min slots: each point spans exactly a quarter hour.
    assert series.points[0].end - series.points[0].start == timedelta(minutes=15)


def test_infers_hourly_resolution_from_spacing():
    start = datetime(2026, 1, 15, 23, 0, tzinfo=timezone.utc)
    series = parse_price_response(
        _body(_epochs(start, 3, 60), [50.0, 51.0, 49.0]), "DE-LU"
    )
    assert series.resolution == RESOLUTION_PT60M
    assert series.points[0].end - series.points[0].start == timedelta(hours=1)


def test_clips_to_requested_window():
    # API returns a wider range; the adapter keeps only [start, end).
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    epochs = _epochs(start - timedelta(minutes=30), 8, 15)  # two slots before start
    window_start = start
    window_end = start + timedelta(minutes=45)
    series = parse_price_response(
        _body(epochs, [float(i) for i in range(8)]),
        "DE-LU",
        start=window_start,
        end=window_end,
    )
    # Only the 3 slots at 22:00, 22:15, 22:30 fall inside [start, start+45m).
    assert len(series) == 3
    assert series.start == window_start
    assert series.end == window_end


def test_skips_null_prices_but_keeps_series():
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    series = parse_price_response(
        _body(_epochs(start, 3, 15), [10.0, None, 12.0]), "DE-LU"
    )
    assert series.prices() == [10.0, 12.0]


def test_empty_series_raises_unavailable():
    with pytest.raises(PriceSourceUnavailable):
        parse_price_response(_body([], []), "DE-LU")


def test_mismatched_arrays_raise_error():
    with pytest.raises(PriceSourceError):
        parse_price_response(_body([1782943200], [1.0, 2.0]), "DE-LU")


def test_invalid_json_raises_error():
    with pytest.raises(PriceSourceError):
        parse_price_response("not json", "DE-LU")


def test_unsupported_spacing_raises_error():
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    epochs = [int(start.timestamp()), int((start + timedelta(minutes=5)).timestamp())]
    with pytest.raises(PriceSourceError):
        parse_price_response(_body(epochs, [1.0, 2.0]), "DE-LU")


# ---- source (HTTP seam) --------------------------------------------------


def test_source_sends_keyless_window_request_and_maps_response():
    http = FakeHttpClient(
        response=HttpResponse(200, load_fixture("energy_charts_de_lu_pt15m.json"))
    )
    source = EnergyChartsDayAheadPriceSource(
        EnergyChartsConfig(base_url="https://api.energy-charts.info"),
        http_client=http,
    )
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    end = datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc)
    series = source.fetch_day_ahead_prices("DE-LU", start, end)

    call = http.calls[0]
    assert call["url"] == "https://api.energy-charts.info/price"
    assert call["params"]["bzn"] == "DE-LU"
    # No securityToken/key anywhere in the request - the source is keyless.
    assert "securityToken" not in call["params"]
    assert call["params"]["start"] == str(int(start.timestamp()))
    assert series.source == "energy-charts"
    assert len(series) == 4


def test_source_5xx_is_unavailable():
    http = FakeHttpClient(response=HttpResponse(503, "upstream down"))
    source = EnergyChartsDayAheadPriceSource(http_client=http)
    with pytest.raises(PriceSourceUnavailable):
        source.fetch_day_ahead_prices(
            "DE-LU",
            datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc),
            datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc),
        )


def test_source_4xx_is_error():
    http = FakeHttpClient(response=HttpResponse(400, "bad request"))
    source = EnergyChartsDayAheadPriceSource(http_client=http)
    with pytest.raises(PriceSourceError):
        source.fetch_day_ahead_prices(
            "DE-LU",
            datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc),
            datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc),
        )


# ---- end-to-end fetch + store -------------------------------------------


def test_fetch_and_store_writes_15min_rows():
    # A full delivery day of 15-min slots (96) inside the 2026-07-02 window.
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    epochs = _epochs(start, 96, 15)
    prices = [40.0 + (i % 24) for i in range(96)]
    http = FakeHttpClient(response=HttpResponse(200, _body(epochs, prices)))
    source = EnergyChartsDayAheadPriceSource(http_client=http)
    repo = InMemoryPriceRepository()

    result = fetch_and_store(source, "DE-LU", date(2026, 7, 2), repository=repo)

    assert result.rows_written == 96
    assert len(repo.rows) == 96
    stored = repo.by_zone["DE-LU"]
    assert stored.resolution == RESOLUTION_PT15M
    assert stored.source == "energy-charts"

"""Zone->EIC mapping and the ENTSO-E adapter's request/response handling."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from voltpilot_market_data.entsoe import (
    EntsoeConfig,
    EntsoeDayAheadPriceSource,
)
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.source import PriceSourceError, PriceSourceUnavailable
from voltpilot_market_data.zones import eic_for_zone

from tests.conftest import FakeHttpClient

WINDOW = (
    datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc),
    datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc),
)


def test_zone_mapping_known_zones():
    assert eic_for_zone("DE-LU") == "10Y1001A1001A82H"
    assert eic_for_zone("AT") == "10YAT-APG------L"
    assert eic_for_zone("CH") == "10YCH-SWISSGRIDZ"


def test_zone_mapping_unknown_zone_raises():
    with pytest.raises(ValueError):
        eic_for_zone("FR")


def test_config_from_env_requires_token():
    with pytest.raises(PriceSourceError):
        EntsoeConfig.from_env({})
    cfg = EntsoeConfig.from_env({"ENTSOE_SECURITY_TOKEN": "tok"})
    assert cfg.security_token == "tok"
    assert cfg.base_url.endswith("/api")


def _source(http):
    cfg = EntsoeConfig(security_token="secret-token", base_url="https://example/api")
    return EntsoeDayAheadPriceSource(cfg, http_client=http)


def test_fetch_builds_correct_request_params(pt60m_xml):
    http = FakeHttpClient(response=HttpResponse(200, pt60m_xml))
    series = _source(http).fetch_day_ahead_prices("DE-LU", *WINDOW)

    assert len(series) == 24
    call = http.calls[0]
    assert call["url"] == "https://example/api"
    params = call["params"]
    assert params["securityToken"] == "secret-token"
    assert params["documentType"] == "A44"
    assert params["in_Domain"] == "10Y1001A1001A82H"
    assert params["out_Domain"] == "10Y1001A1001A82H"
    assert params["periodStart"] == "202607012200"
    assert params["periodEnd"] == "202607022200"


def test_fetch_401_is_price_source_error(pt60m_xml):
    http = FakeHttpClient(response=HttpResponse(401, "unauthorized"))
    with pytest.raises(PriceSourceError):
        _source(http).fetch_day_ahead_prices("DE-LU", *WINDOW)


def test_fetch_500_is_unavailable():
    http = FakeHttpClient(response=HttpResponse(503, "busy"))
    with pytest.raises(PriceSourceUnavailable):
        _source(http).fetch_day_ahead_prices("DE-LU", *WINDOW)


def test_fetch_transport_error_is_unavailable():
    http = FakeHttpClient(error=ConnectionError("dns fail"))
    with pytest.raises(PriceSourceUnavailable):
        _source(http).fetch_day_ahead_prices("DE-LU", *WINDOW)

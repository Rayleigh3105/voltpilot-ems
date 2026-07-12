"""Zone->EIC mapping and the ENTSO-E adapter's request/response handling."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from voltpilot_market_data.entsoe import (
    EntsoeConfig,
    EntsoeDayAheadPriceSource,
    redact,
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


def test_redact_strips_query_string_and_token():
    # The exact urllib3 shape: full URL incl. the token in the query string.
    exc = ConnectionError(
        "HTTPSConnectionPool(host='web-api.tp.entsoe.eu', port=443): "
        "Max retries exceeded with url: /api?securityToken=SECRET-123"
        "&documentType=A44 (Caused by NameResolutionError)"
    )
    safe = redact(exc)
    assert "SECRET-123" not in safe
    assert "<redacted>" in safe
    # Belt-and-braces: a token outside a URL/query context is redacted too.
    assert "tok-99" not in redact(ValueError("securityToken=tok-99 rejected"))
    # Text without a token passes through unchanged.
    assert redact(ValueError("dns fail")) == "dns fail"


def test_fetch_transport_error_never_leaks_the_token(caplog):
    """S3: the token must reach neither the warning log nor the raised message
    nor the exception chain (an uncaught traceback prints the cause)."""
    token = "SECRET-TOKEN-XYZ"
    err = ConnectionError(
        "Max retries exceeded with url: "
        f"/api?securityToken={token}&documentType=A44"
    )
    http = FakeHttpClient(error=err)
    cfg = EntsoeConfig(security_token=token, base_url="https://example/api")
    source = EntsoeDayAheadPriceSource(cfg, http_client=http)

    with caplog.at_level("WARNING", logger="voltpilot.market_data.entsoe"):
        with pytest.raises(PriceSourceUnavailable) as excinfo:
            source.fetch_day_ahead_prices("DE-LU", *WINDOW)

    assert token not in str(excinfo.value)
    assert excinfo.value.__cause__ is None  # raised `from None`
    assert excinfo.value.__suppress_context__ is True
    for record in caplog.records:
        assert token not in str(record.__dict__.get("context", ""))
        assert token not in record.getMessage()

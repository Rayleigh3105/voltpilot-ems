"""Adapter tests for the keyless Open-Meteo weather source + collector.

Offline: a fake HttpClient replays a recorded Open-Meteo response, so parse +
mapping + the PV-provider adaptation + the collector's store all run without a
network or a database (CI-safe).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.http import HttpResponse
from voltpilot_forecast.openmeteo import (
    OpenMeteoConfig,
    OpenMeteoWeatherProvider,
    OpenMeteoWeatherSource,
    WeatherSourceError,
    parse_forecast_response,
)
from voltpilot_forecast.weather_collect import SiteRow, collect_once
from voltpilot_forecast.weather_repository import InMemoryWeatherForecastRepository

FIXTURES = Path(__file__).parent / "fixtures"
BERLIN = GeoLocation(latitude=52.52, longitude=13.405)
RUN_AT = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)
TENANT = "00000000-0000-0000-0000-000000000001"
SITE = "00000000-0000-0000-0000-000000000002"


def _fixture() -> str:
    return (FIXTURES / "open_meteo_berlin.json").read_text(encoding="utf-8")


class _FakeHttp:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls: list[dict] = []

    def get(self, url, params, timeout):
        self.calls.append({"url": url, "params": dict(params), "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.response


# ---- parsing -------------------------------------------------------------


def test_parses_hourly_points_with_all_channels():
    fc = parse_forecast_response(_fixture(), TENANT, SITE, RUN_AT)
    assert len(fc) == 5
    assert fc.source == "open-meteo"
    p0 = fc.points[0]
    assert p0.timestamp == datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)
    assert p0.temperature_c == 14.2
    assert p0.cloud_cover_pct == 80.0
    assert p0.ghi_w_m2 == 0.0
    midday = fc.points[3]
    assert midday.ghi_w_m2 == 720.0
    assert midday.dni_w_m2 == 540.0
    assert midday.dhi_w_m2 == 180.0


def test_parse_makes_times_utc_aware():
    fc = parse_forecast_response(_fixture(), TENANT, SITE, RUN_AT)
    assert all(p.timestamp.tzinfo is not None for p in fc.points)


def test_missing_hourly_block_raises():
    with pytest.raises(WeatherSourceError):
        parse_forecast_response(json.dumps({"latitude": 1.0}), TENANT, SITE, RUN_AT)


def test_invalid_json_raises():
    with pytest.raises(WeatherSourceError):
        parse_forecast_response("not json", TENANT, SITE, RUN_AT)


# ---- source (HTTP seam) --------------------------------------------------


def test_source_builds_keyless_request():
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(
        OpenMeteoConfig(base_url="https://api.open-meteo.com", forecast_days=3),
        http_client=http,
    )
    fc = source.fetch(BERLIN, TENANT, SITE, RUN_AT)

    call = http.calls[0]
    assert call["url"] == "https://api.open-meteo.com/v1/forecast"
    assert call["params"]["latitude"].startswith("52.52")
    assert call["params"]["timezone"] == "UTC"
    assert "shortwave_radiation" in call["params"]["hourly"]
    # No key/token param anywhere - the source is keyless.
    assert "apikey" not in call["params"] and "key" not in call["params"]
    assert len(fc) == 5


def test_source_non_200_raises():
    http = _FakeHttp(response=HttpResponse(429, "rate limited"))
    source = OpenMeteoWeatherSource(http_client=http)
    with pytest.raises(WeatherSourceError):
        source.fetch(BERLIN, TENANT, SITE, RUN_AT)


# ---- PV provider adaptation ---------------------------------------------


def test_weather_provider_yields_measured_irradiance_for_pv():
    fc = parse_forecast_response(_fixture(), TENANT, SITE, RUN_AT)
    provider = OpenMeteoWeatherProvider(forecast=fc)
    samples = provider.irradiance(
        BERLIN,
        [
            datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc),  # -> 12:00 hour
            datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc),
        ],
    )
    assert samples[0].ghi_w_m2 == 720.0
    assert samples[0].dni_w_m2 == 540.0
    assert samples[1].ghi_w_m2 == 0.0


def test_weather_provider_zero_outside_horizon():
    fc = parse_forecast_response(_fixture(), TENANT, SITE, RUN_AT)
    provider = OpenMeteoWeatherProvider(forecast=fc)
    samples = provider.irradiance(
        BERLIN, [datetime(2030, 1, 1, 12, 0, tzinfo=timezone.utc)]
    )
    assert samples[0].ghi_w_m2 == 0.0


# ---- collector store -----------------------------------------------------


def test_collect_once_stores_all_sites():
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(http_client=http)
    repo = InMemoryWeatherForecastRepository()
    sites = [SiteRow(tenant_id=TENANT, site_id=SITE, location=BERLIN)]

    written = collect_once(source, sites, repo, RUN_AT)

    assert written == 5
    latest = repo.latest(SITE)
    assert latest is not None and len(latest) == 5
    assert latest.tenant_id == TENANT


def test_collect_once_skips_failing_site_without_crashing():
    http = _FakeHttp(error=RuntimeError("boom"))
    source = OpenMeteoWeatherSource(http_client=http)
    repo = InMemoryWeatherForecastRepository()
    sites = [SiteRow(tenant_id=TENANT, site_id=SITE, location=BERLIN)]

    written = collect_once(source, sites, repo, RUN_AT)
    assert written == 0
    assert repo.latest(SITE) is None

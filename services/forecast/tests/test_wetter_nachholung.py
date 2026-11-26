"""Offline tests for the "Ort berichtigen" weather catch-up (vp-standort-konzept §6.6, B3).

Like test_openmeteo.py's collect_once tests: a fake HttpClient replays a recorded
Open-Meteo response, no network or database.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.http import HttpResponse
from voltpilot_forecast.openmeteo import OpenMeteoConfig, OpenMeteoWeatherSource
from voltpilot_forecast.weather_repository import InMemoryWeatherForecastRepository
from voltpilot_forecast.wetter_nachholung import NachholAuftrag, process_auftraege

FIXTURES = Path(__file__).parent / "fixtures"
TENANT = "00000000-0000-0000-0000-000000000001"
SITE_A = "00000000-0000-0000-0000-000000000002"
SITE_B = "00000000-0000-0000-0000-000000000003"
NEUER_PUNKT = GeoLocation(latitude=48.2085, longitude=16.3738)
RUN_AT = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)


def _fixture() -> str:
    return (FIXTURES / "open_meteo_berlin.json").read_text(encoding="utf-8")


class _FakeHttp:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls: list[dict] = []

    def get(self, url, params, timeout):
        self.calls.append({"url": url, "params": dict(params)})
        if self.error is not None:
            raise self.error
        return self.response


def test_discards_the_old_point_and_stores_the_new_one():
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(past_days=28), http_client=http)
    repo = InMemoryWeatherForecastRepository()
    alt = source.fetch(GeoLocation(latitude=52.52, longitude=13.405), TENANT, SITE_A, RUN_AT)
    repo.save(alt)
    assert repo.latest(SITE_A) is not None

    auftrag = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT)
    erledigt = process_auftraege([auftrag], source, repo)

    assert erledigt == [auftrag]
    assert http.calls[-1]["params"]["past_days"] == "28"
    assert http.calls[-1]["params"]["latitude"].startswith("48.2085")
    # Verworfen und neu gespeichert, nicht nur ergänzt - exakt ein Lauf steht da.
    assert repo.latest(SITE_A) is not None


def test_ein_fehlschlag_laesst_die_anderen_auftraege_unberuehrt():
    http = _FakeHttp(error=RuntimeError("boom"))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(past_days=28), http_client=http)
    repo = InMemoryWeatherForecastRepository()
    a = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT)
    b = NachholAuftrag(id=2, tenant_id=TENANT, site_id=SITE_B, location=NEUER_PUNKT)

    erledigt = process_auftraege([a, b], source, repo)

    assert erledigt == []
    assert repo.latest(SITE_A) is None
    assert repo.latest(SITE_B) is None


def test_nur_die_erfolgreichen_auftraege_kommen_in_die_rueckgabe():
    ok_http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(past_days=28), http_client=ok_http)
    repo = InMemoryWeatherForecastRepository()
    a = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT)

    erledigt = process_auftraege([a], source, repo)

    assert [x.id for x in erledigt] == [1]

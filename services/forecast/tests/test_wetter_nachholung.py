"""Offline tests for the "Ort berichtigen" (vp-standort-konzept §6.6, B3) and Umzug
(§7, E1 = B) weather catch-up.

Like test_openmeteo.py's collect_once tests: a fake HttpClient replays a recorded
Open-Meteo response, no network or database.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

import voltpilot_forecast.wetter_nachholung as wetter_nachholung
from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.http import HttpResponse
from voltpilot_forecast.openmeteo import OpenMeteoConfig, OpenMeteoWeatherSource, WeatherForecast, WeatherPoint
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


# ---- Umzug (§7, E1 = B): das Wetter trennt sich am Umzugstag --------------------------------

ALTER_PUNKT = GeoLocation(latitude=52.52, longitude=13.405)
#: Die Fixtur hat feste Stunden am 01.07.2026 (_fixture) - der Umzugstag liegt bewusst DAVOR,
#: damit "ab dem Umzugstag" die Fixtur-Punkte trifft, egal wie "jetzt" später gewählt wird.
UMZUGSTAG = date(2026, 6, 25)
JETZT = datetime(2026, 7, 5, 6, 0, tzinfo=timezone.utc)


def _alte_punkte_sitzen(repo: InMemoryWeatherForecastRepository) -> None:
    """Wetter, das VOR dem Nachholen schon am ALTEN Punkt gelernt war - ein Tag vor dem
    Umzugstag (bleibt stehen) und einer danach, aber noch vor der Fixtur (wird ersetzt)."""
    repo.save(
        WeatherForecast(
            tenant_id=TENANT,
            site_id=SITE_A,
            latitude=ALTER_PUNKT.latitude,
            longitude=ALTER_PUNKT.longitude,
            run_at=datetime(2026, 6, 24, 6, 0, tzinfo=timezone.utc),
            points=(
                WeatherPoint(timestamp=datetime(2026, 6, 24, 12, 0, tzinfo=timezone.utc), temperature_c=1.0,
                              cloud_cover_pct=None, ghi_w_m2=None, dni_w_m2=None, dhi_w_m2=None, dni_normal_w_m2=None),
                WeatherPoint(timestamp=datetime(2026, 6, 26, 12, 0, tzinfo=timezone.utc), temperature_c=2.0,
                              cloud_cover_pct=None, ghi_w_m2=None, dni_w_m2=None, dhi_w_m2=None, dni_normal_w_m2=None),
            ),
            source="open-meteo",
        )
    )


def test_umzug_behaelt_das_wetter_vor_dem_umzugstag_und_ersetzt_nur_ab_dann(monkeypatch):
    monkeypatch.setattr(wetter_nachholung, "_now_utc", lambda: JETZT)
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(), http_client=http)
    repo = InMemoryWeatherForecastRepository()
    _alte_punkte_sitzen(repo)

    auftrag = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT, ab_tag=UMZUGSTAG)
    erledigt = process_auftraege([auftrag], source, repo)

    assert erledigt == [auftrag]
    # past_days ist dynamisch (heute - Umzugstag), nicht der feste Wert der Berichtigung.
    assert http.calls[-1]["params"]["past_days"] == "10"
    assert http.calls[-1]["params"]["latitude"].startswith("48.2085")

    ergebnis = repo.latest(SITE_A)
    assert ergebnis is not None
    cutoff = datetime(2026, 6, 25, tzinfo=timezone.utc)
    zeiten = sorted(p.timestamp for p in ergebnis.points)
    # Der 24.06. (vor dem Umzugstag) ist noch da, UNVERÄNDERT vom alten Punkt gelernt.
    vor_umzug = [p for p in ergebnis.points if p.timestamp < cutoff]
    assert len(vor_umzug) == 1
    assert vor_umzug[0].temperature_c == 1.0
    # Ab dem Umzugstag kommt alles vom NEUEN Fetch (Fixtur) - der alte 26.06.-Punkt ist weg.
    ab_umzug = [p for p in ergebnis.points if p.timestamp >= cutoff]
    assert ab_umzug
    assert all(p.timestamp.date() == date(2026, 7, 1) for p in ab_umzug)  # aus der Fixtur
    assert all(p.temperature_c != 2.0 for p in ab_umzug)
    assert zeiten == sorted(zeiten)


def test_umzug_laenger_als_92_tage_zurueck_kappt_bei_past_days_max(monkeypatch):
    monkeypatch.setattr(wetter_nachholung, "_now_utc", lambda: JETZT)
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(), http_client=http)
    repo = InMemoryWeatherForecastRepository()

    auftrag = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT,
                              ab_tag=date(2026, 1, 1))
    process_auftraege([auftrag], source, repo)

    assert http.calls[-1]["params"]["past_days"] == str(wetter_nachholung.PAST_DAYS_MAX)


def test_eine_berichtigung_ohne_ab_tag_ersetzt_weiter_alles():
    http = _FakeHttp(response=HttpResponse(200, _fixture()))
    source = OpenMeteoWeatherSource(OpenMeteoConfig(past_days=28), http_client=http)
    repo = InMemoryWeatherForecastRepository()
    _alte_punkte_sitzen(repo)

    auftrag = NachholAuftrag(id=1, tenant_id=TENANT, site_id=SITE_A, location=NEUER_PUNKT)
    process_auftraege([auftrag], source, repo)

    ergebnis = repo.latest(SITE_A)
    assert ergebnis is not None
    # Keine Spur der alten Temperatur-Werte - "Adresse war falsch" ersetzt wie gehabt alles.
    assert all(p.temperature_c != 1.0 and p.temperature_c != 2.0 for p in ergebnis.points)
    assert http.calls[-1]["params"]["past_days"] == "28"

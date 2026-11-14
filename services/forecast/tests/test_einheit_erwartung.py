"""Anlagen-Check A1: die Erwartung je Einheit (reine Rechnung).

Bauplan §9.2 A1, Tests: "Summe je Einheit = Summe der Flächen; Einheit ohne
Fläche".
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_forecast.domain import GeoLocation, PlantSpec
from voltpilot_forecast.einheit_erwartung import (
    EinheitSpec,
    InMemoryEinheitErwartungRepository,
    anteile_je_slot,
    einheiten_aus_zeilen,
    erwartung_je_einheit,
    physikalische_leistung,
    zeilen_fuer_tag,
)
from voltpilot_forecast.evaluation import berlin_day_bounds
from voltpilot_forecast.rueckblick import _slot_zeiten, tageskwh

ORT = GeoLocation(latitude=48.6, longitude=12.7)
TAG = date(2026, 6, 21)


def _zeiten(day: date = TAG) -> list[datetime]:
    start, end = berlin_day_bounds(day)
    return _slot_zeiten(start, end)


def _abendlauf(zeiten: list[datetime], peak_kw: float = 8.0) -> dict[datetime, float]:
    """Eine glockenförmige Tageskurve als Abend-Lauf der Anlage."""
    werte = {}
    for t in zeiten:
        stunde = t.astimezone(timezone.utc).hour + t.minute / 60
        werte[t] = max(0.0, peak_kw * (1 - ((stunde - 11.0) / 7.0) ** 2))
    return werte


def test_summe_der_einheiten_ist_die_tagessumme_des_abendlaufs():
    zeiten = _zeiten()
    einheiten = [
        EinheitSpec("ost", 4.0, (PlantSpec(capacity_kwp=4.0, azimuth_deg=90.0, tilt_deg=30.0),)),
        EinheitSpec("west", 6.0, (PlantSpec(capacity_kwp=6.0, azimuth_deg=270.0, tilt_deg=30.0),)),
        EinheitSpec("sued", 3.0, (PlantSpec(capacity_kwp=3.0),)),
    ]
    leistung = physikalische_leistung(ORT, einheiten, zeiten, [])
    predicted = _abendlauf(zeiten)
    kwh = erwartung_je_einheit(predicted, zeiten, anteile_je_slot(einheiten, leistung))
    tagessumme = sum(max(0.0, v) for v in predicted.values()) * 0.25
    assert sum(kwh.values()) == pytest.approx(tagessumme, abs=1e-3)
    # Und dieselbe Zahl wie der Rückblick der Anlage über alle Viertelstunden.
    erwartet_anlage, _, _ = tageskwh(predicted, {t: 0.0 for t in zeiten})
    assert sum(kwh.values()) == pytest.approx(erwartet_anlage, abs=1e-3)


def test_ost_bekommt_den_morgen_west_den_abend():
    zeiten = _zeiten()
    einheiten = [
        EinheitSpec("ost", 5.0, (PlantSpec(capacity_kwp=5.0, azimuth_deg=90.0, tilt_deg=45.0),)),
        EinheitSpec("west", 5.0, (PlantSpec(capacity_kwp=5.0, azimuth_deg=270.0, tilt_deg=45.0),)),
    ]
    anteile = anteile_je_slot(einheiten, physikalische_leistung(ORT, einheiten, zeiten, []))
    morgen = zeiten[4 * 7]  # 07:00 Berlin (Sommerzeit)
    abend = zeiten[4 * 18]  # 18:00 Berlin
    assert anteile[4 * 7]["ost"] > 0.6, morgen
    assert anteile[4 * 18]["west"] > 0.6, abend


def test_nachts_teilt_die_kwp():
    einheiten = [
        EinheitSpec("a", 3.0, (PlantSpec(capacity_kwp=3.0),)),
        EinheitSpec("b", 1.0, (PlantSpec(capacity_kwp=1.0),)),
    ]
    anteile = anteile_je_slot(einheiten, {"a": [0.0], "b": [0.0]})
    assert anteile == [{"a": 0.75, "b": 0.25}]


def test_slot_ohne_prognose_traegt_nichts_bei_und_negativ_ist_null():
    t0 = datetime(2026, 6, 21, 10, tzinfo=timezone.utc)
    zeiten = [t0, t0 + timedelta(minutes=15), t0 + timedelta(minutes=30)]
    anteile = [{"a": 1.0}] * 3
    kwh = erwartung_je_einheit({t0: 4.0, zeiten[2]: -1.0}, zeiten, anteile)
    assert kwh == {"a": 1.0}


def test_einheit_ohne_flaeche_zaehlt_mit_ganzer_kwp_nach_sueden():
    rows = [
        ("s1", "e1", 9.8, 180.0, 35.0, 6.0),
        ("s1", "e1", 9.8, 270.0, 35.0, 3.8),
        ("s1", "e2", 4.0, None, None, None),
    ]
    specs = einheiten_aus_zeilen(rows)["s1"]
    assert [s.einheit_id for s in specs] == ["e1", "e2"]
    assert len(specs[0].flaechen) == 2
    assert specs[1].flaechen == (PlantSpec(capacity_kwp=4.0),)


def test_anlage_mit_einer_einheit_ohne_leistung_faellt_heraus():
    rows = [("s1", "e1", 5.0, None, None, None), ("s1", "e2", None, None, None, None)]
    assert einheiten_aus_zeilen(rows) == {}


def test_zeilen_fuer_tag_traegt_kwp_und_modell_und_upsert_ist_idempotent():
    zeiten = _zeiten()
    einheiten = [
        EinheitSpec("a", 6.0, (PlantSpec(capacity_kwp=6.0),)),
        EinheitSpec("b", 2.0, (PlantSpec(capacity_kwp=2.0),)),
    ]
    leistung = physikalische_leistung(ORT, einheiten, zeiten, [])
    zeilen = zeilen_fuer_tag(
        day=TAG, tenant_id="t", site_id="s", model="pv-physical", lead_days=1,
        predicted=_abendlauf(zeiten), zeiten=zeiten, einheiten=einheiten, leistung=leistung,
    )
    assert [(z.einheit_id, z.leistung_kwp) for z in zeilen] == [("a", 6.0), ("b", 2.0)]
    # Gleiche Ausrichtung: die Aufteilung folgt der kWp.
    assert zeilen[0].erwartet_kwh == pytest.approx(3 * zeilen[1].erwartet_kwh, rel=1e-3)
    repo = InMemoryEinheitErwartungRepository()
    for z in zeilen + zeilen:
        repo.upsert(z)
    assert len(repo.rows) == 2


def test_zeitumstellung_hat_92_und_100_viertelstunden():
    assert len(_zeiten(date(2026, 3, 29))) == 92
    assert len(_zeiten(date(2026, 10, 25))) == 100


# ---- der Lauf: rueckblick_day mit einer Attrappe der Datenbank ----------------

class _Cursor:
    """Antwortet nach dem SQL-Text - nur was rueckblick_day fragt."""

    def __init__(self, db: "_Db") -> None:
        self.db = db
        self._rows: list = []
        self.connection = db

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, params=()):
        s = " ".join(sql.split())
        if "FROM site s JOIN tenant" in s:
            self._rows = [("t1", "s1")]
        elif "telemetry_fuehrende_box" in s:
            self._rows = [(None,)]
        elif "FROM telemetry" in s:
            self._rows = []  # keine Messung: "erwartet" braucht keine
        elif "FROM register_einheit" in s:
            self._rows = [
                ("s1", "e-ost", 4.0, 90.0, 30.0, 4.0),
                ("s1", "e-west", 4.0, 270.0, 30.0, 4.0),
            ]
        elif "SELECT DISTINCT model FROM forecast" in s:
            self._rows = [("pv-physical",)] if params[1] == "pv" else []
        elif "SELECT DISTINCT run_at FROM forecast" in s:
            self._rows = [(params[3] + timedelta(minutes=2),)]
        elif "SELECT time, value_kw FROM forecast" in s:
            self._rows = list(self.db.abendlauf.items())
        elif "FROM site WHERE id" in s:
            self._rows = [(48.6, 12.7)]
        elif "FROM weather_forecast" in s:
            self._rows = []
        else:
            raise AssertionError(f"unerwartete Abfrage: {s[:80]}")

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Db:
    def __init__(self, abendlauf):
        self.abendlauf = abendlauf

    def cursor(self):
        return _Cursor(self)

    def rollback(self):
        pass


def test_rueckblick_day_legt_die_einheiten_ab_auch_ohne_messung():
    from voltpilot_forecast.rueckblick import rueckblick_day
    from voltpilot_forecast.rueckblick_repository import InMemoryRueckblickRepository

    zeiten = _zeiten()
    abendlauf = _abendlauf(zeiten)
    anlage = InMemoryRueckblickRepository()
    einheiten = InMemoryEinheitErwartungRepository()
    rows = rueckblick_day(_Db(abendlauf), anlage, TAG, einheiten)
    assert rows == 2
    assert anlage.rows == {}  # ohne Messung keine Zeile der Anlage
    werte = {k[1]: r.erwartet_kwh for k, r in einheiten.rows.items()}
    assert set(werte) == {"e-ost", "e-west"}
    assert sum(werte.values()) == pytest.approx(
        sum(abendlauf.values()) * 0.25, abs=1e-3
    )


def test_rueckblick_day_ohne_einheiten_repository_bleibt_wie_bisher():
    from voltpilot_forecast.rueckblick import rueckblick_day
    from voltpilot_forecast.rueckblick_repository import InMemoryRueckblickRepository

    assert rueckblick_day(_Db(_abendlauf(_zeiten())), InMemoryRueckblickRepository(), TAG) == 0

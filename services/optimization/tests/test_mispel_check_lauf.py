"""MiSpeL MP-13b: der Check je Anlage - Fenster, Datenbasis, Formelsatz nach den
Zählerrollen, Posten-Vokabular und wann neu gerechnet wird; ohne Datenbank.
Der Lauf gegen eine echte Datenbank steht in ``test_mispel_check_lauf_db.py``."""

from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.simulation import mispel_check as mc
from voltpilot_optimization.simulation import mispel_check_lauf as lauf

F = lauf.fenster(date(2026, 10, 2))
JETZT = datetime(2026, 10, 2, 3, 0, tzinfo=timezone.utc)

#: Eine Simulator-Anlage mit Z1/Z2 und einem vollen Jahr Verlauf.
SIMULATOR = lauf.Stammdaten(
    tenant_id=uuid4(), site_id=uuid4(), zone="DE-LU", speicher_kwh=65.0, speicher_kw=30.0,
    foerderweg="marktpraemie_ausschliesslichkeit", formelsatz=None, pv_kwp=100.0,
    latitude=48.62, longitude=12.55, anzulegender_wert_ct=6.9, zaehler=frozenset({"Z1", "Z2"}),
    verbrauch_tage=365, verbrauch_kwh=58_400.0, erzeugung_tage=365, erzeugung_kwh=101_000.0,
)
#: Eine Bestandsanlage ohne Zähler, ohne Verlauf, ohne Preisblatt.
BESTAND = lauf.Stammdaten(
    tenant_id=uuid4(), site_id=uuid4(), zone="DE-LU", speicher_kwh=10.0, speicher_kw=5.0,
    foerderweg="marktpraemie_ausschliesslichkeit", formelsatz=None, pv_kwp=9.9,
    anzulegender_wert_ct=8.2,
)


def _angabe(e: lauf.Eingang, name: str) -> dict:
    return next(a for a in e.datenbasis if a["angabe"] == name)


# --------------------------------------------------------------------------- Fenster


def test_fenster_sind_die_letzten_zwoelf_vollen_monate():
    assert (F.beginn, F.monate, F.von, F.bis, F.tage) == ((2025, 10), 12, date(2025, 10, 1), date(2026, 9, 30), 365)
    jan = lauf.fenster(date(2026, 1, 1))
    assert (jan.beginn, jan.von, jan.bis) == ((2025, 1), date(2025, 1, 1), date(2025, 12, 31))


# --------------------------------------------------------------------------- Datenbasis


def test_simulator_anlage_gemessen_und_formelsatz_aus_z1_z2():
    e = lauf.eingang(SIMULATOR, F)
    assert e.stand is None and e.formelsatz == "A1"
    assert _angabe(e, "Formelsatz") == {
        "angabe": "Formelsatz", "wert": "A1", "einheit": None, "herkunft": "angenommen",
        "quelle": "Zähler Z1 und Z2: Basisfall A1 (Gebot der Bestnutzung, A1 S. 24)"}
    verbrauch = _angabe(e, "Jahresverbrauch")
    assert verbrauch["herkunft"] == "gemessen" and verbrauch["wert"] == 58_400
    assert verbrauch["quelle"] == "Verlauf 01.10.2025–30.09.2026, 365 von 365 Tagen"
    assert _angabe(e, "Erzeugung im Jahr")["wert"] == 101_000
    assert e.anlage.jahresverbrauch_kwh == 58_400 and e.anlage.pv_jahreserzeugung_kwh == 101_000
    assert (e.anlage.latitude, e.anlage.longitude, e.anlage.anzulegender_wert_ct) == (48.62, 12.55, 6.9)
    # Ohne Preisblatt: die Gewerbe-Annahmen von MP-13, offengelegt.
    assert _angabe(e, "Netzentgelt-Arbeitspreis")["herkunft"] == "angenommen"
    assert e.anlage.netzentgelt_arbeitspreis_ct == 4.0 and e.anlage.ust_pct == 0.0


def test_bestandsanlage_ohne_messreihe_ist_angenommen():
    e = lauf.eingang(BESTAND, F)
    assert e.formelsatz == "A1" and e.anlage is not None
    assert _angabe(e, "Formelsatz")["quelle"].startswith("Basisfall A1 für Erzeugungsanlage mit Speicher; Z2 fehlt")
    verbrauch = _angabe(e, "Jahresverbrauch")
    assert (verbrauch["wert"], verbrauch["herkunft"], verbrauch["quelle"]) == (60_000, "angenommen", "Konzept § 3 a2 (Gewerbe)")
    assert _angabe(e, "Erzeugung im Jahr")["herkunft"] == "angenommen"
    assert _angabe(e, "Standort")["herkunft"] == "angenommen"
    assert e.anlage.pv_jahreserzeugung_kwh is None and e.anlage.jahresverbrauch_kwh == 60_000.0


def test_luecken_im_verlauf_unter_neunzig_prozent_sind_keine_messung():
    e = lauf.eingang(replace(SIMULATOR, verbrauch_tage=320), F)
    assert _angabe(e, "Jahresverbrauch")["herkunft"] == "angenommen"
    e = lauf.eingang(replace(SIMULATOR, verbrauch_tage=330, verbrauch_kwh=33_000.0), F)
    v = _angabe(e, "Jahresverbrauch")
    assert v["herkunft"] == "gemessen" and v["wert"] == 36_500  # 33 000 × 365 / 330
    assert v["quelle"].endswith("330 von 365 Tagen, aufs Fenster hochgerechnet")


def test_gewaehlter_formelsatz_ist_stammdaten():
    e = lauf.eingang(replace(SIMULATOR, foerderweg="marktpraemie_abgrenzung", formelsatz="A1"), F)
    assert _angabe(e, "Formelsatz")["herkunft"] == "stammdaten"


def test_ohne_erzeugung_a10_oder_a11_nach_dem_verbrauch():
    netz = replace(BESTAND, pv_kwp=None, anzulegender_wert_ct=None, verbrauch_tage=365, verbrauch_kwh=0.0)
    e = lauf.eingang(netz, F)
    assert e.formelsatz == "A10" and e.anlage.jahresverbrauch_kwh == 0.0 and e.anlage.pv_kwp == 0.0
    e = lauf.eingang(replace(netz, verbrauch_kwh=20_000.0), F)
    assert e.formelsatz == "A11" and e.anlage.jahresverbrauch_kwh == 20_000.0
    # Ohne Messreihe: mit sonstigem Verbrauch angenommen.
    assert lauf.eingang(replace(netz, verbrauch_tage=0), F).formelsatz == "A11"
    # Z1 und Z2 schließen die vereinfachten Fälle aus (A1 S. 24) - A1 ohne Erzeugung rechnet der Check nicht.
    e = lauf.eingang(replace(netz, zaehler=frozenset({"Z1", "Z2"})), F)
    assert (e.formelsatz, e.stand) == ("A1", lauf.STAND_NICHT_UNTERSTUETZT)


def test_formelsaetze_ohne_rechnung_bekommen_einen_satz():
    e = lauf.eingang(replace(SIMULATOR, zaehler=frozenset({"Z1", "Z2", "Z3"})), F)
    assert (e.formelsatz, e.stand, e.anlage) == ("A4", lauf.STAND_NICHT_UNTERSTUETZT, None)
    assert mc.NICHT_UNTERSTUETZT in e.hinweis
    e = lauf.eingang(replace(SIMULATOR, foerderweg="marktpraemie_abgrenzung", formelsatz="A5"), F)
    assert e.stand == lauf.STAND_NICHT_UNTERSTUETZT and "A5" in e.hinweis
    e = lauf.eingang(replace(BESTAND, anzulegender_wert_ct=None), F)
    assert e.stand == lauf.STAND_NICHT_UNTERSTUETZT and "anzulegenden Wert" in e.hinweis
    # Widersprüchliche Stammdaten: kein Betrag, ein Satz.
    e = lauf.eingang(replace(SIMULATOR, foerderweg="ungefoerdert", formelsatz="A10"), F)
    assert e.stand == lauf.STAND_FEHLGESCHLAGEN and "ohne sonstige Erzeugung" in e.hinweis


def test_pv_reihe_wird_auf_die_gemessene_erzeugung_skaliert():
    reihe = [0.0, 4.0, 8.0, 4.0]  # 4 kWh in vier Viertelstunden
    assert sum(mc._skaliert(reihe, 120.0, 1)) * 0.25 == pytest.approx(10.0)
    assert mc._skaliert(reihe, None, 12) is reihe
    assert mc.anlage_aus_json({"formelsatz": "A10", "speicher_kwh": 1.0, "speicher_kw": 1.0}).formelsatz == "A10"
    with pytest.raises(ValueError, match="unbekannte Angaben"):
        mc.anlage_aus_json({"formelsatz": "A10", "speicher_kwh": 1.0, "speicher_kw": 1.0, "kapazitaet": 2})


# --------------------------------------------------------------------------- Posten


def _ergebnis(posten_je_fall: dict[str, list[tuple[str, float]]]) -> dict:
    return {
        "fenster": {"von": "2025-10-01", "bis": "2026-09-30"},
        "faelle": {name: {"posten": [{"posten": p, "eur": eur, "herkunft": "h"} for p, eur in ps]}
                   for name, ps in posten_je_fall.items()},
        "spanne": {name: round(sum(eur for _, eur in ps), 2) for name, ps in posten_je_fall.items()},
    }


def test_posten_auf_das_geschlossene_vokabular_je_fall():
    a1 = [("Netzladen-Handel mit Saldierung", 300.0), ("Jahresmarktwert statt Monatsmarktwert", -200.0),
          ("Zweiter Zähler Z2", -450.0), ("Gesonderter Bilanzkreis", -150.0)]
    zeile = lauf.ergebnis_zeile(_ergebnis({"niedrig": a1, "mittel": a1, "hoch": a1}))
    assert [p["art"] for p in zeile["posten"]] == ["handel_saldierung", "jahresmarktwert", "zaehler_z2", "bilanzkreis"]
    assert zeile["posten"][2] == {"art": "zaehler_z2", "niedrig_eur": -450.0, "mittel_eur": -450.0,
                                  "hoch_eur": -450.0, "herkunft": "h"}
    assert zeile["differenz"] == {"niedrig": -500.0, "mittel": -500.0, "hoch": -500.0}
    a10 = [("Handel mit Saldierung (MiSpeL)", 900.0), ("abzüglich Handel heute ohne Saldierung", -400.0),
           ("Mehr Vermarktungsentgelt auf die zusätzliche Rückspeisung", -12.0)]
    arten = [p["art"] for p in lauf.ergebnis_zeile(_ergebnis(dict.fromkeys(mc.FAELLE, a10)))["posten"]]
    assert arten == ["handel_saldierung", "handel_heute", "vermarktungsentgelt"]
    assert set(lauf.POSTEN_ART.values()) == {
        "handel_saldierung", "handel_heute", "jahresmarktwert", "zaehler_z2", "bilanzkreis", "vermarktungsentgelt"}


def test_ein_unbekannter_posten_faellt_nie_still_heraus():
    with pytest.raises(ValueError, match="unbekannter Posten"):
        lauf.ergebnis_zeile(_ergebnis(dict.fromkeys(mc.FAELLE, [("Neuer Posten", 1.0)])))
    with pytest.raises(ValueError, match="es fehlen Fälle"):
        lauf.ergebnis_zeile(_ergebnis({"mittel": []}))


# --------------------------------------------------------------------------- wann neu gerechnet wird


def test_neu_gerechnet_wird_nur_was_nicht_aktuell_ist():
    e = lauf.eingang(SIMULATOR, F)
    fertig = lauf.Zeile("fertig", JETZT - timedelta(days=3), "A1", F.bis, e.datenbasis)
    assert lauf.grund(None, e, F, JETZT) == "noch nie gerechnet"
    assert lauf.grund(fertig, e, F, JETZT) is None
    assert lauf.grund(replace(fertig, stand="wird_gerechnet"), e, F, JETZT) == "verwaist in wird_gerechnet"
    assert lauf.grund(replace(fertig, fenster_bis=date(2026, 8, 31)), e, F, JETZT) == "neues Preisfenster"
    anders = lauf.eingang(replace(SIMULATOR, speicher_kwh=80.0), F)
    assert lauf.grund(fertig, anders, F, JETZT) == "Datenbasis geändert"
    fehl = replace(fertig, stand="fehlgeschlagen", fenster_bis=None)
    assert lauf.grund(replace(fehl, stand_seit=JETZT - timedelta(hours=2)), e, F, JETZT) is None
    assert lauf.grund(replace(fehl, stand_seit=JETZT - timedelta(hours=21)), e, F, JETZT) == "neuer Versuch nach Fehlschlag"
    nicht = lauf.eingang(replace(SIMULATOR, zaehler=frozenset({"Z1", "Z2", "Z3"})), F)
    zeile = lauf.Zeile("nicht_unterstuetzt", JETZT - timedelta(days=40), "A4", None, nicht.datenbasis)
    assert lauf.grund(zeile, nicht, F, JETZT) is None

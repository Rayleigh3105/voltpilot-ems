"""Die Verbrauchsbildung gegen die GETEILTEN Vektoren (UEMS AP-08 IP-1).

Diese Suite ist die eine Hälfte des Zwillingspaares: sie fährt
:mod:`voltpilot_optimization.verbrauch` gegen jeden Fall von
``docs/contracts/v2/verbrauch-vectors.json``. Die andere Hälfte ist der Java-Zwilling
``services/api .../uems/VerbrauchRegeln`` mit ``VerbrauchVectorsTest``, der DIESELBE Datei
per Pfad liest. Zwei Umsetzungen einer Rechenregel driften auseinander, sobald sie nicht
beide gegen dieselbe Datei geprüft werden - deshalb steht die Wahrheit in der Datei und
nicht in einer der beiden Sprachen.

Die Vektoren werden PER PFAD gelesen: wer sie verschiebt, bricht diesen Test absichtlich.
"""

from __future__ import annotations

import bisect
import json
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization import verbrauch

VECTORS = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2" / "verbrauch-vectors.json"

DOC = json.loads(VECTORS.read_text(encoding="utf-8"))
CASES = DOC["cases"]

# Die Felder, die die Regel RECHNET. Alles andere in einer Erwartung ist beschreibend
# (``name``, ``von``, ``bis``, ``reihe``, ``version``, ``ereignisse_zusatz``).
GERECHNET = (
    "menge",
    "mittel",
    "min",
    "max",
    "energie_kwh",
    "zustand",
    "erhalten",
    "erwartet",
    "abdeckung_prozent",
    "kennzeichen",
    "stunden",
)

ERWARTUNGEN = [
    pytest.param(case, erwartung, id=f"{case['name']}::{erwartung['name']}")
    for case in CASES
    for erwartung in case["expected"]
]


def _reihe(case: dict, erwartung: dict) -> dict:
    """Die Reihe einer Erwartung: ein Fall hat EINE Reihe oder mehrere mit Namen."""
    if "reihe" in case["input"]:
        return case["input"]["reihe"]
    return case["input"]["reihen"][erwartung["reihe"]]


# --------------------------------------------------------------------- Form der Datei


def test_die_datei_traegt_die_dreiundzwanzig_faelle():
    """23 Fälle, jeder mit Namen, Familie, Begründung und mindestens einer Erwartung."""
    assert len(CASES) == 23
    assert DOC["schema_version"] == "1.0"
    assert DOC["zeitzone"] == "Europe/Berlin"
    namen = [c["name"] for c in CASES]
    assert len(set(namen)) == len(namen)
    for case in CASES:
        assert case["why"].strip(), case["name"]
        assert case["familie"] in {"zaehlerstand", "intervallmenge", "momentanwert", "mehrere-reihen"}
        assert case["ableitung"] in {"einzel", "reihen"}
        assert case["expected"], case["name"]


def test_die_regeln_der_datei_sind_die_regeln_des_moduls():
    """Die Schwellen stehen in der Datei; das Modul schreibt sie nicht selbst fest."""
    regeln = DOC["regeln"]
    assert regeln["luecke_faktor"] == verbrauch.LUECKE_FAKTOR
    assert regeln["integration_halten_faktor"] == verbrauch.HALTEN_FAKTOR
    assert regeln["vergleich_nachkommastellen"] == verbrauch.NACHKOMMASTELLEN
    assert set(DOC["zustaende"]) >= {
        verbrauch.VOLLSTAENDIG,
        verbrauch.UNVOLLSTAENDIG,
        verbrauch.KEINE_WERTE,
    }


def test_beide_plan_abnahmen_sind_vertreten():
    """Die zwei Plan-Abnahmen des Programms hängen namentlich an ihren Fällen."""
    abnahmen = {c["abnahme"] for c in CASES if c["abnahme"] is not None}
    assert abnahmen == {"1", "2"}


def test_jede_erwartung_wird_wirklich_verglichen():
    """Kein Fall darf still durchrutschen: jede Erwartung nennt mindestens ein gerechnetes Feld."""
    for case in CASES:
        for erwartung in case["expected"]:
            felder = [f for f in GERECHNET if f in erwartung]
            assert felder, f"{case['name']}::{erwartung['name']} vergleicht nichts"


# ------------------------------------------------------------------------ Die Vektoren


@pytest.mark.parametrize("case,erwartung", ERWARTUNGEN)
def test_vektor(case: dict, erwartung: dict):
    """Jede Erwartung der Vektor-Datei, Feld für Feld - exakt, ohne Toleranz."""
    ist = verbrauch.ergebnis(
        _reihe(case, erwartung),
        erwartung["von"],
        erwartung["bis"],
        erwartung.get("ereignisse_zusatz", ()),
    )
    for feld in GERECHNET:
        if feld not in erwartung:
            continue
        soll, gerechnet = erwartung[feld], ist.get(feld)
        if feld in ("menge", "mittel", "min", "max", "energie_kwh"):
            if soll is None:
                assert gerechnet is None, f"{feld}: {case['why']}"
            else:
                assert gerechnet is not None, f"{feld} fehlt: {case['why']}"
                assert float(gerechnet) == pytest.approx(float(soll), abs=1e-9), f"{feld}: {case['why']}"
        else:
            assert gerechnet == soll, f"{feld}: {case['why']}"


# ------------------------------------------------- Die Eigenschaften, die die Regel tragen


def test_eine_luecke_ist_nie_eine_null():
    """Hausregel Zahlen-Ehrlichkeit: wo keine Menge bildbar ist, steht None - nie 0."""
    ohne_menge = [
        (c["name"], e["name"])
        for c in CASES
        for e in c["expected"]
        if "menge" in e and e["menge"] is None
    ]
    assert ohne_menge, "kein Fall zeigt die fehlende Menge - der Katalog wäre unvollständig"
    for case in CASES:
        for erwartung in case["expected"]:
            if erwartung.get("zustand") == verbrauch.KEINE_WERTE:
                assert erwartung.get("menge", None) is None
                assert erwartung.get("mittel", None) is None


def test_ein_zaehlerruecksprung_erzeugt_keinen_fiktiven_verbrauch():
    """Plan-Abnahme 1 (F6): über eine Rücksetzung wird nie eine Differenz gebildet.

    Der Beweis ist die Gegenprobe: die naive Differenz Endstand − Anfangsstand liegt weit
    neben der Menge, die die Regel liefert.
    """
    fall = next(c for c in CASES if c["abnahme"] == "1")
    erwartung = fall["expected"][0]
    reihe = _reihe(fall, erwartung)
    werte = verbrauch.rohwerte(reihe)
    in_periode = [
        r
        for r in werte
        if verbrauch._zeit(erwartung["von"]) <= r.zeit < verbrauch._zeit(erwartung["bis"])
    ]
    naiv = float(in_periode[-1].wert - in_periode[0].wert)
    ist = verbrauch.ergebnis(reihe, erwartung["von"], erwartung["bis"])
    assert ist["zustand"] == verbrauch.UNVOLLSTAENDIG
    assert float(ist["menge"]) == pytest.approx(float(erwartung["menge"]))
    assert naiv < 0, "die naive Differenz müsste hier negativ sein (der Zähler sprang zurück)"
    assert any("Rücksetzung" in k for k in ist["kennzeichen"])


def test_eine_luecke_wird_nie_automatisch_aufgefuellt():
    """Plan-Abnahme 2 (F8): der Box-Ausfall erscheint nicht als gemessener Stillstand.

    Der Tageswert bleibt vollständig (die Zählerstände an beiden Tagesgrenzen sind da), die
    Viertelstunden der Lücke liefern aber keine Menge - und die Abdeckung sagt es.
    """
    fall = next(c for c in CASES if c["abnahme"] == "2")
    tag = next(e for e in fall["expected"] if e["name"].startswith("Tag"))
    ist = verbrauch.ergebnis(_reihe(fall, tag), tag["von"], tag["bis"])
    assert ist["zustand"] == verbrauch.VOLLSTAENDIG
    assert ist["abdeckung_prozent"] < 100, "eine Lücke darf nie auf 100 % gerundet werden"
    ohne_werte = [e for e in fall["expected"] if e.get("zustand") == verbrauch.KEINE_WERTE]
    assert ohne_werte, "der Fall zeigt keine Viertelstunde ohne Werte"
    for erwartung in ohne_werte:
        assert verbrauch.ergebnis(_reihe(fall, erwartung), erwartung["von"], erwartung["bis"])["menge"] is None


def test_der_umstellungstag_hat_dreiundzwanzig_oder_fuenfundzwanzig_stunden():
    """P3: Tage sind Kalenderperioden in der Zeitzone des Standorts, keine 24-h-Blöcke."""
    stunden = {
        e["stunden"]
        for c in CASES
        for e in c["expected"]
        if "stunden" in e
    }
    assert stunden == {23, 25}
    for case in CASES:
        for erwartung in case["expected"]:
            if "stunden" in erwartung:
                ist = verbrauch.ergebnis(_reihe(case, erwartung), erwartung["von"], erwartung["bis"])
                assert ist["stunden"] == erwartung["stunden"]


def test_energie_aus_leistung_ist_immer_gekennzeichnet():
    """M4/E5: eine integrierte Energie nennt ihre Herkunft - sonst sähe sie aus wie gemessen."""
    integriert = [
        (c, e)
        for c in CASES
        for e in c["expected"]
        if e.get("energie_kwh") is not None
    ]
    assert integriert, "kein Fall integriert Leistung"
    for case, erwartung in integriert:
        assert any("aus Leistung integriert" in k for k in erwartung["kennzeichen"]), case["name"]


def test_genau_eine_bewusste_abweichung_von_der_vorlage():
    """Die Vektor-Datei nennt jede Stelle, an der sie von ``referenzfaelle.json`` abweicht."""
    abweichungen = DOC["_abweichungen"]
    assert len(abweichungen) == 1
    (eine,) = abweichungen
    assert eine["feld"] == "kennzeichen"
    assert eine["grund"].strip()
    assert eine["fall"].startswith("F15")


# ------------------------------------- Zusammensetzung aus Teilperioden (AP-08 IP-5, P7/§4.5)

_VIERTELSTUNDE = timedelta(minutes=15)
_ORT = ZoneInfo("Europe/Berlin")


def _im_raster(t: datetime) -> bool:
    return int(t.timestamp()) % 900 == 0


def _mitternacht(t: datetime) -> bool:
    lokal = t.astimezone(_ORT)
    return lokal.hour == 0 and lokal.minute == 0 and lokal.second == 0


_LOCKSTEP = [
    pytest.param(case, erwartung, ueber_tage, id=f"{case['name']}::{erwartung['name']}" + ("::tage" if ueber_tage else ""))
    for case in CASES
    for erwartung in case["expected"]
    if _reihe(case, erwartung)["wertart"] == "zaehlerstand"
    for von, bis in [(verbrauch._zeit(erwartung["von"]), verbrauch._zeit(erwartung["bis"]))]
    if bis - von >= 2 * _VIERTELSTUNDE and _im_raster(von) and _im_raster(bis)
    for ueber_tage in ([False, True] if bis - von >= timedelta(hours=46) and _mitternacht(von) and _mitternacht(bis) else [False])
]


def _fenster(werte: list, von: datetime, bis: datetime) -> list:
    """Die Rohwerte in ``[von, bis]`` (sortiert) - genug für Stand(von), die Werte und Stand(bis)."""
    lo = bisect.bisect_left(werte, von, key=lambda r: r.zeit)
    hi = bisect.bisect_right(werte, bis, key=lambda r: r.zeit)
    return werte[lo:hi]


def test_der_lockstep_traegt_die_abnahme_von_ip5():
    """F8 (Tag), F13, F14, F16 und F20 müssen unter den zusammengesetzten Erwartungen sein."""
    assert "nie Summe der Teilmengen" in DOC["regeln"]["teilperioden"]
    namen = {p.id for p in _LOCKSTEP}
    for teil in (
        "f8-plan-abnahme-2::Tag 03.11.2026",
        "f13-sommerzeit-ende-25-10-2026::Tag 25.10.2026 (25 h)",
        "f14-sommerzeit-beginn-28-03-2027::Tag 28.03.2027 (23 h)",
        "Monat Oktober 2026::tage",
        "Zeitraum 20.–21.10.2026::tage",
    ):
        assert any(teil in n for n in namen), teil


@pytest.mark.parametrize("case,erwartung,ueber_tage", _LOCKSTEP)
def test_zusammengesetzt_aus_viertelstunden(case: dict, erwartung: dict, ueber_tage: bool):
    """Lockstep: aus den gespeicherten Viertelstunden (und über Tage) ergibt sich GENAU die Erwartung.

    Eine Viertelstunde ohne einen einzigen Rohwert bekommt - wie in der Datenbank - keine
    Teilperiode. Verglichen wird mit der DATEI, nicht mit der eigenen Rohwert-Rechnung.
    """
    reihe = _reihe(case, erwartung)
    werte = verbrauch.rohwerte(reihe)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    von, bis = verbrauch._zeit(erwartung["von"]), verbrauch._zeit(erwartung["bis"])
    ereignisse = list(reihe.get("ereignisse", [])) + list(erwartung.get("ereignisse_zusatz", []))
    faktor = verbrauch._dez(reihe.get("faktor", 1))
    modul = verbrauch._dez(reihe["wertebereich_modul"]) if reihe.get("wertebereich_modul") else None
    hoechst = verbrauch._dez(reihe["hoechstzuwachs_je_kadenz"]) if reihe.get("hoechstzuwachs_je_kadenz") else None
    zusatz = (ereignisse, faktor, modul, hoechst)

    ab = von - (timedelta(days=2) if ueber_tage else timedelta(days=1))
    ende = bis + (timedelta(days=1) if ueber_tage else _VIERTELSTUNDE)
    viertelstunden = []
    q = ab
    while q < ende:
        fenster = _fenster(werte, q - kadenz, q + _VIERTELSTUNDE)
        if any(q <= r.zeit < q + _VIERTELSTUNDE for r in fenster):
            viertelstunden.append(verbrauch.teilperiode(fenster, q, q + _VIERTELSTUNDE, kadenz, *zusatz))
        q += _VIERTELSTUNDE

    teile = viertelstunden
    if ueber_tage:
        teile = []
        tag = ab.astimezone(_ORT).date()
        while True:
            t_von = datetime.combine(tag, time(), _ORT).astimezone(timezone.utc)
            if t_von >= ende:
                break
            t_bis = datetime.combine(tag + timedelta(days=1), time(), _ORT).astimezone(timezone.utc)
            fuer_tag = [v for v in viertelstunden if v.bis > t_von - timedelta(days=1) and v.von <= t_bis]
            if any(v.von >= t_von and v.bis <= t_bis for v in fuer_tag):
                teile.append(verbrauch.zaehlerstand_aus_teilperioden(fuer_tag, t_von, t_bis, kadenz, *zusatz))
            tag += timedelta(days=1)

    ist = verbrauch.zaehlerstand_aus_teilperioden(teile, von, bis, kadenz, *zusatz).ergebnis
    for feld in ("menge", "zustand", "erhalten", "erwartet", "abdeckung_prozent", "kennzeichen"):
        if feld not in erwartung:
            continue
        soll = erwartung[feld]
        if feld == "menge" and soll is not None:
            assert ist["menge"] is not None and Decimal(str(soll)) == ist["menge"], f"{feld}: {case['why']}"
        else:
            assert ist[feld] == soll, f"{feld}: {case['why']}"


def test_die_summe_der_tage_ist_nicht_die_monatsmenge():
    """F16: 31 Oktobertage, jeder für sich gerundet, summieren sich zu 55 100,013 kWh - falsch,
    obwohl kein Wert fehlt. Aus den Periodenständen ergibt sich 55 100,000."""
    (case,) = [c for c in CASES if c["name"].startswith("f16-")]
    werte = verbrauch.rohwerte(case["input"]["reihe"])
    kadenz = timedelta(seconds=60)
    tage, summe = [], Decimal(0)
    tag = datetime(2026, 10, 1).date()
    while tag.month == 10:
        t_von = datetime.combine(tag, time(), _ORT).astimezone(timezone.utc)
        t_bis = datetime.combine(tag + timedelta(days=1), time(), _ORT).astimezone(timezone.utc)
        t = verbrauch.teilperiode(_fenster(werte, t_von - kadenz, t_bis), t_von, t_bis, kadenz)
        tage.append(t)
        summe += t.ergebnis["menge"]
        tag += timedelta(days=1)
    monat = verbrauch.zaehlerstand_aus_teilperioden(
        tage, verbrauch._zeit("2026-10-01T00:00:00+02:00"), verbrauch._zeit("2026-11-01T00:00:00+01:00"), kadenz
    )
    assert summe == Decimal("55100.013")
    assert monat.ergebnis["menge"] == Decimal("55100.000")


def test_eine_ueberstehende_teilperiode_wird_abgewiesen():
    von = verbrauch._zeit("2026-10-20T00:00:00+00:00")
    kadenz = timedelta(seconds=60)
    schief = verbrauch.teilperiode(
        [verbrauch.Rohwert(von, Decimal(1))], von - kadenz, von + timedelta(seconds=840), kadenz
    )
    with pytest.raises(ValueError, match="ragt"):
        verbrauch.zaehlerstand_aus_teilperioden([schief], von, von + timedelta(hours=1), kadenz)

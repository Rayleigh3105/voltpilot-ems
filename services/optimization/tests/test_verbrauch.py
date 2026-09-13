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


def test_die_datei_traegt_die_dreiundzwanzig_faelle_und_f24():
    """23 Fälle der Vorlage plus F24 (AP-08 IP-3), jeder mit Namen, Familie, Begründung und Erwartung."""
    assert len(CASES) == 24
    assert CASES[-1]["name"].startswith("f24-")
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
    assert tuple(regeln["luecke_zeitraeume"]) == verbrauch.LUECKE_ZEITRAEUME
    assert "JE ROHWERT" in regeln["anteil"]
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
        erwartung.get("anteil"),
        erwartung.get("quelle"),
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


def test_erst_mitteln_dann_zuordnen_ist_falsch():
    """AP-08 IP-7, E15 Option C als benannte Gegenprobe: das Mittel des ganzen Vorzeichen-Werts,
    danach nach seinem Vorzeichen zugeordnet, ergibt genau die verworfene Zahl der Datei — und weicht
    von beiden Anteil-Erwartungen ab, die JE ROHWERT geteilt sind."""
    faelle = [c for c in CASES if "gegenprobe" in c]
    assert [c["name"] for c in faelle] == ["f19-richtung"]
    case = faelle[0]
    g = case["gegenprobe"]
    reihe = case["input"]["reihen"][g["reihe"]]
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    von, bis = datetime.fromisoformat(g["von"]), datetime.fromisoformat(g["bis"])
    mittel = verbrauch.momentanwerte(verbrauch.rohwerte(reihe), von, bis, kadenz)["mittel"]
    assert float(mittel) == pytest.approx(g["mittel_vorzeichen"])
    falsch = {
        "positiv": verbrauch.anteil_des_werts(mittel, "positiv"),
        "negativ": verbrauch.anteil_des_werts(mittel, "negativ"),
    }
    assert float(falsch["positiv"]) == pytest.approx(g["falsch_bezug"])
    assert float(falsch["negativ"]) == pytest.approx(g["falsch_abgabe"])
    anteile = [e for e in case["expected"] if e.get("anteil")]
    assert len(anteile) == 2
    for e in anteile:
        assert float(falsch[e["anteil"]]) != pytest.approx(e["mittel"]), e["name"]


def test_der_anteil_wird_je_rohwert_geteilt_und_das_vorzeichen_nie_zweimal():
    """max(0, P) / max(0, −P) je Wert; ein schon vorzeichenrichtiger Rohwert wird nicht noch einmal gedreht."""
    t = datetime(2026, 10, 20, 10, 7, tzinfo=timezone.utc)
    werte = [verbrauch.Rohwert(t, Decimal("-10.0"))]
    assert verbrauch.anteil_je_rohwert(werte, "positiv")[0].wert == 0
    assert verbrauch.anteil_je_rohwert(werte, "negativ")[0].wert == Decimal("10.0")
    assert verbrauch.anteil_je_rohwert(werte, None) == werte
    with pytest.raises(ValueError):
        verbrauch.anteil_je_rohwert(werte, "gesamt")


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


# ------------------- Momentanwert und Intervallmenge aus Teilperioden (AP-08 IP-3, §4.5)

_WERTE_LOCKSTEP = [
    pytest.param(case, erwartung, id=f"{case['name']}::{erwartung['name']}")
    for case in CASES
    for erwartung in case["expected"]
    if _reihe(case, erwartung)["wertart"] in ("momentanwert", "intervallmenge")
    for von, bis in [(verbrauch._zeit(erwartung["von"]), verbrauch._zeit(erwartung["bis"]))]
    if bis - von >= 2 * _VIERTELSTUNDE and _im_raster(von) and _im_raster(bis)
]


def _werteteile(reihe: dict, von: datetime, bis: datetime) -> list:
    """Die Viertelstunden als :class:`verbrauch.Werteteil` - wie in der Datenbank nur die mit Rohwert,
    dazu je eine davor und danach (die Nachbarn der Lücke und des Haltens)."""
    werte = verbrauch.rohwerte(reihe)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    reichweite = verbrauch.HALTEN_FAKTOR * kadenz
    teile = []
    q = von - timedelta(hours=1)
    while q < bis + timedelta(hours=1):
        q_bis = q + _VIERTELSTUNDE
        fenster = _fenster(werte, q - reichweite, q_bis + reichweite)
        if reihe["wertart"] == "intervallmenge":
            if any(q < r.zeit <= q_bis for r in fenster):
                teile.append(verbrauch.intervallmenge_teil(fenster, q, q_bis, kadenz, verbrauch._dez(reihe.get("faktor", 1))))
        elif any(q <= r.zeit < q_bis for r in fenster):
            teile.append(verbrauch.momentanwert_teil(fenster, q, q_bis, kadenz, reihe.get("integrieren", False)))
        q = q_bis
    return teile


def test_der_werte_lockstep_traegt_die_abnahme_von_ip3():
    """F2 (halbe Stunde) und F24 (halbe Stunde, Stunde) müssen unter den zusammengesetzten Erwartungen sein."""
    assert "nie Mittel von Mitteln" in DOC["regeln"]["werte_teilperioden"]
    namen = {p.id for p in _WERTE_LOCKSTEP}
    for teil in ("f2-intervallmenge::Halbe Stunde", "f24-momentanwert-ueber-die-viertelstundengrenze::Stunde"):
        assert any(teil in n for n in namen), teil


@pytest.mark.parametrize("case,erwartung", _WERTE_LOCKSTEP)
def test_werte_zusammengesetzt_aus_viertelstunden(case: dict, erwartung: dict):
    """Lockstep: aus den gespeicherten Viertelstunden ergibt sich GENAU die Erwartung der Datei."""
    reihe = _reihe(case, erwartung)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    von, bis = verbrauch._zeit(erwartung["von"]), verbrauch._zeit(erwartung["bis"])
    teile = _werteteile(reihe, von, bis)
    if reihe["wertart"] == "intervallmenge":
        ist = verbrauch.intervallmenge_aus_teilperioden(teile, von, bis, kadenz).teil.ergebnis
    else:
        ist = verbrauch.momentanwert_aus_teilperioden(teile, von, bis, kadenz, reihe.get("integrieren", False)).teil.ergebnis
    for feld in GERECHNET:
        if feld not in erwartung or feld == "stunden":
            continue
        soll = erwartung[feld]
        if feld in ("menge", "mittel", "min", "max", "energie_kwh") and soll is not None:
            assert ist[feld] is not None and Decimal(str(soll)) == ist[feld], f"{feld}: {case['why']}"
        else:
            assert ist[feld] == soll, f"{feld}: {case['why']}"


def test_die_viertelstunden_energien_ergeben_die_der_stunde():
    """F24: die ungerundeten Energien der vier Viertelstunden sind zusammen GENAU die der Stunde -
    weil jeder Wert bis zum nächsten guten Wert hält, auch hinter der Grenze (M4)."""
    (case,) = [c for c in CASES if c["name"].startswith("f24-")]
    reihe = case["input"]["reihe"]
    von, bis = verbrauch._zeit("2026-10-20T10:00:00+02:00"), verbrauch._zeit("2026-10-20T11:00:00+02:00")
    teile = [t for t in _werteteile(reihe, von, bis) if von <= t.teil.von and t.teil.bis <= bis]
    werte = verbrauch.rohwerte(reihe)
    assert len(teile) == 4
    stunde = verbrauch._integriere(werte, von, bis, timedelta(seconds=10))
    # Gleich bis auf die 28. Stelle des Dezimal-Kontexts (jeder Teil teilt für sich durch 3600).
    assert abs(sum(t.energie for t in teile) - stunde) < Decimal("1e-20")
    assert verbrauch._runde(verbrauch._D(386309) / verbrauch._D(3600)) == Decimal("107.308")


def test_ein_mittel_von_mitteln_waere_falsch():
    """Zwei Viertelstunden mit dem wahren Mittel 10,05 und 10,04: gerundet 10,1 und 10,0, deren Mittel
    10,05 ergäbe 10,1 - die halbe Stunde hat 10,045, also 10,0. Gerechnet wird aus den Summen."""
    von = verbrauch._zeit("2026-10-20T10:00:00+00:00")
    kadenz = timedelta(seconds=450)

    def werte(t0: datetime, a: str, b: str) -> list:
        return [verbrauch.Rohwert(t0, Decimal(a)), verbrauch.Rohwert(t0 + kadenz, Decimal(b))]

    roh = werte(von, "10.00", "10.10") + werte(von + _VIERTELSTUNDE, "10.00", "10.08")
    teile = [
        verbrauch.momentanwert_teil(roh, von, von + _VIERTELSTUNDE, kadenz),
        verbrauch.momentanwert_teil(roh, von + _VIERTELSTUNDE, von + 2 * _VIERTELSTUNDE, kadenz),
    ]
    assert [t.teil.ergebnis["mittel"] for t in teile] == [Decimal("10.1"), Decimal("10.0")]
    halb = verbrauch.momentanwert_aus_teilperioden(teile, von, von + 2 * _VIERTELSTUNDE, kadenz)
    assert halb.teil.ergebnis["mittel"] == Decimal("10.0")
    assert halb.teil.ergebnis["mittel"] == verbrauch.momentanwerte(roh, von, von + 2 * _VIERTELSTUNDE, kadenz)["mittel"]


def test_ohne_einen_guten_wert_gibt_es_keine_energie():
    """Eine Stunde, deren Viertelstunden keinen guten Wert tragen, hat keine Zahl - nie 0, nie Mittel × Länge."""
    von = verbrauch._zeit("2026-10-20T10:00:00+00:00")
    kadenz = timedelta(seconds=10)
    schlecht = [verbrauch.Rohwert(von + timedelta(seconds=10 * i), Decimal(96), "bad") for i in range(90)]
    teil = verbrauch.momentanwert_teil(schlecht, von, von + _VIERTELSTUNDE, kadenz, True)
    assert teil.energie is None and teil.teil.ergebnis["zustand"] == verbrauch.KEINE_WERTE
    stunde = verbrauch.momentanwert_aus_teilperioden([teil], von, von + timedelta(hours=1), kadenz, True)
    assert stunde.energie is None
    assert stunde.teil.ergebnis["energie_kwh"] is None and stunde.teil.ergebnis["kennzeichen"] == []
    assert stunde.teil.ergebnis["erwartet"] == 360


def test_integrieren_verlangt_die_energie_jedes_teils():
    von = verbrauch._zeit("2026-10-20T10:00:00+00:00")
    kadenz = timedelta(seconds=10)
    roh = [verbrauch.Rohwert(von + timedelta(seconds=10 * i), Decimal(96)) for i in range(90)]
    ohne = verbrauch.momentanwert_teil(roh, von, von + _VIERTELSTUNDE, kadenz, False)
    with pytest.raises(ValueError, match="Energie"):
        verbrauch.momentanwert_aus_teilperioden([ohne], von, von + timedelta(hours=1), kadenz, True)


def test_rechenrauschen_kippt_keine_rundungsgrenze():
    """Die Summe 28-stelliger Teil-Energien trägt Rauschen: 24,11249…9 darf nicht auf 24,112 kippen (F3)."""
    assert verbrauch._runde_energie(Decimal("24.11249999999999999999999999")) == Decimal("24.113")
    assert verbrauch._runde_energie(Decimal("24.11250000000000000000000001")) == Decimal("24.113")
    assert verbrauch._runde_energie(Decimal("24.11244444444444444444444444")) == Decimal("24.112")


# ------------------------------------------------ Z6: die EINE Überlauf-Entscheidung (AP-08 IP-4)


def _faelle_mit_fallendem_stand():
    """Jeder fallende Nachbar guter Werte in jeder Zählerstand-Reihe, samt der Zeiten, an denen die
    Erwartungen des Falls einen Überlauf nennen. Eine Gerätegrenze dazwischen ist Z4, nie Z6."""
    for case in CASES:
        reihe = case["input"].get("reihe")
        if case["familie"] != "zaehlerstand" or reihe is None:
            continue
        gute = [r for r in verbrauch.rohwerte(reihe) if r.gut]
        grenzen = [verbrauch._zeit(e["t"]) for e in reihe.get("ereignisse", []) if e["art"] == "device_boundary"]
        genannt = {
            k.split(" ")[1]
            for erwartung in case["expected"]
            for k in erwartung.get("kennzeichen", [])
            if k.startswith("Überlauf ")
        }
        for vorher, nachher in zip(gute, gute[1:]):
            if nachher.wert < vorher.wert and not any(vorher.zeit < g <= nachher.zeit for g in grenzen):
                yield case["name"], reihe, vorher, nachher, genannt


def test_die_ueberlauf_entscheidung_steht_genau_dort_wo_die_erwartung_einen_ueberlauf_nennt():
    """F7: 65 536 − 64 954 + 185 = 767 ≤ 1 667 ist ein Überlauf, 65 536 − 12 457 + 100 = 53 179 nicht.

    Die Writer-Erkennung (``UeberlaufRegel``) prüft dieselbe Ableitung aus derselben Datei."""
    gesehen = set()
    for name, reihe, vorher, nachher, genannt in _faelle_mit_fallendem_stand():
        kadenz = timedelta(seconds=reihe["kadenz_s"])
        modul = verbrauch._dez(reihe["wertebereich_modul"]) if reihe.get("wertebereich_modul") else None
        hoechst = verbrauch._dez(reihe["hoechstzuwachs_je_kadenz"]) if reihe.get("hoechstzuwachs_je_kadenz") else None
        ueber = verbrauch.ueberlauf(vorher, nachher, kadenz, modul, hoechst)
        uhr = verbrauch._uhr(nachher.zeit)
        assert (ueber is not None) == (uhr in genannt), f"{name} {uhr}"
        if ueber is not None:
            assert ueber == modul - vorher.wert + nachher.wert
            gesehen.add((name, uhr))
        # Ohne Deklaration wird nie ein Überlauf geraten (E4).
        assert verbrauch.ueberlauf(vorher, nachher, kadenz, None, hoechst) is None
        assert verbrauch.ueberlauf(vorher, nachher, kadenz, modul, None) is None
    assert any(n.startswith("f7-") for n, _ in gesehen)
    # Ein steigender Stand ist nie ein Überlauf, auch nicht mit Deklaration.
    t = verbrauch._zeit("2026-10-20T10:00:00+02:00")
    assert verbrauch.ueberlauf(
        verbrauch.Rohwert(t, Decimal(100)), verbrauch.Rohwert(t + timedelta(minutes=1), Decimal(101)),
        timedelta(minutes=1), Decimal(65536), Decimal(1667)) is None


# ------------------------------------------ Zuwachs über eine Lücke (AP-08 IP-6, E2 = A)

_IMMER_VON = verbrauch._zeit("2000-01-01T00:00:00+00:00")
_IMMER_BIS = verbrauch._zeit("2100-01-01T00:00:00+00:00")

LUECKEN_ERWARTUNGEN = [
    pytest.param(case, erwartung, id=f"{case['name']}::{erwartung['name']}")
    for case in CASES
    for erwartung in case["expected"]
    if "luecken_zuwachs" in erwartung
]


def test_die_abnahmefaelle_von_ip6_tragen_ihre_zuwachs_felder():
    """F8, F11, F20 und F23 nennen an JEDER Erwartung, welche Lücken ihr Zuwachs zählt."""
    abnahme = [c for c in CASES if c["name"].split("-")[0] in {"f8", "f11", "f20", "f23"}]
    assert len(abnahme) == 4
    for case in abnahme:
        for erwartung in case["expected"]:
            assert "luecken_zuwachs" in erwartung, f"{case['name']}::{erwartung['name']}"


@pytest.mark.parametrize("case,erwartung", LUECKEN_ERWARTUNGEN)
def test_der_zuwachs_steht_genau_einmal(case: dict, erwartung: dict):
    """E2: die Periode, die die Lücke GANZ enthält, zählt den Zuwachs (Stände, Einheit, Kennzeichen); sonst keine."""
    reihe = _reihe(case, erwartung)
    werte = verbrauch.rohwerte(reihe)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    faktor = verbrauch._dez(reihe.get("faktor", 1))
    ereignisse = list(reihe.get("ereignisse", [])) + list(erwartung.get("ereignisse_zusatz", []))
    von, bis = verbrauch._zeit(erwartung["von"]), verbrauch._zeit(erwartung["bis"])
    ist = verbrauch.ergebnis(reihe, erwartung["von"], erwartung["bis"], erwartung.get("ereignisse_zusatz", ()))

    gezaehlt = verbrauch.luecken_zuwaechse(werte, von, bis, kadenz, ereignisse, faktor)
    soll = erwartung["luecken_zuwachs"]
    assert len(gezaehlt) == len(soll), case["why"]
    for luecke, s in zip(gezaehlt, soll):
        assert luecke.messzeit_vor == verbrauch._zeit(s["messzeit_vor"])
        assert luecke.messzeit_nach == verbrauch._zeit(s["messzeit_nach"])
        assert luecke.stand_vor == verbrauch._dez(s["stand_vor"])
        assert luecke.stand_nach == verbrauch._dez(s["stand_nach"])
        assert luecke.zuwachs == verbrauch._dez(s["zuwachs"])
        assert s["einheit"] == reihe["einheit"]
        assert verbrauch.luecken_kennzeichen(luecke) in ist["kennzeichen"]
    for luecke in verbrauch.luecken_zuwaechse(werte, _IMMER_VON, _IMMER_BIS, kadenz, ereignisse, faktor):
        if luecke not in gezaehlt:
            assert verbrauch.luecken_kennzeichen(luecke) not in ist["kennzeichen"], case["why"]


@pytest.mark.parametrize("zuordnung", DOC["luecken_zuordnung"], ids=lambda z: z["name"])
def test_der_kleinste_ganz_enthaltende_zeitraum(zuordnung: dict):
    """E2: Viertelstunde → Stunde → Tag → Monat → Jahr; über den Jahreswechsel keiner."""
    kadenz = timedelta(seconds=zuordnung["kadenz_s"])
    vor, nach = verbrauch._zeit(zuordnung["messzeit_vor"]), verbrauch._zeit(zuordnung["messzeit_nach"])
    ist = verbrauch.kleinster_zeitraum(verbrauch.LueckenZuwachs(vor, nach), kadenz, DOC["zeitzone"])
    soll = zuordnung["kleinster_zeitraum"]
    if soll is None:
        assert ist is None, zuordnung["why"]
    else:
        assert ist == (soll["art"], verbrauch._zeit(soll["von"]), verbrauch._zeit(soll["bis"])), zuordnung["why"]
    if zuordnung["fall"] is not None:
        reihe = next(c for c in CASES if c["name"] == zuordnung["fall"])["input"]["reihe"]
        alle = verbrauch.luecken_zuwaechse(
            verbrauch.rohwerte(reihe),
            _IMMER_VON,
            _IMMER_BIS,
            timedelta(seconds=reihe["kadenz_s"]),
            reihe.get("ereignisse", []),
            verbrauch._dez(reihe.get("faktor", 1)),
        )
        assert [(l.messzeit_vor, l.messzeit_nach) for l in alle] == [(vor, nach)]

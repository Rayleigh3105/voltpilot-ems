"""Drehbuch und Ergebnisblatt ohne Broker (AP-15 IP-29).

Lauf: make test
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

import nutzlast
import szenarien as sz
import uems_verbund as uv

JETZT = dt.datetime(2026, 9, 22, 12, 0, tzinfo=dt.timezone.utc)


def test_jede_matrixzeile_hat_einen_lauf_und_r1_ist_dabei():
    ls = sz.laeufe()
    assert set(sz.ZEILEN) | {"R1"} <= set(ls)
    assert len(sz.ZEILEN) == 17 and "A19" not in ls
    assert {n for n, x in ls.items() if x.nicht_fahrbar} == {"A6", "A8"}


def test_messfenster_ist_nach_zeit_plus_zwei_volle_viertel():
    ls = sz.laeufe()
    assert ls["A4"].messdauer() == 1800           # ohne Unterbrechung
    assert ls["A2"].messdauer() == 2700           # 60 s → ein Viertel + zwei
    assert ls["A3"].messdauer() == 3600           # Plan veraltet nach 20 min
    assert ls["A20"].messdauer() == 3600          # wie NW-2 (ende 60 min)
    assert (ls["R1"].t0, ls["R1"].messdauer()) == (600, 2700)   # wie IP-28
    assert (ls["A7"].t0, ls["A7"].messdauer()) == (600, 1800)   # wie `make a7`


def test_bezugs_punkt_verschiebt_den_nullpunkt_und_haengt_die_saeulen_an():
    e = sz.laeufe()["A20"].umgebung()
    assert e["VB_PROFIL"] == "nacht_a20" and e["VB_NULLPUNKT_KW"] == "400"
    assert e["VB_LADEPUNKTE"].split(",") == [f"ladepunkte:91{n:02d}" for n in range(2, 8)]
    assert e["VB_VERBRAUCHER"] == "true"
    assert "VB_NULLPUNKT_KW" not in sz.laeufe()["R1"].umgebung()
    assert sz.NULLPUNKT_NACHT_KW == uv.NULLPUNKT_NACHT_KW


def test_drehbuch_hat_absolute_messsekunden_in_zeitfolge(tmp_path: Path):
    datei = sz.schreibe_drehbuch(sz.laeufe()["A18"], tmp_path, JETZT)
    zeilen = [z for z in datei.read_text().splitlines() if not z.startswith("#")]
    zeiten = [int(z.split()[0]) for z in zeilen]
    assert zeiten == [0, 0, 60, 60]                 # T0 = 60: Revision 5 eine Minute vorher
    assert all(z.split()[1] == "sende" and str(tmp_path) in z for z in zeilen)
    r4 = json.loads((tmp_path / "a18-e1-r4.json").read_text())
    k = nutzlast.kennungen()
    assert r4["revision"] == 4 and r4["anteile"]["einspeisung"] == {k["E-1"]: 60, k["E-4"]: 40}


def test_a10_dokumente_wie_za_a10(tmp_path: Path):
    datei = sz.schreibe_drehbuch(sz.laeufe()["A10"], tmp_path, JETZT)
    text = datei.read_text()
    assert '0 anlage {"cmd":"rueckfall","komponente":"K-1","kw":10}' in text  # ohne Leerzeichen: ein Wort
    ue = json.loads((tmp_path / "a10-e1-r2.json").read_text())
    assert ue["schritt"] == "uebergang" and ue["verteilbar"] == {"einspeisung": 70, "bezug": 77}
    zuviel = json.loads((tmp_path / "a10-e4-r4.json").read_text())
    assert zuviel["verteilbar"]["einspeisung"] == 100 and sum(zuviel["anteile"]["einspeisung"].values()) == 110
    assert not (tmp_path / "a10-e4-r3.json").exists()   # das Ziel erreicht Box Verwaltung nie


def test_handeingriff_bekommt_die_sendezeit_erst_beim_senden(tmp_path: Path):
    sz.schreibe_drehbuch(sz.laeufe()["A11"], tmp_path, JETZT)
    h = json.loads((tmp_path / "a11-hand.json").read_text())
    assert h["issued_at"] == "@JETZT@" and h["command"] == {"type": "setpoint_kw", "value": -100.0}
    assert h["source"] == {"kind": "local-ui"} and h["override"] is True


def test_varianten_der_nutzlasten():
    a12 = nutzlast.alle(1, JETZT, ohne_anteile=True)
    assert set(a12["E-1"]) == {"v2/entities", "schedule"}
    assert a12["E-1"]["schedule"]["grid_export_limit_kw"] == 100.0
    a9 = nutzlast.alle(1, JETZT, runde=2, nur_plan=True, ungueltig=True)
    assert set(a9["E-1"]) == {"v2/plan"} and a9["E-1"]["v2/plan"]["schema_version"] == "9.9"
    nacht = nutzlast.alle(1, JETZT, profil="nacht", nullpunkt=400)
    assert nacht["E-1"]["v2/plan"]["grid_import_limit_kw"] == 150.0
    assert nacht["E-1"]["v2/plan"]["entities"][0]["slots"][0]["commands"] == {"setpoint_kw": 100.0}
    assert nacht["E-1"]["v2/charging-config"]["grid_limit_kw"] == 150.0
    assert nacht["E-4"]["v2/charging-config"]["grid_limit_kw"] == 550.0
    assert all(c["rated_kw"] == 22.0 for c in nacht["E-4"]["v2/charging-config"]["charge_points"])


def test_nullpunkt_haelt_grenze_minus_zaehler_gleich():
    a = uv.Anlage(uv.profil("nacht"), t0_s=10)
    a.k2.wirkt, a.k2.rampe_kw_s, a.k2.rueckfall_kw = 100, 0, 100
    a.ladepunkte_kw = 132.0
    a.schritt()
    assert a.netz == pytest.approx(473 + 100 + 132)          # über der Karte
    seite = uv.BoxSeite("E-1", nullpunkt_kw=400)
    seite.aktualisiere(a)
    assert seite.ueberlauf == 0
    assert uv.s16(seite.regs[uv.R_GRID]) / 100 == pytest.approx(a.netz - 400)
    assert uv.s16(seite.regs[uv.R_LOAD]) / 100 == pytest.approx(73.0)
    grenze_box = seite.regs[uv.R_GRIDCONN] / 100
    assert grenze_box - uv.s16(seite.regs[uv.R_GRID]) / 100 == pytest.approx(550 - a.netz)


def test_a20_last_waechst_nach_fuenf_minuten():
    p = uv.profil("nacht_a20")
    assert (p.grundlast(299), p.grundlast(300)) == (430.0, 480.0)


def protokoll(m1_ein: float | None, m2: float = 26.8, s: int = 2, bez: float = 0.0, core: str = "vb-edge-core:ip29-17abebe1c993") -> dict:
    def r(m1, grenze):
        return {"grenze_kw": grenze, "m1_hoechstes_viertel_kw": m1,
                "m1_viertel": [] if m1 is None else [{"viertel": 0, "ab_s": 0, "mittel_kw": m1}],
                "m2_sekunden_ueber": s, "m2_laengste_ueber_s": s, "m2_groesste_ueber_kw": m2}
    return {"core_bild": core, "bilder_aus_commit": "17abebe1c9935c852b42", "boxen": {
        "E-1": {"quittungen": [{"topic": "v2/verbund-anteile-result", "nutzlast": {"urteil": "angenommen"}},
                               {"topic": "v2/plan-result", "nutzlast": {"angenommen": True}}]}},
            "anlage": {"einspeisung": r(m1_ein, 100.0), "bezug": r(bez, 550.0)}}


def test_urteil():
    assert sz.urteil(98.0, 100.0, True) == "hält"
    assert sz.urteil(99.985, 100.0, True) == "hält ohne Marge"
    assert sz.urteil(100.17, 100.0, True) == "verletzt"
    assert sz.urteil(557.0, 550.0, False).startswith("verletzt - wie die Matrix erwartet")
    assert sz.urteil(None, 100.0, True) == "kein volles Viertel gemessen"


NW2 = """| Zeile | Punkt | Einspeisung: M-1 höchstes Viertel | M-2 größte Überschr. | längste | gesamt | Bezug: M-1 höchstes Viertel | M-2 größte Überschr. | längste | gesamt | Matrix: nach welcher Zeit | Urteil |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 | Mittag | 98.0 kW (13:15) | 26.8 kW | 6 s | 6 s | 0.0 kW (13:00) | 0.0 kW | 0 s | 0 s | — | hält |
| A7e | Mittag | 99.0 kW (13:00) | 26.8 kW | 36 s | 36 s | 0.0 kW (13:00) | 0.0 kW | 0 s | 0 s | ≤ 90 s | hält |
| A20 | Nacht | 0.0 kW (13:00) | 0.0 kW | 0 s | 0 s | 557.0 kW (13:15) | 7.0 kW | 1506 s | 1506 s | … | BEFUND gezeigt |
"""


def test_nw2_protokoll_wird_gelesen():
    n = sz.lies_nw2(NW2)
    assert n[("R1", "Mittag")]["einspeisung"] == (98.0, 26.8, 6)
    assert n[("A20", "Nacht")]["bezug"] == (557.0, 7.0, 1506)
    assert sz.nw2_text(n, "A7", False) == "A7e: 99 kW, +26.8 kW / 36 s"


def test_blatt_hat_jede_zeile_und_die_bandbreite(tmp_path: Path):
    prot = tmp_path / "p"
    prot.mkdir()
    (prot / "R1-1.json").write_text(json.dumps(protokoll(98.0)))
    (prot / "R1-2.json").write_text(json.dumps(protokoll(97.74, 24.7, 1)))
    (prot / "A7-1.json").write_text(json.dumps(protokoll(99.985, 31.0, 79)))
    nw2 = tmp_path / "nw2.md"
    nw2.write_text(NW2)
    text = sz.blatt(prot, nw2, "2026-09-22")
    zeilen = [z for z in text.splitlines() if z.startswith("| ") and not z.startswith("| Zeile")]
    namen = [z.split("|")[1].strip() for z in zeilen]
    assert [n for n in namen if n != "A7x"][:18] == ["R1", *sz.ZEILEN]
    r1 = zeilen[0]
    assert "2 Läufe: 97.74–98" in r1 and "+24.7–26.8 kW" in r1 and r1.endswith("| hält |")
    a7 = next(z for z in zeilen if z.startswith("| A7 "))
    assert "hält ohne Marge" in a7 and "A7e: 99 kW" in a7
    assert "nicht fahrbar" in next(z for z in zeilen if z.startswith("| A8 "))
    assert "noch nicht gefahren" in next(z for z in zeilen if z.startswith("| A1 "))
    assert "`uems-17abebe1c993`" in text
    (prot / "A7-2.json").write_text(json.dumps(protokoll(99.2, 26.8, 60, core="vb-edge-core:ip29-b70334ea3abc")))
    zeilen = [z for z in sz.blatt(prot, nw2).splitlines() if z.startswith("| A7 ")]
    assert len(zeilen) == 2 and "`b70334ea3abc`" in zeilen[1] and zeilen[1].endswith("| hält |")

"""MiSpeL MP-39b: Aus, Schnell und eine Szene halten das Zurueckspeisen an (Captain-Entscheid 04.10.2026).

Aus = die Wallbox ruht ganz, Schnell = nur laden fuer diese Ladung, Szene = sicherer Zustand; danach gilt wieder die
Stufe der Wallbox-Karte (Vertrag ``docs/contracts/v2/mispel-ladepunkt-bidirektional.md`` § 5a). Die eine Stelle im Plan
ist ``fahrzeugspeicher.rueckspeisen_wirksam``; der Block ``fahrzeug`` im Fahrplan 2.0 entfaellt dann (MP-39: fehlt = nie
zurueckspeisen). Die Freigabe ist ein Wunsch am Ladepunkt (A1 S. 27) - die Halte-Gruende sind Regeln von VoltPilot,
kein Wort der Festlegung.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, time, timedelta, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization.entities import fahrzeug_dispatch
from voltpilot_optimization.fahrzeugspeicher import (
    HALT_LADEMODUS_AUS,
    HALT_LADEMODUS_SCHNELL,
    HALT_SZENE,
    FahrerEinstellung,
    Fenster,
    Messung,
    halte_grund,
    lademodus_halt,
    rueckspeisen_wirksam,
)
from voltpilot_optimization.publisher_v2 import build_plan_v2_payload
from voltpilot_optimization.solver import optimize

from test_contract_v2 import load_validator
from test_mispel_fahrer_einstellungen import BOX, NUR_V2G, OHNE, UNI_V2H
from test_mispel_fahrzeugspeicher import BERLIN, PENDLER, V2G, V2H, _abend_preise, _input, _lader, _site
from test_solver import T0, needs_highs

import test_bestandsschutz_nw6 as nw6

HALTE_GRUENDE = (HALT_LADEMODUS_AUS, HALT_LADEMODUS_SCHNELL, HALT_SZENE)


def _fz(einstellung=FahrerEinstellung("v2g"), lademodus=None, szene=False, soc_pct=90.0, n=192):
    fz, grund = fz_regeln.fahrzeugspeicher(
        "lp-1", V2G, Fenster(20.0, 60.0, PENDLER), Messung(True, soc_pct, lademodus),
        [T0 + timedelta(minutes=15 * i) for i in range(n)], 15, BERLIN,
        einstellung=einstellung, box_device_id=str(nw6.E_1), szene=szene,
    )
    assert grund is None, grund
    return fz


# --- die eine Stelle: rueckspeisen_wirksam ---------------------------------------


@pytest.mark.parametrize("halt", HALTE_GRUENDE)
@pytest.mark.parametrize("wunsch", ["v2g", "v2h", "aus", None])
@pytest.mark.parametrize("faehigkeit", [V2G, V2H, NUR_V2G, OHNE, UNI_V2H])
def test_halte_grund_macht_jede_stufe_aus(halt, wunsch, faehigkeit):
    assert rueckspeisen_wirksam(wunsch, faehigkeit, halt) == "aus"


def test_ohne_halte_grund_gilt_die_stufe_der_karte():
    # Bestand: der dritte Parameter fehlt = wie MP-33f (Zwilling LadepunktRegeln.rueckspeisenWirksam).
    assert rueckspeisen_wirksam("v2g", V2G) == rueckspeisen_wirksam("v2g", V2G, None) == "v2g"
    assert rueckspeisen_wirksam("v2g", V2H, None) == "v2h"


# --- woher der Halte-Grund kommt -------------------------------------------------


@pytest.mark.parametrize("boost, reason, halt", [
    (True, None, HALT_LADEMODUS_SCHNELL),          # „Schnell“: der Handeingriff „voll“
    (False, "handeingriff", HALT_LADEMODUS_AUS),   # „Aus“: der Handeingriff „pause“ (lastmgmt.ReasonManual)
    (True, "handeingriff", HALT_LADEMODUS_SCHNELL),  # Reihenfolge wie eingriffVon im Portal: boost zuerst
    (False, "plan", None),                         # der Fahrplan haelt die Saeule: kein Lademodus
    (False, "regel", None),
    (False, "laedt", None),
    (None, None, None),                            # nichts gemeldet = „Smart“
])
def test_lademodus_wie_die_wallbox_karte(boost, reason, halt):
    assert lademodus_halt(boost, reason) == halt


def test_lademodus_vor_der_szene_und_ohne_messung_nur_die_szene():
    assert halte_grund(Messung(True, 50.0, HALT_LADEMODUS_AUS), True) == HALT_LADEMODUS_AUS
    assert halte_grund(Messung(True, 50.0), True) == HALT_SZENE
    assert halte_grund(None, True) == HALT_SZENE
    assert halte_grund(None, False) is None
    assert halte_grund(Messung(True, 50.0), False) is None


@pytest.mark.parametrize("lademodus, szene, halt", [
    (HALT_LADEMODUS_AUS, False, HALT_LADEMODUS_AUS),
    (HALT_LADEMODUS_SCHNELL, False, HALT_LADEMODUS_SCHNELL),
    (None, True, HALT_SZENE),
])
def test_fahrzeugspeicher_gehalten_plant_nur_laden(lademodus, szene, halt):
    fz = _fz(lademodus=lademodus, szene=szene)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw, fz.v2g, fz.rueckspeisen_halt) == ("aus", 0.0, False, halt)
    # Abfahrt, Reserve und Fenster bleiben - gehalten wird nur das Zurueckspeisen.
    frei = _fz()
    assert (fz.angesteckt, fz.untergrenze_kwh, fz.naechste_abfahrt) == (
        frei.angesteckt, frei.untergrenze_kwh, frei.naechste_abfahrt)


def test_halte_grund_gilt_auch_ohne_gelesene_einstellungen():
    fz = _fz(einstellung=None, lademodus=HALT_LADEMODUS_SCHNELL)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw) == ("aus", 0.0)
    # ohne Halte-Grund rechnet einstellung=None weiter wie MP-33 (Bestand)
    assert (_fz(einstellung=None).rueckspeisen, _fz(einstellung=None).rueckspeisen_kw) == (None, 11.0)


def test_ohne_halte_grund_byte_gleich_wie_vorher():
    frei = _fz()
    assert frei.rueckspeisen_halt is None and frei.rueckspeisen == "v2g" and frei.rueckspeisen_kw == 11.0
    assert frei == dataclasses.replace(_fz(lademodus=None, szene=False))


# --- Solver und Fahrplan: keine negativen Sollwerte, kein Block --------------------


def _lauf(fz):
    inp = _input(fz, prices=_abend_preise(spitze=900.0), load=2.0)
    plan = optimize(inp, uuid4(), T0)
    assert plan.fahrzeug is not None
    eintrag = fahrzeug_dispatch(fz, plan.fahrzeug, list(inp.slot_starts))
    site_plan = dataclasses.replace(nw6._plan(), fahrzeug=dataclasses.replace(
        eintrag, slot_starts=tuple(nw6.T0 + (s - T0) for s in eintrag.slot_starts)))
    payload = build_plan_v2_payload(site_plan)
    assert list(load_validator().iter_errors(payload)) == []
    return plan, [e for e in payload["entities"] if e.get("kind") == "ev-charger"]


@needs_highs
@pytest.mark.parametrize("lademodus, szene", [
    (HALT_LADEMODUS_AUS, False), (HALT_LADEMODUS_SCHNELL, False), (None, True),
])
def test_gehalten_keine_rueckspeisung_und_kein_block(lademodus, szene):
    """Dieselbe Abendspitze, bei der die Karte (v2g) zurueckspeist: gehalten speist der Plan nie zurueck."""
    plan, eintraege = _lauf(_fz(lademodus=lademodus, szene=szene))
    assert all(s.rueckspeisen_kw <= 1e-9 for s in plan.fahrzeug.slots)
    assert eintraege == []  # MP-39: fehlt = nie zurueckspeisen
    # das Abfahrtsziel bleibt erreicht - laden darf der Plan weiter
    assert plan.fahrzeug.slots[-1].soc_kwh >= 0.0


@needs_highs
@pytest.mark.parametrize("lademodus, szene", [
    (HALT_LADEMODUS_AUS, False), (HALT_LADEMODUS_SCHNELL, False), (None, True),
])
def test_nach_dem_ende_wieder_die_stufe_der_karte(lademodus, szene):
    """Schnell endet mit der Ladung, die Szene mit „Beenden“: der naechste Lauf plant wieder mit „Haus + Netz“."""
    _, gehalten = _lauf(_fz(lademodus=lademodus, szene=szene))
    plan, (e,) = _lauf(_fz())
    assert gehalten == []
    assert any(s.rueckspeisen_kw > 0 for s in plan.fahrzeug.slots)
    assert e["fahrzeug"]["rueckspeisen"] == "v2g"
    assert all(s["commands"]["setpoint_kw"] < 0 for s in e["slots"])


# --- Lader: Stecker und Szene aus der Datenbank -------------------------------------


def _tabellen(kid, boost=False, reason=None, alter=timedelta(minutes=2), szene=()):
    naechste = datetime(2026, 7, 2, 4, 30, tzinfo=timezone.utc)
    return {
        "ladepunkt_faehigkeit": [(kid, "bidirektional", True, True, False, 11)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, None, None, None, None)],
        "device_charge_connector": [(kid, "Charging", 50.0, T0 - alter, boost, reason)],
        "device_charge_point": [(kid, BOX)],
        "ladepunkt_fahrer_einstellung": [(kid, "v2h", 0.5, naechste, 90)],
        "ladepunkt_abfahrt": [(kid, 5, time(7, 30), 80)],
        "site_scene": [(list(szene),)] if szene else [],
    }


@pytest.mark.parametrize("boost, reason, szene, halt", [
    (True, None, (), HALT_LADEMODUS_SCHNELL),
    (False, "handeingriff", (), HALT_LADEMODUS_AUS),
    (False, None, ("lp",), HALT_SZENE),
    (True, None, ("lp",), HALT_LADEMODUS_SCHNELL),
])
def test_lader_liest_lademodus_und_szene(monkeypatch, boost, reason, szene, halt):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, _tabellen(kid, boost, reason, szene=tuple(kid if s == "lp" else s for s in szene)))
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert fz is not None
    assert (fz.rueckspeisen, fz.rueckspeisen_kw, fz.rueckspeisen_halt, fz.box_device_id) == ("aus", 0.0, halt, BOX)


def test_lader_ohne_halte_grund_die_stufe_der_karte(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    # eine Szene, die ein ANDERES Geraet pausiert hat, betrifft den Ladepunkt nicht
    _lader(monkeypatch, _tabellen(kid, szene=(uuid4(),)))
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw, fz.rueckspeisen_halt) == ("v2h", 11.0, None)


def test_lader_veralteter_lademodus_ist_nicht_aktuell(monkeypatch):
    """Eine veraltete Zeile traegt keinen Lademodus - und ohne frischen Ladestand plant niemand das Fahrzeug."""
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, _tabellen(kid, boost=True, alter=timedelta(hours=1)))
    assert load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots) is None


def test_lader_ohne_szenen_tabelle_keine_szene(monkeypatch):
    import sys
    from types import SimpleNamespace

    from voltpilot_optimization.inputs import load_szene_ladepunkte

    class Fehlt(Exception):
        pass

    def connect(dsn):
        raise Fehlt("relation site_scene does not exist")

    errors = SimpleNamespace(UndefinedTable=Fehlt, UndefinedColumn=KeyError)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect, errors=errors))
    assert load_szene_ladepunkte("postgresql://fake", uuid4()) == frozenset()

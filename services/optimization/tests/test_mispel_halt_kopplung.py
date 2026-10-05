"""MiSpeL MP-39b: Aus, Schnell und eine Szene halten das Zurueckspeisen an (Captain-Entscheid 04.10.2026).

Aus = die Wallbox ruht ganz, Schnell = nur laden fuer diese Ladung, Szene = sicherer Zustand; danach gilt wieder die
Stufe der Wallbox-Karte (Vertrag ``docs/contracts/v2/mispel-ladepunkt-bidirektional.md`` § 5a). Die eine Stelle im Plan
ist ``fahrzeugspeicher.rueckspeisen_wirksam``; der Block ``fahrzeug`` im Fahrplan 2.0 entfaellt dann (MP-39: fehlt = nie
zurueckspeisen). Die Freigabe ist ein Wunsch am Ladepunkt (A1 S. 27) - die Halte-Gruende sind Regeln von VoltPilot,
kein Wort der Festlegung.

MiSpeL MP-41c (BK-41c-3 = A): auch die dauerhafte Steuerart „sofort“ haelt an - was die Karte „Schnell“ nennt
(``fahrzeugspeicher.steuerart_sofort``, Vektoren ``mispel-steuerart-sofort-vectors.json``). Und der Ladestand zaehlt
nach seiner eigenen Uhr ``soc_measured_at`` (BK-41c-2).
"""

from __future__ import annotations

import dataclasses
import json
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization.entities import fahrzeug_dispatch
from voltpilot_optimization.fahrzeugspeicher import (
    HALT_LADEMODUS_AUS,
    HALT_LADEMODUS_SCHNELL,
    HALT_LADEMODUS_SOFORT,
    HALT_SZENE,
    FahrerEinstellung,
    Fenster,
    Messung,
    halte_grund,
    lademodus_halt,
    rueckspeisen_wirksam,
    steuerart_sofort,
)
from voltpilot_optimization.publisher_v2 import build_plan_v2_payload
from voltpilot_optimization.solver import optimize

from test_contract_v2 import load_validator
from test_mispel_fahrer_einstellungen import BOX, NUR_V2G, OHNE, UNI_V2H
from test_mispel_fahrzeugspeicher import BERLIN, PENDLER, V2G, V2H, _abend_preise, _input, _lader, _site
from test_solver import T0, needs_highs

import test_bestandsschutz_nw6 as nw6

HALTE_GRUENDE = (HALT_LADEMODUS_AUS, HALT_LADEMODUS_SCHNELL, HALT_LADEMODUS_SOFORT, HALT_SZENE)
VEKTOREN = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2" / "mispel-steuerart-sofort-vectors.json"


def _fz(einstellung=FahrerEinstellung("v2g"), lademodus=None, szene=False, soc_pct=90.0, n=192, sofort=False):
    fz, grund = fz_regeln.fahrzeugspeicher(
        "lp-1", V2G, Fenster(20.0, 60.0, PENDLER), Messung(True, soc_pct, lademodus),
        [T0 + timedelta(minutes=15 * i) for i in range(n)], 15, BERLIN,
        einstellung=einstellung, box_device_id=str(nw6.E_1), szene=szene, sofort=sofort,
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


def test_sofort_nach_dem_eingriff_vor_der_szene_auch_ohne_messung():
    """MP-41c: der Eingriff am Stecker nennt sich zuerst (er endet), dann die Einstellung „sofort“, dann die Szene.
    „sofort“ ist keine Messung - sie gilt auch ohne frische Zeile am Stecker."""
    assert halte_grund(Messung(True, 50.0, HALT_LADEMODUS_SCHNELL), True, True) == HALT_LADEMODUS_SCHNELL
    assert halte_grund(Messung(True, 50.0), True, True) == HALT_LADEMODUS_SOFORT
    assert halte_grund(None, False, True) == HALT_LADEMODUS_SOFORT
    assert halte_grund(None, True, False) == HALT_SZENE  # Bestand: ohne „sofort“ wie MP-39b
    assert lademodus_halt(None, None) is None  # die Messung am Stecker kennt „sofort“ nicht


def test_steuerart_sofort_gleich_der_portal_projektion():
    """Die geteilten Vektoren - Java ``SteuerartSofortVektorenTest`` liest dieselbe Datei gegen
    ``SteuerartProjektion``. „Guenstige Stunden“ faehrt dieselbe Bahn ``schnell`` und ist trotzdem nicht „sofort“."""
    faelle = json.loads(VEKTOREN.read_text())["faelle"]
    assert len(faelle) >= 15
    for fall in faelle:
        assert steuerart_sofort(fall["policy"], fall["saeule"], fall["anlage"]) is fall["erwartet"]["sofort"], fall["name"]


@pytest.mark.parametrize("lademodus, szene, sofort, halt", [
    (HALT_LADEMODUS_AUS, False, False, HALT_LADEMODUS_AUS),
    (HALT_LADEMODUS_SCHNELL, False, False, HALT_LADEMODUS_SCHNELL),
    (None, True, False, HALT_SZENE),
    (None, False, True, HALT_LADEMODUS_SOFORT),
])
def test_fahrzeugspeicher_gehalten_plant_nur_laden(lademodus, szene, sofort, halt):
    fz = _fz(lademodus=lademodus, szene=szene, sofort=sofort)
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
    assert frei == dataclasses.replace(_fz(lademodus=None, szene=False)) == _fz(sofort=False)


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
@pytest.mark.parametrize("lademodus, szene, sofort", [
    (HALT_LADEMODUS_AUS, False, False), (HALT_LADEMODUS_SCHNELL, False, False), (None, True, False),
    (None, False, True),
])
def test_gehalten_keine_rueckspeisung_und_kein_block(lademodus, szene, sofort):
    """Dieselbe Abendspitze, bei der die Karte (v2g) zurueckspeist: gehalten speist der Plan nie zurueck."""
    plan, eintraege = _lauf(_fz(lademodus=lademodus, szene=szene, sofort=sofort))
    assert all(s.rueckspeisen_kw <= 1e-9 for s in plan.fahrzeug.slots)
    assert eintraege == []  # MP-39: fehlt = nie zurueckspeisen
    # das Abfahrtsziel bleibt erreicht - laden darf der Plan weiter
    assert plan.fahrzeug.slots[-1].soc_kwh >= 0.0


@needs_highs
@pytest.mark.parametrize("lademodus, szene, sofort", [
    (HALT_LADEMODUS_AUS, False, False), (HALT_LADEMODUS_SCHNELL, False, False), (None, True, False),
    (None, False, True),
])
def test_nach_dem_ende_wieder_die_stufe_der_karte(lademodus, szene, sofort):
    """Schnell endet mit der Ladung, die Szene mit „Beenden“, „sofort“ mit „Smart“: der naechste Lauf plant wieder
    mit „Haus + Netz“."""
    _, gehalten = _lauf(_fz(lademodus=lademodus, szene=szene, sofort=sofort))
    plan, (e,) = _lauf(_fz())
    assert gehalten == []
    assert any(s.rueckspeisen_kw > 0 for s in plan.fahrzeug.slots)
    assert e["fahrzeug"]["rueckspeisen"] == "v2g"
    assert all(s["commands"]["setpoint_kw"] < 0 for s in e["slots"])


# --- Lader: Stecker und Szene aus der Datenbank -------------------------------------


def _tabellen(kid, boost=False, reason=None, alter=timedelta(minutes=2), szene=(), soc_alter="wie_zeile",
              anlage="sonne_zuerst", saeule=None, policy=None):
    naechste = datetime(2026, 7, 2, 4, 30, tzinfo=timezone.utc)
    soc_um = T0 - alter if soc_alter == "wie_zeile" else None if soc_alter is None else T0 - soc_alter
    return {
        "ladepunkt_faehigkeit": [(kid, "bidirektional", True, True, False, 11)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, None, None, None, None)],
        "device_charge_connector": [(kid, "Charging", 50.0, T0 - alter, boost, reason, soc_um)],
        "device_charge_point": [(kid, BOX)],
        "ladepunkt_fahrer_einstellung": [(kid, "v2h", 0.5, naechste, 90)],
        "ladepunkt_abfahrt": [(kid, 5, time(7, 30), 80)],
        "site_scene": [(list(szene),)] if szene else [],
        # MP-41c: die Steuerart - Vorgabe hier eine Sonnen-Bahn (nicht „sofort“)
        "site_charging_config": [(anlage,)] if anlage is not None else [],
        "site_charge_point_allowlist": [(kid, saeule)] if saeule is not None else [],
        "consumer_policy": [(kid, json.dumps(policy))] if policy is not None else [],
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


# --- MP-41c: die Steuerart „sofort“ aus der Datenbank ----------------------------------

GUENSTIG = {"schema_version": "1.0", "entity_id": "e1", "requirements": [
    {"id": "r1", "kind": "reactive", "enforcement": "opportunistic", "target": {"kind": "on_off", "value": True},
     "condition": {"signal": "market.import_price_ct_kwh", "operator": "lt", "value": 12}}]}


@pytest.mark.parametrize("anlage, saeule, policy, halt", [
    (None, None, None, HALT_LADEMODUS_SOFORT),            # nie gewaehlt: die Vorgabe der Box schnell
    ("schnell", None, None, HALT_LADEMODUS_SOFORT),
    ("nur_sonne", "schnell", None, HALT_LADEMODUS_SOFORT),  # die eigene Wahl der Saeule schlaegt die Anlage
    ("schnell", "sonne_zuerst", None, None),
    ("sonne_zuerst", None, None, None),
    (None, "schnell", GUENSTIG, None),                     # „Guenstig“ faehrt die Bahn schnell und ist Smart
])
def test_lader_liest_die_steuerart(monkeypatch, anlage, saeule, policy, halt):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, _tabellen(kid, anlage=anlage, saeule=saeule, policy=policy))
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    erwartet = ("aus", 0.0) if halt else ("v2h", 11.0)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw, fz.rueckspeisen_halt) == (*erwartet, halt)


def test_lader_steuerart_einer_anderen_saeule_gilt_hier_nicht(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    tabellen = _tabellen(kid)
    tabellen["site_charge_point_allowlist"] = [(uuid4(), "schnell")]
    _lader(monkeypatch, tabellen)
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert (fz.rueckspeisen, fz.rueckspeisen_halt) == ("v2h", None)


def test_lader_ohne_steuerart_tabellen_ruht_das_zurueckspeisen(monkeypatch):
    """Nicht gelesen ist keine Freigabe: es gilt die Vorgabe der Box (schnell = „sofort“)."""
    import sys
    from types import SimpleNamespace

    from voltpilot_optimization.inputs import load_steuerart_sofort

    class Fehlt(Exception):
        pass

    def connect(dsn):
        raise Fehlt("relation site_charging_config does not exist")

    errors = SimpleNamespace(UndefinedTable=Fehlt, UndefinedColumn=KeyError)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect, errors=errors))
    sofort = load_steuerart_sofort("postgresql://fake", uuid4())
    assert sofort(str(uuid4())) is True


# --- MP-41c: der Ladestand nach seiner eigenen Uhr (BK-41c-2) ----------------------------


@pytest.mark.parametrize("alter, soc_alter, geplant", [
    (timedelta(minutes=2), timedelta(minutes=14), True),    # der Ladestand hat seine eigene, aeltere Uhr
    (timedelta(minutes=2), timedelta(minutes=16), False),   # Zeile frisch, Ladestand alt: kein Ladestand
    (timedelta(minutes=2), None, True),                     # aeltere Box ohne Uhr des Ladestands: die der Zeile
    (timedelta(minutes=16), None, False),                   # und die ist alt
    (timedelta(minutes=16), timedelta(minutes=1), False),   # Zeile alt: Stecker unbekannt, nichts ist aktuell
])
def test_lader_ladestand_an_seiner_eigenen_uhr(monkeypatch, alter, soc_alter, geplant):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, _tabellen(kid, alter=alter, soc_alter=soc_alter))
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert (fz is not None) is geplant
    if geplant:
        assert fz.stand_kwh[0] == pytest.approx(30.0)  # 50 % von 60 kWh


def test_lader_ladestand_alt_aber_lademodus_frisch(monkeypatch):
    """Die Zeile traegt Stecker und Lademodus an ihrer Uhr - ein alter Ladestand nimmt sie nicht mit."""
    from voltpilot_optimization import inputs

    gesehen = []

    def spion(kid, f, fenster, messung, *a, **kw):
        gesehen.append(messung)
        return None, "beobachtet"

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, _tabellen(kid, boost=True, soc_alter=timedelta(minutes=40)))
    monkeypatch.setattr(inputs.fz_regeln, "fahrzeugspeicher", spion)
    assert inputs.load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots) is None
    assert gesehen == [Messung(True, None, HALT_LADEMODUS_SCHNELL)]

"""MiSpeL MP-33f: der Optimierer liest die Einstellungen des Fahrers und sendet den Block ``fahrzeug``.

Vertrag ``docs/contracts/v2/mispel-ladepunkt-bidirektional.md`` § 5a (Zurueckspeisen aus · v2h · v2g, Reserve,
Abfahrten, nur die naechste Fahrt, Akku schonen) und ``docs/contracts/v2/mqtt-schedule-2.0.md`` (Block ``fahrzeug``,
MP-39). Zitierweise „A1 S. 27“ = Anlage 1 der Festlegung (BNetzA, Az. 618-25-02), Seite 27.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import engine
from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization.entities import FahrzeugDispatch, fahrzeug_dispatch
from voltpilot_optimization.fahrzeugspeicher import (
    OHNE_EINSTELLUNG,
    Abfahrt,
    Anwesenheit,
    Faehigkeit,
    FahrerEinstellung,
    Fenster,
    Messung,
    fahrer_abfahrten,
    rueckspeisen_wirksam,
)
from voltpilot_optimization.persistence_v2 import InMemorySitePlanRepository
from voltpilot_optimization.publisher_v2 import RecordingPlanV2Publisher, build_plan_v2_payload, plan_je_box
from voltpilot_optimization.solver import optimize

from test_contract_v2 import EXAMPLES_DIR, load_validator
from test_mispel_fahrzeugspeicher import BERLIN, PENDLER, V2G, V2H, _abend_preise, _input, _lader, _site
from test_solver import T0, needs_highs

import test_bestandsschutz_nw6 as nw6

UNI_V2H = Faehigkeit("bidirektional", True, False, True, 11.0)  # V2H, Rueckspeisung bei Einspeisung unterbunden
NUR_V2G = Faehigkeit("bidirektional", False, True, False, 11.0)
OHNE = Faehigkeit("bidirektional", False, False, False, 11.0)
BOX = "00000000-0000-0000-0000-0000000000e1"


def _fz(einstellung, faehigkeit=V2G, soc_pct=30.0, anwesenheit=PENDLER, mindest=20.0, kap=60.0, n=192,
        angesteckt=True):
    fz, grund = fz_regeln.fahrzeugspeicher(
        "lp-1", faehigkeit, Fenster(mindest, kap, anwesenheit), Messung(angesteckt, soc_pct),
        [T0 + timedelta(minutes=15 * i) for i in range(n)], 15, BERLIN, einstellung=einstellung, box_device_id=BOX,
    )
    assert grund is None, grund
    return fz


# --- Zurueckspeisen: aus · v2h · v2g, nie ueber der Faehigkeit ----------------


@pytest.mark.parametrize("wunsch, faehigkeit, stufe", [
    ("v2g", V2G, "v2g"), ("v2g", V2H, "v2h"), ("v2g", NUR_V2G, "v2g"), ("v2g", OHNE, "aus"),
    ("v2h", V2G, "v2h"), ("v2h", V2H, "v2h"), ("v2h", NUR_V2G, "aus"), ("aus", V2G, "aus"),
    (None, V2G, "aus"), ("ja", V2G, "aus"),
])
def test_rueckspeisen_wirksam_wie_die_ansicht(wunsch, faehigkeit, stufe):
    """Zwilling von ``LadepunktRegeln.rueckspeisenWirksam`` (§ 5a: ``v2g`` ohne V2G → ``v2h``, ohne V2H → ``aus``)."""
    assert rueckspeisen_wirksam(wunsch, faehigkeit) == stufe


@needs_highs
@pytest.mark.parametrize("einstellung", [OHNE_EINSTELLUNG, FahrerEinstellung("aus", 2.0)], ids=["ohne_zeile", "aus"])
def test_stufe_aus_nie_entladen(einstellung):
    """Ohne Zeile oder mit „aus“ plant der Lauf das Fahrzeug nur ladend - auch wenn die Spitze lockt."""
    fz = _fz(einstellung, soc_pct=90.0)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw, fz.v2g) == ("aus", 0.0, False)
    plan = optimize(_input(fz, prices=_abend_preise(spitze=2000.0)), uuid4(), T0)
    assert max(s.rueckspeisen_kw for s in plan.fahrzeug.slots) == 0.0
    assert plan.fahrzeug.messlatte_nur_laden is None  # ohne Rueckspeisung ist der Plan selbst „nur laden“


@needs_highs
def test_stufe_v2h_haelt_die_rueckspeisung_im_haus_trotz_v2g_faehigkeit():
    """V2H vor V2G (E3 = D): der Wunsch „Ins Haus“ an einer V2G-Saeule - kein Export im rueckspeisenden Slot, auch
    wenn die Spitze den Export lohnte (A1 S. 27 Fn. 22)."""
    preise = _abend_preise(spitze=1500.0)
    v2g = optimize(_input(_fz(FahrerEinstellung("v2g"), soc_pct=90.0), prices=preise, load=2.0), uuid4(), T0)
    assert min(s.grid_kw for s in v2g.slots) < -2.0  # mit „Haus + Netz“ geht es ins Netz
    fz = _fz(FahrerEinstellung("v2h"), soc_pct=90.0)
    assert (fz.rueckspeisen, fz.v2g) == ("v2h", False)
    plan = optimize(_input(fz, prices=preise, load=2.0), uuid4(), T0)
    rueck = [t for t, s in enumerate(plan.fahrzeug.slots) if s.rueckspeisen_kw > 1e-6]
    assert rueck and all(plan.slots[t].grid_kw >= -1e-6 for t in rueck)


def test_stufe_nie_ueber_der_faehigkeit():
    assert _fz(FahrerEinstellung("v2g"), faehigkeit=V2H).rueckspeisen == "v2h"
    assert _fz(FahrerEinstellung("v2g"), faehigkeit=V2H).v2g is False
    assert _fz(FahrerEinstellung("v2h"), faehigkeit=UNI_V2H).rueckspeisen == "v2h"
    fz = _fz(FahrerEinstellung("v2g"), faehigkeit=OHNE)
    assert (fz.rueckspeisen, fz.rueckspeisen_kw) == ("aus", 0.0)


# --- Reserve und Abfahrtsziele -----------------------------------------------


@needs_highs
@pytest.mark.parametrize("reserve", [20.0, 45.0])
def test_nie_unter_der_reserve(reserve):
    """``reserve_pct`` = ``mindest_soc_pct`` (§ 5a): die Rueckspeisung endet an der Reserve, wie teuer es auch ist."""
    fz = _fz(FahrerEinstellung("v2g", 2.0), soc_pct=95.0, mindest=reserve)
    plan = optimize(_input(fz, prices=_abend_preise(spitze=3000.0)), uuid4(), T0)
    assert max(s.rueckspeisen_kw for s in plan.fahrzeug.slots) > 0.0
    for s in plan.fahrzeug.slots:
        if s.soc_kwh is not None:
            assert s.soc_kwh >= reserve / 100.0 * 60.0 - 1e-6


def test_abfahrten_des_fahrers_und_naechste_fahrt():
    """Wochenplan je Wochentag; „nur die naechste Fahrt“ ersetzt ihn bis einschliesslich zu ihr, danach gilt er
    wieder (§ 5a); eine vergangene naechste Fahrt zaehlt nicht."""
    woche = (Abfahrt(4, time(7, 0), 80.0), Abfahrt(5, time(7, 0), 85.0))  # Do, Fr 07:00 Ortszeit
    bis = T0 + timedelta(hours=48)
    utc = timezone.utc
    assert fahrer_abfahrten(FahrerEinstellung("v2g", None, woche), T0, bis, BERLIN)[:2] == [
        (datetime(2026, 7, 2, 5, 0, tzinfo=utc), 80.0), (datetime(2026, 7, 3, 5, 0, tzinfo=utc), 85.0)]
    naechste = (datetime(2026, 7, 3, 4, 0, tzinfo=utc), 95.0)  # Fr 06:00 Ortszeit
    mit = fahrer_abfahrten(FahrerEinstellung("v2g", None, woche, naechste), T0, bis, BERLIN)
    assert mit[:3] == [naechste, (datetime(2026, 7, 3, 5, 0, tzinfo=utc), 85.0),
                       (datetime(2026, 7, 9, 5, 0, tzinfo=utc), 80.0)]
    vergangen = (T0 - timedelta(hours=1), 95.0)
    assert fahrer_abfahrten(FahrerEinstellung("v2g", None, woche, vergangen), T0, bis, BERLIN) == \
        fahrer_abfahrten(FahrerEinstellung("v2g", None, woche), T0, bis, BERLIN)


@needs_highs
@pytest.mark.parametrize("seed", range(3))
@pytest.mark.parametrize("soc_pct", [0.0, 60.0, 100.0])
def test_abfahrtsziel_des_fahrers_immer_erreicht(seed, soc_pct):
    """Die Abfahrt des Fahrers Do 06:00 mit 90 % liegt vor dem Fensterende 07:00 (80 %): das Fahrzeug faehrt um
    06:00, mit dem hoeheren Ziel - und das wird erreicht; Fr 07:00 (Fenster 80 %, Fahrer 85 %) ebenso."""
    woche = (Abfahrt(4, time(6, 0), 90.0), Abfahrt(5, time(7, 0), 85.0))
    fz = _fz(FahrerEinstellung("v2g", None, woche), soc_pct=soc_pct)
    assert [s for s, _ in fz.abfahrten] == [24, 124]  # Do 06:00, Fr 07:00
    assert [z for _, z in fz.abfahrten] == [pytest.approx(54.0), pytest.approx(51.0)]
    assert not fz.angesteckt[24] and fz.angesteckt[23]
    plan = optimize(_input(fz, prices=_abend_preise(seed=seed, spitze=400.0 + 300.0 * seed)), uuid4(), T0)
    for s, ziel, geplant in plan.fahrzeug.abfahrten:
        assert geplant >= ziel - 1e-6, (s, ziel, geplant)


@needs_highs
def test_ohne_fenster_steht_das_auto_bis_zur_abfahrt_des_fahrers():
    """BK-41 A: der Fahrer denkt in Abfahrten, nicht in Fenstern. Gemessen angesteckt, kein Fenster - es steht bis
    zur naechsten Abfahrt und erreicht ihr Ziel; danach ist es weg (die Rueckkehr kennt der Plan nicht)."""
    woche = (Abfahrt(4, time(7, 0), 85.0),)
    fz = _fz(FahrerEinstellung("v2h", 0.5, woche), soc_pct=50.0, anwesenheit=())
    assert fz.angesteckt[:28] == (True,) * 28 and not any(fz.angesteckt[28:])
    assert fz.naechste_abfahrt == (datetime(2026, 7, 2, 5, 0, tzinfo=timezone.utc), 85.0)
    plan = optimize(_input(fz), uuid4(), T0)
    ((s, ziel, geplant),) = plan.fahrzeug.abfahrten
    assert (s, ziel) == (28, pytest.approx(51.0)) and geplant >= ziel - 1e-6
    # ohne Messung und ohne Fenster: nichts zu planen
    _, grund = fz_regeln.fahrzeugspeicher(
        "lp-1", V2G, Fenster(20.0, 60.0, ()), None, [T0 + timedelta(minutes=15 * i) for i in range(192)], 15,
        BERLIN, einstellung=FahrerEinstellung("v2g", None, woche))
    assert grund == "nicht_im_horizont"


def test_leer_ist_das_heutige_verhalten():
    """Gesagt ist nur die Stufe ``v2g`` an einer V2G-Saeule: Fenster, Ziele, Grenzen und Zyklenbudget wie MP-33."""
    alt = _fz(None)
    neu = _fz(FahrerEinstellung("v2g"))
    felder = ("angesteckt", "stand_kwh", "untergrenze_kwh", "abfahrten", "rueckspeisen_kw", "v2g", "vollzyklen_je_tag")
    assert [getattr(neu, f) for f in felder] == [getattr(alt, f) for f in felder]
    assert alt.rueckspeisen is None and neu.rueckspeisen == "v2g"


# --- Akku schonen: 0,5 · 1 · 2 Vollzyklen je Tag ------------------------------


def _wechselpreise(n=192):
    """Stuendlich teuer und billig im Wechsel: lohnt viele Zyklen am Tag."""
    return [900.0 if (T0 + timedelta(minutes=15 * i)).astimezone(BERLIN).hour % 2 else 10.0 for i in range(n)]


#: Fast rund um die Uhr am Ladepunkt (07:00 bis 06:45 am Folgetag, jeden Tag), Ziel 50 %.
RUND = tuple(Anwesenheit(w, time(7, 0), time(6, 45), 50.0) for w in range(1, 8))


@needs_highs
def test_zyklenbudget_05_1_2_wirkt():
    rueck_je_tag = {}
    for k in (0.5, 1.0, 2.0):
        fz = _fz(FahrerEinstellung("v2g", k), soc_pct=90.0, anwesenheit=RUND)
        assert fz.vollzyklen_je_tag == k
        plan = optimize(_input(fz, prices=_wechselpreise()), uuid4(), T0)
        tage: dict[str, float] = {}
        for t, s in enumerate(plan.fahrzeug.slots):
            tage[fz.tag_je_slot[t]] = tage.get(fz.tag_je_slot[t], 0.0) + s.rueckspeisen_kw * 0.25
        assert all(v <= k * 60.0 + 1e-6 for v in tage.values()), (k, tage)
        rueck_je_tag[k] = tage
    assert max(rueck_je_tag[0.5].values()) == pytest.approx(30.0, abs=1e-4)  # 0,5 * 60 kWh bindet
    assert max(rueck_je_tag[1.0].values()) == pytest.approx(60.0, abs=1e-4)  # 1 * 60 kWh bindet
    assert sum(rueck_je_tag[1.0].values()) > sum(rueck_je_tag[0.5].values()) + 1.0
    assert sum(rueck_je_tag[2.0].values()) > sum(rueck_je_tag[1.0].values()) + 1.0
    # nicht gesagt = die feste 1 (domain.py FAHRZEUG_VOLLZYKLEN_JE_TAG)
    assert _fz(FahrerEinstellung("v2g", None)).vollzyklen_je_tag == 1.0


# --- Der Block ``fahrzeug`` im Fahrplan 2.0 -----------------------------------

BEISPIEL = EXAMPLES_DIR / "mqtt-schedule-2.0.valid.fahrzeug-aus-dem-optimierer.json"


def _dispatch(**kw) -> FahrzeugDispatch:
    starts = tuple(nw6.T0 + timedelta(minutes=15 * i) for i in range(4))
    werte = dict(
        entity_id="9f0c2a54-7b1e-4c3d-8a2f-5e6d7c8b9a01", device_id=nw6.E_1, rueckspeisen="v2h",
        mindest_soc_pct=40.0, abfahrt=datetime(2027, 6, 14, 5, 0, tzinfo=timezone.utc), abfahrt_soc_pct=80.0,
        kapazitaet_kwh=60.0, rueckspeiseleistung_kw=10.0, slot_starts=starts,
        rueckspeisen_kw=(0.0, 7.25, 10.0, 0.0001),
    )
    werte.update(kw)
    return FahrzeugDispatch(**werte)


@needs_highs
def test_block_fahrzeug_gleich_dem_vertragsbeispiel():
    """Das Vertragsbeispiel IST die Ausgabe des Senders (Vektor): Block wie MP-39 ihn liest, nur die
    rueckspeisenden Slots mit negativem ``setpoint_kw``, alles andere im Dokument wie vorher."""
    payload = build_plan_v2_payload(dataclasses.replace(nw6._plan(), fahrzeug=_dispatch()))
    assert payload == json.loads(BEISPIEL.read_text())
    assert list(load_validator().iter_errors(payload)) == []
    ohne = dict(payload, entities=[e for e in payload["entities"] if e.get("kind") != "ev-charger"])
    assert nw6._fingerabdruck(ohne) == nw6.VOR_AP15  # der Rest des Dokuments ist byte-gleich


@needs_highs
@pytest.mark.parametrize("aenderung", [
    {"device_id": UUID(int=0xE2)},  # die Saeule haengt an einer anderen Box
    {"device_id": None},  # Box unbekannt
    {"rueckspeisen": "aus"},
    {"rueckspeisen_kw": (0.0, 0.0, 0.0, 0.0004)},  # kein Rueckspeisewunsch im Fenster
], ids=["andere_box", "box_unbekannt", "aus", "kein_wunsch"])
def test_ohne_rueckspeisewunsch_oder_fremde_box_kein_eintrag(aenderung):
    """Fehlt der Eintrag, speist die Box nie zurueck (MP-39) - fuer sie dasselbe wie „aus“."""
    payload = build_plan_v2_payload(dataclasses.replace(nw6._plan(), fahrzeug=_dispatch(**aenderung)))
    assert nw6._fingerabdruck(payload) == nw6.VOR_AP15


@needs_highs
def test_block_nur_reserve_und_ziel_die_gesagt_sind():
    payload = build_plan_v2_payload(dataclasses.replace(
        nw6._plan(), fahrzeug=_dispatch(mindest_soc_pct=None, abfahrt=None, abfahrt_soc_pct=None)))
    (eintrag,) = [e for e in payload["entities"] if e["kind"] == "ev-charger"]
    assert eintrag["fahrzeug"] == {"rueckspeisen": "v2h", "kapazitaet_kwh": 60.0, "rueckspeiseleistung_kw": 10.0}
    assert list(load_validator().iter_errors(payload)) == []


@needs_highs
def test_gemeinsame_steuerung_eintrag_im_dokument_der_box_der_saeule():
    """In der scharfen Gemeinsamen Steuerung steht der Eintrag nur im Dokument der Box, an der die Saeule haengt."""
    import test_plan_je_box as pjb

    plan = dataclasses.replace(pjb._plan(), fahrzeug=_dispatch(device_id=pjb.E_4))
    dokumente = plan_je_box(plan, pjb._stand(), lauf_nr=3)
    mit_fahrzeug = [d.device_id for d in dokumente if d.payload and any(
        e.get("kind") == "ev-charger" for e in d.payload["entities"])]
    assert mit_fahrzeug == [pjb.E_4]


# --- Bestandsschutz: ausserhalb des Schalters und ohne Fahrzeug byte-gleich ---


def _zyklus(monkeypatch, schalter: str, inp_fahrzeug, fahrzeug_plan):
    plan = nw6._plan()
    monkeypatch.setattr(engine, "from_v1_input", lambda inp: SimpleNamespace())
    monkeypatch.setattr(engine, "co_optimize", lambda co, plan_id, now: plan)
    monkeypatch.delenv("VOLTPILOT_CONTROLLABLE_LOADS", raising=False)
    monkeypatch.setenv("VOLTPILOT_MISPEL_FAHRZEUG_SITES", schalter)
    publisher, repo = RecordingPlanV2Publisher(), InMemorySitePlanRepository()
    site = SimpleNamespace(site_id=nw6.SITE, device_id=nw6.E_1, verbund=None)
    inp = SimpleNamespace(soc_unbekannt=False, battery_observed=False, fahrzeug=inp_fahrzeug,
                          slot_starts=[nw6.T0 + timedelta(minutes=15 * i) for i in range(4)])
    engine._shadow_publish_v2("dsn", site, inp, nw6.T0, publisher, frozenset({nw6.SITE}), repo,
                              fahrzeug_plan=fahrzeug_plan)
    ((_, payload),) = publisher.published
    return payload


def _fahrzeug_des_laufs():
    fz = dataclasses.replace(_fz(FahrerEinstellung("v2h"), n=4), box_device_id=str(nw6.E_1), komponente_id="lp-1")
    slots = tuple(fz_regeln_slot(kw) for kw in (0.0, 5.0, 11.0, 0.0))
    from voltpilot_optimization.domain import FahrzeugPlan

    return fz, FahrzeugPlan(komponente_id="lp-1", slots=slots)


def fz_regeln_slot(kw):
    from voltpilot_optimization.domain import FahrzeugSlot

    return FahrzeugSlot(laden_kw=0.0, rueckspeisen_kw=kw, soc_kwh=30.0)


@needs_highs
def test_bestandsschutz_ausserhalb_des_schalters_und_ohne_fahrzeug(monkeypatch):
    fz, fz_plan = _fahrzeug_des_laufs()
    assert nw6._fingerabdruck(_zyklus(monkeypatch, "", fz, fz_plan)) == nw6.VOR_AP15
    assert nw6._fingerabdruck(_zyklus(monkeypatch, str(uuid4()), fz, fz_plan)) == nw6.VOR_AP15
    assert nw6._fingerabdruck(_zyklus(monkeypatch, str(nw6.SITE), None, None)) == nw6.VOR_AP15
    # im Schalter mit Fahrzeug: der Eintrag kommt dazu, der Rest bleibt
    payload = _zyklus(monkeypatch, str(nw6.SITE), fz, fz_plan)
    (eintrag,) = [e for e in payload["entities"] if e.get("kind") == "ev-charger"]
    assert eintrag["entity_id"] == "lp-1" and eintrag["fahrzeug"]["rueckspeisen"] == "v2h"
    assert [s["commands"]["setpoint_kw"] for s in eintrag["slots"]] == [-5.0, -11.0]
    ohne = dict(payload, entities=[e for e in payload["entities"] if e.get("kind") != "ev-charger"])
    assert nw6._fingerabdruck(ohne) == nw6.VOR_AP15


def test_dispatch_ohne_gelesene_einstellung_ist_kein_block():
    fz, fz_plan = _fahrzeug_des_laufs()
    assert fahrzeug_dispatch(dataclasses.replace(fz, rueckspeisen=None), fz_plan, []) is None


@needs_highs
def test_ganzer_lauf_mit_fahrzeug_gegen_das_schema():
    """Lauf mit Fahrzeug (Pendler, V2H, Akku schonen 0,5) bis zum Dokument: schema-gueltig, Freigabe wie gesagt."""
    fz = dataclasses.replace(_fz(FahrerEinstellung("v2h", 0.5), soc_pct=90.0), box_device_id=str(nw6.E_1))
    inp = _input(fz, prices=_abend_preise(spitze=900.0), load=2.0)
    plan = optimize(inp, uuid4(), T0)
    eintrag = fahrzeug_dispatch(fz, plan.fahrzeug, list(inp.slot_starts))
    site_plan = dataclasses.replace(nw6._plan(), fahrzeug=dataclasses.replace(
        eintrag, slot_starts=tuple(nw6.T0 + (s - T0) for s in eintrag.slot_starts)))
    payload = build_plan_v2_payload(site_plan)
    assert list(load_validator().iter_errors(payload)) == []
    (e,) = [e for e in payload["entities"] if e.get("kind") == "ev-charger"]
    assert e["fahrzeug"]["rueckspeisen"] == "v2h" and e["fahrzeug"]["mindest_soc_pct"] == 20.0
    assert e["fahrzeug"]["abfahrt"] == "2026-07-02T05:00:00Z" and e["fahrzeug"]["abfahrt_soc_pct"] == 80.0
    assert all(s["commands"]["setpoint_kw"] < 0 for s in e["slots"])


# --- Lader ---------------------------------------------------------------------


def test_lader_liest_die_einstellungen_des_fahrers(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    naechste = datetime(2026, 7, 2, 4, 30, tzinfo=timezone.utc)
    _lader(monkeypatch, {
        "ladepunkt_faehigkeit": [(kid, "bidirektional", True, True, False, 11)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, None, None, None, None)],
        "device_charge_connector": [(kid, "Charging", 50.0, T0 - timedelta(minutes=2), False, None,
                                     T0 - timedelta(minutes=2))],
        "device_charge_point": [(kid, BOX)],
        "ladepunkt_fahrer_einstellung": [(kid, "v2h", 0.5, naechste, 90)],
        "ladepunkt_abfahrt": [(kid, 5, time(7, 30), 80)],
        "site_charging_config": [("nur_sonne",)],  # MP-41c: nicht „sofort“
    })
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert fz is not None
    assert (fz.rueckspeisen, fz.v2g, fz.vollzyklen_je_tag, fz.box_device_id) == ("v2h", False, 0.5, BOX)
    assert fz.naechste_abfahrt == (naechste, 90.0)  # nur die naechste Fahrt (Do 06:30) vor dem Wochenplan
    assert sum(fz.angesteckt) == 26  # Do 00:00 bis 06:30, ohne Fenster aus der Messung


def test_lader_ohne_tabellen_des_fahrers_gilt_aus(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrer_einstellungen

    class Fehlt(Exception):
        pass

    def connect(dsn):
        raise Fehlt("relation ladepunkt_fahrer_einstellung does not exist")

    errors = SimpleNamespace(UndefinedTable=Fehlt, UndefinedColumn=KeyError)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect, errors=errors))
    assert load_fahrer_einstellungen("postgresql://fake", uuid4()) == {}

"""MiSpeL MP-41c (BK-41c-1 = A): der Ladepunkt-Eintrag wird abgelegt, wie er gesendet wird.

Der Optimierer legt den Eintrag mit dem Block ``fahrzeug`` in ``entity_plan_slot`` ab - aus derselben Funktion
(:func:`publisher_v2.fahrzeug_viertelstunden`), aus der der Sender ihn baut: ``setpoint_kw`` mit -kW in den
Rueckspeise-Viertelstunden, 0 in den uebrigen des gesendeten Fensters, ``reason_code`` ``fahrzeug_rueckspeisen``.
Ohne Eintrag keine Zeile - „nicht gerechnet“ bleibt von „gerechnet, kein Zurueckspeisen“ unterscheidbar.
"""

from __future__ import annotations

import dataclasses
import math
from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import engine
from voltpilot_optimization.entities import (
    REASON_FAHRZEUG_RUECKSPEISEN,
    FahrzeugDispatch,
    LoadDispatch,
    LoadSlot,
    SitePlan,
)
from voltpilot_optimization.persistence_v2 import InMemorySitePlanRepository, consumer_slot_rows
from voltpilot_optimization.publisher_v2 import (
    EDGE_PLAN_SLOTS,
    RecordingPlanV2Publisher,
    build_plan_v2_payload,
    fahrzeug_viertelstunden,
)

from test_mispel_fahrer_einstellungen import _fahrzeug_des_laufs
from test_solver import needs_highs

import test_bestandsschutz_nw6 as nw6

N = EDGE_PLAN_SLOTS + 8  # der Plan reicht weiter als das gesendete Fenster
STARTS = tuple(nw6.T0 + timedelta(minutes=15 * i) for i in range(N))


def _kw(**slots) -> tuple[float, ...]:
    werte = [0.0] * N
    for i, kw in slots.items():
        werte[int(i[1:])] = kw
    return tuple(werte)


#: 18:00-19:00 zurueck, eine Spur unter der Rundung, und eine Viertelstunde nach dem gesendeten Fenster.
RUECK = _kw(s28=2.4, s29=2.4, s30=1.8, s31=1.6, s40=0.0004, **{f"s{EDGE_PLAN_SLOTS + 2}": 5.0})


def _eintrag(**kw) -> FahrzeugDispatch:
    werte = dict(
        entity_id="lp-1", device_id=nw6.E_1, rueckspeisen="v2h", mindest_soc_pct=40.0,
        abfahrt=nw6.T0 + timedelta(hours=20), abfahrt_soc_pct=80.0, kapazitaet_kwh=60.0,
        rueckspeiseleistung_kw=11.0, slot_starts=STARTS, rueckspeisen_kw=RUECK,
    )
    werte.update(kw)
    return FahrzeugDispatch(**werte)


def _plan(fahrzeug=None, loads=None, device_id=nw6.E_1) -> SitePlan:
    """Ein Lauf ohne Solver: ein Verbraucher ``c-1`` haelt das Dokument baubar, auch ohne Ladepunkt-Eintrag."""
    pumpe = LoadDispatch("c-1", "on_off", [LoadSlot(s, i % 3 == 0, 2.0 if i % 3 == 0 else 0.0,
                                                    "fixed_window" if i % 3 == 0 else None,
                                                    "req-1" if i % 3 == 0 else None)
                                           for i, s in enumerate(STARTS)])
    return SitePlan(plan_id=uuid4(), tenant_id=nw6.SITE, site_id=nw6.SITE, device_id=device_id,
                    generated_at=nw6.T0, loads=[pumpe] if loads is None else loads, fahrzeug=fahrzeug)


def _zeilen(plan, entity="lp-1"):
    return [r for r in consumer_slot_rows(plan) if r[5] == entity]


def _gesendet(plan, entity="lp-1"):
    return [e for e in build_plan_v2_payload(plan)["entities"] if e["entity_id"] == entity and "fahrzeug" in e]


def _zeit(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# --- Ablage = Sendung ----------------------------------------------------------------


def test_abgelegt_wie_gesendet():
    plan = _plan(_eintrag())
    zeilen = _zeilen(plan)
    (eintrag,) = _gesendet(plan)
    # eine Zeile je Viertelstunde des gesendeten Fensters, alle mit demselben Befehl und Grund
    assert [r[0] for r in zeilen] == list(STARTS[:EDGE_PLAN_SLOTS])
    assert {(r[6], r[8], r[9]) for r in zeilen} == {("setpoint_kw", REASON_FAHRZEUG_RUECKSPEISEN, None)}
    assert {(r[1], r[2], r[3], r[4]) for r in zeilen} == {(plan.tenant_id, plan.site_id, plan.plan_id, nw6.T0)}
    # die negativen Zeilen SIND die gesendeten Slots - Zeit und Wert
    assert [(r[0], r[7]) for r in zeilen if r[7] != 0.0] == [
        (_zeit(s["start"]), s["commands"]["setpoint_kw"]) for s in eintrag["slots"]]
    assert [r[7] for r in zeilen if r[7] != 0.0] == [-2.4, -2.4, -1.8, -1.6]
    # 0 ist eine echte Null (nie -0.0), auch unter der Rundung; hinter dem Fenster nichts
    assert all(math.copysign(1.0, r[7]) == 1.0 for r in zeilen if r[7] == 0.0)
    assert sum(1 for r in zeilen if r[7] == 0.0) == EDGE_PLAN_SLOTS - 4


def test_eine_funktion_fuer_sender_und_ablage():
    plan = _plan(_eintrag())
    viertel = fahrzeug_viertelstunden(plan)
    assert [(r[0], r[7]) for r in _zeilen(plan)] == viertel
    assert len(viertel) == EDGE_PLAN_SLOTS


@pytest.mark.parametrize("aenderung", [
    {"rueckspeisen": "aus"},  # Halte-Grund oder keine Freigabe: die Stufe ist aus
    {"rueckspeisen_kw": _kw(s40=0.0004)},  # kein Rueckspeisewunsch im Fenster
    {"rueckspeisen_kw": _kw(**{f"s{EDGE_PLAN_SLOTS + 1}": 7.0})},  # erst hinter dem Fenster
], ids=["stufe_aus", "kein_wunsch", "hinter_dem_fenster"])
def test_gerechnet_ohne_zurueckspeisen_nur_nullen(aenderung):
    """Die Box bekommt keinen Eintrag (fehlt = nie entladen), die Ablage sagt: gerechnet, 0 kW."""
    plan = _plan(_eintrag(**aenderung))
    assert _gesendet(plan) == []
    zeilen = _zeilen(plan)
    assert len(zeilen) == EDGE_PLAN_SLOTS
    assert {r[7] for r in zeilen} == {0.0}
    assert {r[8] for r in zeilen} == {REASON_FAHRZEUG_RUECKSPEISEN}


def test_saeule_an_anderer_box_nicht_im_dokument_dieser_box():
    """Welche Box ueberhaupt ein Dokument bekommt, entscheidet der Lauf (``engine._mit_fahrzeug``, Tests unten)."""
    plan = _plan(_eintrag(device_id=UUID(int=0xE2)))
    assert fahrzeug_viertelstunden(plan) is None
    assert _gesendet(plan) == []


def test_box_unbekannt_weder_gesendet_noch_abgelegt():
    plan = _plan(_eintrag(device_id=None))
    assert fahrzeug_viertelstunden(plan) is None
    assert _gesendet(plan) == [] and _zeilen(plan) == []


def test_ladepunkt_auch_verbraucher_eine_zeile_je_viertelstunde():
    """firstmate 002: plant der Lauf dieselbe Saeule auch als Verbraucher (ihre Policy, Co-Optimierer), steht je
    Viertelstunde GENAU EINE Zeile - der Schluessel (entity_id, generated_at, time) haelt keine zwei. Zurueckspeisen
    vor Laden (die Box reserviert den Stecker beim Entladen; der Co-Optimierer kennt das Fahrzeug nicht, beides kann
    auf dieselbe Viertelstunde fallen), sonst das geplante Laden mit seinem Grund, sonst die 0 des Fahrzeugs."""
    laden = {10: 7.4, 11: 7.4, 29: 3.7}  # 29 faellt in die Rueckspeisung 28-31
    lp_last = LoadDispatch("lp-1", "continuous", [
        LoadSlot(s, i in laden, laden.get(i, 0.0), "flex_deadline" if i in laden else None,
                 "ziel@x" if i in laden else None)
        for i, s in enumerate(STARTS)])
    plan = _plan(_eintrag(), loads=[_plan().loads[0], lp_last])
    zeilen = _zeilen(plan)
    assert [r[0] for r in zeilen] == list(STARTS)  # eine je Viertelstunde, kein doppelter Schluessel
    alle = consumer_slot_rows(plan)
    assert len({(r[5], r[4], r[0]) for r in alle}) == len(alle)
    je = {r[0]: r for r in zeilen}
    for i in (10, 11):
        assert je[STARTS[i]][6:] == ("setpoint_kw", 7.4, "flex_deadline", "ziel@x")
    for i, kw in zip((28, 29, 30, 31), (-2.4, -2.4, -1.8, -1.6)):
        assert je[STARTS[i]][6:] == ("setpoint_kw", kw, REASON_FAHRZEUG_RUECKSPEISEN, None)
    assert je[STARTS[0]][6:] == ("setpoint_kw", 0.0, REASON_FAHRZEUG_RUECKSPEISEN, None)
    # hinter dem gesendeten Fenster bleibt die Verbraucher-Zeile, wie vorher
    assert je[STARTS[EDGE_PLAN_SLOTS + 2]][6:] == ("setpoint_kw", 0.0, None, None)
    # firstmate 003: im Dokument ERSETZT der Fahrzeug-Eintrag den Verbraucher-Eintrag derselben Komponente
    assert [e["kind"] for e in build_plan_v2_payload(plan)["entities"] if e["entity_id"] == "lp-1"] == ["ev-charger"]
    # die Rueckspeise-Zeilen bleiben die gesendeten Slots des Eintrags
    (eintrag,) = _gesendet(plan)
    assert [(r[0], r[7]) for r in zeilen if r[7] < 0] == [
        (_zeit(s["start"]), s["commands"]["setpoint_kw"]) for s in eintrag["slots"]]
    # die Pumpe daneben unveraendert
    pumpe = [(r[0], *r[6:]) for r in alle if r[5] == "c-1"]
    assert pumpe == [(r[0], *r[6:]) for r in consumer_slot_rows(_plan()) if r[5] == "c-1"]


def test_ladepunkt_auch_verbraucher_ohne_fahrzeug_wie_vorher():
    lp_last = LoadDispatch("lp-1", "continuous", [LoadSlot(s, True, 3.7, "flex_deadline", "r@x") for s in STARTS])
    plan = _plan(loads=[lp_last])
    assert [r[6:] for r in _zeilen(plan)] == [("setpoint_kw", 3.7, "flex_deadline", "r@x")] * N
    assert [e["kind"] for e in build_plan_v2_payload(plan)["entities"]] == ["consumer"]


def test_ladepunkt_auch_verbraucher_ohne_rueckspeisewunsch_dokument_byte_gleich():
    """Ohne gesendeten Fahrzeug-Eintrag (kein −kW im Fenster) bleibt der Verbraucher-Eintrag - das Dokument ist
    byte-gleich zum Lauf ohne Fahrzeug; die Ablage sagt in den Viertelstunden ohne Laden „gerechnet, 0“."""
    lp_last = LoadDispatch("lp-1", "continuous", [LoadSlot(s, i == 3, 3.7 if i == 3 else 0.0,
                                                           "flex_deadline" if i == 3 else None, None)
                                                  for i, s in enumerate(STARTS)])
    ohne = _plan(loads=[lp_last])
    mit = dataclasses.replace(ohne, fahrzeug=_eintrag(rueckspeisen="aus"))
    assert build_plan_v2_payload(mit) == build_plan_v2_payload(ohne)
    je = {r[0]: r[6:] for r in _zeilen(mit)}
    assert je[STARTS[3]] == ("setpoint_kw", 3.7, "flex_deadline", None)
    assert je[STARTS[4]] == ("setpoint_kw", 0.0, REASON_FAHRZEUG_RUECKSPEISEN, None)


# --- Bestandsschutz: ohne Fahrzeug die Zeilen von vorher ------------------------------


def test_ohne_fahrzeug_zeilen_wie_vorher():
    plan = _plan()
    vorher = [(s.start, plan.tenant_id, plan.site_id, plan.plan_id, plan.generated_at, "c-1", "on_off",
               s.power_kw if s.on else 0.0, s.reason_code, s.requirement_id) for s in plan.loads[0].slots]
    assert consumer_slot_rows(plan) == vorher
    repo = InMemorySitePlanRepository()
    assert repo.upsert_site_plan(plan) == N
    assert repo.upsert_site_plan(_plan(_eintrag())) == N + EDGE_PLAN_SLOTS


# --- Der Lauf: Eintrag nur, wenn die Box der Saeule ein Dokument bekommt ---------------


def _zyklus(monkeypatch, fz, fz_plan):
    plan = nw6._plan()
    monkeypatch.setattr(engine, "from_v1_input", lambda inp: SimpleNamespace())
    monkeypatch.setattr(engine, "co_optimize", lambda co, plan_id, now: plan)
    monkeypatch.delenv("VOLTPILOT_CONTROLLABLE_LOADS", raising=False)
    monkeypatch.setenv("VOLTPILOT_MISPEL_FAHRZEUG_SITES", str(nw6.SITE))
    publisher, repo = RecordingPlanV2Publisher(), InMemorySitePlanRepository()
    site = SimpleNamespace(site_id=nw6.SITE, device_id=nw6.E_1, verbund=None)
    inp = SimpleNamespace(soc_unbekannt=False, fahrzeug=fz,
                          slot_starts=[nw6.T0 + timedelta(minutes=15 * i) for i in range(4)])
    engine._shadow_publish_v2("dsn", site, inp, nw6.T0, publisher, frozenset({nw6.SITE}), repo,
                              fahrzeug_plan=fz_plan)
    ((_, payload),) = publisher.published
    return payload, repo.latest_for_site(nw6.SITE)


@needs_highs
def test_lauf_legt_ab_was_er_sendet(monkeypatch):
    fz, fz_plan = _fahrzeug_des_laufs()
    payload, gespeichert = _zyklus(monkeypatch, fz, fz_plan)
    (eintrag,) = [e for e in payload["entities"] if e.get("kind") == "ev-charger"]
    zeilen = _zeilen(gespeichert)
    assert [(r[0], r[7]) for r in zeilen] == [(nw6.T0 + timedelta(minutes=15 * i), kw)
                                             for i, kw in enumerate((0.0, -5.0, -11.0, 0.0))]
    assert [(r[0], r[7]) for r in zeilen if r[7] < 0] == [
        (_zeit(s["start"]), s["commands"]["setpoint_kw"]) for s in eintrag["slots"]]


@needs_highs
def test_lauf_saeule_an_fremder_box_weder_gesendet_noch_abgelegt(monkeypatch):
    fz, fz_plan = _fahrzeug_des_laufs()
    payload, gespeichert = _zyklus(monkeypatch, dataclasses.replace(fz, box_device_id=str(UUID(int=0xE2))), fz_plan)
    assert nw6._fingerabdruck(payload) == nw6.VOR_AP15
    assert gespeichert.fahrzeug is None and _zeilen(gespeichert) == []


@needs_highs
@pytest.mark.parametrize("box, erwartet", [("E_4", True), ("fremd", False)])
def test_gemeinsame_steuerung_nur_an_einer_box_mit_dokument(monkeypatch, box, erwartet):
    import test_plan_je_box as pjb

    monkeypatch.setenv("VOLTPILOT_MISPEL_FAHRZEUG_SITES", str(pjb._plan().site_id))
    fz, fz_plan = _fahrzeug_des_laufs()
    saeule = pjb.E_4 if box == "E_4" else UUID(int=0xE9)
    fz = dataclasses.replace(fz, box_device_id=str(saeule))
    plan = pjb._plan()
    site = SimpleNamespace(site_id=plan.site_id)
    inp = SimpleNamespace(fahrzeug=fz, slot_starts=[nw6.T0 + timedelta(minutes=15 * i) for i in range(4)])
    mit = engine._mit_fahrzeug(plan, site, inp, fz_plan, pjb._stand())
    assert (mit.fahrzeug is not None) is erwartet
    assert bool(_zeilen(mit)) is erwartet


@needs_highs
def test_lauf_mit_beiden_schaltern_und_policy_an_der_saeule(monkeypatch):
    """firstmate 003 (3): OPTIMIZER_CONTROLLABLE_LOADS_ENABLED + VOLTPILOT_MISPEL_FAHRZEUG_SITES, die Saeule traegt eine
    Policy (der Co-Optimierer plant sie als Verbraucher): das Dokument traegt fuer sie NUR den Fahrzeug-Eintrag, der
    Rest ist byte-gleich; die Ablage hat je Viertelstunde eine Zeile nach der Vorrang-Regel, kein Schluessel doppelt."""

    @dataclasses.dataclass(frozen=True)
    class _Co:
        import_prices: tuple = (0.0,) * 4
        controllable_loads: tuple = ()

    fz, fz_plan = _fahrzeug_des_laufs()  # zurueck (0, 5, 11, 0) kW
    starts = [nw6.T0 + timedelta(minutes=15 * i) for i in range(4)]
    laden = (3.7, 3.7, 0.0, 0.0)  # Viertelstunde 1: Laden UND Zurueckspeisen
    lp_last = LoadDispatch("lp-1", "continuous", [
        LoadSlot(s, kw > 0, kw, "price_below_threshold" if kw > 0 else None, "r1" if kw > 0 else None)
        for s, kw in zip(starts, laden)])
    gesehen = []

    def co_optimize(co, plan_id, now):
        gesehen.append(co.controllable_loads)
        return dataclasses.replace(nw6._plan(), loads=[lp_last])

    monkeypatch.setattr(engine, "from_v1_input", lambda inp: _Co())
    monkeypatch.setattr(engine, "co_optimize", co_optimize)
    monkeypatch.setattr(engine, "load_consumer_entities", lambda *a, **kw: ("policy-der-saeule",))
    monkeypatch.setenv("OPTIMIZER_CONTROLLABLE_LOADS_ENABLED", "true")
    monkeypatch.setenv("VOLTPILOT_MISPEL_FAHRZEUG_SITES", str(nw6.SITE))
    publisher, repo = RecordingPlanV2Publisher(), InMemorySitePlanRepository()
    site = SimpleNamespace(site_id=nw6.SITE, device_id=nw6.E_1, verbund=None)
    inp = SimpleNamespace(soc_unbekannt=False, fahrzeug=fz, slot_starts=starts, slot_minutes=15,
                          prices_eur_mwh=[100.0] * 4)
    engine._shadow_publish_v2("dsn", site, inp, nw6.T0, publisher, frozenset({nw6.SITE}), repo,
                              fahrzeug_plan=fz_plan)
    assert gesehen == [("policy-der-saeule",)]  # der Verbraucher-Pfad lief wirklich
    ((_, payload),) = publisher.published
    assert [e["kind"] for e in payload["entities"] if e["entity_id"] == "lp-1"] == ["ev-charger"]
    ohne = dict(payload, entities=[e for e in payload["entities"] if e["entity_id"] != "lp-1"])
    assert nw6._fingerabdruck(ohne) == nw6.VOR_AP15
    zeilen = consumer_slot_rows(repo.latest_for_site(nw6.SITE))
    assert len({(r[5], r[4], r[0]) for r in zeilen}) == len(zeilen) == 4
    assert [r[6:] for r in zeilen] == [
        ("setpoint_kw", 3.7, "price_below_threshold", "r1"),   # Laden, kein Zurueckspeisen
        ("setpoint_kw", -5.0, REASON_FAHRZEUG_RUECKSPEISEN, None),  # beides: Zurueckspeisen vor Laden
        ("setpoint_kw", -11.0, REASON_FAHRZEUG_RUECKSPEISEN, None),
        ("setpoint_kw", 0.0, REASON_FAHRZEUG_RUECKSPEISEN, None),   # gerechnet, nichts
    ]

"""PH-1 A (Captain-Entscheid 15.11.2026): der Plan rechnet die Defizitdeckung der Box mit.

Die Box deckt in jedem Slot, in dem der Plan nicht laedt, ein gemessenes
Hausdefizit aus dem Speicher bis zur Untergrenze (``deficitcover.go``,
Captain-Entscheid 28.08.2026). Herzogau 02.11.2026: Der Plan hielt ab 16:00 mit
0 kW fuer den Verkauf am 03.11. um 08:00/09:00, die Box gab den Bestand ins Haus
(``follow.path: deficit_cover``), gegen 22-23 Uhr waere der Speicher leer
gewesen. Seither plant der Plan den Bestand so, wie die Box ihn faehrt - und
verkauft ihn, solange er noch da ist.

Die Box steht hier als :func:`voltpilot_optimization.vorsprung._wirksam`, die
Nachbildung, mit der die Vorsprung-Regel (NS-2) schon rechnet.
"""

from __future__ import annotations

import logging
import math
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization import defizitdeckung
from voltpilot_optimization import solver as solver_mod
from voltpilot_optimization.domain import (
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.explain import KNOWN_CONSTRAINTS
from voltpilot_optimization.modules import select_modules
from voltpilot_optimization.solver import build_model, optimize
from voltpilot_optimization.verbund import BoxAnteil
from voltpilot_optimization.vorsprung import _wirksam

from test_solver import needs_highs

DT = 0.25
BEZUG_CT = 25.0
REGEL = ("defizit_deckung", "defizit_boden", "defizit_laden")

# Ein Abend wie Herzogau am 02.11.: Speicher 65 kWh / 30 kW bei 48 %, das Haus
# zieht die Nacht ueber 5 kW, keine Sonne bis zum Morgen. Jetzt bringt der Abend
# 31 ct, die Nacht 22 ct, morgen frueh eine Spitze von 33 ct, danach Sonne
# ueber dem Haus. Festpreis-Bezug 25 ct, Netzladen verboten (Direktvermarktung).
HZ_T0 = datetime(2026, 11, 2, 17, 0, tzinfo=timezone.utc)  # 18:00 MEZ
HZ_N = 96
HZ_BATTERY = BatteryParams(
    capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0, wear_cost_ct_per_kwh=1.0
)
HZ_EXPORT = [310.0] * 4 + [220.0] * 52 + [330.0] * 4 + [220.0] * 36
HZ_PV = [0.0] * 56 + [0.0] * 4 + [8.0] * 24 + [0.0] * 12
HZ_LOAD = [5.0] * HZ_N


def _herzogau(**aenderung) -> OptimizationInput:
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=HZ_BATTERY,
        slot_starts=horizon_slot_starts(HZ_T0, HZ_N),
        prices_eur_mwh=HZ_EXPORT,
        load_kw=HZ_LOAD,
        pv_kw=HZ_PV,
        initial_soc_kwh=0.48 * 65.0,
        netzladen_erlaubt=False,
        import_price_eur_mwh=[BEZUG_CT * 10.0] * HZ_N,
        export_value_eur_mwh=HZ_EXPORT,
        grid_charge_hurdle_ct_kwh=2.0,
    )
    return replace(inp, **aenderung) if aenderung else inp


def _ohne_regel(monkeypatch) -> None:
    """Der Plan VOR PH-1 A: dasselbe Modell ohne die Defizitdeckung."""
    monkeypatch.setattr(defizitdeckung, "baue", lambda m, **kw: 0.0)


def _box_faehrt(plan, inp: OptimizationInput):
    """Die Box fuehrt den Plan an den Prognosewerten aus (Defizitdeckung
    inklusive): ``(soc-Bahn der Box, Wert mit Bestand in EUR)``. Geld wie die
    Erloesrechnung: Bezug zum Festpreis, Einspeisung zum Einspeisewert; der
    Bestand am Ende zaehlt mit 25 ct x eta je kWh im Speicher."""
    b = inp.battery
    boden = defizitdeckung.boden_kwh(b)
    soc = inp.initial_soc_kwh
    bahn, kasse = [], 0.0
    for t, slot in enumerate(plan.slots):
        ch, dis = _wirksam(slot, b, soc, boden, DT)
        netz = inp.load_kw[t] - inp.pv_kw[t] + ch - dis
        kasse -= max(netz, 0.0) * inp.import_prices[t] / 1000.0 * DT
        kasse += max(-netz, 0.0) * inp.export_values[t] / 1000.0 * DT
        soc += (b.one_way_efficiency * ch - dis / b.one_way_efficiency) * DT
        bahn.append(soc)
    bestand = (soc - inp.initial_soc_kwh) * BEZUG_CT / 100.0 * b.one_way_efficiency
    return bahn, kasse + bestand


def _halten_mit_defizit(plan, inp: OptimizationInput) -> list[int]:
    """Slots, in denen der Plan ein Hausdefizit ueber der Schwelle stehen
    laesst, obwohl er nicht laedt und der Speicher ueber dem Boden der Box ist -
    genau das Halten, das die Box nicht ausfuehrt."""
    boden = defizitdeckung.boden_kwh(inp.battery)
    soc = inp.initial_soc_kwh
    out = []
    for t, slot in enumerate(plan.slots):
        defizit = min(inp.load_kw[t] - inp.pv_kw[t], inp.battery.max_discharge_kw)
        laedt = slot.battery_kw > defizitdeckung.LADEN_AB_KW - 1e-6
        if (
            defizit > defizitdeckung.DECKUNG_AB_KW
            and not laedt
            and -slot.battery_kw < defizit - 1e-3
            and slot.soc_kwh > boden + 1e-3
        ):
            out.append(t)
        soc = slot.soc_kwh
    return out


# --- Modell ------------------------------------------------------------------


def test_regel_steht_im_inventar_der_erklaerung():
    assert set(REGEL) <= KNOWN_CONSTRAINTS


def test_ohne_hausdefizit_kommt_nichts_ins_modell():
    # PV deckt das Haus in jedem Slot, Restdefizite bis 0,2 kW regelt auch die
    # Box nicht nach: kein Slot fuer die Regel, das Modell bleibt das alte.
    inp = _herzogau(
        pv_kw=[6.0] * HZ_N, load_kw=[5.0] * 48 + [6.15] * 48, initial_soc_kwh=30.0
    )
    m = build_model(inp)
    for name in REGEL + ("boden_erreicht", "deckung_luecke"):
        assert not hasattr(m, name), name


@needs_highs
def test_ohne_hausdefizit_bleibt_der_plan_unveraendert(monkeypatch):
    inp = _herzogau(pv_kw=[6.0] * HZ_N, load_kw=[5.0] * 48 + [6.15] * 48)
    mit = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    _ohne_regel(monkeypatch)
    ohne = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    for a, b in zip(mit.slots, ohne.slots):
        assert a.battery_kw == b.battery_kw
        assert a.soc_kwh == b.soc_kwh
        assert a.grid_kw == b.grid_kw
    assert mit.cost_eur == ohne.cost_eur


def test_regel_nur_fuer_einen_gesteuerten_speicher():
    # Ein Speicher, den der Plan nicht steuert, liegt per Schranke fest - die
    # Regel haette nichts zu entscheiden und koennte das Modell unloesbar machen.
    for aenderung in (
        {"battery_held": True},
        {"soc_source": SOC_SOURCE_UNBEKANNT},
        {"battery_observed": True},
    ):
        m = build_model(_herzogau(**aenderung))
        assert not hasattr(m, "defizit_deckung"), aenderung
    assert hasattr(build_model(_herzogau()), "defizit_deckung")


def test_regel_ausserhalb_des_verbunds():
    # Im Verbund zaehlt die Entladung als Einspeisung der Box (verbund_einspeisung);
    # mit kleinem Einspeise-Anteil waere die erzwungene Deckung unloesbar.
    box = BoxAnteil(device_id=uuid4(), einspeisung_kw=1.0, bezug_kw=10.0, pv_kw=(0.0,) * HZ_N)
    m = build_model(_herzogau(verbund=(box,)))
    assert not hasattr(m, "defizit_deckung")
    assert not any(mod.name == "defizitdeckung" for mod in select_modules(from_v1_input(_herzogau(verbund=(box,)))))


def test_luecke_nur_im_lauf_mit_harter_paragraph_14a_grenze():
    assert not hasattr(build_model(_herzogau()), "deckung_luecke")
    mit_grenze = _herzogau(grid_limit_kw=20.0)
    assert hasattr(build_model(mit_grenze), "deckung_luecke")
    assert not hasattr(build_model(mit_grenze, enforce_grid_limit=False), "deckung_luecke")
    (mod,) = [m for m in select_modules(from_v1_input(mit_grenze)) if m.name == "defizitdeckung"]
    assert mod.mit_luecke
    (mod,) = [
        m
        for m in select_modules(from_v1_input(mit_grenze), enforce_grid_limit=False)
        if m.name == "defizitdeckung"
    ]
    assert not mod.mit_luecke


# --- Herzogau 02.11.: verkaufen statt halten ----------------------------------


@needs_highs
def test_herzogau_plan_und_box_fahren_denselben_bestand(monkeypatch):
    inp = _herzogau()
    plan = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    # Kein Halten, das die Box nicht ausfuehrt ...
    assert _halten_mit_defizit(plan, inp) == []
    # ... also faehrt die Box genau die Bahn des Plans.
    bahn, wert = _box_faehrt(plan, inp)
    for t, (box, slot) in enumerate(zip(bahn, plan.slots)):
        assert box == pytest.approx(slot.soc_kwh, abs=0.05), t
    # Der Bestand geht heute Abend zu 31 ct ins Netz, nicht nachts zu 25 ct ins Haus.
    verkauf = sum(max(-s.grid_kw, 0.0) * DT for s in plan.slots[:4])
    assert verkauf > 15.0, verkauf

    # Gegenprobe: der Plan vor PH-1 A haelt fuer die Morgenspitze (33 ct), die
    # Box leert den Speicher in der Nacht ins Haus, um 06:00 ist nichts mehr da.
    _ohne_regel(monkeypatch)
    vorher = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    assert len(_halten_mit_defizit(vorher, inp)) > 10
    assert min(s.battery_kw for s in vorher.slots[56:60]) < -10.0  # Verkauf geplant
    bahn_vorher, wert_vorher = _box_faehrt(vorher, inp)
    assert bahn_vorher[55] == pytest.approx(defizitdeckung.boden_kwh(HZ_BATTERY), abs=1e-6)
    # Geld: verkaufen statt ins Haus geben, ≈ (31 - 25) ct je kWh Bestand.
    assert wert - wert_vorher > 1.0, (wert, wert_vorher)


@needs_highs
def test_herzogau_bestand_ueber_den_verkauf_hinaus_haelt_der_plan_nicht():
    # Was die Nacht braucht, laesst sich nicht halten: die Box deckt bis 5 %.
    plan = optimize(_herzogau(), plan_id=uuid4(), generated_at=HZ_T0)
    boden = defizitdeckung.boden_kwh(HZ_BATTERY)
    assert plan.slots[55].soc_kwh == pytest.approx(boden, abs=1e-3)
    # In jedem Nachtslot oberhalb des Bodens deckt der Plan das Haus.
    for t in range(4, 56):
        if plan.slots[t - 1].soc_kwh > boden + 1e-3:
            assert -plan.slots[t].battery_kw >= 5.0 - 1e-3 or plan.slots[t].soc_kwh <= boden + 1e-3, t


@needs_highs
def test_haendler_haelt_nur_ueber_eine_ladung_die_die_box_zaehlt():
    # Mit Netzladen erlaubt darf der Plan halten, indem er laedt - aber nur mit
    # einer Ladung, die die Box als Laden zaehlt (> 0,05 kW), nie mit 0 kW.
    inp = _herzogau(netzladen_erlaubt=True, grid_charge_hurdle_ct_kwh=0.0)
    plan = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    assert _halten_mit_defizit(plan, inp) == []
    for slot in plan.slots:
        assert not (0.0 < slot.battery_kw < defizitdeckung.LADEN_AB_KW - 1e-6), slot


@needs_highs
def test_start_unter_dem_boden_der_box_deckt_nicht():
    # Unter der Reserve deckt die Box nichts; der Plan bleibt loesbar und
    # entlaedt nicht tiefer.
    batt = replace(HZ_BATTERY, backup_reserve_pct=30.0)
    inp = _herzogau(battery=batt, initial_soc_kwh=0.20 * 65.0)
    plan = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    assert min(s.soc_kwh for s in plan.slots) >= 0.20 * 65.0 - 1e-6


@needs_highs
def test_paragraph_14a_grenze_gewinnt_wo_beides_nicht_geht(caplog):
    # Grundlast 9 kW, abends 14 kW, §14a-Grenze 11 kW, Speicher 10 kWh / 5 kW:
    # Deckte der Plan wie die Box, waere der Speicher vor der Abendspitze leer
    # und die Grenze nicht zu halten. Hart gerechnet waere der Lauf unloesbar.
    n = 96
    last = [9.0 + 5.0 * math.exp(-((i / 4.0 - 19.0) ** 2) / 3.0) for i in range(n)]
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0),
        slot_starts=horizon_slot_starts(HZ_T0, n),
        prices_eur_mwh=[100.0] * n,
        load_kw=last,
        pv_kw=[0.0] * n,
        initial_soc_kwh=8.0,
        netzladen_erlaubt=True,
        grid_limit_kw=11.0,
    )
    with caplog.at_level(logging.WARNING, logger="voltpilot.optimization.solver"):
        plan = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    assert all(s.grid_kw <= 11.0 + 1e-6 for s in plan.slots)
    assert any("Defizitdeckung der Box" in r.getMessage() for r in caplog.records)


@needs_highs
def test_die_box_flacht_eine_spitze_nicht_ab():
    # Leistungspreis, 2 kW Last ueber 8 h, 8,5 kWh im Speicher: das LP allein
    # flachte den Bezug auf ~0,98 kW ab (test_peak_shaving.py). Die Box vertieft
    # aber jede Teilentladung auf das ganze Defizit, bis der Speicher leer ist -
    # danach bezieht das Haus wieder 2 kW. Der Plan rechnet das mit und
    # verspricht keine Kappung, die die Box nicht faehrt.
    batt = BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0)
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=batt,
        slot_starts=horizon_slot_starts(HZ_T0, 32),
        prices_eur_mwh=[100.0] * 32,
        load_kw=[2.0] * 32,
        pv_kw=[0.0] * 32,
        initial_soc_kwh=9.0,
        netzladen_erlaubt=False,
        leistungspreis_eur_kw=100.0,
    )
    plan = optimize(inp, plan_id=uuid4(), generated_at=HZ_T0)
    assert _halten_mit_defizit(plan, inp) == []
    # Der erste Slot deckt das ganze Defizit (keine Teilentladung) ...
    assert -plan.slots[0].battery_kw >= 2.0 - 1e-3
    # ... und am Ende bezieht das Haus wieder voll: keine versprochene Kappung.
    assert plan.peak_target_kw == pytest.approx(2.0, abs=1e-3)


@needs_highs
def test_erklaerung_laeuft_mit_der_regel():
    plan = optimize(_herzogau(), plan_id=uuid4(), generated_at=HZ_T0)
    assert all(s.slot_role is not None for s in plan.slots)
    assert all(s.stored_value_ct_kwh is not None for s in plan.slots)

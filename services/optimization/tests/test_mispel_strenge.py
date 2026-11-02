"""Netzladen „Verboten“: kein Laden in einer Viertelstunde mit geplantem Bezug.

Captain-Entscheid EN-2 A (02.11.2026, Aufgabe vp-netzladen-harte-sperre): „Ich
will auf keinen Fall, dass der Speicher vom Netz beladen wird, wenn Grid
Charging aus ist. Das darf nie wieder passieren.“ Die Nebenbedingung stammt aus
MiSpeL MP-45 (``origin/mispel`` 2189615b5); dort war sie ein Betreiber-Schalter
je Anlage mit Toleranz, hier gilt sie für JEDE Anlage mit
``netzladen_erlaubt = false`` und ohne Toleranz.

FK3 allein (Laden ≤ erzeugte PV) ließ das Haus beim Laden parallel aus dem Netz
beziehen. In der Bilanz am Hausanschluss ist das Netzstrom im Speicher, so liest
es die BNetzA seit ihrer Festlegung vom 01.10.2026 („kein Verbrauch im
Stromspeicher ..., waehrend es gleichzeitig einen Netzbezug gibt“, Anlage 1
S. 11; gleichzeitig = dieselbe Viertelstunde, Anlage 1 S. 7). Die Größe ist die
des Prüfers MP-2: (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (Anlage 1 S. 33) - im Plan 0.

Herzogau 02.11.2026 (Pilsting, Deye 65 kWh, Festpreis 25 ct, Netzladen
„Verboten“): Haus 6,5 kW, PV 1-3 kW, kein Überschuss - der Plan von 14:30 UTC
lud ab 03.11. 09:30 trotzdem +7,6 bis +1,3 kW, weil ein späterer Verkauf die
2-ct-Hürde schlug. Mit der Regel lädt er dort nicht.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import solver as solver_mod
from voltpilot_optimization.co_solver import build_co_model
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.explain import KNOWN_CONSTRAINTS
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import build_model, optimize

from test_contract import load_validator
from test_solver import T0, make_input, needs_highs

VIERTELSTUNDE_H = 0.25

# Ein wolkiger Tag mit einem sonnigen Mittag: billige Nacht, teurer Abend.
# Wolkig (pv 3 < Last 4): FK3 laedt die PV in den Speicher, das Haus bezieht
# parallel - genau das Bild, das die Regel verbietet. Sonnig (pv 8 > Last 4):
# echter Ueberschuss, den auch die Regel laden laesst.
N = 96
PRICES = [20.0] * 40 + [60.0] * 24 + [250.0] * 32
PV = [0.0] * 40 + [3.0] * 12 + [8.0] * 6 + [3.0] * 6 + [0.0] * 32
LOAD = 4.0


def _eeg() -> OptimizationInput:
    return make_input(PRICES, load=LOAD, pv=PV, soc0_kwh=1.0, netzladen_erlaubt=False)


def _haendler() -> OptimizationInput:
    return make_input(PRICES, load=LOAD, pv=PV, soc0_kwh=1.0, netzladen_erlaubt=True)


def _netzstrom_im_speicher_kwh(slot) -> float:
    """(1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] eines geplanten 15-min-Slots in kWh."""
    bezug = max(slot.grid_kw, 0.0) * VIERTELSTUNDE_H
    laden = max(slot.battery_kw, 0.0) * VIERTELSTUNDE_H
    return min(bezug, laden)


def _nur_fk3(monkeypatch) -> None:
    """Der Plan VOR EN-2 A: dasselbe Modell, die neue Bedingung abgeschaltet.

    Nur als Gegenprobe - ohne sie bewiese ein Test, der kein Laden bei Bezug
    findet, nichts (vielleicht lud der Plan dort ohnehin nicht)."""
    bauen = solver_mod.build_model

    def ohne_regel(inp, enforce_grid_limit=True):
        m = bauen(inp, enforce_grid_limit=enforce_grid_limit)
        m.strenge_ausschliesslichkeit.deactivate()
        return m

    monkeypatch.setattr(solver_mod, "build_model", ohne_regel)


def _laedt_nie_bei_bezug(plan) -> None:
    for i, s in enumerate(plan.slots):
        if s.battery_kw > 1e-6:
            assert s.grid_kw <= 1e-6, f"Slot {i}: Laden {s.battery_kw} kW bei Bezug {s.grid_kw} kW"
        assert _netzstrom_im_speicher_kwh(s) <= 1e-6


# --- Modell ------------------------------------------------------------------


def test_jede_eeg_anlage_eine_bedingung_je_slot_auch_im_14a_rueckfall():
    for enforce in (True, False):
        eeg = build_model(_eeg(), enforce_grid_limit=enforce)
        assert hasattr(eeg, "solar_only_charge"), "FK3 bindet weiter"
        assert hasattr(eeg, "strenge_ausschliesslichkeit")
        assert len(eeg.strenge_ausschliesslichkeit) == N
        # Keine neue Ganzzahl-Variable: die Bedingung nutzt is_charging.
        assert eeg.nvariables() == build_model(_haendler()).nvariables()


def test_haendler_anlage_baut_die_bedingung_nicht():
    for enforce in (True, False):
        model = build_model(_haendler(), enforce_grid_limit=enforce)
        assert not hasattr(model, "strenge_ausschliesslichkeit")
        assert not hasattr(model, "solar_only_charge")


def test_die_erklaer_schicht_kennt_die_bedingung():
    assert "strenge_ausschliesslichkeit" in KNOWN_CONSTRAINTS


def test_v2_traegt_dieselbe_bedingung_je_eeg_speicher():
    eeg = build_co_model(from_v1_input(_eeg()))
    assert hasattr(eeg, "strenge_ausschliesslichkeit")
    assert len(eeg.strenge_ausschliesslichkeit) == N  # ein Speicher x N Slots
    haendler = build_co_model(from_v1_input(_haendler()))
    assert not hasattr(haendler, "strenge_ausschliesslichkeit")


# --- Solver ------------------------------------------------------------------


@needs_highs
def test_fk3_laedt_bei_netzbezug_die_regel_nicht(monkeypatch):
    streng = optimize(_eeg(), plan_id=uuid4(), generated_at=T0)
    _laedt_nie_bei_bezug(streng)
    # Der sonnige Mittag laedt weiter - aus echtem Ueberschuss.
    sonnig = streng.slots[52:58]
    assert sum(max(s.battery_kw, 0.0) for s in sonnig) > 1.0
    assert all(s.battery_kw <= PV[52 + k] - LOAD + 1e-6 for k, s in enumerate(sonnig))
    # FK3 bindet weiter: nie mehr laden als die erzeugte PV.
    assert all(s.battery_kw <= PV[i] + 1e-6 for i, s in enumerate(streng.slots))

    # Gegenprobe: FK3 allein laedt die wolkige PV, waehrend das Haus bezieht.
    _nur_fk3(monkeypatch)
    fk3 = optimize(_eeg(), plan_id=uuid4(), generated_at=T0)
    assert any(_netzstrom_im_speicher_kwh(s) > 0.1 for s in fk3.slots)


@needs_highs
def test_auch_der_14a_rueckfall_laedt_nicht_bei_bezug():
    plan = solver_mod.optimize_ignoring_grid_limit(_eeg(), plan_id=uuid4(), generated_at=T0)
    _laedt_nie_bei_bezug(plan)


# --- Herzogau 02.11.2026 -----------------------------------------------------

# Deye SUN-30K-SG01HP3 mit 65-kWh-Speicher; Festpreis-Bezug 25 ct (250 EUR/MWh),
# Direktvermarktung. Haus 6,5 kW, PV 1-3 kW von 08:30 bis 15:30 Ortszeit (MEZ),
# kein Ueberschuss. Abends ein Verkaufswert, der die Huerde K2 schlaegt
# (≥ (25 + 2 + Verschleiss)/eta) - so lud der Plan vom 02.11. 14:30 UTC ab
# 03.11. 09:30 +7,6 bis +1,3 kW.
HZ_T0 = datetime(2026, 11, 2, 23, 0, tzinfo=timezone.utc)  # 03.11. 00:00 MEZ
HZ_BATTERY = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
)
HZ_PV = (
    [0.0] * 34
    + [1.0, 1.5, 2.0, 2.5] * 2
    + [3.0] * 12
    + [2.5, 2.0, 1.5, 1.0] * 2
    + [0.0] * 34
)
HZ_LOAD = 6.5
HZ_EXPORT = [90.0] * 68 + [380.0] * 12 + [90.0] * 16


def _herzogau(netzladen_erlaubt: bool = False) -> OptimizationInput:
    assert len(HZ_PV) == N
    return OptimizationInput(
        tenant_id=UUID(int=1),
        site_id=UUID("063012ff-4be7-4c1f-85c4-498bf555bd12"),
        device_id=UUID(int=3),
        battery=HZ_BATTERY,
        slot_starts=horizon_slot_starts(HZ_T0, N),
        prices_eur_mwh=[90.0] * N,
        load_kw=[HZ_LOAD] * N,
        pv_kw=HZ_PV,
        initial_soc_kwh=12.0,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=[250.0] * N,
        export_value_eur_mwh=HZ_EXPORT,
        grid_charge_hurdle_ct_kwh=2.0,
    )


@needs_highs
def test_herzogau_haus_6_5_kw_pv_1_bis_3_kw_laedt_nicht(monkeypatch):
    plan = optimize(_herzogau(), plan_id=uuid4(), generated_at=HZ_T0)
    # Jeder Slot bezieht (Haus 6,5 kW > PV 3 kW) - also laedt keiner.
    assert all(s.battery_kw <= 1e-6 for s in plan.slots), [
        (i, round(s.battery_kw, 2)) for i, s in enumerate(plan.slots) if s.battery_kw > 1e-6
    ]
    _laedt_nie_bei_bezug(plan)

    # Gegenprobe: FK3 allein laedt am Tag die PV in den Speicher, waehrend
    # das Haus bezieht - das Bild vom 02.11.
    _nur_fk3(monkeypatch)
    fk3 = optimize(_herzogau(), plan_id=uuid4(), generated_at=HZ_T0)
    netz = sum(_netzstrom_im_speicher_kwh(s) for s in fk3.slots)
    assert netz > 5.0, f"FK3 lud nur {netz:.2f} kWh bei Bezug"


# --- Plan und Vertrag --------------------------------------------------------


def _payload_bytes(inp) -> bytes:
    # Feste Kennungen: make_input wuerfelt sie je Aufruf.
    inp = replace(inp, tenant_id=UUID(int=1), site_id=UUID(int=2), device_id=UUID(int=3))
    plan = optimize(inp, plan_id=UUID(int=45), generated_at=T0)
    return json.dumps(build_schedule_payload(plan), sort_keys=True).encode()


@needs_highs
def test_vertrag_bleibt_ohne_neues_feld():
    # Die Box liest die Regel aus grid_charge_allowed = false (Paket a); der
    # Plan bekommt kein neues Feld, der Vertrag bleibt unberuehrt.
    for inp in (_eeg(), _haendler()):
        payload = build_schedule_payload(optimize(inp, plan_id=uuid4(), generated_at=T0))
        assert "strict_exclusivity" not in payload
        errors = list(load_validator().iter_errors(payload))
        assert not errors, [e.message for e in errors]
    assert json.loads(_payload_bytes(_eeg()))["grid_charge_allowed"] is False


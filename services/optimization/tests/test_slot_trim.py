"""The price-aware in-slot trim: which slots the cloud marks
``charge_from_surplus_only`` for the edge (2026-07-30, captain observation at
Anlage Pilsting).

Two layers, both proven here:

- the pure RULE (:mod:`voltpilot_optimization.slot_trim`) - stated as economic
  properties, with the captain's observed live numbers as the anchor case; and
- the rule reaching a real solved plan through the solver's explain stamping,
  where lambda is the model's OWN marginal value of stored energy.
"""

from __future__ import annotations

import importlib.util
import math
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.config import SLOT_TRIM_MARGIN_CT_PER_KWH, slot_trim_enabled
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.slot_trim import (
    charge_from_surplus_only,
    grid_charge_uneconomic,
    planned_grid_charge_kw,
    willingness_to_pay_ct_kwh,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 30, 10, 0, tzinfo=timezone.utc)
ETA = math.sqrt(0.92)  # one-way efficiency of the 92 % round trip
WEAR_EACH_WAY_CT = 2.0  # the 4 ct/kWh-cycle platform default, half per direction


# ---- the rule ---------------------------------------------------------------


def test_the_observed_pilsting_slot_is_not_uneconomic_so_nothing_is_trimmed():
    """The anchor case: 14,6 ct/kWh all-in import against an evening that
    avoids ~33,5 ct. Buying was RIGHT, and the rule must agree - otherwise the
    feature would break the very dispatch the captain confirmed as correct."""
    # An evening slot avoiding 33.5 ct puts the water value near eta * 33.5.
    stored = ETA * 33.5
    assert not grid_charge_uneconomic(
        import_price_ct_kwh=14.6,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    # ... and the full flag agrees on the observed physics (pv 15.3, house 7.6,
    # commanded 10.8 -> 3.1 kW of the charge would come from the grid).
    assert not charge_from_surplus_only(
        battery_kw=10.8,
        pv_kw=15.3,
        load_kw=7.6,
        curtail_kw=0.0,
        import_price_ct_kwh=14.6,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_an_expensive_slot_is_flagged_when_the_plan_charges_from_surplus():
    """Same physics, expensive import: the stored kWh is only worth the forgone
    feed-in, so covering a forecast shortfall from the grid is a loss."""
    assert charge_from_surplus_only(
        battery_kw=10.8,
        pv_kw=15.3,
        load_kw=4.0,  # planned surplus 11.3 > 10.8 -> plan buys nothing
        curtail_kw=0.0,
        import_price_ct_kwh=32.0,
        stored_value_ct_kwh=ETA * 8.0,  # only the forgone 8 ct feed-in
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_the_willingness_to_pay_prices_losses_and_wear_and_never_goes_negative():
    wtp = willingness_to_pay_ct_kwh(
        stored_value_ct_kwh=30.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert wtp == pytest.approx(ETA * 30.0 - 2.0)
    assert wtp < 30.0  # losses + wear always discount the raw water value
    # A worthless (or nonsensically negative) water value floors at zero, so the
    # comparison stays a comparison instead of inventing a negative price.
    assert (
        willingness_to_pay_ct_kwh(
            stored_value_ct_kwh=-5.0,
            one_way_efficiency=ETA,
            wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
        )
        == 0.0
    )


def test_a_hairline_difference_is_not_trimmed_the_margin_is_the_deadband():
    stored = 30.0
    wtp = willingness_to_pay_ct_kwh(
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    just_inside = wtp + SLOT_TRIM_MARGIN_CT_PER_KWH - 0.01
    just_outside = wtp + SLOT_TRIM_MARGIN_CT_PER_KWH + 0.01
    common = dict(
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert not grid_charge_uneconomic(import_price_ct_kwh=just_inside, **common)
    assert grid_charge_uneconomic(import_price_ct_kwh=just_outside, **common)


def test_no_stored_value_and_no_finite_number_make_no_claim():
    common = dict(
        one_way_efficiency=ETA, wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT
    )
    # No why-layer -> lambda absent -> no restriction (fail-open by contract).
    assert not grid_charge_uneconomic(
        import_price_ct_kwh=40.0, stored_value_ct_kwh=None, **common
    )
    # A guard the edge enforces against measured values must never rest on NaN.
    assert not grid_charge_uneconomic(
        import_price_ct_kwh=float("nan"), stored_value_ct_kwh=1.0, **common
    )
    assert not grid_charge_uneconomic(
        import_price_ct_kwh=40.0, stored_value_ct_kwh=float("inf"), **common
    )


def test_a_discharging_or_idle_slot_carries_no_trim_duty():
    common = dict(
        pv_kw=0.0,
        load_kw=5.0,
        curtail_kw=0.0,
        import_price_ct_kwh=40.0,
        stored_value_ct_kwh=1.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert not charge_from_surplus_only(battery_kw=-4.0, **common)
    assert not charge_from_surplus_only(battery_kw=0.0, **common)
    assert not charge_from_surplus_only(battery_kw=0.02, **common)  # noise


def test_a_slot_the_plan_deliberately_buys_in_is_never_flagged():
    """The consistency guard: the edge must never be told to undo a purchase the
    cloud itself planned (LP optimality makes the two agree, but a tolerance
    artefact must not be able to produce that payload)."""
    assert not charge_from_surplus_only(
        battery_kw=5.0,
        pv_kw=1.0,
        load_kw=1.0,  # surplus 0 -> the whole 5 kW is a planned purchase
        curtail_kw=0.0,
        import_price_ct_kwh=40.0,
        stored_value_ct_kwh=1.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_planned_grid_charge_counts_curtailment_against_the_surplus():
    # 10 kW PV, 2 kW house -> 8 kW surplus, charge 6 kW: nothing bought.
    assert planned_grid_charge_kw(battery_kw=6.0, pv_kw=10.0, load_kw=2.0) == 0.0
    # Curtailing 5 kW leaves only 3 kW of surplus -> 3 kW must be bought.
    assert planned_grid_charge_kw(
        battery_kw=6.0, pv_kw=10.0, load_kw=2.0, curtail_kw=5.0
    ) == pytest.approx(3.0)
    # A discharge slot buys nothing for the battery.
    assert planned_grid_charge_kw(battery_kw=-6.0, pv_kw=0.0, load_kw=2.0) == 0.0


def test_the_flag_is_env_switchable_and_defaults_on():
    assert slot_trim_enabled({}) is True
    assert slot_trim_enabled({"OPTIMIZER_SLOT_TRIM_ENABLED": "false"}) is False
    with pytest.raises(ValueError):
        slot_trim_enabled({"OPTIMIZER_SLOT_TRIM_ENABLED": "maybe"})


# ---- through the real solver -------------------------------------------------

BATTERY = BatteryParams(
    capacity_kwh=20.0,
    max_charge_kw=10.0,
    max_discharge_kw=10.0,
    roundtrip_efficiency=0.92,
)


def make_input(
    spot: list[float],
    load: list[float],
    pv: list[float],
    import_price: list[float] | None = None,
    export_value: list[float] | None = None,
    soc0_kwh: float = 1.0,
    netzladen_erlaubt: bool = True,
) -> OptimizationInput:
    n = len(spot)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=spot,
        load_kw=load,
        pv_kw=pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=import_price,
        export_value_eur_mwh=export_value,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


@needs_highs
def test_a_flat_retail_plant_storing_pv_gets_every_charge_slot_flagged():
    """Flat retail: buying a kWh at 30 ct to displace a 30 ct kWh later loses
    the round trip and the wear, so covering a PV shortfall from the grid can
    NEVER pay. Every planned charge slot must carry the duty."""
    n = 8
    # Sunny first half (surplus), consuming second half.
    pv = [12.0] * 4 + [0.0] * 4
    load = [2.0] * 4 + [6.0] * 4
    spot = [50.0] * n
    plan = solve(
        make_input(
            spot,
            load,
            pv,
            import_price=[300.0] * n,  # 30 ct/kWh flat retail
            export_value=[80.0] * n,  # 8 ct/kWh feed-in
        )
    )
    charging = [s for s in plan.slots if s.battery_kw > 0.05]
    assert charging, "scenario must plan a PV charge"
    assert all(s.charge_from_surplus_only for s in charging)
    # Discharge/idle slots carry no duty - there is nothing to trim there.
    assert all(
        not s.charge_from_surplus_only for s in plan.slots if s.battery_kw <= 0.05
    )


@needs_highs
def test_a_cheap_night_purchase_for_an_expensive_evening_stays_untouched():
    """The Pilsting economics through the model: with a dynamic tariff whose
    cheap slots are far below the expensive ones, the planned purchase IS worth
    it - and the plan must not be second-guessed on the device."""
    n = 8
    pv = [0.0] * n
    load = [1.0] * n
    # Cheap first half, expensive second half; import = spot + 5 ct Aufschlag.
    spot = [20.0] * 4 + [400.0] * 4
    imp = [p + 50.0 for p in spot]
    plan = solve(make_input(spot, load, pv, import_price=imp, export_value=spot))
    charging = [s for s in plan.slots if s.battery_kw > 0.05]
    assert charging, "scenario must plan a cheap grid charge"
    assert all(not s.charge_from_surplus_only for s in charging)


@needs_highs
def test_the_flag_is_absent_without_the_explain_layer_and_with_the_switch_off(
    monkeypatch,
):
    n = 8
    pv = [12.0] * 4 + [0.0] * 4
    load = [2.0] * 4 + [6.0] * 4
    inp = make_input(
        [50.0] * n, load, pv, import_price=[300.0] * n, export_value=[80.0] * n
    )

    monkeypatch.setenv("OPTIMIZER_SLOT_TRIM_ENABLED", "false")
    off = solve(inp)
    assert all(s.charge_from_surplus_only is None for s in off.slots)
    # ... and the why-layer itself still works (only the trim duty is gone).
    assert any(s.slot_role for s in off.slots)

    monkeypatch.delenv("OPTIMIZER_SLOT_TRIM_ENABLED")
    monkeypatch.setenv("OPTIMIZER_EXPLAIN_ENABLED", "false")
    no_explain = solve(inp)
    assert all(s.charge_from_surplus_only is None for s in no_explain.slots)
    assert all(s.slot_role is None for s in no_explain.slots)


@needs_highs
def test_the_flag_never_changes_the_committed_setpoints():
    """The duty is stamped POST-HOC like the why-fields: a plan solved with the
    trim off must carry byte-identical decisions."""
    n = 8
    pv = [12.0] * 4 + [0.0] * 4
    load = [2.0] * 4 + [6.0] * 4
    inp = make_input(
        [50.0] * n, load, pv, import_price=[300.0] * n, export_value=[80.0] * n
    )
    import os

    on = solve(inp)
    os.environ["OPTIMIZER_SLOT_TRIM_ENABLED"] = "false"
    try:
        off = solve(inp)
    finally:
        del os.environ["OPTIMIZER_SLOT_TRIM_ENABLED"]
    for a, b in zip(on.slots, off.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw) == (
            b.battery_kw,
            b.grid_kw,
            b.soc_kwh,
            b.curtail_kw,
        )

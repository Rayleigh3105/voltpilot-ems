"""Ehrliche Marge at a fixed tariff (Captain-Entscheid E6 A, 24.09.2026).

Anlass: Herzogau 24.09. 16:00-16:30 (K0 ``vp-wr-k0-plandaten``). The plan
charged 7,1 / 5,4 / 4,0 kW over the EEG PV bus while the house imported at the
flat 25 ct - economically a grid purchase for a sale worth +0,5 to +0,8 ct/kWh
after the full round trip - and the in-slot trim could not mark it: the plan
intended the purchase (condition 3), and lambda had settled at
``(25 + 0,5)/eta = 26,6`` so that WTP sat exactly on the import price.

ONE constant (``FEST_GRID_CHARGE_HURDLE_CT_PER_KWH``, 2 ct), two readers:

- the LP prices it on the grid-sourced part of every charge
  (``solver.build_model``, constraint ``grid_charge_hurdle``), so the hairline
  purchase is no longer planned while a real arbitrage (23.09., lambda 32,9)
  still is; and
- the trim turns its margin around (``slot_trim.grid_charge_uneconomic``):
  flag as soon as ``import + hurdle > eta*lambda - wear/2``.

The vectors carry K0's numbers verbatim.
"""

from __future__ import annotations

import importlib.util
import math
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.config import (
    FEST_GRID_CHARGE_HURDLE_CT_PER_KWH,
    SLOT_TRIM_MARGIN_CT_PER_KWH,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.pricing import (
    TARIF_DYNAMISCH,
    TARIF_FEST,
    TARIF_OHNE,
    SiteTariff,
    grid_charge_hurdle_ct_kwh,
)
from voltpilot_optimization.slot_trim import (
    PLANNED_GRID_CHARGE_DEADBAND_KW,
    charge_from_surplus_only,
    grid_charge_uneconomic,
    planned_grid_charge_kw,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

M_E6 = FEST_GRID_CHARGE_HURDLE_CT_PER_KWH


# ---- the one constant -------------------------------------------------------


def test_the_hurdle_is_two_cents_and_only_a_fixed_tariff_carries_it():
    assert M_E6 == 2.0
    assert grid_charge_hurdle_ct_kwh(SiteTariff(tarif_art=TARIF_FEST)) == M_E6
    # A fest site without a maintained price still IS a flat-tariff site.
    assert (
        grid_charge_hurdle_ct_kwh(
            SiteTariff(tarif_art=TARIF_FEST, tarif_param_ct_kwh=None)
        )
        == M_E6
    )
    # E6 is about the flat retail price only: spot-priced import keeps 0.
    assert grid_charge_hurdle_ct_kwh(SiteTariff(tarif_art=TARIF_DYNAMISCH)) == 0.0
    assert grid_charge_hurdle_ct_kwh(SiteTariff(tarif_art=TARIF_OHNE)) == 0.0
    assert grid_charge_hurdle_ct_kwh(SiteTariff()) == 0.0


# ---- the vectors (K0 "K2 konkret") -----------------------------------------

#: (name, import ct, lambda ct, eta_RT, wear ct per cycle, hurdle ct, flagged)
VEKTOREN = [
    # Herzogau 24.09. 14:00-14:30Z: WTP = sqrt(0,92)*26,6 - 0,5 = 25,014;
    # 25,0 + 2,0 = 27,0 > 25,014.
    ("herzogau_24_09_fest", 25.0, 26.6, 0.92, 1.0, M_E6, True),
    # 23.09. 05:15Z: real arbitrage, WTP = 31,06 > 27,0.
    ("herzogau_23_09_arbitrage", 25.0, 32.9, 0.92, 1.0, M_E6, False),
    # The break-even K0 names: lambda >= (25 + 2 + 0,5)/sqrt(0,92) = 28,67.
    ("knapp_unter_der_huerde", 25.0, 28.6, 0.92, 1.0, M_E6, True),
    ("knapp_ueber_der_huerde", 25.0, 28.7, 0.92, 1.0, M_E6, False),
    # The SAME Herzogau numbers under the spot rule (hurdle 0, margin 0,5):
    # 25,0 > 25,014 + 0,5 never held - why nothing was marked on 24.09.
    ("herzogau_24_09_ohne_huerde", 25.0, 26.6, 0.92, 1.0, 0.0, False),
]


@pytest.mark.parametrize(
    "name,import_ct,lam,eta_rt,wear_cycle,hurdle,flagged",
    VEKTOREN,
    ids=[v[0] for v in VEKTOREN],
)
def test_the_k0_vectors(name, import_ct, lam, eta_rt, wear_cycle, hurdle, flagged):
    assert (
        grid_charge_uneconomic(
            import_price_ct_kwh=import_ct,
            stored_value_ct_kwh=lam,
            one_way_efficiency=math.sqrt(eta_rt),
            wear_ct_per_kwh_each_way=wear_cycle / 2.0,
            hurdle_ct_per_kwh=hurdle,
        )
        is flagged
    )


def test_the_hurdle_turns_the_margin_around_instead_of_adding_to_it():
    """With a hurdle the old sparing margin plays no part: the purchase must
    EARN the hurdle, however large a margin a caller passes."""
    common = dict(
        import_price_ct_kwh=25.0,
        stored_value_ct_kwh=26.6,
        one_way_efficiency=math.sqrt(0.92),
        wear_ct_per_kwh_each_way=0.5,
    )
    assert grid_charge_uneconomic(**common, hurdle_ct_per_kwh=M_E6)
    assert grid_charge_uneconomic(
        **common, hurdle_ct_per_kwh=M_E6, margin_ct_per_kwh=50.0
    )
    assert not grid_charge_uneconomic(**common, margin_ct_per_kwh=SLOT_TRIM_MARGIN_CT_PER_KWH)
    # A non-finite hurdle makes no claim, like every other non-finite input.
    assert not grid_charge_uneconomic(**common, hurdle_ct_per_kwh=math.nan)


def test_a_surplus_slot_at_the_fest_rule_is_flagged_a_planned_purchase_still_never():
    """The whole flag: a charge the plan covers from forecast surplus is
    marked (a passing cloud must not be bought for a 0,5-ct gain), while the
    consistency guard still never undoes a purchase the plan intends."""
    common = dict(
        import_price_ct_kwh=25.0,
        stored_value_ct_kwh=26.6,
        one_way_efficiency=math.sqrt(0.92),
        wear_ct_per_kwh_each_way=0.5,
        curtail_kw=0.0,
        hurdle_ct_per_kwh=M_E6,
    )
    assert charge_from_surplus_only(battery_kw=5.0, pv_kw=20.0, load_kw=14.0, **common)
    # Herzogau 14:00Z as planned: 7,07 kW charge against a 1,38-kW deficit.
    assert not charge_from_surplus_only(
        battery_kw=7.07, pv_kw=13.38, load_kw=14.76, **common
    )


# ---- through the real solver -----------------------------------------------

#: Herzogau master data (K0 "Stammdaten"): 65 kWh, SoC 5-95 %, round trip 0,92
#: (the default), wear 1,0 ct per cycle, 30 kW discharge (K0: the 17:45Z sale
#: ran at the discharge cap).
HERZOGAU = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
    soc_min_fraction=0.05,
    soc_max_fraction=0.95,
    wear_cost_ct_per_kwh=1.0,
)

T0 = datetime(2026, 9, 24, 13, 45, tzinfo=timezone.utc)

#: The three Herzogau slots of 24.09. 14:00-14:30Z (forecast PV / load, kW).
PV_BUS_SLOTS = [(13.38, 14.76), (5.38, 15.34), (7.48, 15.09)]

#: The two sales K0 found in the 14:00Z run (ct/kWh): 17:45Z at the 30-kW
#: discharge cap and 25.09. 06:00Z - folded into this horizon as 18:00Z.
SALES_24_09_CT = (28.823, 29.087)

#: The sale price that makes lambda = 32,9 ct (the 23.09. arbitrage):
#: lambda = eta * (p - wear/2)  <=>  p = 32,9/sqrt(0,92) + 0,5.
SALE_23_09_CT = 32.9 / math.sqrt(0.92) + 0.5
SALES_23_09_CT = (SALE_23_09_CT, SALE_23_09_CT)

#: Where the two sales sit: 13:45Z + 16 (17) * 15 min = 17:45Z (18:00Z).
SALE_SLOTS = (16, 17)


def herzogau_input(sales_ct: tuple[float, float], hurdle_ct: float) -> OptimizationInput:
    """A stylized Herzogau afternoon, horizon 13:45Z-18:45Z.

    Slot 0 (13:45Z) is a TRUE surplus slot (PV 20 over a 14-kW house), slots
    1-3 are K0's 14:00-14:30Z deficit slots, the house then draws 14 kW; in
    the two sale slots it drops to 1 kW so the sales are clean exports with
    room for every kWh the afternoon can store. Flat 25 ct import; the EEG
    export value is spot, 4 ct outside the sales. The terminal value is
    pinned to 0 so that ONLY the sales carry the charge (the horizon-derived
    value would otherwise price the stored kWh too).
    """
    n = 21
    pv = [20.0] + [p for p, _ in PV_BUS_SLOTS] + [0.0] * (n - 4)
    load = [14.0] + [lo for _, lo in PV_BUS_SLOTS] + [14.0] * (n - 4)
    export_ct = [4.0] * n
    for slot, price in zip(SALE_SLOTS, sales_ct):
        load[slot] = 1.0
        export_ct[slot] = price
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=HERZOGAU,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=[c * 10.0 for c in export_ct],
        load_kw=load,
        pv_kw=pv,
        initial_soc_kwh=HERZOGAU.soc_min_kwh,
        netzladen_erlaubt=False,  # EEG mode: PV bus per FK3
        import_price_eur_mwh=[250.0] * n,  # fest 25,0 ct
        export_value_eur_mwh=[c * 10.0 for c in export_ct],
        terminal_value_eur_per_kwh=0.0,
        grid_charge_hurdle_ct_kwh=hurdle_ct,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


def grid_charge(slot) -> float:
    return planned_grid_charge_kw(
        battery_kw=slot.battery_kw,
        pv_kw=slot.pv_kw,
        load_kw=slot.load_kw,
        curtail_kw=slot.curtail_kw,
    )


@needs_highs
def test_without_the_hurdle_the_plan_buys_over_the_pv_bus_as_on_24_09():
    """The reproduction: at hurdle 0 the model takes the +0,5-ct trade and
    charges over the PV bus while the house imports - and the old margin rule
    marks none of it (the plan intends the purchase, and WTP sits below
    import + 0,5)."""
    plan = solve(herzogau_input(SALES_24_09_CT, hurdle_ct=0.0))
    for s in plan.slots[1:4]:
        assert grid_charge(s) > PLANNED_GRID_CHARGE_DEADBAND_KW
        assert s.charge_from_surplus_only is False


@needs_highs
def test_with_the_hurdle_the_herzogau_slots_no_longer_charge_from_the_grid():
    """E6 A: +0,5 to +0,8 ct after the round trip does not earn the 2-ct
    hurdle - the 14:00-14:30Z slots plan no grid-sourced charge any more, the
    true surplus slot still stores its PV, and there the flag lands."""
    plan = solve(herzogau_input(SALES_24_09_CT, hurdle_ct=M_E6))
    for s in plan.slots[1:4]:
        assert grid_charge(s) <= PLANNED_GRID_CHARGE_DEADBAND_KW
    surplus = plan.slots[0]
    assert surplus.battery_kw == pytest.approx(6.0, abs=0.01)
    assert grid_charge(surplus) <= PLANNED_GRID_CHARGE_DEADBAND_KW
    assert surplus.charge_from_surplus_only is True
    # What is stored still goes into the better sale.
    assert plan.slots[SALE_SLOTS[1]].battery_kw < -PLANNED_GRID_CHARGE_DEADBAND_KW


@needs_highs
def test_with_the_hurdle_the_23_09_arbitrage_still_charges_from_the_grid():
    """lambda 32,9: the purchase earns ~4 ct after the round trip AND the
    hurdle, so the plan keeps it - and, being a planned purchase, the trim
    leaves it alone."""
    plan = solve(herzogau_input(SALES_23_09_CT, hurdle_ct=M_E6))
    for s in plan.slots[1:4]:
        assert grid_charge(s) > PLANNED_GRID_CHARGE_DEADBAND_KW
        assert s.stored_value_ct_kwh == pytest.approx(32.9, abs=0.06)
        assert s.charge_from_surplus_only is False


@needs_highs
def test_the_hurdle_never_enters_a_persisted_cost():
    """A planning hurdle, never a cash flow: the per-slot cost stays the grid
    cash flow at the tariff and the export value."""
    inp = herzogau_input(SALES_23_09_CT, hurdle_ct=M_E6)
    plan = solve(inp)
    for t, s in enumerate(plan.slots):
        price = inp.import_prices[t] if s.grid_kw > 0 else inp.export_values[t]
        assert s.cost_eur == pytest.approx(price * s.grid_kw * 0.25 / 1000.0, abs=1e-5)


def test_a_rest_the_hurdle_decided_is_no_tie_in_the_next_best_margin():
    """The explain layer's rejected ``netzladen`` alternative carries the
    hurdle it was rejected by: a grid charge worth +1 ct after the round trip
    but short of the 2-ct hurdle is a 1-ct disadvantage, never a tie."""
    from dataclasses import replace

    from voltpilot_optimization.explain import (
        NEXT_BEST_NETZLADEN,
        SlotDuals,
        _SlotPrimal,
        next_best_alternative,
    )

    eta = math.sqrt(0.92)
    battery = HERZOGAU
    wear = battery.wear_cost_eur_per_kwh_each_way  # EUR per AC kWh
    # lambda such that eta*lambda - import - wear = +1 ct.
    lam = (0.25 + wear + 0.01) / eta
    inp = replace(herzogau_input(SALES_24_09_CT, hurdle_ct=M_E6), netzladen_erlaubt=True)
    rest = _SlotPrimal(
        charge_kw=0.0,
        discharge_kw=0.0,
        battery_kw=0.0,
        curtail_kw=0.0,
        grid_kw=14.0,
        grid_import_kw=14.0,
        grid_export_kw=0.0,
        soc_end_kwh=battery.soc_min_kwh,
        pv_kw=0.0,
    )
    duals = SlotDuals(lambda_eur_kwh=lam, pi_eur_kwh=0.25, mu_eur_kw=None)
    # At the floor only charging is on offer (a deficit slot, no PV surplus).
    floor = ["soc_floor"]
    assert next_best_alternative(inp, 5, rest, floor, duals) == (NEXT_BEST_NETZLADEN, -1.0)
    spot_site = replace(inp, grid_charge_hurdle_ct_kwh=0.0)
    # Without the hurdle the same numbers would have charged (clamped to 0).
    assert next_best_alternative(spot_site, 5, rest, floor, duals) == (
        NEXT_BEST_NETZLADEN,
        0.0,
    )

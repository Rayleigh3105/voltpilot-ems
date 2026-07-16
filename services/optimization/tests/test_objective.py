"""The P1 market-revenue objective, end to end through the MILP.

Each test states an economic property the plan must have once import and
export are priced asymmetrically (target report §2.1-§2.4; critique findings
F1/F6/F7). The pre-P1 symmetric model remains the exact special case
import_price == export_value == spot - the untouched test_solver suite is that
regression proof; the tests here drive the NEW behaviors, several as
same-physics/different-pricing contrast pairs so the pricing (and nothing
else) is provably what flips the dispatch. All need the HiGHS wheel.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.solver import build_model

T0 = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)
BATTERY = BatteryParams(
    capacity_kwh=10.0,
    max_charge_kw=5.0,
    max_discharge_kw=5.0,
    roundtrip_efficiency=0.92,
)


def make_input(
    spot: list[float],
    load: float | list[float] = 0.0,
    pv: float | list[float] = 0.0,
    import_price: list[float] | None = None,
    export_value: list[float] | None = None,
    soc0_kwh: float = 0.5,
    netzladen_erlaubt: bool = False,
    battery: BatteryParams = BATTERY,
) -> OptimizationInput:
    n = len(spot)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=spot,
        load_kw=[load] * n if isinstance(load, (int, float)) else load,
        pv_kw=[pv] * n if isinstance(pv, (int, float)) else pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=import_price,
        export_value_eur_mwh=export_value,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


# ---- the captain's reference scenario (target report §2.2) -------------------


@needs_highs
def test_reference_scenario_pv_to_battery_load_from_cheap_grid_evening_discharge():
    """Midday: cheap spot, abundant PV. Evening: expensive retail import.

    The market-revenue plan routes the PV into the battery BEYOND the PV
    surplus - i.e. it deliberately imports the (cheap) load from the grid
    while charging - and discharges into the expensive evening. No rule says
    "self-consumption first"; the routing emerges from the prices alone.
    Merchant site (grid-assisted charging is the point), dynamic tariff.
    """
    n = 96
    # 48 midday slots: spot 30, PV 4.5 kW, load 4 kW - the 0.5 kW surplus
    # alone (6 kWh over the window) can NOT fill the 9 kWh battery, so filling
    # it requires deliberately importing the load while the PV charges.
    # 48 evening slots: spot 250, no PV, load 4 kW.
    spot = [30.0] * 48 + [250.0] * 48
    load = [4.0] * 96
    pv = [4.5] * 48 + [0.0] * 48
    aufschlag = 180.0  # 18 ct dynamic-tariff Aufschlag
    inp = make_input(
        spot,
        load=load,
        pv=pv,
        import_price=[p + aufschlag for p in spot],
        export_value=list(spot),  # merchant: bare spot export
        netzladen_erlaubt=True,
    )
    plan = solve(inp)
    midday = plan.slots[:48]
    evening = plan.slots[48:]

    # The decoupled routing: some midday slot charges BEYOND the 0.5 kW PV
    # surplus while importing from the grid - PV feeds the battery, the load
    # buys cheap grid power (never chosen by a rule-based self-consumption
    # dispatch, which stops at the surplus).
    assert any(
        s.battery_kw > 0.5 + 1e-3 and s.grid_kw > 1e-3 for s in midday
    ), "midday must charge beyond the PV surplus while importing the load"

    # The evening discharges into the load (avoiding the 430 EUR/MWh retail
    # import); with only 250-spot export on offer, it never net-exports.
    discharged = -sum(min(s.battery_kw, 0.0) for s in evening) * 0.25
    assert discharged > 5.0, "the stored energy must serve the evening"
    assert all(s.grid_kw >= -1e-6 for s in evening), "no export at bare spot 250"
    # And the whole exercise pays: honest net savings over the baseline.
    assert plan.savings_eur - plan.wear_cost_eur > 1.0


# ---- no simultaneous import + export -----------------------------------------


@needs_highs
def test_no_simultaneous_import_and_export_even_when_export_is_worth_more():
    """A spot-settled DV site's premium makes export value (180) EXCEED the
    import price (100). Without the is_importing binary the LP would import
    and export in the same slot to farm the 80 EUR/MWh difference; the gate
    must hold in every slot."""
    from pyomo.environ import value

    from voltpilot_optimization.solver import _solve

    n = 96
    spot = [100.0] * n
    inp = make_input(
        spot,
        load=2.0,
        pv=[5.0] * (n // 2) + [0.0] * (n - n // 2),
        import_price=list(spot),
        export_value=[p + 80.0 for p in spot],  # Marktprämie 8 ct
        netzladen_erlaubt=False,  # EEG mode: battery content provably solar
    )
    model = build_model(inp)
    _solve(model)
    for t in range(n):
        imp = float(value(model.grid_import[t]))
        exp = float(value(model.grid_export[t]))
        assert min(imp, exp) < 1e-6, f"slot {t} imports AND exports"


# ---- §2.3: retail-billed vs spot-settled load, same physics ------------------

# Shared physics: 32 midday slots (PV 8 kW, load 2 kW, spot -10 - a normal
# negative-price solar noon, so storing forfeits almost nothing) charge the
# battery from the surplus; 64 evening slots (no PV, load 2 kW, spot 100).
# Only the PRICING differs between the two tests - that is the whole point.
_SPOT = [-10.0] * 32 + [100.0] * 64
_LOAD = [2.0] * 96
_PV = [8.0] * 32 + [0.0] * 64


@needs_highs
def test_retail_billed_site_self_consumes_and_never_exports_the_battery():
    """Retail-billed load (dynamisch + 18 ct) with feste Vergütung (8.2 ct,
    pre-Solarspitzengesetz: earned even at negative spot): the evening's
    avoided import (280) dwarfs the export value (82), so the battery serves
    the load and never net-exports - self-consumption emerges as the CORRECT
    valuation here, not as a rule (target report §2.4 EEG)."""
    plan = solve(
        make_input(
            _SPOT,
            load=_LOAD,
            pv=_PV,
            import_price=[p + 180.0 for p in _SPOT],
            export_value=[82.0] * 96,
        )
    )
    evening = plan.slots[32:]
    assert all(s.grid_kw >= -1e-6 for s in evening), "never exports at 82 vs 280"
    discharged = -sum(min(s.battery_kw, 0.0) for s in evening) * 0.25
    assert discharged > 5.0, "the battery must cover the evening load"


@needs_highs
def test_spot_settled_dv_site_exports_past_its_own_load():
    """The SAME physics on a spot-settled DV site (import at spot; export at
    spot + 100 premium in non-negative slots, bare spot in the negative noon):
    the evening export (200) beats the avoided import (100), so the discharge
    exceeds the load and NET-EXPORTS while the load runs - the exact opposite
    of self-consumption-first (target report §2.3)."""
    plan = solve(
        make_input(
            _SPOT,
            load=_LOAD,
            pv=_PV,
            import_price=list(_SPOT),
            export_value=[p + 100.0 if p >= 0 else p for p in _SPOT],
        )
    )
    evening = plan.slots[32:]
    assert any(
        s.grid_kw < -0.5 and s.battery_kw < -1e-3 for s in evening
    ), "the premium must pull stored energy past the load into export"


# ---- F1 experiment 4: hold for the late retail load, not the spot peak -------


@needs_highs
def test_tariff_aware_plan_holds_the_battery_for_the_late_load_not_the_spot_peak():
    """The critique's Experiment 4 shape: an early evening SPOT peak (140)
    with almost no load, then late-evening load at spot 50 - but retail
    import 230. The symmetric model discharges into the export peak (140);
    the tariff-aware model holds for the late load (avoids 230). Same input,
    only the pricing differs - the F1 fix, demonstrated."""
    n = 96
    spot = [30.0] * 32 + [140.0] * 32 + [50.0] * 32
    load = [2.0] * 32 + [0.2] * 32 + [4.0] * 32
    pv = [8.0] * 32 + [0.0] * 64
    aufschlag = 180.0

    symmetric = solve(make_input(spot, load=load, pv=pv))
    peak_export_sym = -sum(
        min(s.grid_kw, 0.0) for s in symmetric.slots[32:64] if s.battery_kw < -1e-3
    )
    assert peak_export_sym > 1.0, (
        "precondition: the symmetric model discharges into the 140 spot peak"
    )

    tariff_aware = solve(
        make_input(
            spot,
            load=load,
            pv=pv,
            import_price=[p + aufschlag for p in spot],
            export_value=[82.0] * n,  # feste Vergütung
        )
    )
    peak = tariff_aware.slots[32:64]
    late = tariff_aware.slots[64:]
    assert all(s.grid_kw >= -1e-6 for s in peak), (
        "the tariff-aware plan must not export into the 140 spot peak at 82"
    )
    late_discharged = -sum(min(s.battery_kw, 0.0) for s in late) * 0.25
    assert late_discharged > 5.0, "the battery is held for the 230 retail load"


# ---- F7: a flat retail tariff kills grid-charge arbitrage --------------------


@needs_highs
def test_flat_retail_tariff_leaves_no_spread_for_grid_arbitrage():
    """Merchant site on a FLAT retail tariff (fest 30 ct): every imported kWh
    costs 300 regardless of spot, and export earns bare spot (max 200), so
    grid-charge -> export loses the full Aufschlag and grid-charge -> later
    avoided-import has zero spread - the battery must stay idle even though
    the SPOT spread (20 -> 200) would scream arbitrage (critique F7)."""
    n = 96
    spot = [20.0] * 48 + [200.0] * 48
    plan = solve(
        make_input(
            spot,
            load=5.0,
            import_price=[300.0] * n,
            export_value=list(spot),
            netzladen_erlaubt=True,
        )
    )
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert plan.savings_eur == pytest.approx(0.0, abs=1e-6)


# ---- F6: curtailment follows the EXPORT VALUE, not the spot sign -------------


@needs_highs
def test_feste_verguetung_plant_never_curtails_at_negative_spot():
    """Same negative-spot/full-battery physics as the classic curtailment
    test - but a pre-Solarspitzengesetz feste-Vergütung plant still earns
    8.2 ct on every exported kWh, so curtailing burns real money and the plan
    must keep feeding in (critique F6). The DV twin (premium suspended,
    export value = spot < 0) still curtails."""
    n = 96
    spot = [-50.0] * n
    fixed = solve(
        make_input(
            spot,
            load=2.0,
            pv=6.0,
            import_price=list(spot),
            export_value=[82.0] * n,
            soc0_kwh=BATTERY.soc_max_kwh,
        )
    )
    assert all(s.curtail_kw < 1e-6 for s in fixed.slots)
    assert all(s.grid_kw < -1.0 for s in fixed.slots), "keeps exporting at 82"

    dv = solve(
        make_input(
            spot,
            load=2.0,
            pv=6.0,
            import_price=list(spot),
            export_value=list(spot),  # premium suspended below zero
            soc0_kwh=BATTERY.soc_max_kwh,
        )
    )
    # Full curtailment: at spot -50 with symmetric spot import, being PAID to
    # import the load beats consuming own PV (the classic curtailment result).
    assert all(s.curtail_kw == pytest.approx(6.0, abs=1e-3) for s in dv.slots), (
        "the DV plant discards its PV once the premium is suspended"
    )


# ---- Marktprämie pulls real revenue into the plan economics ------------------


@needs_highs
def test_premium_export_revenue_shows_up_in_cost_and_savings():
    """An EEG-mode DV site exporting PV surplus books spot + premium in
    cost_eur (the projected cashflow) - and the baseline (immediate feed-in)
    earns it too, so savings stay honest (both sides credited, mirroring
    EarningsRepository)."""
    n = 16
    spot = [100.0] * n
    inp = make_input(
        spot,
        load=1.0,
        pv=5.0,
        import_price=list(spot),
        export_value=[180.0] * n,  # spot + 80 premium
    )
    plan = solve(inp)
    for slot in plan.slots:
        assert slot.grid_kw == pytest.approx(-4.0, abs=1e-3)
        assert slot.cost_eur == pytest.approx(-180.0 * 4.0 * 0.25 / 1000.0, abs=1e-6)
        assert slot.baseline_cost_eur == pytest.approx(slot.cost_eur, abs=1e-6)


# ---- EEG mode composes with the new pricing ----------------------------------


@needs_highs
def test_eeg_mode_still_never_grid_charges_under_a_juicy_export_premium():
    """A big export premium makes grid-charge -> export tempting (import 100,
    export 250 clears wear + losses comfortably); the EEG solar-only-charge
    bound (charge <= pv - curtail, zero with no PV - FK3 PV-bus semantics)
    must still forbid it - the premium may only ever flow through solar
    energy."""
    n = 96
    spot = [100.0] * n
    plan = solve(
        make_input(
            spot,
            load=2.0,
            pv=0.0,  # no PV at all: nothing may charge
            import_price=list(spot),
            export_value=[250.0] * n,
            netzladen_erlaubt=False,
        )
    )
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)

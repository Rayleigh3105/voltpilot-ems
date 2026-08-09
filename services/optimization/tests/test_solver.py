"""Behavioral tests for the battery-dispatch MILP.

Each test states an economic or physical property the plan must have on a
synthetic price/load curve. Solver-dependent tests importorskip ``highspy``
(the wheel is unavailable on some platforms, per the repo convention); the
model-building test always runs.
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

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
BATTERY = BatteryParams(
    capacity_kwh=10.0,
    max_charge_kw=5.0,
    max_discharge_kw=5.0,
    roundtrip_efficiency=0.92,
)


def make_input(
    prices: list[float],
    load: float | list[float] = 5.0,
    pv: float | list[float] = 0.0,
    battery: BatteryParams = BATTERY,
    soc0_kwh: float = 5.0,
    grid_limit_kw: float | None = None,
    max_feed_in_kw: float | None = None,
    netzladen_erlaubt: bool = True,
) -> OptimizationInput:
    # netzladen_erlaubt defaults to True (merchant mode) HERE, deliberately:
    # merchant mode is the exact pre-switch model, so every long-standing test
    # below doubles as the regression proof that the switch changed nothing for
    # sites where grid charging is allowed. EEG-mode tests opt in explicitly.
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[load] * n if isinstance(load, (int, float)) else load,
        pv_kw=[pv] * n if isinstance(pv, (int, float)) else pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        grid_limit_kw=grid_limit_kw,
        max_feed_in_kw=max_feed_in_kw,
    )


def arbitrage_prices(n: int = 96) -> list[float]:
    """Cheap night (first 8h), normal day, expensive evening (last 8h)."""
    third = n // 3
    return [20.0] * third + [100.0] * (n - 2 * third) + [200.0] * third


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


def test_model_builds_without_solver():
    model = build_model(make_input(arbitrage_prices(), grid_limit_kw=30.0))
    # 96 slots: balance + import/export gates + dynamics + charge/discharge
    # gates + 2 grid caps per slot. (The old hard terminal-SoC constraint is
    # gone - P3 replaced it with a terminal-value objective term.)
    assert model.nconstraints() == 96 * 8
    # charge/discharge/is_charging/curtail/import/export/is_importing per slot
    # + 97 SoC nodes.
    assert model.nvariables() == 96 * 7 + 97


def test_curtailment_exists_in_both_builds_and_is_bounded_by_pv():
    # The curtailment variable must be present with and without the §14a
    # constraint (the infeasible-cap fallback rebuilds without it), and its
    # bounds must pin [0, pv] - a curtailment can only ever REDUCE feed-in.
    pv = [0.0] * 48 + [6.0] * 48
    for enforce in (True, False):
        model = build_model(
            make_input([50.0] * 96, pv=pv, grid_limit_kw=30.0),
            enforce_grid_limit=enforce,
        )
        assert model.curtail[0].bounds == (0.0, 0.0)
        assert model.curtail[95].bounds == (0.0, 6.0)


# ---- everything below needs the HiGHS wheel ---------------------------------


@needs_highs
def test_charges_in_cheap_slots_discharges_in_expensive_ones():
    n = 96
    plan = solve(make_input(arbitrage_prices(n)))
    third = n // 3
    cheap = plan.slots[:third]
    expensive = plan.slots[2 * third :]
    charged_kwh = sum(s.battery_kw for s in cheap if s.battery_kw > 0) * 0.25
    discharged_kwh = -sum(s.battery_kw for s in expensive if s.battery_kw < 0) * 0.25
    assert charged_kwh > 1.0, "should charge in the cheap night window"
    assert discharged_kwh > 1.0, "should discharge in the expensive evening"
    # Never charge at the peak, never discharge at the trough.
    assert all(s.battery_kw <= 1e-6 for s in expensive)
    assert all(s.battery_kw >= -1e-6 for s in cheap)


@needs_highs
def test_savings_positive_on_arbitrage_curve_zero_on_flat():
    arb = solve(make_input(arbitrage_prices()))
    assert arb.savings_eur > 0.5

    flat = solve(make_input([100.0] * 96))
    assert flat.savings_eur == pytest.approx(0.0, abs=1e-6)
    # On a flat curve cycling only burns round-trip losses: the optimum is idle.
    assert all(abs(s.battery_kw) < 1e-6 for s in flat.slots)


@needs_highs
def test_respects_power_limits_and_soc_bounds():
    plan = solve(make_input(arbitrage_prices(), soc0_kwh=2.0))
    p = plan.battery
    for slot in plan.slots:
        assert slot.battery_kw <= p.max_charge_kw + 1e-6
        assert slot.battery_kw >= -p.max_discharge_kw - 1e-6
        assert p.soc_min_kwh - 1e-6 <= slot.soc_kwh <= p.soc_max_kwh + 1e-6


@needs_highs
def test_soc_dynamics_account_for_efficiency():
    plan = solve(make_input(arbitrage_prices()))
    eta = plan.battery.one_way_efficiency
    soc = plan.battery.clamp_soc_kwh(5.0)
    for slot in plan.slots:
        charge = max(slot.battery_kw, 0.0)
        discharge = max(-slot.battery_kw, 0.0)
        soc = soc + (eta * charge - discharge / eta) * 0.25
        assert slot.soc_kwh == pytest.approx(soc, abs=1e-3)


@needs_highs
def test_small_spread_below_roundtrip_loss_and_wear_stays_idle():
    # Arbitrage pays only if the spread beats round-trip losses AND the priced
    # battery wear (P2): eta^2 * p_d - p_c > wear * 5 * (1 + eta^2), which at
    # the 4 ct/kWh default and eta^2 = 0.92 is ~38.4 EUR/MWh. A 5% spread must
    # not trigger cycling; a 70% spread must. (The dedicated wear tests in
    # test_wear.py pin the threshold band itself.)
    # Start at the SoC floor so the test isolates pure CYCLING economics:
    # since P3 the plan may legitimately REALIZE pre-stored energy at a price
    # above the terminal-value anchor (that is the F3 fix), which is a
    # different decision than opening a new cycle.
    n = 96
    small = [100.0] * (n // 2) + [105.0] * (n - n // 2)
    plan = solve(make_input(small, soc0_kwh=BATTERY.soc_min_kwh))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)

    big = [100.0] * (n // 2) + [170.0] * (n - n // 2)
    plan = solve(make_input(big, soc0_kwh=BATTERY.soc_min_kwh))
    assert any(s.battery_kw > 1e-3 for s in plan.slots)


@needs_highs
def test_grid_limit_is_a_hard_cap_on_import_and_export():
    # Load 5 kW, limit 6 kW: charging may add at most ~1 kW on top of the load.
    plan = solve(make_input(arbitrage_prices(), load=5.0, grid_limit_kw=6.0))
    for slot in plan.slots:
        assert abs(slot.grid_kw) <= 6.0 + 1e-6
    # The battery still cycles (within the envelope): the plan is not degenerate.
    assert any(s.battery_kw > 1e-3 for s in plan.slots)


# ---- FK1: static feed-in cap at the grid connection point -------------------


def test_feed_in_cap_constraint_exists_in_both_builds_export_only():
    # The static connection-point cap (site master data) must be present in the
    # primary build AND the infeasible-§14a fallback rebuild - unlike the
    # telemetry-driven grid_limit_kw it is never dropped (curtailment can
    # always satisfy it, so it can never cause infeasibility). And it is
    # EXPORT ONLY: no import-side twin.
    for enforce in (True, False):
        model = build_model(
            make_input([50.0] * 96, max_feed_in_kw=40.0),
            enforce_grid_limit=enforce,
        )
        assert hasattr(model, "feed_in_cap")
        assert not hasattr(model, "grid_import_cap")
    # Unconfigured -> no constraint (the pre-FK1 model, byte-identical).
    model = build_model(make_input([50.0] * 96))
    assert not hasattr(model, "feed_in_cap")


@needs_highs
def test_the_feed_in_cap_is_handed_to_the_edge_as_the_watchdogs_target():
    # Dynamische Einspeisebegrenzung (2026-08-06): the SAME master datum the
    # constraint above plans against is stamped on the plan, so the edge's
    # real-time watchdog regulates against exactly the number the cloud planned
    # against - a pure pass-through, never a solved value (a solved export peak
    # would drift below the real limit and quietly throttle the plant).
    plan = solve(make_input([50.0] * 96, max_feed_in_kw=40.0))
    assert plan.max_feed_in_kw == 40.0
    # Unconfigured stays unconfigured: a limit is never invented.
    assert solve(make_input([50.0] * 96)).max_feed_in_kw is None


@needs_highs
def test_pv_surplus_beyond_the_feed_in_cap_caps_export_instead_of_infeasible():
    # A 100-kW PV forecast against a 40-kW connection: the plan must stay
    # feasible and hold export at/below the cap - absorbing the surplus into
    # the battery and/or curtailing the rest (the model's lever), never
    # exporting beyond the physical connection.
    n = 96
    plan = solve(
        make_input(
            [80.0] * n,
            load=5.0,
            pv=[100.0] * n,
            soc0_kwh=BATTERY.soc_min_kwh,
            max_feed_in_kw=40.0,
        )
    )
    for slot in plan.slots:
        export_kw = max(-slot.grid_kw, 0.0)
        assert export_kw <= 40.0 + 1e-6
    # 100 pv - 5 load - 5 max charge = 90 kW surplus vs a 40 kW cap: the
    # remainder MUST be curtailed (at a positive price - forced by physics,
    # not economics).
    assert any(s.curtail_kw > 1.0 for s in plan.slots)


@needs_highs
def test_feed_in_cap_never_caps_import():
    # EXPORT ONLY: a 3-kW feed-in cap must not stop a 5-kW load from importing
    # (plus charging on top in the cheap window).
    plan = solve(make_input(arbitrage_prices(), load=5.0, max_feed_in_kw=3.0))
    assert any(s.grid_kw > 5.0 + 1e-3 for s in plan.slots), (
        "import (load + charge) must exceed the feed-in cap untouched"
    )


@needs_highs
def test_tighter_of_feed_in_cap_and_grid_limit_wins_on_export():
    # Full battery discharging into the expensive evening with zero load:
    # export comes from the battery, bounded by BOTH caps - the tighter one
    # binds. (An arbitrage curve, not a flat one: on a flat curve the terminal
    # value ties with discharging and the plan correctly stays idle.)
    prices = arbitrage_prices()

    def max_export(plan) -> float:
        return max(max(-s.grid_kw, 0.0) for s in plan.slots)

    tight_feed_in = solve(
        make_input(prices, load=0.0, soc0_kwh=9.5,
                   grid_limit_kw=4.0, max_feed_in_kw=2.0)
    )
    assert max_export(tight_feed_in) <= 2.0 + 1e-6
    assert max_export(tight_feed_in) > 1.0  # it does discharge-export

    tight_14a = solve(
        make_input(prices, load=0.0, soc0_kwh=9.5,
                   grid_limit_kw=2.0, max_feed_in_kw=4.0)
    )
    assert max_export(tight_14a) <= 2.0 + 1e-6


@needs_highs
def test_feed_in_cap_survives_the_infeasible_grid_limit_fallback():
    # When the §14a cap is infeasible and the engine retries without it, the
    # STATIC connection-point cap must still be enforced in the fallback plan.
    from voltpilot_optimization.solver import optimize_ignoring_grid_limit

    inp = make_input(
        [100.0] * 96, load=50.0, pv=[120.0] * 96,
        grid_limit_kw=1.0, max_feed_in_kw=30.0,
    )
    plan = optimize_ignoring_grid_limit(inp, plan_id=uuid4(), generated_at=T0)
    for slot in plan.slots:
        assert max(-slot.grid_kw, 0.0) <= 30.0 + 1e-6


@needs_highs
def test_infeasible_grid_limit_raises_and_fallback_solves():
    from voltpilot_optimization.solver import (
        InfeasiblePlanError,
        optimize_ignoring_grid_limit,
        optimize,
    )

    # 50 kW of load against a 1 kW limit: no battery can bridge that for 24h.
    inp = make_input([100.0] * 96, load=50.0, grid_limit_kw=1.0)
    with pytest.raises(InfeasiblePlanError):
        optimize(inp, plan_id=uuid4(), generated_at=T0)
    plan = optimize_ignoring_grid_limit(inp, plan_id=uuid4(), generated_at=T0)
    assert len(plan.slots) == 96


@needs_highs
def test_no_simultaneous_charge_and_discharge_even_at_negative_prices():
    # At negative prices an LP would charge AND discharge simultaneously
    # (burning energy through the round trip is "profitable"); the binaries
    # must exclude that. Inspect the raw charge/discharge variables.
    from pyomo.environ import value

    from voltpilot_optimization.solver import _solve

    n = 96
    prices = [-50.0] * (n // 4) + arbitrage_prices(n - n // 4)
    model = build_model(make_input(prices))
    _solve(model)
    for t in range(n):
        charge = float(value(model.charge[t]))
        discharge = float(value(model.discharge[t]))
        assert min(charge, discharge) < 1e-6, f"slot {t} charges AND discharges"


# ---- Negative-price curtailment (Phase 3) -----------------------------------
# The tests assert the ECONOMIC property (curtail exactly when feeding in would
# cost money), never a hard-coded price condition - the model has none.


@needs_highs
def test_full_battery_at_negative_prices_curtails_instead_of_paying_to_export():
    # Battery already full (soc0 = soc_max), PV surplus, deeply negative
    # prices: without curtailment the plant is forced to export and PAYS for
    # it. The optimal plan discards the surplus instead - and because import
    # is symmetrically priced, being paid to consume beats using own PV, so
    # the full PV output is curtailed in every slot. (The battery may still
    # cycle: at negative prices the paid import more than covers the
    # round-trip loss - real spot-exposed battery behavior, not a bug - so
    # grid power varies with the dispatch; PV feed-in is what must be gone.)
    plan = solve(
        make_input([-50.0] * 96, load=2.0, pv=6.0, soc0_kwh=BATTERY.soc_max_kwh)
    )
    for slot in plan.slots:
        assert slot.curtail_kw == pytest.approx(6.0, abs=1e-3)
        # Safety invariant: curtailment never exceeds the PV forecast.
        assert 0.0 <= slot.curtail_kw <= slot.pv_kw + 1e-9
        # Any export left is battery dispatch, never PV: export never exceeds
        # what the battery can discharge on top of the (fully curtailed) load.
        assert slot.grid_kw >= 2.0 - BATTERY.max_discharge_kw - 1e-6
    # The savings vs. the uncurtailed baseline (which exports 4 kW at -50) are
    # real money: baseline pays, the plan earns.
    assert plan.savings_eur > 0.5
    assert plan.cost_eur < plan.baseline_cost_eur


@needs_highs
def test_no_curtailment_at_positive_prices():
    # Identical situation but positive prices: discarding PV would burn
    # revenue, so no slot may curtail.
    plan = solve(
        make_input([50.0] * 96, load=2.0, pv=6.0, soc0_kwh=BATTERY.soc_max_kwh)
    )
    assert all(s.curtail_kw < 1e-6 for s in plan.slots)


@needs_highs
def test_curtailment_engages_exactly_in_the_negative_half():
    # Mixed curve, full battery throughout: the economics alone must pick the
    # negative half for curtailment and leave the positive half untouched.
    n = 96
    prices = [-30.0] * (n // 2) + [30.0] * (n - n // 2)
    plan = solve(make_input(prices, load=1.0, pv=5.0, soc0_kwh=BATTERY.soc_max_kwh))
    negative = plan.slots[: n // 2]
    positive = plan.slots[n // 2 :]
    assert all(s.curtail_kw > 1.0 for s in negative)
    assert all(s.curtail_kw < 1e-6 for s in positive)


@needs_highs
def test_curtailment_makes_a_tight_export_cap_feasible_but_stays_minimal():
    # §14a interplay: 20 kW PV against a 6 kW export limit and a full battery
    # was INFEASIBLE before curtailment existed. With it the plan becomes
    # feasible - and at POSITIVE prices it curtails only the minimum needed to
    # honor the cap (every exportable kW earns money), keeping export at the
    # limit.
    plan = solve(
        make_input(
            [80.0] * 96,
            load=0.0,
            pv=20.0,
            soc0_kwh=BATTERY.soc_max_kwh,
            grid_limit_kw=6.0,
        )
    )
    for slot in plan.slots:
        assert slot.grid_kw == pytest.approx(-6.0, abs=1e-3)
        assert slot.curtail_kw == pytest.approx(14.0, abs=1e-3)


@needs_highs
def test_fallback_build_curtails_too():
    # The infeasible-cap fallback (optimize_ignoring_grid_limit) must carry the
    # same curtailment capability as the primary build.
    from voltpilot_optimization.solver import optimize_ignoring_grid_limit
    from uuid import uuid4 as _uuid4

    inp = make_input([-50.0] * 96, load=2.0, pv=6.0, soc0_kwh=BATTERY.soc_max_kwh)
    plan = optimize_ignoring_grid_limit(inp, plan_id=_uuid4(), generated_at=T0)
    assert all(s.curtail_kw == pytest.approx(6.0, abs=1e-3) for s in plan.slots)


# ---- Per-site grid-charging switch (netzladen_erlaubt, EEG mode) -------------
# EEG mode (netzladen_erlaubt=False) enforces the Ausschliesslichkeitsprinzip
# with PV-bus Bilanzierung (FK3, captain decision 2026-07-16): the battery
# charges ONLY from PV the site actually produces (charge <= pv - curtail) -
# the house may import its load in parallel, but grid energy can never enter
# the battery. Merchant mode (True) is byte-identical to the pre-switch model -
# the untouched tests above are that regression proof; the structural test
# below pins it.


def test_eeg_constraint_exists_only_in_eeg_mode_and_in_both_builds():
    # Merchant build: same constraint/variable counts as before the EEG switch,
    # no EEG constraint objects (the regression guarantee).
    merchant = build_model(make_input(arbitrage_prices(), grid_limit_kw=30.0))
    assert merchant.nconstraints() == 96 * 8
    assert not hasattr(merchant, "solar_only_charge")
    assert not hasattr(merchant, "no_import_while_charging")

    # EEG build: exactly ONE extra constraint family (FK3 removed the pre-FK3
    # no-import-while-charging ban; the pv - curtail bound carries the
    # Graustrom protection alone) - and it must survive the infeasible-§14a
    # fallback rebuild (enforce_grid_limit=False) too, so a degraded plan can
    # never fall back into grid charging.
    for enforce in (True, False):
        eeg = build_model(
            make_input(
                arbitrage_prices(), grid_limit_kw=30.0, netzladen_erlaubt=False
            ),
            enforce_grid_limit=enforce,
        )
        assert hasattr(eeg, "solar_only_charge")
        assert not hasattr(eeg, "no_import_while_charging")
        expected = 96 * 9 if enforce else 96 * 7
        assert eeg.nconstraints() == expected


@needs_highs
def test_eeg_mode_never_charges_from_grid_even_under_extreme_spread():
    # The hardest temptation: a free night (price 0) before a 500 EUR/MWh
    # evening, and NO PV at all. Merchant mode fills the battery from the grid;
    # EEG mode produces no PV, so NOTHING may charge - but since P3 the
    # stored energy it already holds legitimately discharges into the 500 peak
    # (pre-P3, the hard terminal floor froze it completely - critique F3; the
    # dedicated F3 tests live in test_terminal_value.py).
    n = 96
    prices = [0.0] * 32 + [100.0] * 32 + [500.0] * 32
    eeg = solve(make_input(prices, load=5.0, pv=0.0, netzladen_erlaubt=False))
    assert all(s.battery_kw <= 1e-6 for s in eeg.slots), "no grid charge, ever"
    discharged_kwh = -sum(min(s.battery_kw, 0.0) for s in eeg.slots) * 0.25
    assert discharged_kwh > 1.0, "the stored energy serves the 500 peak (P3)"

    merchant = solve(make_input(prices, load=5.0, pv=0.0))
    charged_kwh = sum(s.battery_kw for s in merchant.slots if s.battery_kw > 0) * 0.25
    assert charged_kwh > 1.0, "merchant mode should arbitrage the spread"
    assert merchant.savings_eur > 0.5


@needs_highs
def test_eeg_mode_cloudy_day_charges_up_to_produced_pv_while_the_house_imports():
    # The FK3 headline proof (PV-bus Bilanzierung, captain decision 2026-07-16):
    # a cloudy day where load > pv in EVERY slot. The pre-FK3 Zähler semantics
    # (charge <= max(pv - load, 0) = 0) forbade ALL charging here; PV-bus mode
    # charges up to the PV actually produced while the house draws its load
    # from the grid in parallel (DC-hybrid physics) - and never beyond the PV.
    n = 96
    prices = [20.0] * 48 + [60.0] * 16 + [250.0] * 32
    pv = [0.0] * 48 + [3.0] * 16 + [0.0] * 32  # cloudy: pv < load (4) all day
    plan = solve(make_input(prices, load=4.0, pv=pv, netzladen_erlaubt=False))
    for i, slot in enumerate(plan.slots):
        charge = max(slot.battery_kw, 0.0)
        assert charge <= pv[i] + 1e-6, f"slot {i} charges beyond the produced PV"
    night = plan.slots[:48]
    midday = plan.slots[48:64]
    evening = plan.slots[64:]
    assert all(s.battery_kw <= 1e-6 for s in night), "no grid charging at night"
    # The old surplus rule bounded every midday charge at max(3 - 4, 0) = 0;
    # PV-bus mode stores real solar energy on this cloudy day.
    assert sum(s.battery_kw for s in midday) > 1.0, "cloudy-day PV is stored"
    # ... and the charging slots legitimately IMPORT the house load in
    # parallel (the flow the pre-FK3 import ban forbade).
    assert any(
        s.battery_kw > 0.5 and s.grid_kw > 0.5 for s in midday
    ), "the house must be allowed to import while the battery charges from PV"
    assert sum(s.battery_kw for s in evening) < -1.0, "stored solar covers the peak"
    assert plan.savings_eur > 0.5


@needs_highs
def test_eeg_fully_curtailed_pv_cannot_charge_and_grid_never_feeds_the_battery():
    # The Graustrom loophole test, FK3 edition: at negative prices the model
    # earns by importing, and WITHOUT the curtail term in the bound it could
    # curtail the PV fully while "charging from PV" - the balance then feeds
    # the battery from paid grid import. With charge <= pv - curtail the
    # charge power is always covered by uncurtailed PV, so via the grid
    # balance a charging slot's import can never exceed the LOAD - grid energy
    # never enters the battery, however profitable importing is.
    n = 96
    prices = [-80.0] * (n // 2) + [120.0] * (n - n // 2)
    eeg = solve(
        make_input(prices, load=2.0, pv=6.0, soc0_kwh=1.0, netzladen_erlaubt=False)
    )
    for i, slot in enumerate(eeg.slots):
        charge = max(slot.battery_kw, 0.0)
        assert charge <= 6.0 - slot.curtail_kw + 1e-6, (
            f"slot {i} charges curtailed PV (charge {charge} kW, "
            f"curtail {slot.curtail_kw} kW)"
        )
        assert slot.grid_kw <= 2.0 + 1e-6, (
            f"slot {i} imports beyond the load (grid {slot.grid_kw} kW) - "
            f"grid power is feeding the battery"
        )
    # Curtailment itself stays available to EEG plants (it limits feed-in, not
    # charge availability): the negative half still discards surplus PV.
    assert any(s.curtail_kw > 1.0 for s in eeg.slots[: n // 2])

    merchant = solve(make_input(prices, load=2.0, pv=6.0, soc0_kwh=1.0))
    assert any(
        s.battery_kw > 1e-3 and s.grid_kw > 2.0 + 1e-3 for s in merchant.slots
    ), "merchant mode should grid-charge (import beyond the load) when paid"


@needs_highs
def test_eeg_mode_respects_the_14a_grid_limit_and_fallback_stays_eeg_clean():
    # §14a interplay: the grid cap and the EEG rules compose - and when the cap
    # is infeasible, the fallback build must still refuse grid charging.
    from voltpilot_optimization.solver import (
        InfeasiblePlanError,
        optimize,
        optimize_ignoring_grid_limit,
    )

    n = 96
    prices = [20.0] * 48 + [60.0] * 16 + [250.0] * 32
    pv = [0.0] * 48 + [8.0] * 16 + [0.0] * 32
    plan = solve(
        make_input(
            prices, load=2.0, pv=pv, grid_limit_kw=4.0, netzladen_erlaubt=False
        )
    )
    for i, slot in enumerate(plan.slots):
        assert abs(slot.grid_kw) <= 4.0 + 1e-6
        assert max(slot.battery_kw, 0.0) <= pv[i] - slot.curtail_kw + 1e-6

    # Infeasible cap (load 50 kW against 1 kW): the EEG rule survives the
    # fallback rebuild - the degraded plan still never charges (no PV at all).
    inp = make_input(
        [0.0] * 48 + [500.0] * 48, load=50.0, grid_limit_kw=1.0,
        netzladen_erlaubt=False,
    )
    with pytest.raises(InfeasiblePlanError):
        optimize(inp, plan_id=uuid4(), generated_at=T0)
    fallback = optimize_ignoring_grid_limit(inp, plan_id=uuid4(), generated_at=T0)
    assert all(s.battery_kw <= 1e-6 for s in fallback.slots)


@needs_highs
def test_pv_surplus_is_stored_for_the_evening_peak():
    # Sunny midday (PV >> load), expensive evening: the plan should charge from
    # the surplus and discharge into the peak, beating the sell-now baseline.
    n = 96
    prices = [100.0] * 48 + [60.0] * 16 + [250.0] * 32
    pv = [0.0] * 48 + [8.0] * 16 + [0.0] * 32
    plan = solve(make_input(prices, load=2.0, pv=pv))
    midday = plan.slots[48:64]
    evening = plan.slots[64:]
    assert sum(s.battery_kw for s in midday) > 1.0
    assert sum(s.battery_kw for s in evening) < -1.0
    assert plan.savings_eur > 0.5


@needs_highs
def test_plan_carries_the_sites_grid_charge_posture_for_the_edge():
    # P5 (EEG execution gap): the plan hands netzladen_erlaubt to the edge as
    # the optional grid_charge_allowed contract field, so the solar-only-charge
    # rule is also enforced against MEASURED pv/load at execution time
    # (guards.Limits.SolarOnlyCharge), not just in forecast space.
    eeg = solve(make_input(arbitrage_prices(), netzladen_erlaubt=False))
    assert eeg.grid_charge_allowed is False

    merchant = solve(make_input(arbitrage_prices()))
    assert merchant.grid_charge_allowed is True


# ---- Charge-timing tie-break: early-charge (captain decision 2026-08-09) -----
# "Bei gleichen Kosten so frueh wie moeglich laden." A free/negative-price PV
# surplus window is a pure timing tie - the pre-2026-08 solver put the fill at
# the window's END (Anlage Pilsting). Early filling is strictly more robust
# (an early cloud finds a full battery) and, on a plant whose curtailment is
# not yet released, immediately cuts the real loss-making export.

BIG_BATTERY = BatteryParams(
    capacity_kwh=60.0,
    max_charge_kw=15.0,
    max_discharge_kw=15.0,
    roundtrip_efficiency=0.92,
)


def test_early_charge_tiebreak_is_strictly_smaller_than_its_two_siblings():
    # The magnitude discipline (docstring): the third tie-break must stay
    # cleanly sub-dominant so prefer-idle keeps deciding WHETHER to cycle and
    # early-charge only WHEN a justified charge is placed. Docker-free unit,
    # always runs (no HiGHS needed).
    from voltpilot_optimization.solver import (
        BATTERY_WEAR_TIEBREAK_EUR_PER_KW,
        CURTAIL_TIEBREAK_EUR_PER_KW,
        EARLY_CHARGE_TIEBREAK_EUR_PER_KW,
    )

    assert 0 < EARLY_CHARGE_TIEBREAK_EUR_PER_KW < BATTERY_WEAR_TIEBREAK_EUR_PER_KW
    assert EARLY_CHARGE_TIEBREAK_EUR_PER_KW < CURTAIL_TIEBREAK_EUR_PER_KW


def _pilsting_scenario(pv_kw: float = 38.0, netzladen_erlaubt: bool = False):
    # A long free/negative-price PV-surplus window (slots 40..63), an evening
    # peak (slots 74..95) that makes filling the battery worthwhile, and a low
    # starting SoC (23%): the fill is a pure timing tie inside the window.
    n = 96
    prices = [40.0] * n
    pv = [0.0] * n
    for t in range(40, 64):
        prices[t] = -10.0
        pv[t] = pv_kw
    for t in range(74, 96):
        prices[t] = 300.0
    return make_input(
        prices,
        load=4.0,
        pv=pv,
        battery=BIG_BATTERY,
        soc0_kwh=BIG_BATTERY.capacity_kwh * 0.23,
        netzladen_erlaubt=netzladen_erlaubt,
    )


@needs_highs
def test_early_charge_places_the_fill_in_the_earliest_surplus_slots():
    # THE Pilsting vector: EEG mode, a long negative-price window with ample
    # PV, the battery must be full for the evening peak. The fill MUST sit in
    # the EARLIEST surplus slots, not (as before) at the window's end.
    window = list(range(40, 64))  # 24 slots of free/negative-price surplus
    plan = solve(_pilsting_scenario())

    charge = [max(plan.slots[t].battery_kw, 0.0) for t in window]
    charged_kwh = sum(charge) * 0.25
    assert charged_kwh > 20.0, "the battery fills from the free surplus"

    # Front-loaded: charging starts at the window's very first slot...
    assert plan.slots[window[0]].battery_kw > 1.0, (
        "charging must start at the window's first surplus slot"
    )
    # ...and the last third of the window stays idle (the fill is placed early,
    # not late - this is exactly what the old plan got wrong).
    assert all(plan.slots[t].battery_kw < 0.1 for t in window[-8:]), (
        "the late window slots must stay idle - the fill is early, not late"
    )
    # The charge's energy-weighted center of mass sits in the window's early
    # half (robust to the exact slot split).
    com = sum(t * c for t, c in zip(window, charge)) / sum(charge)
    midpoint = (window[0] + window[-1]) / 2
    assert com < midpoint, "the charge's center of mass is in the early half"


@needs_highs
def test_a_genuinely_cheaper_later_slot_still_beats_an_earlier_expensive_one():
    # The tie-break must NEVER override real economics: an early expensive
    # charge window (50 EUR/MWh) and a later CHEAPER one (20 EUR/MWh, 30 apart -
    # far beyond the ~4e-4 EUR/MWh epsilon). The merchant plan charges in the
    # LATER cheap window and leaves the earlier expensive one alone.
    prices = [50.0] * 32 + [20.0] * 32 + [300.0] * 32  # early 50 / late 20 / peak
    plan = solve(
        make_input(
            prices,
            load=1.0,
            pv=0.0,
            battery=BIG_BATTERY,
            soc0_kwh=BIG_BATTERY.soc_min_kwh,
        )
    )
    charged_early = sum(max(s.battery_kw, 0.0) for s in plan.slots[:32]) * 0.25
    charged_cheap = sum(max(s.battery_kw, 0.0) for s in plan.slots[32:64]) * 0.25
    assert charged_cheap > 10.0, "the battery fills in the cheaper later window"
    assert charged_early < 0.5, (
        "it must NOT charge in the earlier, genuinely more expensive window"
    )


@needs_highs
def test_early_charge_never_exceeds_the_produced_pv_in_eeg_mode():
    # EEG solar-only stays intact under the tie-break: with the window PV
    # (10 kW) BELOW the 15 kW charge limit the bound charge <= pv - curtail
    # binds in every charging slot, and front-loading may never pull the charge
    # beyond the PV actually produced.
    plan = solve(_pilsting_scenario(pv_kw=10.0, netzladen_erlaubt=False))
    for i, slot in enumerate(plan.slots):
        charge = max(slot.battery_kw, 0.0)
        assert charge <= max(slot.pv_kw, 0.0) - slot.curtail_kw + 1e-6, (
            f"slot {i} charges beyond the produced PV - EEG solar-only broken"
        )
    # It still charges early where PV allows (the first surplus slots).
    assert any(plan.slots[t].battery_kw > 0.1 for t in range(40, 48)), (
        "the battery charges in the early PV slots"
    )

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
) -> OptimizationInput:
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
        grid_limit_kw=grid_limit_kw,
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
    # 96 slots: dynamics + 2 gates + 2 grid caps per slot, 1 terminal condition.
    assert model.nconstraints() == 96 * 5 + 1
    # charge/discharge/binary per slot + 97 SoC nodes.
    assert model.nvariables() == 96 * 3 + 97


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
def test_small_spread_below_roundtrip_loss_stays_idle():
    # Arbitrage pays only if price ratio beats 1/eta^2 (= 1/0.92 ~ 1.087).
    # A 5% spread must not trigger cycling; a 30% spread must.
    n = 96
    small = [100.0] * (n // 2) + [105.0] * (n - n // 2)
    plan = solve(make_input(small))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)

    big = [100.0] * (n // 2) + [130.0] * (n - n // 2)
    plan = solve(make_input(big))
    assert any(s.battery_kw > 1e-3 for s in plan.slots)


@needs_highs
def test_grid_limit_is_a_hard_cap_on_import_and_export():
    # Load 5 kW, limit 6 kW: charging may add at most ~1 kW on top of the load.
    plan = solve(make_input(arbitrage_prices(), load=5.0, grid_limit_kw=6.0))
    for slot in plan.slots:
        assert abs(slot.grid_kw) <= 6.0 + 1e-6
    # The battery still cycles (within the envelope): the plan is not degenerate.
    assert any(s.battery_kw > 1e-3 for s in plan.slots)


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


@needs_highs
def test_terminal_soc_never_below_initial():
    plan = solve(make_input(arbitrage_prices(), soc0_kwh=8.0))
    assert plan.slots[-1].soc_kwh >= plan.battery.clamp_soc_kwh(8.0) - 1e-6


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

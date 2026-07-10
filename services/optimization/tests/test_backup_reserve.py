"""Customer-configurable backup-reserve SoC floor (P11, Stage 3).

``site.backup_reserve_soc_pct`` raises the plan's SoC lower bound - a HARD
constraint the dispatch never crosses, no matter how attractive a price or the
terminal value is (the Deye-Copilot scout documented that product silently
draining below its configured min-SoC; VoltPilot's floor must really hold).
NULL keeps the platform 5% technical floor byte-identical. Solver tests need
the HiGHS wheel; the floor arithmetic tests always run.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)


def make_battery(reserve_pct: float | None) -> BatteryParams:
    return BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
        backup_reserve_pct=reserve_pct,
    )


def make_input(
    prices: list[float],
    battery: BatteryParams,
    soc0_kwh: float = 9.0,
    load: float = 2.0,
) -> OptimizationInput:
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[load] * n,
        pv_kw=[0.0] * n,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=True,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


# A strong discharge temptation: cheap day, a 500 EUR/MWh evening peak.
TEMPTATION = [100.0] * 80 + [500.0] * 16


# ---- floor arithmetic (no solver needed) --------------------------------------


def test_floor_defaults_to_the_technical_minimum_without_a_reserve():
    battery = make_battery(None)
    assert battery.soc_floor_kwh(9.0) == pytest.approx(battery.soc_min_kwh)


def test_reserve_raises_the_floor_and_the_technical_minimum_wins_below_it():
    assert make_battery(40.0).soc_floor_kwh(9.0) == pytest.approx(4.0)
    # A 2% reserve sits below the 5% technical floor: the floor wins.
    assert make_battery(2.0).soc_floor_kwh(9.0) == pytest.approx(0.5)


def test_floor_relaxes_to_a_below_reserve_start_and_caps_at_soc_max():
    # Battery currently below its reserve: the plan must stay feasible and may
    # not discharge any further - the floor is the actual start.
    assert make_battery(60.0).soc_floor_kwh(2.0) == pytest.approx(2.0)
    # A 100% reserve pins the battery at the usable maximum, never infeasible.
    assert make_battery(100.0).soc_floor_kwh(9.5) == pytest.approx(9.5)


def test_reserve_percent_is_validated():
    with pytest.raises(ValueError):
        make_battery(-1.0)
    with pytest.raises(ValueError):
        make_battery(101.0)
    with pytest.raises(ValueError):
        make_battery(float("nan"))


# ---- the hard floor in the solved plan ----------------------------------------


@needs_highs
def test_plan_never_discharges_below_the_configured_reserve():
    plan = solve(make_input(TEMPTATION, make_battery(40.0)))
    for slot in plan.slots:
        assert slot.soc_kwh >= 4.0 - 1e-6
    # The floor binds (the 500 peak wants everything): the plan discharges
    # exactly down to the reserve, not the technical minimum.
    assert plan.slots[-1].soc_kwh == pytest.approx(4.0, abs=1e-3)
    discharged_kwh = -sum(min(s.battery_kw, 0.0) for s in plan.slots) * 0.25
    assert discharged_kwh > 3.0, "above the reserve the battery still works"


@needs_highs
def test_null_reserve_keeps_the_old_five_percent_behavior():
    plan = solve(make_input(TEMPTATION, make_battery(None)))
    assert plan.slots[-1].soc_kwh == pytest.approx(0.5, abs=1e-3)


@needs_highs
def test_reserve_is_a_hard_floor_while_the_terminal_value_stays_soft():
    """The interplay the redesign demands: V_end is an objective PREFERENCE
    (a better in-horizon price overrides it - the peak is sold), the reserve
    is a CONSTRAINT (no price ever crosses it). Same temptation, three
    reserves: the end SoC follows the configured floor exactly."""
    for reserve, floor in ((None, 0.5), (30.0, 3.0), (70.0, 7.0)):
        plan = solve(make_input(TEMPTATION, make_battery(reserve)))
        assert plan.slots[-1].soc_kwh == pytest.approx(floor, abs=1e-3)
        assert all(s.soc_kwh >= floor - 1e-6 for s in plan.slots)


@needs_highs
def test_below_reserve_start_stays_feasible_and_never_discharges_further():
    # Battery at 2 kWh with a 60% (6 kWh) reserve: the plan solves, never
    # goes below the start, and the cheap 100-window recovery charge toward
    # the reserve is allowed (merchant economics decide the timing).
    plan = solve(make_input(TEMPTATION, make_battery(60.0), soc0_kwh=2.0))
    assert all(s.soc_kwh >= 2.0 - 1e-6 for s in plan.slots)


@needs_highs
def test_full_reserve_pins_the_battery():
    plan = solve(make_input(TEMPTATION, make_battery(100.0), soc0_kwh=9.5))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert all(s.soc_kwh == pytest.approx(9.5, abs=1e-6) for s in plan.slots)

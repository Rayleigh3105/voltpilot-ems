"""Priced battery degradation (P2, critique finding F2).

The wear cost turns "cycle whenever the spread beats round-trip losses" into
"cycle only when the spread ALSO clears real degradation": at the platform
default of 4 ct per kWh cycled the threshold is
``eta^2 * p_discharge - p_charge > wear * 5 * (1 + eta^2)`` ~= 38.4 EUR/MWh
(eta^2 = 0.92). These tests pin that band, the per-asset override, and the
persisted per-slot wear economics. Solver tests need the HiGHS wheel.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.config import DEFAULT_WEAR_COST_CT_PER_KWH
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)


def make_battery(wear_ct: float | None = None) -> BatteryParams:
    kwargs = {} if wear_ct is None else {"wear_cost_ct_per_kwh": wear_ct}
    return BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
        **kwargs,
    )


def make_input(prices: list[float], battery: BatteryParams) -> OptimizationInput:
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[5.0] * n,
        pv_kw=[0.0] * n,
        initial_soc_kwh=5.0,
        netzladen_erlaubt=True,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


# 100 -> 130 EUR/MWh: clears round-trip losses (0.92 * 130 - 100 = 19.6 > 0)
# but NOT the default wear threshold (~38.4 EUR/MWh) - the exact spread the
# pre-P2 optimizer cycled on for sub-cent net gain.
NARROW = [100.0] * 48 + [130.0] * 48
# 100 -> 200 EUR/MWh: 0.92 * 200 - 100 = 84 clears wear comfortably.
WIDE = [100.0] * 48 + [200.0] * 48


@needs_highs
def test_narrow_spread_that_does_not_clear_wear_stays_idle():
    plan = solve(make_input(NARROW, make_battery()))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert all(s.wear_cost_eur == pytest.approx(0.0, abs=1e-9) for s in plan.slots)


@needs_highs
def test_wide_spread_still_cycles_and_earns_more_than_its_wear():
    plan = solve(make_input(WIDE, make_battery()))
    discharged_kwh = -sum(min(s.battery_kw, 0.0) for s in plan.slots) * 0.25
    assert discharged_kwh > 1.0, "a genuinely profitable spread must still cycle"
    # The grid savings must strictly exceed the wear spent - the whole point
    # of pricing degradation: no cycle whose gross margin wear would eat.
    assert plan.wear_cost_eur > 0.0
    assert plan.savings_eur > plan.wear_cost_eur


@needs_highs
def test_per_slot_wear_cost_is_persisted_economics():
    battery = make_battery()
    plan = solve(make_input(WIDE, battery))
    per_kwh_each_way = battery.wear_cost_eur_per_kwh_each_way
    assert per_kwh_each_way == pytest.approx(
        DEFAULT_WEAR_COST_CT_PER_KWH / 100.0 / 2.0
    )
    for slot in plan.slots:
        expected = per_kwh_each_way * abs(slot.battery_kw) * 0.25
        assert slot.wear_cost_eur == pytest.approx(expected, abs=1e-6)
        assert slot.wear_cost_eur >= 0.0
    active = [s for s in plan.slots if abs(s.battery_kw) > 1e-3]
    assert active and all(s.wear_cost_eur > 0.0 for s in active)


@needs_highs
def test_low_per_asset_override_cycles_where_the_default_does_not():
    # An asset with a cheap-wear override (0.5 ct/kWh -> threshold ~4.8
    # EUR/MWh) profits from the narrow spread the platform default refuses.
    plan = solve(make_input(NARROW, make_battery(wear_ct=0.5)))
    assert any(s.battery_kw > 1e-3 for s in plan.slots)


@needs_highs
def test_high_per_asset_override_freezes_a_spread_the_default_cycles():
    # 20 ct/kWh -> threshold ~192 EUR/MWh: even the wide 100->200 spread
    # (margin 84) no longer clears it.
    plan = solve(make_input(WIDE, make_battery(wear_ct=20.0)))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)


@needs_highs
def test_zero_wear_restores_the_losses_only_threshold():
    # wear = 0 (explicitly disabled): anything beating round-trip losses
    # cycles again - the pre-P2 economics as an explicit opt-out.
    plan = solve(make_input(NARROW, make_battery(wear_ct=0.0)))
    assert any(s.battery_kw > 1e-3 for s in plan.slots)
    assert all(s.wear_cost_eur == pytest.approx(0.0, abs=1e-9) for s in plan.slots)


def test_wear_cost_must_be_finite_and_non_negative():
    with pytest.raises(ValueError):
        make_battery(wear_ct=-1.0)
    with pytest.raises(ValueError):
        make_battery(wear_ct=float("nan"))

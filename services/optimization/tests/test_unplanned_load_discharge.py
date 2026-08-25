"""Economic and wire-contract proofs for corrective discharge from idle slots."""

from dataclasses import replace
from datetime import datetime, timezone
import importlib.util
from uuid import uuid4

import pytest

from voltpilot_optimization.domain import (
    BatteryParams, OptimizationInput, PlanSlot, SchedulePlan, horizon_slot_starts,
)
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.slot_trim import unplanned_load_discharge

COMMON = dict(
    import_price_ct_kwh=32.5,
    stored_value_ct_kwh=20.0,
    one_way_efficiency=0.96,
    wear_ct_per_kwh_each_way=2.0,
)
needs_highs = pytest.mark.skipif(importlib.util.find_spec("highspy") is None, reason="HiGHS unavailable")


def make_plan(slots: int = 1) -> SchedulePlan:
    battery = BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5)
    start = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
    return SchedulePlan(
        plan_id=uuid4(), tenant_id=uuid4(), site_id=uuid4(), device_id=uuid4(),
        generated_at=start, battery=battery,
        slots=[PlanSlot(start=start, battery_kw=0, grid_kw=1, soc_kwh=5,
                        load_kw=3, pv_kw=0, price_eur_mwh=100,
                        cost_eur=0, baseline_cost_eur=0) for _ in range(slots)],
    )


def test_idle_authority_is_distinct_economic_and_never_reinterprets_a_trade():
    assert unplanned_load_discharge(
        battery_kw=0.0,
        grid_kw=3.0,
        charge_surplus_to_battery=False,
        **COMMON,
    )
    for battery_kw in (-2.0, 2.0):
        assert not unplanned_load_discharge(
            battery_kw=battery_kw,
            grid_kw=3.0,
            charge_surplus_to_battery=False,
            **COMMON,
        )
    assert not unplanned_load_discharge(
        battery_kw=0.0,
        grid_kw=-2.0,  # planned sale
        charge_surplus_to_battery=False,
        **COMMON,
    )
    assert not unplanned_load_discharge(
        battery_kw=0.0,
        grid_kw=3.0,
        charge_surplus_to_battery=True,  # opposite local authority
        **COMMON,
    )


def test_future_value_or_reserve_can_honestly_hold_the_battery():
    # Lambda already contains future prices and later recharge opportunities.
    assert not unplanned_load_discharge(
        battery_kw=0.0,
        grid_kw=20.0,
        charge_surplus_to_battery=False,
        import_price_ct_kwh=20.0,
        stored_value_ct_kwh=40.0,
        one_way_efficiency=0.96,
        wear_ct_per_kwh_each_way=2.0,
    )
    battery = BatteryParams(
        capacity_kwh=20,
        max_charge_kw=10,
        max_discharge_kw=10,
        soc_min_fraction=0.1,
        backup_reserve_pct=25,
        peak_reserve_pct=35,
    )
    assert battery.effective_floor_soc_pct == 35


def test_wire_flag_and_full_floor_are_additive_and_omitted_safely():
    base = make_plan(slots=1)
    payload = build_schedule_payload(base)
    assert payload["effective_floor_soc_pct"] == base.battery.effective_floor_soc_pct
    assert "unplanned_load_discharge" not in payload["slots"][0]
    slot = replace(
        base.slots[0],
        battery_kw=0.0,
        cover_load_from_battery=False,
        unplanned_load_discharge=True,
    )
    payload = build_schedule_payload(replace(base, slots=[slot]))
    assert payload["slots"][0]["unplanned_load_discharge"] is True
    assert "cover_load_from_battery" not in payload["slots"][0]


def solved(import_prices: list[float], *, initial_soc: float):
    from voltpilot_optimization.solver import optimize

    start = datetime(2026, 8, 25, tzinfo=timezone.utc)
    battery = BatteryParams(20, 10, 10, .92)
    inp = OptimizationInput(
        tenant_id=uuid4(), site_id=uuid4(), device_id=uuid4(), battery=battery,
        slot_starts=horizon_slot_starts(start, 4), prices_eur_mwh=[0] * 4,
        load_kw=[0, 0, 0, 5], pv_kw=[0] * 4, initial_soc_kwh=initial_soc,
        netzladen_erlaubt=True, max_feed_in_kw=.01,
        import_price_eur_mwh=import_prices, export_value_eur_mwh=[200] * 4,
    )
    return optimize(inp, plan_id=uuid4(), generated_at=start)


@needs_highs
def test_later_cheap_recharge_changes_the_full_marginal_idle_decision():
    cheap_recharge = solved([500, 10, 10, 800], initial_soc=2)
    no_cheap_recharge = solved([500, 500, 500, 800], initial_soc=2)
    assert cheap_recharge.slots[0].unplanned_load_discharge is True
    assert no_cheap_recharge.slots[0].unplanned_load_discharge is False


@needs_highs
def test_a_more_valuable_future_hour_keeps_the_idle_slot_unauthorized():
    plan = solved([50, 1000, 1000, 1200], initial_soc=7)
    first = plan.slots[0]
    assert abs(first.battery_kw) <= .05
    assert first.unplanned_load_discharge is False

"""Solver-Laufzeitbudget mit Verbrauchern (§22 Abnahme 17): p95 < 5 s pro
Standort, GEMESSEN über ein repräsentatives Worst-Case-Szenario - nicht
behauptet.

The scenario deliberately stacks every expensive feature at once: a full
96-slot day, storage + producer, THREE consumers (a D4 power-ranges wallbox,
an on_off must-run heater whose grid policy triggers the allocation matrix +
stage 2, and a storage_first flexible pump), unit-commitment constraints and
a binding §14a grid limit - so all three lexicographic stages solve and the
matrix is built. The measured numbers travel in the test output (`-s` shows
them); the assertion is the budget.

Measured on the dev machine (Apple Silicon, HiGHS via highspy, 2026-08-09):
p50 = 0.77 s, p95 = 0.80 s per site (max 0.81 s over 8 solves) - a factor 6
inside the budget, three lexicographic stages + allocation matrix included.
CI runners are slower but not 6x slower; if this ever flakes there, the
budget conversation belongs to the captain, not to a silent tolerance bump.
"""

from __future__ import annotations

import importlib.util
import time
from datetime import datetime, timezone
from uuid import uuid4

import pytest

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="highspy not installed (install the [solver] extra)",
)

from voltpilot_optimization.co_solver import co_optimize  # noqa: E402
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts  # noqa: E402
from voltpilot_optimization.entities import (  # noqa: E402
    ControllableLoadEntity,
    CoOptimizationInput,
    LoadRequirement,
    ProducerEntity,
    StorageEntity,
)

T0 = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
RUNS = 8
BUDGET_P95_SECONDS = 5.0


def representative_input() -> CoOptimizationInput:
    n = 96
    prices = [80.0 + 60.0 * ((t % 32) / 31.0) for t in range(n)]
    gen = [0.0] * n
    for t in range(28, 68):
        gen[t] = 8.0
    base = [1.2] * n
    for t in range(70, 96):
        base[t] = 3.5
    storage = StorageEntity(
        entity_id="storage-main",
        params=BatteryParams(
            capacity_kwh=12.0,
            max_charge_kw=6.0,
            max_discharge_kw=6.0,
            roundtrip_efficiency=0.92,
            wear_cost_ct_per_kwh=4.0,
        ),
        initial_soc_kwh=4.0,
        charge_from_grid_allowed=True,
    )
    wallbox = ControllableLoadEntity(
        entity_id="wallbox-1",
        max_power_kw=11.0,
        control_kind="continuous",
        power_ranges_kw=((1.4, 3.7), (4.2, 11.0)),
        min_on_slots=2,
        max_starts_per_horizon=4,
        requirements=(
            LoadRequirement(
                requirement_id="charge",
                kind="flexible_task",
                window_slots=tuple(range(0, 60)),
                required_kwh=14.0,
                enforcement="required_by_deadline",
            ),
        ),
    )
    heater = ControllableLoadEntity(
        entity_id="heater-1",
        max_power_kw=3.0,
        control_kind="on_off",
        requirements=(
            LoadRequirement(
                requirement_id="noon",
                kind="fixed_window",
                window_slots=tuple(range(52, 56)),
                target_kw=3.0,
                enforcement="must_run",
                grid_energy_policy="allow",
            ),
            LoadRequirement(
                requirement_id="daily-heat",
                kind="flexible_task",
                window_slots=tuple(range(0, 96)),
                required_minutes=120,
                grid_energy_policy="avoid",  # stage 2 + matrix active
            ),
        ),
    )
    pump = ControllableLoadEntity(
        entity_id="pump-1",
        max_power_kw=2.2,
        control_kind="on_off",
        storage_relation="storage_first",  # matrix preference active
        min_on_slots=4,
        requirements=(
            LoadRequirement(
                requirement_id="daily-pump",
                kind="flexible_task",
                window_slots=tuple(range(0, 96)),
                required_minutes=60,
                contiguous=True,
            ),
        ),
    )
    return CoOptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        base_load_kw=base,
        storages=(storage,),
        producers=(ProducerEntity("pv-main", gen),),
        controllable_loads=(wallbox, heater, pump),
        grid_limit_kw=18.0,
        terminal_value_eur_per_kwh=0.0,
    )


def test_consumer_dispatch_p95_stays_inside_the_5s_budget():
    inp = representative_input()
    durations: list[float] = []
    for _ in range(RUNS):
        started = time.perf_counter()
        plan = co_optimize(inp, plan_id=uuid4(), generated_at=T0)
        durations.append(time.perf_counter() - started)
        assert plan.loads  # the solve really dispatched consumers
    durations.sort()
    p95 = durations[max(0, int(len(durations) * 0.95) - 1)]
    p50 = durations[len(durations) // 2]
    print(
        f"\nconsumer-dispatch runtime over {RUNS} solves: "
        f"p50={p50:.3f}s p95={p95:.3f}s max={durations[-1]:.3f}s"
    )
    assert p95 < BUDGET_P95_SECONDS, (
        f"p95 {p95:.3f}s exceeds the §22 budget of {BUDGET_P95_SECONDS}s"
    )

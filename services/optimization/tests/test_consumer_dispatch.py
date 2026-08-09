"""Controllable-consumer dispatch in the co-optimizer (Verbrauchssteuerung
Inkrement 2, §12/§21).

Behavioral MILP tests (skip without highspy, like test_solver.py): control
kinds incl. the D4 non-convex power ranges, must-run windows (grid allowed,
E2), cloud-compiled price windows, contiguous vs splittable flexible tasks
(E5), the D5 earliness tie-break, the conditional allocation matrix (exact
row/column sums, storage-discharge ban, matrix-not-built proof), the D2 stage
lexicography (colliding must-runs by service_rank/deadline/stable id, the
grid-avoid stage), the consumer_first/storage_first divergence (§22 Abnahme
5), honest slack under a binding §14a limit, and determinism.

The empty-consumer byte-equality (§22 Abnahme 16) is pinned by the golden
suite (tests/test_golden_cooptimizer.py) - every scenario there runs the
co-optimizer with an empty list against the v1 solver.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="highspy not installed (install the [solver] extra)",
)

from pyomo.environ import value  # noqa: E402

from voltpilot_optimization.co_solver import (  # noqa: E402
    _lexicographic_solve,
    build_co_model,
    co_optimize,
)
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts  # noqa: E402
from voltpilot_optimization.entities import (  # noqa: E402
    ControllableLoadEntity,
    CoOptimizationInput,
    LoadRequirement,
    ProducerEntity,
    REASON_FIXED_WINDOW,
    REASON_GRID_LIMIT,
    REASON_NO_PERMITTED_ENERGY,
    REASON_OPTIMIZER,
    REASON_PRICE_WINDOW,
    StorageEntity,
)

T0 = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)


def storage(
    entity_id: str = "batt-1",
    capacity: float = 10.0,
    power: float = 5.0,
    soc0: float = 0.5,
    grid_charge: bool = True,
    roundtrip: float = 1.0,
    wear_ct: float = 0.0,
) -> StorageEntity:
    return StorageEntity(
        entity_id=entity_id,
        params=BatteryParams(
            capacity_kwh=capacity,
            max_charge_kw=power,
            max_discharge_kw=power,
            roundtrip_efficiency=roundtrip,
            wear_cost_ct_per_kwh=wear_ct,
        ),
        initial_soc_kwh=soc0,
        charge_from_grid_allowed=grid_charge,
    )


def onoff(
    entity_id: str = "heater-1",
    rated: float = 3.0,
    requirements: tuple[LoadRequirement, ...] = (),
    **kwargs,
) -> ControllableLoadEntity:
    return ControllableLoadEntity(
        entity_id=entity_id,
        max_power_kw=rated,
        control_kind="on_off",
        requirements=requirements,
        **kwargs,
    )


def fixed(rid: str, window, target: float, **kwargs) -> LoadRequirement:
    return LoadRequirement(
        requirement_id=rid,
        kind="fixed_window",
        window_slots=tuple(window),
        target_kw=target,
        enforcement="must_run",
        grid_energy_policy="allow",
        reason_code=kwargs.pop("reason_code", REASON_FIXED_WINDOW),
        **kwargs,
    )


def flexible(rid: str, window, **kwargs) -> LoadRequirement:
    return LoadRequirement(
        requirement_id=rid,
        kind="flexible_task",
        window_slots=tuple(window),
        enforcement="required_by_deadline",
        reason_code=REASON_OPTIMIZER,
        **kwargs,
    )


def make_input(
    prices,
    loads,
    storages=None,
    producers=(),
    base_load=1.0,
    **kwargs,
) -> CoOptimizationInput:
    n = len(prices)
    storages = (storage(),) if storages is None else storages
    return CoOptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        base_load_kw=(
            [base_load] * n if isinstance(base_load, (int, float)) else base_load
        ),
        storages=storages,
        producers=producers,
        controllable_loads=tuple(loads),
        terminal_value_eur_per_kwh=kwargs.pop("terminal_value_eur_per_kwh", 0.0),
        **kwargs,
    )


def solve(inp: CoOptimizationInput):
    return co_optimize(inp, plan_id=uuid4(), generated_at=T0)


def on_indices(plan, load_index: int = 0) -> list[int]:
    return [i for i, s in enumerate(plan.loads[load_index].slots) if s.on]


# ---------------------------------------------------------------------------
# Control kinds (§12.2)
# ---------------------------------------------------------------------------


def test_onoff_must_run_window_runs_at_rated_and_uses_grid():
    """E2: a Pflichtlauf may use grid power - no PV, an empty battery, flat
    expensive prices, and the heater still runs in its window."""
    n = 24
    window = range(8, 12)
    inp = make_input(
        [300.0] * n,
        [onoff(requirements=(fixed("noon", window, 3.0),))],
    )
    plan = solve(inp)
    assert on_indices(plan) == list(window)
    dispatch = plan.loads[0]
    assert all(
        s.power_kw == pytest.approx(3.0) for s in dispatch.slots if s.on
    )
    assert {s.reason_code for s in dispatch.slots if s.on} == {REASON_FIXED_WINDOW}
    assert {s.requirement_id for s in dispatch.slots if s.on} == {"noon"}
    assert dispatch.unserved == ()
    # The consumer's energy rides the grid balance: base 1 kW + heater 3 kW.
    for t in window:
        assert plan.site_slots[t].grid_kw == pytest.approx(4.0, abs=1e-3)


def test_stepped_consumer_picks_a_level_at_or_above_the_target():
    n = 16
    load = ControllableLoadEntity(
        entity_id="stufen-1",
        max_power_kw=4.5,
        control_kind="stepped",
        levels_kw=(0.0, 1.5, 3.0, 4.5),
        requirements=(fixed("win", range(4, 8), 2.0),),
    )
    plan = solve(make_input([100.0] * n, [load]))
    for i in range(4, 8):
        # 2.0 kW is not a level: the cheapest level >= target is 3.0.
        assert plan.loads[0].slots[i].power_kw == pytest.approx(3.0)
    assert all(
        s.power_kw == 0.0 for i, s in enumerate(plan.loads[0].slots)
        if i not in range(4, 8)
    )


def test_continuous_consumer_serves_energy_in_the_cheapest_slots():
    n = 16
    prices = [100.0] * n
    for cheap in (5, 6):
        prices[cheap] = 10.0
    load = ControllableLoadEntity(
        entity_id="cont-1",
        max_power_kw=10.0,
        control_kind="continuous",
        min_power_kw=1.0,
        requirements=(flexible("task", range(0, 16), required_kwh=5.0),),
    )
    plan = solve(make_input(prices, [load]))
    served = {i: s.power_kw for i, s in enumerate(plan.loads[0].slots) if s.on}
    # 5 kWh at 10 kW max = 2 slots of 15 min: exactly the two cheap slots.
    assert set(served) == {5, 6}
    assert sum(served.values()) * 0.25 == pytest.approx(5.0, abs=1e-3)


def test_power_ranges_never_operate_in_the_forbidden_gap():
    """D4: 1-/3-phase charging - power sits inside one of the disjoint
    ranges, never in the (3.7, 4.2) gap, and the demand decides the range."""
    n = 16
    ranges = ((1.4, 3.7), (4.2, 11.0))

    def wallbox(kwh: float) -> ControllableLoadEntity:
        return ControllableLoadEntity(
            entity_id="wb-1",
            max_power_kw=11.0,
            control_kind="continuous",
            power_ranges_kw=ranges,
            requirements=(flexible("charge", range(4, 8), required_kwh=kwh),),
        )

    # 9 kWh within 4 slots (1 h) needs 9 kW average -> range 2 MUST engage
    # (4 x 3.7 kW = 3.7 kWh is all range 1 could deliver); individual slots
    # may still hop back into range 1, but never into the gap.
    plan_high = solve(make_input([100.0] * n, [wallbox(9.0)]))
    highs = [s.power_kw for s in plan_high.loads[0].slots if s.on]
    assert highs and max(highs) >= 4.2 - 1e-6
    for p in highs:
        assert (1.4 - 1e-6 <= p <= 3.7 + 1e-6) or (4.2 - 1e-6 <= p <= 11.0 + 1e-6)
    # 1.5 kWh is servable inside range 1 - and never in the gap.
    plan_low = solve(make_input([100.0] * n, [wallbox(1.5)]))
    lows = [s.power_kw for s in plan_low.loads[0].slots if s.on]
    assert lows
    for p in lows:
        assert (1.4 - 1e-6 <= p <= 3.7 + 1e-6) or (4.2 - 1e-6 <= p <= 11.0 + 1e-6)
        assert not (3.7 + 1e-6 < p < 4.2 - 1e-6)


# ---------------------------------------------------------------------------
# Windows: Pflichtlauf + compiled price window (D1)
# ---------------------------------------------------------------------------


def test_compiled_price_window_activates_deterministically():
    n = 24
    prices = [100.0] * n
    for t in (3, 4, 11):
        prices[t] = 30.0
    window = tuple(t for t, p in enumerate(prices) if p < 50.0)
    inp = make_input(
        prices,
        [onoff(requirements=(
            fixed("cheap", window, 3.0, reason_code=REASON_PRICE_WINDOW),
        ))],
    )
    plan = solve(inp)
    assert on_indices(plan) == [3, 4, 11]
    assert {s.reason_code for s in plan.loads[0].slots if s.on} == {
        REASON_PRICE_WINDOW
    }


# ---------------------------------------------------------------------------
# Flexible tasks: contiguous vs splittable (E5) + earliness (D5)
# ---------------------------------------------------------------------------


def cheap_two_islands_prices(n: int = 32) -> list[float]:
    prices = [100.0] * n
    prices[10] = prices[11] = 10.0  # island 1 (30 min)
    prices[24] = prices[25] = 10.0  # island 2 (30 min)
    return prices


def test_contiguous_task_takes_one_block_splittable_takes_the_cheap_islands():
    prices = cheap_two_islands_prices()
    window = range(0, 32)

    def pump(contiguous: bool) -> ControllableLoadEntity:
        return onoff(
            "pump-1",
            rated=2.2,
            requirements=(
                flexible(
                    "daily", window, required_minutes=60, contiguous=contiguous
                ),
            ),
        )

    split_plan = solve(make_input(prices, [pump(False)]))
    split_on = on_indices(split_plan)
    assert len(split_on) == 4
    # Splittable: both cheap islands are used (the user's choice is honored).
    assert set(split_on) >= {10, 11, 24, 25}

    contig_plan = solve(make_input(prices, [pump(True)]))
    contig_on = on_indices(contig_plan)
    assert len(contig_on) == 4
    # Contiguous: ONE block - consecutive indices (around a cheap island).
    assert contig_on == list(range(contig_on[0], contig_on[0] + 4))
    assert sum(1 for s in contig_plan.loads[0].slots if s.on) == 4


def test_earliness_places_a_cost_equal_task_early_and_a_real_price_beats_it():
    n = 32
    window = range(0, n)
    pump = onoff(
        "pump-1", rated=2.2,
        requirements=(flexible("daily", window, required_minutes=60),),
    )
    # Flat prices: every placement is cost-equal -> D5 earliness wins.
    early_plan = solve(make_input([100.0] * n, [pump]))
    assert on_indices(early_plan) == [0, 1, 2, 3]
    # A REAL price advantage late in the horizon overrules the tie-break.
    prices = [100.0] * n
    for t in (20, 21, 22, 23):
        prices[t] = 40.0
    late_plan = solve(make_input(prices, [pump]))
    assert on_indices(late_plan) == [20, 21, 22, 23]


# ---------------------------------------------------------------------------
# Unit commitment
# ---------------------------------------------------------------------------


def test_min_on_and_max_starts_shape_the_runs():
    n = 32
    prices = cheap_two_islands_prices()
    pump = onoff(
        "pump-1",
        rated=2.2,
        min_on_slots=4,  # 60 min minimum run
        max_starts_per_horizon=1,
        requirements=(flexible("daily", range(0, n), required_minutes=60),),
    )
    plan = solve(make_input(prices, [pump]))
    on = on_indices(plan)
    # One start, at least 4 consecutive slots.
    assert on == list(range(on[0], on[0] + len(on)))
    assert len(on) >= 4


# ---------------------------------------------------------------------------
# Allocation matrix (§6/D2)
# ---------------------------------------------------------------------------


def matrix_input(allow_discharge: bool, relation: str = "consumer_first"):
    n = 16
    load = onoff(
        "heater-1",
        rated=3.0,
        allow_storage_discharge=allow_discharge,
        storage_relation=relation,
        requirements=(fixed("win", range(4, 8), 3.0),),
    )
    return make_input(
        [100.0] * n,
        [load],
        storages=(storage(soc0=9.5, capacity=10.0),),
        base_load=[2.0] * n,
    )


def test_allocation_matrix_is_not_built_without_restriction_or_preference():
    inp = matrix_input(allow_discharge=True, relation="consumer_first")
    model = build_co_model(inp)
    assert not hasattr(model, "alloc")
    # ... and the restricted twin builds it.
    restricted = build_co_model(matrix_input(allow_discharge=False))
    assert hasattr(restricted, "alloc")


def test_allocation_sums_are_exact_and_a_banned_consumer_gets_no_storage_energy():
    inp = matrix_input(allow_discharge=False)
    model = build_co_model(inp)
    _lexicographic_solve(model)
    n = inp.slots
    sources = ["grid", "pv", "storage"]
    sources = [s for s in sources if (s, "base", 0) in model.alloc]
    sinks = sorted({k for (_s, k, _t) in model.alloc})
    for t in range(n):
        # Row sums == physical source totals (no kWh invented or lost).
        grid_row = sum(float(value(model.alloc["grid", k, t])) for k in sinks)
        assert grid_row == pytest.approx(
            float(value(model.grid_import[t])), abs=1e-5
        )
        storage_row = sum(
            float(value(model.alloc["storage", k, t])) for k in sinks
        )
        assert storage_row == pytest.approx(
            float(value(model.discharge[0, t])), abs=1e-5
        )
        # Column sums == physical sink totals.
        load_col = sum(
            float(value(model.alloc[s, "load0", t])) for s in sources
        )
        assert load_col == pytest.approx(
            float(value(model.load_power[0, t])), abs=1e-5
        )
        # The ban: not one storage kWh is assigned to this consumer.
        assert float(value(model.alloc["storage", "load0", t])) == pytest.approx(
            0.0, abs=1e-6
        )


def test_grid_forbid_without_local_energy_yields_honest_slack():
    """A flexible task that may not import and has no PV/storage energy stays
    UNSERVED - the model remains solvable and names the cause."""
    n = 16
    load = onoff(
        "pump-1",
        rated=2.2,
        allow_storage_discharge=False,
        requirements=(
            flexible(
                "daily",
                range(0, n),
                required_minutes=60,
                grid_energy_policy="forbid",
            ),
        ),
    )
    inp = make_input([100.0] * n, [load], storages=(storage(soc0=9.5),))
    plan = solve(inp)
    assert on_indices(plan) == []
    assert len(plan.loads[0].unserved) == 1
    shortfall = plan.loads[0].unserved[0]
    assert shortfall.requirement_id == "daily"
    assert shortfall.shortfall == pytest.approx(60.0)
    assert shortfall.unit == "minutes"
    assert shortfall.reason_code == REASON_NO_PERMITTED_ENERGY


def test_grid_avoid_moves_the_task_onto_pv_surplus_before_economics():
    """Stage 2 (D2): with flat prices the earliness tie-break would run the
    pump at slot 0 on grid power - the avoid stage overrules it and places
    the run into the PV surplus, because stages beat epsilons."""
    n = 32
    surplus = list(range(20, 26))
    gen = [0.0] * n
    for t in surplus:
        gen[t] = 3.2  # base 1.0 -> 2.2 kW surplus, exactly the pump
    pump = onoff(
        "pump-1",
        rated=2.2,
        requirements=(
            flexible(
                "daily",
                range(0, n),
                required_minutes=60,
                grid_energy_policy="avoid",
            ),
        ),
    )
    inp = make_input(
        [100.0] * n,
        [pump],
        producers=(ProducerEntity("pv-main", gen),),
        export_value_eur_mwh=[0.0] * n,
        import_price_eur_mwh=[100.0] * n,
    )
    plan = solve(inp)
    assert set(on_indices(plan)) <= set(surplus)
    assert len(on_indices(plan)) == 4


# ---------------------------------------------------------------------------
# consumer_first vs storage_first (§22 Abnahme 5, D6)
# ---------------------------------------------------------------------------


def preference_input(relation: str) -> CoOptimizationInput:
    """A true indifference: eff 1.0, wear 0, flat 30 ct import, worthless
    export. 5 kWh of PV surplus either feeds the consumer's 4-kWh task (the
    task then costs nothing, the battery banks 1 kWh) or charges the battery
    (5 kWh offsets the evening load, the task buys 4 kWh of grid) - the total
    cost is IDENTICAL, only the preference decides."""
    n = 40
    gen = [0.0] * n
    for t in range(8, 18):
        gen[t] = 3.0  # base 1.0 -> 2.0 kW surplus x 10 slots = 5 kWh
    base = [1.0] * n
    for t in range(24, 40):
        base[t] = 4.0  # evening: plenty of load for every banked kWh
    task = onoff(
        "task-1",
        rated=2.0,
        storage_relation=relation,
        allow_storage_discharge=False,
        requirements=(flexible("daily", range(0, 24), required_minutes=120),),
    )
    return make_input(
        [300.0] * n,
        [task],
        storages=(storage(soc0=0.5, capacity=10.0, roundtrip=1.0, wear_ct=0.0),),
        producers=(ProducerEntity("pv-main", gen),),
        base_load=base,
        import_price_eur_mwh=[300.0] * n,
        export_value_eur_mwh=[0.0] * n,
    )


def test_consumer_first_and_storage_first_produce_the_expected_divergent_plans():
    surplus = set(range(8, 18))
    # consumer_first: the task absorbs the surplus, the battery banks the rest.
    cf_plan = solve(preference_input("consumer_first"))
    cf_on = set(on_indices(cf_plan))
    assert cf_on <= surplus
    cf_charge = sum(
        max(s.setpoint_kw, 0.0) for s in cf_plan.storages[0].slots
    ) * 0.25
    assert cf_charge == pytest.approx(1.0, abs=0.1)

    # storage_first: the battery absorbs the surplus, the task runs early on
    # permitted grid power (D5 earliness picks the first cost-equal slots).
    sf_plan = solve(preference_input("storage_first"))
    sf_on = set(on_indices(sf_plan))
    assert sf_on.isdisjoint(surplus)
    assert sf_on == set(range(0, 8))
    sf_charge = sum(
        max(s.setpoint_kw, 0.0) for s in sf_plan.storages[0].slots
    ) * 0.25
    assert sf_charge == pytest.approx(5.0, abs=0.1)
    # Both plans fully serve the task - the preference never drops service.
    assert cf_plan.loads[0].unserved == ()
    assert sf_plan.loads[0].unserved == ()
    assert len(cf_on) == len(sf_on) == 8


# ---------------------------------------------------------------------------
# Colliding mandatory consumers (E9) + §14a slack honesty
# ---------------------------------------------------------------------------


def collision_input(rank_a=None, rank_b=None, window_b=None):
    n = 16
    window = tuple(range(4, 8))
    a = onoff(
        "cons-a",
        rated=3.0,
        requirements=(fixed("req-a", window, 3.0, service_rank=rank_a),),
    )
    b = onoff(
        "cons-b",
        rated=3.0,
        requirements=(
            fixed("req-b", window_b or window, 3.0, service_rank=rank_b),
        ),
    )
    return make_input(
        [100.0] * n,
        [a, b],
        storages=(storage(soc0=0.5, grid_charge=False),),
        base_load=[0.5] * n,
        grid_limit_kw=4.0,  # 3.5 kW headroom: exactly ONE 3-kW consumer fits
    )


def test_colliding_must_runs_follow_service_rank():
    plan = solve(collision_input(rank_a=1, rank_b=2))
    assert on_indices(plan, 0) == [4, 5, 6, 7]
    assert on_indices(plan, 1) == []
    assert plan.loads[1].unserved[0].reason_code == REASON_GRID_LIMIT

    flipped = solve(collision_input(rank_a=2, rank_b=1))
    assert on_indices(flipped, 0) == []
    assert on_indices(flipped, 1) == [4, 5, 6, 7]


def test_without_ranks_the_earlier_deadline_wins():
    # B's window ends earlier -> B is less deferrable -> B wins.
    plan = solve(collision_input(window_b=tuple(range(4, 7))))
    assert on_indices(plan, 1) == [4, 5, 6]
    # A runs only where B's window has ended.
    assert on_indices(plan, 0) == [7]


def test_without_ranks_and_equal_deadlines_the_stable_id_decides():
    plan = solve(collision_input())
    # req-a < req-b lexicographically -> A is served, deterministically.
    assert on_indices(plan, 0) == [4, 5, 6, 7]
    assert on_indices(plan, 1) == []


def test_both_consumers_fit_without_a_binding_limit():
    inp = collision_input()
    inp = CoOptimizationInput(
        **{**inp.__dict__, "grid_limit_kw": 20.0}
    )
    plan = solve(inp)
    assert on_indices(plan, 0) == [4, 5, 6, 7]
    assert on_indices(plan, 1) == [4, 5, 6, 7]
    assert plan.loads[0].unserved == () and plan.loads[1].unserved == ()


def test_a_binding_grid_limit_keeps_the_model_solvable_with_honest_slack():
    """§17: the Pflichtlauf is clamped by the Netzlimit - the plan stays
    solvable, the shortfall is explicit and names the grid limit."""
    n = 8
    load = onoff(requirements=(fixed("noon", range(2, 6), 3.0),))
    inp = make_input(
        [100.0] * n,
        [load],
        storages=(storage(soc0=0.5, grid_charge=False),),
        base_load=[1.0] * n,
        grid_limit_kw=2.5,  # 1.5 kW headroom < 3 kW target, every slot short
    )
    plan = solve(inp)
    dispatch = plan.loads[0]
    assert len(dispatch.unserved) == 1
    assert dispatch.unserved[0].reason_code == REASON_GRID_LIMIT
    assert dispatch.unserved[0].unit == "kw_slots"
    assert dispatch.unserved[0].shortfall > 0
    # The §14a cap held: never more import than allowed.
    for slot in plan.site_slots:
        assert slot.grid_kw <= 2.5 + 1e-6


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_cost_equal_slots_solve_deterministically():
    inp = preference_input("storage_first")
    a = solve(inp)
    b = solve(inp)
    assert [s.power_kw for s in a.loads[0].slots] == [
        s.power_kw for s in b.loads[0].slots
    ]
    assert [s.setpoint_kw for s in a.storages[0].slots] == [
        s.setpoint_kw for s in b.storages[0].slots
    ]


# ---------------------------------------------------------------------------
# Structural: an empty consumer list adds NOTHING to the model
# ---------------------------------------------------------------------------


def test_empty_consumer_list_builds_no_consumer_components():
    inp = make_input([100.0] * 8, [])
    model = build_co_model(inp)
    for name in ("load_power", "load_on", "load_start", "load_stop", "alloc"):
        assert not hasattr(model, name)
    assert getattr(model, "_vp_stage1_expr", None) is None
    assert getattr(model, "_vp_stage2_expr", None) is None

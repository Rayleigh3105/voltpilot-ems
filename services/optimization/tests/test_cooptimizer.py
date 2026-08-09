"""Behavioral tests for the multi-entity co-optimizer BEYOND the N=1 case
(the golden suite covers N=1 equivalence; this file covers what N=1 cannot:
several storages, several producers, per-entity permissions, the DV-konform
mode, and the input-shape guarantees)."""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.entities import (
    ControllableLoadEntity,
    CoOptimizationInput,
    ProducerEntity,
    StorageEntity,
    from_v1_input,
)
from voltpilot_optimization.modules import select_modules

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)


def storage(
    entity_id: str = "batt-1",
    capacity: float = 10.0,
    power: float = 5.0,
    soc0: float = 5.0,
    grid_charge: bool = True,
    roundtrip: float = 0.92,
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


def make_input(
    prices: list[float],
    storages: tuple[StorageEntity, ...],
    producers: tuple[ProducerEntity, ...] = (),
    load: float | list[float] = 5.0,
    dv_konform: bool = False,
    **kwargs,
) -> CoOptimizationInput:
    n = len(prices)
    return CoOptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        base_load_kw=[load] * n if isinstance(load, (int, float)) else load,
        storages=storages,
        producers=producers,
        dv_konform=dv_konform,
        **kwargs,
    )


def solve(inp: CoOptimizationInput):
    from voltpilot_optimization.co_solver import co_optimize

    return co_optimize(inp, plan_id=uuid4(), generated_at=T0)


def spread_prices(n: int = 48) -> list[float]:
    """Cheap first half, expensive second half."""
    return [20.0] * (n // 2) + [250.0] * (n - n // 2)


# ---------------------------------------------------------------------------
# Multi-storage dispatch
# ---------------------------------------------------------------------------


@needs_highs
def test_two_storages_both_arbitrage_the_spread():
    prices = spread_prices()
    inp = make_input(
        prices,
        storages=(
            storage("batt-a", capacity=10, power=5, soc0=0.5),
            storage("batt-b", capacity=8, power=4, soc0=0.4),
        ),
        load=2.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    assert {d.entity_id for d in plan.storages} == {"batt-a", "batt-b"}
    for dispatch in plan.storages:
        charged = sum(max(s.setpoint_kw, 0) for s in dispatch.slots) * 0.25
        discharged = sum(max(-s.setpoint_kw, 0) for s in dispatch.slots) * 0.25
        assert charged > 1.0, f"{dispatch.entity_id} should charge cheap"
        assert discharged > 1.0, f"{dispatch.entity_id} should discharge expensive"
    assert plan.savings_eur > 0


@needs_highs
def test_the_more_efficient_storage_cycles_preferentially():
    # A spread that clears the good battery's losses but not the bad one's:
    # eta^2 * 200 - 100 > 0 for rt 0.95 (0.95*200=190 > 100), while rt 0.25
    # loses money (0.25*200=50 < 100).
    prices = [100.0] * 24 + [200.0] * 24
    inp = make_input(
        prices,
        storages=(
            storage("efficient", capacity=10, power=5, soc0=0.5, roundtrip=0.95),
            storage("lossy", capacity=10, power=5, soc0=0.5, roundtrip=0.25),
        ),
        load=3.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    throughput = {
        d.entity_id: sum(abs(s.setpoint_kw) for s in d.slots) * 0.25
        for d in plan.storages
    }
    assert throughput["efficient"] > 2.0
    assert throughput["lossy"] == pytest.approx(0.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Multi-producer curtailment
# ---------------------------------------------------------------------------


@needs_highs
def test_curtailment_lands_on_the_curtailable_producer_only():
    # Feeding in COSTS money (negative export value all day); the site must
    # curtail - but only the curtailable producer may, and each producer's
    # curtailment is bounded by its own generation.
    n = 48
    prices = [-80.0] * n
    inp = make_input(
        prices,
        storages=(storage(soc0=9.5),),  # full battery: nothing to absorb
        producers=(
            ProducerEntity("pv-fixed", [4.0] * n, curtailable=False),
            ProducerEntity("pv-flex", [6.0] * n, curtailable=True),
        ),
        load=1.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    by_id = {p.entity_id: p for p in plan.producers}
    assert not by_id["pv-fixed"].curtails
    assert by_id["pv-flex"].curtails
    for slot in by_id["pv-flex"].slots:
        assert 0.0 <= slot.curtail_kw <= slot.generation_kw + 1e-9
    # The must-run producer's 4 kW minus 1 kW load still exports at a loss -
    # the flex producer curtails fully (its export would only add loss).
    total_curtailed = sum(s.curtail_kw for s in by_id["pv-flex"].slots)
    assert total_curtailed == pytest.approx(6.0 * n, rel=1e-3)


# ---------------------------------------------------------------------------
# Per-entity grid-charge permission + DV-konform mode
# ---------------------------------------------------------------------------


def eeg_mixed_input(dv_konform: bool = False) -> CoOptimizationInput:
    """Cheap-night spread with NO PV at night: a merchant battery may grid-
    charge, an EEG battery must not."""
    n = 48
    prices = spread_prices(n)
    return make_input(
        prices,
        storages=(
            storage("merchant", soc0=0.5, grid_charge=True),
            storage("eeg", soc0=0.5, grid_charge=False),
        ),
        producers=(ProducerEntity("pv", [0.0] * n),),
        load=2.0,
        dv_konform=dv_konform,
        terminal_value_eur_per_kwh=0.0,
    )


@needs_highs
def test_mixed_site_only_the_permitted_storage_grid_charges():
    plan = solve(eeg_mixed_input())
    by_id = {d.entity_id: d for d in plan.storages}
    merchant_charged = sum(max(s.setpoint_kw, 0) for s in by_id["merchant"].slots)
    eeg_charged = sum(max(s.setpoint_kw, 0) for s in by_id["eeg"].slots)
    assert merchant_charged > 4.0  # arbitrages the spread from the grid
    assert eeg_charged == pytest.approx(0.0, abs=1e-6)  # no PV -> no charge
    assert by_id["merchant"].charge_from_grid_allowed is True
    assert by_id["eeg"].charge_from_grid_allowed is False


@needs_highs
def test_dv_konform_mode_hard_disables_grid_charge_for_every_storage():
    # The site-level DV-konformer Modus overrides the merchant battery's own
    # permission (most-restrictive-wins): with no PV, NOTHING may charge -
    # grid-charge arbitrage is off site-wide.
    plan = solve(eeg_mixed_input(dv_konform=True))
    for dispatch in plan.storages:
        charged = sum(max(s.setpoint_kw, 0) for s in dispatch.slots)
        assert charged == pytest.approx(0.0, abs=1e-6), dispatch.entity_id
        assert dispatch.charge_from_grid_allowed is False


@needs_highs
def test_dv_konform_keeps_consumption_side_strategies_alive():
    # DV-konform disables grid ARBITRAGE, not the battery: solar charging and
    # expensive-evening self-consumption keep working (and with a
    # Leistungspreis, so does peak shaving - consumption-side strategies).
    n = 48
    prices = [50.0] * (n // 2) + [300.0] * (n // 2)
    pv = [8.0] * (n // 2) + [0.0] * (n // 2)  # sunny first half
    inp = make_input(
        prices,
        storages=(storage("batt", soc0=0.5, grid_charge=True),),
        producers=(ProducerEntity("pv", pv),),
        load=3.0,
        dv_konform=True,
        leistungspreis_eur_kw=120.0,
        peak_so_far_kw=2.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    (dispatch,) = plan.storages
    solar_charged = sum(max(s.setpoint_kw, 0) for s in dispatch.slots[: n // 2])
    discharged = sum(max(-s.setpoint_kw, 0) for s in dispatch.slots[n // 2 :])
    assert solar_charged > 4.0  # charges from PV despite DV-konform
    assert discharged > 4.0  # serves the expensive evening
    # Solar-only invariant: in every charging slot the charge is covered by
    # uncurtailed PV (never grid energy).
    for t, slot in enumerate(dispatch.slots):
        if slot.setpoint_kw > 1e-6:
            available = pv[t] - plan.producers[0].slots[t].curtail_kw
            assert slot.setpoint_kw <= available + 1e-6
    assert plan.peak_target_kw is not None  # peak module stayed active


@needs_highs
def test_peak_shaving_module_shaves_the_import_peak_in_the_co_optimizer():
    # E5a proof: the PS-1 peak module participates in the CO-optimizer exactly
    # like v1 (the golden peak-shaving-ci scenario pins the slot-by-slot v1↔co
    # equivalence; this asserts the module DOES something). A flat-price day
    # (no arbitrage) with a load spike: WITHOUT a Leistungspreis the battery is
    # idle and the billed import peak IS the spike; WITH one, the module
    # discharges through the spike to hold the peak down.
    n = 16
    prices = [100.0] * n  # flat - kills arbitrage so only the peak term acts
    load = [3.0] * n
    for t in range(6, 9):
        load[t] = 20.0  # a 3-slot import spike
    batt = storage("batt", capacity=30.0, power=12.0, soc0=25.0, wear_ct=0.0)

    def run(leistungspreis):
        return solve(
            make_input(
                prices,
                storages=(batt,),
                load=load,
                leistungspreis_eur_kw=leistungspreis,
                peak_so_far_kw=0.0,
                terminal_value_eur_per_kwh=0.0,
            )
        )

    def import_peak(plan):
        return max((max(s.grid_kw, 0.0) for s in plan.site_slots), default=0.0)

    off = run(None)
    on = run(200.0)

    # No Leistungspreis → no peak module → the raw spike is the import peak.
    assert off.peak_target_kw is None
    assert import_peak(off) > 18.0

    # With a Leistungspreis the module is active, the epigraph binds (peak ==
    # the actual import peak), and the battery shaves the spike well below it.
    assert on.peak_target_kw is not None
    assert on.peak_target_kw == pytest.approx(import_peak(on), abs=0.2)
    assert import_peak(on) < import_peak(off) - 5.0
    spike_discharge = sum(max(-s.setpoint_kw, 0.0) for s in on.storages[0].slots[6:9])
    assert spike_discharge > 0.0, "the battery must discharge through the spike to shave it"


@needs_highs
def test_solar_only_subset_constraint_binds_jointly_not_per_entity():
    # Two EEG storages share ONE solar budget: together they may charge at
    # most the produced PV, not each of them the full PV.
    n = 8
    prices = [-50.0] * n  # paid import makes charging attractive
    pv = [4.0] * n
    inp = make_input(
        prices,
        storages=(
            storage("eeg-a", capacity=50, power=6, soc0=2.5, grid_charge=False),
            storage("eeg-b", capacity=50, power=6, soc0=2.5, grid_charge=False),
        ),
        producers=(ProducerEntity("pv", pv),),
        load=1.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    for t in range(n):
        joint_charge = sum(
            max(d.slots[t].setpoint_kw, 0.0) for d in plan.storages
        )
        available = pv[t] - plan.producers[0].slots[t].curtail_kw
        assert joint_charge <= available + 1e-6


# ---------------------------------------------------------------------------
# Input-shape guarantees
# ---------------------------------------------------------------------------


def test_a_requirement_less_consumer_is_accepted_and_planned_off():
    """Inkrement 2: controllable loads ARE dispatched now - but a consumer
    runs only to serve requirements, so one without any is planned off in
    every slot (no opportunistic operation, §5.5)."""
    inp = make_input(
        [50.0] * 4,
        storages=(storage(),),
        controllable_loads=(
            ControllableLoadEntity("wallbox", max_power_kw=11.0),
        ),
    )
    plan = solve(inp)
    assert len(plan.loads) == 1
    assert all(not s.on and s.power_kw == 0.0 for s in plan.loads[0].slots)


def test_entity_ids_must_be_unique_and_topic_safe():
    with pytest.raises(ValueError, match="unique"):
        make_input(
            [50.0] * 4,
            storages=(storage("same"), storage("same")),
        )
    with pytest.raises(ValueError, match="entity_id"):
        storage("has spaces")


def test_input_requires_at_least_one_dispatchable_entity():
    with pytest.raises(ValueError, match="at least one"):
        make_input([50.0] * 4, storages=())


def test_producer_series_must_cover_the_horizon():
    with pytest.raises(ValueError, match="pv"):
        make_input(
            [50.0] * 4,
            storages=(storage(),),
            producers=(ProducerEntity("pv", [1.0] * 3),),
        )


@needs_highs
def test_storage_only_site_without_producers_solves():
    prices = spread_prices(16)
    inp = make_input(
        prices,
        storages=(storage(soc0=0.5),),
        load=3.0,
        terminal_value_eur_per_kwh=0.0,
    )
    plan = solve(inp)
    assert plan.producers == []
    assert len(plan.site_slots) == 16
    assert plan.savings_eur > 0  # the spread is worth cycling


def test_module_selection_reflects_the_effective_permission():
    # dv_konform selects the solar-only module even when every storage's own
    # flag would allow grid charging - the documented netzladen mapping.
    base = make_input([50.0] * 4, storages=(storage(grid_charge=True),))
    assert "solar-only-charge" not in {m.name for m in select_modules(base)}
    dv = make_input(
        [50.0] * 4, storages=(storage(grid_charge=True),), dv_konform=True
    )
    assert "solar-only-charge" in {m.name for m in select_modules(dv)}


def test_v1_adapter_maps_the_site_switch_onto_the_single_storage():
    from voltpilot_optimization.domain import OptimizationInput

    for netzladen in (True, False):
        v1 = OptimizationInput(
            tenant_id=uuid4(),
            site_id=uuid4(),
            device_id=uuid4(),
            battery=BatteryParams(
                capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5
            ),
            slot_starts=horizon_slot_starts(T0, 4),
            prices_eur_mwh=[50.0] * 4,
            load_kw=[2.0] * 4,
            pv_kw=[1.0] * 4,
            initial_soc_kwh=5.0,
            netzladen_erlaubt=netzladen,
        )
        co = from_v1_input(v1)
        assert len(co.storages) == 1 and len(co.producers) == 1
        assert co.storages[0].charge_from_grid_allowed is netzladen
        assert co.grid_charge_allowed(co.storages[0]) is netzladen
        assert co.producers[0].generation_kw == v1.pv_kw

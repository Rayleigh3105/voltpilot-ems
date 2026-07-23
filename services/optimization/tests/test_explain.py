"""Fahrplan-Warum extraction (voltpilot_optimization.explain).

Three groups of proof, mirroring the design scout vp-fahrplan-why-design:

1. **The duals are real** - the KKT stationarity identities the scout measured
   at 0.000 ct hold on the fixed-binary LP re-solve (``eta*lambda = pi + wear``
   for interior charging, ``lambda = eta*(pi - wear)`` for interior
   discharging, within the documented epsilon-tie-break tolerance), and the
   peak-epigraph duals allocate the Leistungspreis + ratchet EXACTLY.
2. **The roles are honest** - the §6 rule-tree classifies representative days
   (EEG PV day, peak-shaving day, curtailment day, flat day, reserve hold)
   the way the vocabulary promises, and the binding flags name the right
   constraints.
3. **The layer is safe** - the committed plan is byte-identical with the
   explain layer on/off/failed (safety contract rule 1/4), the §14a fallback
   build is marked, and the constraint-inventory guard fails the moment the
   model grows a constraint without an explain mapping (§11.6).

Solver-dependent tests gate on highspy like the solver tests; the inventory
guard and config parsing always run.
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

from pyomo.environ import Constraint

from voltpilot_optimization.config import (
    explain_enabled,
    peak_ratchet_eur_per_kw,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.explain import (
    KNOWN_CONSTRAINTS,
    ExplainMappingError,
    explain,
    resolve_lp_duals,
    slot_duals,
)
from voltpilot_optimization.solver import (
    InfeasiblePlanError,
    _solve,
    build_model,
    optimize,
    optimize_ignoring_grid_limit,
)

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
    leistungspreis_eur_kw: float | None = None,
    peak_so_far_kw: float = 0.0,
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
        netzladen_erlaubt=netzladen_erlaubt,
        grid_limit_kw=grid_limit_kw,
        max_feed_in_kw=max_feed_in_kw,
        leistungspreis_eur_kw=leistungspreis_eur_kw,
        peak_so_far_kw=peak_so_far_kw,
    )


def arbitrage_prices(n: int = 96) -> list[float]:
    third = n // 3
    return [20.0] * third + [100.0] * (n - 2 * third) + [200.0] * third


def solve(inp: OptimizationInput, **kwargs):
    return optimize(inp, plan_id=uuid4(), generated_at=T0, **kwargs)


# ---------------------------------------------------------------------------
# Constraint-inventory guard (§11.6) - always runs, no solver needed.
# ---------------------------------------------------------------------------


def model_constraint_names(model) -> set[str]:
    return {c.local_name for c in model.component_objects(Constraint, active=True)}


def test_every_model_variant_is_covered_by_the_explain_mapping():
    # Every module combination build_model can produce must stay inside the
    # known scan list - a NEW constraint without an explain mapping fails HERE
    # at development time, before it could ever produce a dishonest (or
    # refused) explanation in production.
    variants = [
        make_input(arbitrage_prices()),  # merchant, bare
        make_input(arbitrage_prices(), netzladen_erlaubt=False),  # EEG solar-only
        make_input(arbitrage_prices(), grid_limit_kw=30.0),  # §14a
        make_input(arbitrage_prices(), max_feed_in_kw=8.0),  # FK1 feed-in cap
        make_input(arbitrage_prices(), leistungspreis_eur_kw=120.0),  # PS-1
        make_input(  # kitchen sink
            arbitrage_prices(),
            netzladen_erlaubt=False,
            grid_limit_kw=30.0,
            max_feed_in_kw=8.0,
            leistungspreis_eur_kw=120.0,
        ),
    ]
    for inp in variants:
        for enforce in (True, False):
            names = model_constraint_names(build_model(inp, enforce_grid_limit=enforce))
            unknown = names - KNOWN_CONSTRAINTS
            assert not unknown, (
                f"new constraint(s) without explain mapping: {sorted(unknown)} - "
                "extend explain.KNOWN_CONSTRAINTS + the binding scan/role tree"
            )


def test_explain_refuses_a_model_with_an_unmapped_constraint():
    model = build_model(make_input(arbitrage_prices()))
    model.rogue = Constraint(expr=model.soc[0] >= 0)
    with pytest.raises(ExplainMappingError, match="rogue"):
        explain(model, make_input(arbitrage_prices()))


def test_explain_enabled_flag_parses_strictly():
    assert explain_enabled({}) is True
    assert explain_enabled({"OPTIMIZER_EXPLAIN_ENABLED": "true"}) is True
    assert explain_enabled({"OPTIMIZER_EXPLAIN_ENABLED": "0"}) is False
    assert explain_enabled({"OPTIMIZER_EXPLAIN_ENABLED": "off"}) is False
    with pytest.raises(ValueError):
        explain_enabled({"OPTIMIZER_EXPLAIN_ENABLED": "maybe"})


# ---------------------------------------------------------------------------
# Layer 3: the duals ARE the optimizer's own marginal economics.
# ---------------------------------------------------------------------------


@needs_highs
def test_stationarity_identities_hold_on_the_lp_duals():
    # The scout's 0.000-ct checks: on every INTERIOR charge slot (charge
    # strictly between 0 and the cap, so no bound dual interferes) the KKT
    # stationarity of the fixed-binary LP demands eta*lambda = pi + wear, and
    # on every interior discharge slot lambda = eta*(pi - wear). Tolerance
    # covers only the documented epsilon tie-breaks (1e-6 EUR/kW / dt = 4e-6
    # EUR/kWh scale).
    inp = make_input(arbitrage_prices())
    model = build_model(inp)
    _solve(model)
    duals = slot_duals(model, inp)

    from pyomo.environ import value

    eta = BATTERY.one_way_efficiency
    wear = BATTERY.wear_cost_eur_per_kwh_each_way
    tol = 1e-5  # EUR/kWh
    interior_charge = interior_discharge = 0
    for t in range(inp.slots):
        c = float(value(model.charge[t]))
        d = float(value(model.discharge[t]))
        lam, pi = duals[t].lambda_eur_kwh, duals[t].pi_eur_kwh
        if 1e-4 < c < BATTERY.max_charge_kw - 1e-4:
            interior_charge += 1
            assert abs(eta * lam - (pi + wear)) <= tol
        if 1e-4 < d < BATTERY.max_discharge_kw - 1e-4:
            interior_discharge += 1
            assert abs(lam - eta * (pi - wear)) <= tol
    # The identities must actually have been exercised, not vacuously passed.
    assert interior_charge + interior_discharge > 0


@needs_highs
def test_peak_duals_allocate_the_leistungspreis_exactly():
    # Sum of the peak-epigraph duals (incl. the anchor) = the Leistungspreis
    # EXACTLY, and the peak_below duals = the ratchet - the LP-dual proof that
    # mu really is the per-slot Leistungspreis allocation (mode attribution).
    lp_eur_kw = 120.0
    inp = make_input(arbitrage_prices(), leistungspreis_eur_kw=lp_eur_kw)
    model = build_model(inp)
    _solve(model)
    duals, _rcs = resolve_lp_duals(model)
    peak_sum = sum(-duals[model.peak_epigraph[t]] for t in model.T)
    peak_sum += -duals[model.peak_anchor]
    ratchet_sum = sum(-duals[model.peak_below_epigraph[t]] for t in model.T)
    assert abs(peak_sum - lp_eur_kw) < 1e-6
    assert abs(ratchet_sum - peak_ratchet_eur_per_kw(lp_eur_kw)) < 1e-6


@needs_highs
def test_mu_is_none_without_the_peak_module():
    inp = make_input(arbitrage_prices())
    model = build_model(inp)
    _solve(model)
    duals = slot_duals(model, inp)
    assert all(d.mu_eur_kw is None for d in duals)
    plan = solve(make_input(arbitrage_prices()))
    assert all(s.peak_pressure_eur_kw is None for s in plan.slots)


# ---------------------------------------------------------------------------
# Layer 2: role vectors per scenario (§6 vocabulary).
# ---------------------------------------------------------------------------


@needs_highs
def test_eeg_pv_day_roles_store_pv_and_never_grid_charge():
    # EEG household: PV hump feeds the battery at the solar-only bound, the
    # expensive evening discharges - and guenstig_laden must NEVER appear on
    # an EEG site (the Ausschliesslichkeitsprinzip in role form).
    n = 96
    prices = [100.0] * 64 + [300.0] * 32
    pv = [0.0] * 24 + [4.0] * 32 + [0.0] * 40
    inp = make_input(prices, load=2.0, pv=pv, soc0_kwh=0.5, netzladen_erlaubt=False)
    plan = solve(inp)
    roles = [s.slot_role for s in plan.slots]
    assert plan.fallback_14a is False
    assert "guenstig_laden" not in roles
    charge_roles = {s.slot_role for s in plan.slots if s.battery_kw > 0.05}
    assert charge_roles == {"pv_speichern"}
    # A full-power PV charge sits exactly on the solar-only bound (charge ==
    # pv - curtail) - the EEG binding must be flagged.
    bound_slots = [
        s for s in plan.slots if s.battery_kw > 0.05 and abs(s.battery_kw - 4.0) < 1e-3
    ]
    assert bound_slots, "expected charge slots at the solar-only bound"
    assert all("solar_only" in s.slot_flags for s in bound_slots)
    discharge_roles = {s.slot_role for s in plan.slots if s.battery_kw < -0.05}
    assert discharge_roles <= {"eigenverbrauch", "verkaufen"}
    assert discharge_roles, "the evening peak must discharge"
    # Every slot carries the exact stored-energy value (the Wasserwert).
    assert all(s.stored_value_ct_kwh is not None for s in plan.slots)
    assert all(s.grid_value_ct_kwh is not None for s in plan.slots)


@needs_highs
def test_peak_day_discharge_is_spitze_kappen():
    # RLM site, flat prices (no arbitrage motive), a noon load spike: the only
    # reason to discharge is the Leistungspreis - the role must say so.
    n = 96
    load = [5.0] * 40 + [12.0] * 8 + [5.0] * 48
    inp = make_input(
        [100.0] * n, load=load, soc0_kwh=9.5, leistungspreis_eur_kw=120.0
    )
    plan = solve(inp)
    spike_discharge = [
        s for i, s in enumerate(plan.slots) if 40 <= i < 48 and s.battery_kw < -0.05
    ]
    assert spike_discharge, "the spike must be shaved by discharging"
    assert all(s.slot_role == "spitze_kappen" for s in spike_discharge)
    # The shaved plateau defines the plan's peak - the binding flag names it.
    assert any("peak_defining" in (s.slot_flags or ()) for s in plan.slots)
    # mu is present (not None) whenever the module is on.
    assert all(s.peak_pressure_eur_kw is not None for s in plan.slots)


@needs_highs
def test_curtailment_day_idle_slots_are_abregeln():
    # Negative midday prices, full battery: feeding in would pay money, so the
    # plan curtails - idle + curtailing = abregeln, and the full battery is
    # flagged soc_max.
    n = 96
    prices = [50.0] * 32 + [-50.0] * 16 + [50.0] * 48
    pv = [0.0] * 32 + [8.0] * 16 + [0.0] * 48
    inp = make_input(prices, load=1.0, pv=pv, soc0_kwh=9.5)
    plan = solve(inp)
    curtailing = [s for s in plan.slots if s.curtail_kw > 0.01]
    assert curtailing, "negative export value must curtail"
    idle_curtailing = [s for s in curtailing if abs(s.battery_kw) <= 0.05]
    assert idle_curtailing, "expected idle curtailment slots"
    assert all(s.slot_role == "abregeln" for s in idle_curtailing)
    assert all("curtailing" in s.slot_flags for s in idle_curtailing)


@needs_highs
def test_flat_day_is_all_warten_with_no_bindings():
    # A flat curve plans an idle battery (zero savings by construction) - the
    # honest story is simply "warten", with no fabricated bindings.
    plan = solve(make_input([100.0] * 96, load=5.0, soc0_kwh=5.0))
    assert all(s.slot_role == "warten" for s in plan.slots)
    assert all(s.slot_flags == () for s in plan.slots)
    assert all(abs(s.battery_kw) <= 0.05 for s in plan.slots)


@needs_highs
def test_reserve_hold_names_the_binding_reserve():
    # Battery sitting ON its backup reserve with nothing to earn: the role is
    # reserve_halten and the flag attributes the hold to the backup reserve
    # (the reservation-stack argmax).
    battery = BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
        backup_reserve_pct=50.0,
    )
    plan = solve(make_input([100.0] * 96, load=5.0, battery=battery, soc0_kwh=5.0))
    assert all(s.slot_role == "reserve_halten" for s in plan.slots)
    assert all("soc_floor" in s.slot_flags for s in plan.slots)
    assert all("reserve_backup" in s.slot_flags for s in plan.slots)


@needs_highs
def test_merchant_cheap_night_is_guenstig_laden():
    plan = solve(make_input(arbitrage_prices()))
    third = 96 // 3
    night_charge = [s for s in plan.slots[:third] if s.battery_kw > 0.05]
    assert night_charge, "the cheap night must charge"
    assert all(s.slot_role == "guenstig_laden" for s in night_charge)
    # Full-power slots carry the charge_cap binding.
    capped = [s for s in night_charge if abs(s.battery_kw - 5.0) < 1e-3]
    assert capped and all("charge_cap" in s.slot_flags for s in capped)


@needs_highs
def test_binding_14a_limit_is_flagged():
    # Load 6 kW behind a 5 kW §14a envelope over a short horizon: the battery
    # covers the difference and every capped slot is flagged grid_limit_14a.
    n = 16
    inp = make_input([100.0] * n, load=6.0, soc0_kwh=9.0, grid_limit_kw=5.0)
    plan = solve(inp)
    capped = [s for s in plan.slots if abs(s.grid_kw - 5.0) < 1e-3]
    assert capped, "the §14a cap must bind"
    assert all("grid_limit_14a" in s.slot_flags for s in capped)


# ---------------------------------------------------------------------------
# Safety contract: the plan is untouched, the layer fails soft.
# ---------------------------------------------------------------------------


def _setpoints(plan):
    return [
        (s.start, s.battery_kw, s.grid_kw, s.soc_kwh, s.curtail_kw, s.cost_eur,
         s.baseline_cost_eur, s.wear_cost_eur)
        for s in plan.slots
    ]


@needs_highs
def test_plan_is_byte_identical_with_explain_on_and_off(monkeypatch):
    inp = make_input(arbitrage_prices(), leistungspreis_eur_kw=120.0)
    with_why = solve(inp)
    monkeypatch.setenv("OPTIMIZER_EXPLAIN_ENABLED", "false")
    without_why = solve(inp)
    monkeypatch.delenv("OPTIMIZER_EXPLAIN_ENABLED")
    skipped = solve(inp, explain_plan=False)
    # The committed setpoints/economics are EXACTLY equal - the explain layer
    # is post-hoc and purely additive (safety contract rule 1).
    assert _setpoints(with_why) == _setpoints(without_why) == _setpoints(skipped)
    assert with_why.peak_target_kw == without_why.peak_target_kw
    assert with_why.terminal_value_eur_per_kwh == without_why.terminal_value_eur_per_kwh
    # Only the additive why-fields differ.
    assert all(s.slot_role is not None for s in with_why.slots)
    assert all(s.slot_role is None for s in without_why.slots)
    assert without_why.fallback_14a is None
    assert skipped.fallback_14a is None


@needs_highs
def test_explain_failure_never_sinks_the_plan(monkeypatch):
    import voltpilot_optimization.explain as explain_mod

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic explain failure")

    monkeypatch.setattr(explain_mod, "explain", boom)
    plan = solve(make_input(arbitrage_prices()))
    assert len(plan.slots) == 96
    assert all(s.slot_role is None for s in plan.slots)
    assert all(s.stored_value_ct_kwh is None for s in plan.slots)
    assert plan.fallback_14a is None
    # ...and the setpoints equal an untouched solve.
    monkeypatch.undo()
    clean = solve(make_input(arbitrage_prices()), explain_plan=False)
    assert _setpoints(plan) == _setpoints(clean)


@needs_highs
def test_garbage_explain_flag_degrades_instead_of_sinking(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_EXPLAIN_ENABLED", "definitely-not-a-bool")
    plan = solve(make_input(arbitrage_prices()))
    assert len(plan.slots) == 96
    assert all(s.slot_role is None for s in plan.slots)


@needs_highs
def test_fallback_build_is_marked_and_structurally_unflagged():
    # An infeasible §14a cap: optimize() refuses, the advisory build carries
    # fallback_14a=True and can structurally never flag grid_limit_14a.
    inp = make_input([100.0] * 96, load=10.0, soc0_kwh=5.0, grid_limit_kw=2.0)
    with pytest.raises(InfeasiblePlanError):
        optimize(inp, plan_id=uuid4(), generated_at=T0)
    plan = optimize_ignoring_grid_limit(inp, plan_id=uuid4(), generated_at=T0)
    assert plan.fallback_14a is True
    assert all(s.slot_role is not None for s in plan.slots)
    assert all("grid_limit_14a" not in s.slot_flags for s in plan.slots)

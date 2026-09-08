"""The multi-entity co-optimizer MILP (E4-Basis, plan-draft §2.3).

Generalizes the single-battery dispatch MILP of
:mod:`voltpilot_optimization.solver` to N entities per site - storages[],
producers[], controllable loads[] - behind ONE grid connection point, with the
modules (EEG solar-only, §14a, feed-in cap, peak shaving, reservation stack)
folded in as DECLARED contributions (:mod:`voltpilot_optimization.modules`)
instead of inline conditionals. The solver stays a pure function; strategy
nodes later register additional contributions through the ``modules`` override
of :func:`build_co_model`.

Formulation (per slot t, storage e, producer p; dt = 0.25 h):

    minimize   sum_t  (import_price_t * import_t - export_value_t * export_t) * dt / 1000
                      + sum_e c_wear_e/2 * (charge_et + discharge_et) * dt
                      + eps_c * sum_p curtail_pt + eps_b * sum_e (charge_et + discharge_et)
               + module objective terms (peak shaving)
               - sum_e V_end_e * (soc_e,T - soc_e,0)
    where      import_t - export_t = base_load_t + sum_p (curtail_pt - pv_pt)
                                     + sum_e (charge_et - discharge_et)
    s.t.       per-entity charge/discharge caps + exclusive-direction binaries,
               per-entity SoC dynamics (sqrt-split efficiency) and bounds
               (reservation stack raises the floor),
               per-producer 0 <= curtail_pt <= pv_pt (non-curtailable: == 0),
               site-level exclusive import/export binaries with the tightest
               physical big-Ms, plus the selected module constraints.

Every rule is the v1 rule generalized by summation - for the N=1 adapter
(:func:`voltpilot_optimization.entities.from_v1_input`) the model is
mathematically identical to :func:`solver.build_model` term by term, which the
golden suite (``tests/golden/``, the cutover acceptance basis) verifies
against real pilot-shaped inputs: same objective, same slot-by-slot dispatch.
Design rationale for the individual rules (asymmetric pricing, binaries at
negative prices, terminal value, tie-breaks, PV-bus Bilanzierung, peak
economics) lives in :mod:`voltpilot_optimization.solver`'s docstring and is
deliberately not repeated here.

Multi-entity semantics worth naming:

- **One grid balance.** All entities share the connection point; import/export
  and their §14a/feed-in/peak caps stay SITE-level (the mqtt-schedule-2.0
  contract's table: the billing peak is a property of the connection point).
- **Solar-only charging is a SUBSET constraint.** The storages without
  effective grid-charge permission (per-entity flag AND site DV-konform mode)
  jointly charge at most the site's uncurtailed production; permitted storages
  arbitrage freely alongside.
- **Per-producer curtailment.** Each curtailable producer owns its reduction
  decision bounded by its own forecast; the curtailment tie-break keeps the
  split deterministic-preferring-none, but WHICH producer curtails first is
  economically degenerate - consumers must only rely on the total.

Controllable-consumer dispatch (Verbrauchssteuerung Inkrement 2, §12 of
docs/verbrauchssteuerung.md) - every consumer component is GUARDED behind a
non-empty ``controllable_loads`` list, so a site without consumers builds the
byte-identical pre-consumer model (the golden suite is the proof):

- **Per-load variables + coupling** (§12.2): ``load_power``/``load_on`` with
  the control-kind coupling (on_off, explicit stepped levels, continuous
  min/max, and the D4 non-convex ``power_ranges_kw`` - one binary per range,
  at most one active, range entries dwell like starts), plus the
  unit-commitment invariants (min on/off, max starts per horizon, ramp).
  ``start``/``stop`` are BINARY on purpose: the ramp relaxation at a start
  rides on them, and a fractional spurious start would silently relax the
  ramp (min-up/down alone would tolerate continuous ones).
- **A consumer runs only to serve requirements**: outside every compiled
  window its variables are FIXED off - opportunistic operation (§5.5) is a
  later, explicitly opted-in feature, so cheap energy alone never switches a
  device on.
- **Requirements as constraints with honest slack** (§12.3): fixed windows
  hold their target per slot minus a bounded slack; flexible runtime/energy
  demands sum over their window; ``contiguous`` limits the window to one run
  block (the user's choice is never re-interpreted, E5).
- **Three CONDITIONAL lexicographic stages** (D2, §12.4), implemented as
  sequential solves with the previous stage's optimum fixed as a capped
  constraint (``STAGE_FIX_TOLERANCE`` - documented ABOVE the pinned MIP gap,
  far below any real slack quantum): stage 1 minimizes the requirement
  slacks in strict priority order (operational min-runs are constraints;
  then ``service_rank``, earlier deadline, stable requirement id - encoded
  as 3^k weights over [0,2]-normalized slacks, which IS strict lexicography
  for the bounded slacks); stage 2 exists ONLY when a consumer carries
  ``grid_energy_policy=avoid`` and minimizes the grid kWh allocated to those
  consumers; stage 3 is the unchanged economic objective + the deterministic
  epsilon tie-breaks. Without consumer slacks/avoidance the driver is a
  single solve - the pre-consumer path, byte for byte.
- **The source/sink allocation matrix is built CONDITIONALLY** (D2/§6): only
  when at least one consumer carries a source restriction or preference
  (``allow_storage_discharge=false`` with storages present, or a grid policy
  other than ``allow``). Row sums equal the physical source totals, column
  sums the sink totals, exactly - no kWh is ever assigned twice, and the
  matrix never changes the physical balance, it only restricts/prices its
  admissible split.
- **Two new deterministic tie-breaks in the existing epsilon class**:
  the Energiepräferenz (D6) - ``storage_first`` as an allocation-cell epsilon
  (``CONSUMER_PREFERENCE_TIEBREAK_EUR_PER_KW``, ABOVE the battery-throughput
  epsilon so it can win a true tie, still far below any real price
  difference; ``consumer_first`` deliberately needs no term of its own, the
  throughput epsilon already sides with the consumer) - and the D5 EARLINESS
  of flexible tasks (``EARLY_LOAD_TIEBREAK_EUR_PER_KW``, the early-charge
  class). Never raise them to "make a tie decide" (AGENTS.md tolerance
  discipline) - tighten the solver tolerance instead (see
  ``mip_feasibility_tolerance`` in :func:`solver._solve`).
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pyomo.environ import (
    Binary,
    ConcreteModel,
    Constraint,
    NonNegativeReals,
    Objective,
    RangeSet,
    Var,
    minimize,
    value,
)

from voltpilot_optimization.entities import (
    ControllableLoadEntity,
    CoOptimizationInput,
    LoadDispatch,
    LoadRequirement,
    LoadSlot,
    ProducerDispatch,
    ProducerSlot,
    REASON_GRID_LIMIT,
    REASON_NO_PERMITTED_ENERGY,
    SitePlan,
    SiteSlot,
    StorageDispatch,
    StorageSlot,
    UnservedRequirement,
)
from voltpilot_optimization.config import night_reserve_enabled
from voltpilot_optimization.modules import SolverModule, select_modules
from voltpilot_optimization.night_reserve import (
    night_reserve_terms,
    stash_night_reserve,
)
from voltpilot_optimization.solver import (
    BATTERY_WEAR_TIEBREAK_EUR_PER_KW,
    CURTAIL_TIEBREAK_EUR_PER_KW,
    EARLY_CHARGE_TIEBREAK_EUR_PER_KW,
    EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW,
    MIP_ABS_GAP,
    _solve,
)

# ---------------------------------------------------------------------------
# Consumer-dispatch tie-break + staging constants (Verbrauchssteuerung §12.4).
#
# Epsilon ORDERING is load-bearing and deliberate (never "tune" one to make a
# tie decide - tighten the MIP gap instead, AGENTS.md discipline):
#
#   real economics  (>= ~1e-4 EUR per decision at 0.1 EUR/MWh price deltas)
#     >> CONSUMER_PREFERENCE_TIEBREAK_EUR_PER_KW (1e-5)
#     >> CURTAIL/BATTERY_WEAR tie-breaks          (1e-6)
#     >> EARLY_CHARGE/EARLY_DISCHARGE/EARLY_LOAD  (1e-7)
#     >> STAGE_FIX_TOLERANCE                      (1e-6, stage-objective units)
#     >> MIP_ABS_GAP / MIP_REL_GAP                (1e-9)
#
# The preference epsilon sits ABOVE the battery-throughput epsilon on purpose:
# at a true cost tie between "serve the consumer" and "cycle the storage" the
# preference must decide, and the cheaper-by-epsilon battery idle preference
# (BATTERY_WEAR_TIEBREAK) must not accidentally overrule storage_first. It
# stays 10x below the smallest meaningful price signal the objective can see.
# ---------------------------------------------------------------------------

# The consumer_first/storage_first indifference preference (§6/D6) prices
# ALLOCATION-matrix cells, because only the matrix knows WHERE a consumer's
# energy comes from: storage_first puts the epsilon on local energy
# (PV/storage) feeding that consumer, consumer_first on local PV feeding the
# OPTIONAL storage charge - either way the dispreferred use of the same kWh
# yields at a true cost tie. It must sit ABOVE the battery-throughput epsilon
# (which alone always sides with the consumer - fewer cycles), or
# storage_first could never win a tie. NEVER a stage, never a permission.
CONSUMER_PREFERENCE_TIEBREAK_EUR_PER_KW = 1e-5

# D5: at cost-equal optima a flexible task lands as EARLY as possible - the
# early-charge class (1e-7), small enough to never overturn a real price
# difference, large enough to beat the MIP gap.
EARLY_LOAD_TIEBREAK_EUR_PER_KW = EARLY_CHARGE_TIEBREAK_EUR_PER_KW

# Lexicographic stage fixation: after a stage solve, its optimum is fixed as
# `expr <= J* + STAGE_FIX_TOLERANCE * max(1, |J*|)`. 1e-6 is three orders
# ABOVE the pinned MIP gaps (1e-9 - a stage cap tighter than the gap would
# randomly cut the true optimum) and orders BELOW any real stage quantum
# (stage 1: one missing 15-min slot of a run normalizes to >= 1/96 ~ 1e-2;
# stage 2: real avoided grid energy is >= watt-hours, not micro-watt-hours).
STAGE_FIX_TOLERANCE = 1e-6

# Strict-lexicography weight base for the stage-1 slack priority order (E9):
# each requirement's normalized slack is bounded by 2 (runtime + energy dim),
# and 3^k > 2 * sum(3^j, j<k), so a higher-priority slack always dominates
# every lower one. Capped at 16 priority tiers to keep coefficients within
# solver-friendly magnitude; requirements beyond the cap share the last tier
# (documented numeric guard - realistic sites carry a handful).
_STAGE1_WEIGHT_BASE = 3.0
_STAGE1_MAX_TIERS = 16


def build_co_model(
    inp: CoOptimizationInput,
    enforce_grid_limit: bool = True,
    modules: tuple[SolverModule, ...] | None = None,
) -> ConcreteModel:
    """Build the multi-entity dispatch MILP for one site.

    ``modules`` overrides the input-derived contribution selection - the
    registration seam for v2 strategy nodes; ``None`` selects per
    :func:`voltpilot_optimization.modules.select_modules` (v1-equivalent).
    """
    if modules is None:
        modules = select_modules(inp, enforce_grid_limit)
    n = inp.slots
    dt = inp.slot_hours
    storages = inp.storages
    producers = inp.producers
    E = range(len(storages))
    P = range(len(producers))

    soc0 = [s.params.clamp_soc_kwh(s.initial_soc_kwh) for s in storages]
    # The reservation stack raises each storage's SoC floor (module channel;
    # the technical floor with the below-start relaxation is the fallback so a
    # model built with an explicit module list stays feasible).
    floors = []
    for e in E:
        candidates = [
            f
            for mod in modules
            if (f := mod.storage_soc_floor_kwh(storages[e], soc0[e])) is not None
        ]
        floors.append(
            max(candidates)
            if candidates
            else min(storages[e].params.soc_min_kwh, soc0[e])
        )

    m = ConcreteModel()
    m.T = RangeSet(0, n - 1)  # decision slots
    m.S = RangeSet(0, n)  # SoC nodes (slot boundaries)

    m.charge = Var(
        E,
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, e, t: (0.0, storages[e].params.max_charge_kw),
    )
    m.discharge = Var(
        E,
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, e, t: (0.0, storages[e].params.max_discharge_kw),
    )
    m.is_charging = Var(E, m.T, domain=Binary)
    # Per-producer curtailment: only ever a REDUCTION of that producer's own
    # forecast; a non-curtailable producer is must-run (fixed at 0).
    m.curtail = Var(
        P,
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, p, t: (
            (0.0, max(producers[p].generation_kw[t], 0.0))
            if producers[p].curtailable
            else (0.0, 0.0)
        ),
    )
    m.soc = Var(
        E,
        m.S,
        bounds=lambda model, e, s: (floors[e], storages[e].params.soc_max_kwh),
    )
    for e in E:
        m.soc[e, 0].fix(soc0[e])

    loads = inp.controllable_loads
    if loads:
        _add_consumer_dispatch(m, inp)

    # The tightest physical bounds on a slot's site import/export (the v1
    # big-Ms generalized by summation; max(-x, 0) guards pathological negative
    # forecasts only). Controllable consumers widen only the IMPORT bound -
    # they never generate.
    def _m_import(t: int) -> float:
        return (
            max(inp.base_load_kw[t], 0.0)
            + sum(s.params.max_charge_kw for s in storages)
            + sum(max(-p.generation_kw[t], 0.0) for p in producers)
            + sum(load.max_power_kw for load in loads)
        )

    def _m_export(t: int) -> float:
        return (
            sum(max(p.generation_kw[t], 0.0) for p in producers)
            + sum(s.params.max_discharge_kw for s in storages)
            + max(-inp.base_load_kw[t], 0.0)
        )

    m.grid_import = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_import(t))
    )
    m.grid_export = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_export(t))
    )
    m.is_importing = Var(m.T, domain=Binary)

    # ONE grid balance for the whole site: every entity behind the same
    # connection point (§12.2: + Σ controllable_load_power; an empty consumer
    # list contributes the literal 0 and keeps the expression unchanged).
    m.grid_balance = Constraint(
        m.T,
        rule=lambda model, t: model.grid_import[t] - model.grid_export[t]
        == inp.base_load_kw[t]
        + sum(model.curtail[p, t] - producers[p].generation_kw[t] for p in P)
        + sum(model.charge[e, t] - model.discharge[e, t] for e in E)
        + sum(model.load_power[c, t] for c in range(len(loads))),
    )
    # Mutually exclusive site import/export (load-bearing under asymmetric
    # prices - see solver.py).
    m.import_gate = Constraint(
        m.T,
        rule=lambda model, t: model.grid_import[t]
        <= _m_import(t) * model.is_importing[t],
    )
    m.export_gate = Constraint(
        m.T,
        rule=lambda model, t: model.grid_export[t]
        <= _m_export(t) * (1 - model.is_importing[t]),
    )

    m.soc_dynamics = Constraint(
        E,
        m.T,
        rule=lambda model, e, t: model.soc[e, t + 1]
        == model.soc[e, t]
        + (
            storages[e].params.one_way_efficiency * model.charge[e, t]
            - model.discharge[e, t] / storages[e].params.one_way_efficiency
        )
        * dt,
    )
    # Mutually exclusive charge/discharge PER entity (negative prices would
    # otherwise burn energy through each round trip - see solver.py).
    m.charge_gate = Constraint(
        E,
        m.T,
        rule=lambda model, e, t: model.charge[e, t]
        <= storages[e].params.max_charge_kw * model.is_charging[e, t],
    )
    m.discharge_gate = Constraint(
        E,
        m.T,
        rule=lambda model, e, t: model.discharge[e, t]
        <= storages[e].params.max_discharge_kw * (1 - model.is_charging[e, t]),
    )

    # Declared module contributions: constraints first, then their objective
    # terms folded into the single objective below.
    for mod in modules:
        mod.constrain(m, inp)
    module_cost = sum(mod.objective(m, inp) for mod in modules)

    # The bilanztreue source/sink allocation matrix (§6/D2) - built ONLY when
    # a consumer actually restricts or prefers a source; otherwise the model
    # stays small and matrix-free.
    if loads and _allocation_matrix_needed(inp, m):
        _add_allocation_matrix(m, inp)

    # Consumer epsilon tie-breaks (stage-3 class, §12.4; zero without loads).
    load_tiebreak_cost = 0.0
    if loads:
        C = range(len(loads))
        # D5 earliness: at cost-equal optima flexible demand lands early. The
        # gradient also touches fixed windows, where it is inert (forced).
        load_tiebreak_cost += EARLY_LOAD_TIEBREAK_EUR_PER_KW * sum(
            (t / max(n - 1, 1)) * m.load_power[c, t] for c in C for t in m.T
        )
        # The consumer_first/storage_first allocation preference lives on the
        # matrix cells (set by _add_allocation_matrix; 0.0 when no matrix -
        # the throughput epsilon then already sides with the consumer).
        load_tiebreak_cost += getattr(m, "_vp_pref_expr", 0.0)

    terminal_credit = sum(
        inp.effective_terminal_value_eur_per_kwh(storages[e])
        * (m.soc[e, n] - soc0[e])
        for e in E
    )
    import_prices = inp.import_prices
    export_values = inp.export_values
    m.total_cost = Objective(
        expr=sum(
            (
                import_prices[t] * m.grid_import[t]
                - export_values[t] * m.grid_export[t]
            )
            * dt
            / 1000.0
            + sum(
                storages[e].params.wear_cost_eur_per_kwh_each_way
                * (m.charge[e, t] + m.discharge[e, t])
                * dt
                for e in E
            )
            + CURTAIL_TIEBREAK_EUR_PER_KW * sum(m.curtail[p, t] for p in P)
            + BATTERY_WEAR_TIEBREAK_EUR_PER_KW
            * sum(m.charge[e, t] + m.discharge[e, t] for e in E)
            # Charge-timing tie-break (early-charge, captain 2026-08-09), the
            # summation-generalized twin of the v1 term - kept in lockstep so
            # the golden suite stays exact (see solver.py for the rationale).
            + EARLY_CHARGE_TIEBREAK_EUR_PER_KW
            * (t / max(n - 1, 1))
            * sum(m.charge[e, t] for e in E)
            # Discharge-timing tie-break (cover-now, captain 2026-08-18), the
            # summation-generalized twin of the v1 term - same lockstep rule.
            + EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW
            * (t / max(n - 1, 1))
            * sum(m.discharge[e, t] for e in E)
            for t in m.T
        )
        + module_cost
        + load_tiebreak_cost
        - terminal_credit,
        sense=minimize,
    )
    _add_night_reserve(m, inp, storages, producers, floors)
    return m


def _add_night_reserve(m, inp, storages, producers, floors) -> None:
    """The NIGHT VALUE FUNCTION (P3), generalized by summation: the site has ONE
    night, so it has ONE sunrise node - the SUM of the storages' SoC.

    Everything else is the v1 term verbatim (same module, same numbers, same
    ``vf_s``/``vf_c`` names), which is what keeps the golden suite exact for
    N=1: the summed SoC, floor and efficiency each collapse to the single
    storage's own value. ``eta`` is capacity-weighted because ``D_Rest`` asks
    what the night costs in STORED kWh, and a fleet of storages answers that
    question in proportion to how much of it each of them holds.
    """
    stash_night_reserve(m, None)
    if inp.night_error_quantiles is None or not night_reserve_enabled():
        return
    capacity = sum(s.params.capacity_kwh for s in storages)
    if capacity <= 0.0:  # pragma: no cover - defensive
        return
    eta = (
        sum(s.params.one_way_efficiency * s.params.capacity_kwh for s in storages)
        / capacity
    )
    pv_kw = [
        sum(max(p.generation_kw[t], 0.0) for p in producers)
        for t in range(len(inp.slot_starts))
    ]
    floor = sum(floors)
    terms = night_reserve_terms(
        load_kw=inp.base_load_kw,
        pv_kw=pv_kw,
        import_price_eur_mwh=inp.import_prices,
        export_value_eur_mwh=inp.export_values,
        slot_hours=inp.slot_hours,
        one_way_efficiency=eta,
        soc_floor_kwh=floor,
        errors=inp.night_error_quantiles,
    )
    if terms is None:
        return
    K = terms.levels
    levels = terms.levels_kwh
    coefficients = terms.coefficients_eur_kwh
    i1 = terms.i1
    E = range(len(storages))
    m.vf_s = Var(RangeSet(1, K), domain=NonNegativeReals)
    m.vf_c = Constraint(
        RangeSet(1, K),
        rule=lambda model, k: model.vf_s[k]
        >= levels[k - 1] - (sum(model.soc[e, i1] for e in E) - floor),
    )
    m.total_cost.set_value(
        m.total_cost.expr
        + sum(coefficients[k - 1] * m.vf_s[k] for k in range(1, K + 1))
    )
    stash_night_reserve(m, terms)


# ---------------------------------------------------------------------------
# Controllable-consumer formulation (Verbrauchssteuerung Inkrement 2, §12).
# Every function below is reached ONLY for a non-empty controllable_loads
# list - a consumer-less model is the byte-identical pre-consumer build.
# ---------------------------------------------------------------------------


def _requirement_order(
    loads: tuple[ControllableLoadEntity, ...],
) -> list[tuple[int, LoadRequirement]]:
    """The stage-1 slack priority order (E9/D2): ``service_rank`` first (None
    ranks last), then the earlier in-horizon deadline, then the stable
    requirement id, then the load index - fully deterministic."""
    entries: list[tuple[int, LoadRequirement]] = []
    for c, load in enumerate(loads):
        for req in load.requirements:
            entries.append((c, req))
    entries.sort(
        key=lambda e: (
            e[1].service_rank if e[1].service_rank is not None else 1_000_000,
            e[1].deadline_slot,
            e[1].requirement_id,
            e[0],
        )
    )
    return entries


def _slot_masks(inp: CoOptimizationInput) -> tuple[list[dict], list[dict]]:
    """Per (load, slot) effective source permissions, resolved from the
    covering requirements (§6/§10): grid policy = the LEAST restrictive among
    covering requirements (a slot serving an allow-requirement may import;
    must_run is compiled to allow), storage allowance = OR over covering
    requirements (E10 override or consumer default)."""
    grid_policy: list[dict] = []
    storage_ok: list[dict] = []
    for load in inp.controllable_loads:
        with_sets = [(req, set(req.window_slots)) for req in load.requirements]
        g: dict[int, str] = {}
        s: dict[int, bool] = {}
        for req, slots in with_sets:
            for t in slots:
                pol = load.effective_grid_policy(req)
                prev = g.get(t)
                rank = {"allow": 0, "avoid": 1, "forbid": 2}
                if prev is None or rank[pol] < rank[prev]:
                    g[t] = pol
                s[t] = s.get(t, False) or load.effective_storage_discharge(req)
        grid_policy.append(g)
        storage_ok.append(s)
    return grid_policy, storage_ok


def _add_consumer_dispatch(m: ConcreteModel, inp: CoOptimizationInput) -> None:
    """Variables, control-kind coupling, unit commitment and requirement
    constraints for every controllable consumer (§12.2/§12.3)."""
    loads = inp.controllable_loads
    n = inp.slots
    dt = inp.slot_hours
    C = range(len(loads))

    m.load_power = Var(
        C,
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, c, t: (0.0, loads[c].max_power_kw),
    )
    m.load_on = Var(C, m.T, domain=Binary)
    # BINARY start/stop on purpose: the ramp relaxation rides on them and a
    # fractional spurious start/stop pair would silently relax it (min-up/down
    # and the starts budget alone would tolerate continuous ones).
    m.load_start = Var(C, m.T, domain=Binary)
    m.load_stop = Var(C, m.T, domain=Binary)

    windows: list[set[int]] = []
    for load in loads:
        w: set[int] = set()
        for req in load.requirements:
            w.update(req.window_slots)
        windows.append(w)
    m._vp_load_windows = windows

    # A consumer runs ONLY to serve requirements: outside every compiled
    # window it is fixed off (no opportunistic operation, §5.5).
    for c in C:
        for t in range(n):
            if t not in windows[c]:
                m.load_power[c, t].fix(0.0)
                m.load_on[c, t].fix(0)
                prev_off = (
                    (not loads[c].initially_on)
                    if t == 0
                    else (t - 1) not in windows[c]
                )
                if prev_off:
                    m.load_start[c, t].fix(0)
                    m.load_stop[c, t].fix(0)

    def _start_stop_rule(model, c, t):
        if model.load_start[c, t].fixed and model.load_stop[c, t].fixed:
            return Constraint.Skip
        prev = (
            (1 if loads[c].initially_on else 0)
            if t == 0
            else model.load_on[c, t - 1]
        )
        return (
            model.load_start[c, t] - model.load_stop[c, t]
            == model.load_on[c, t] - prev
        )

    m.load_start_stop = Constraint(C, m.T, rule=_start_stop_rule)

    # -- control-kind coupling (§12.2) --------------------------------------
    for c, load in enumerate(loads):
        if load.control_kind == "on_off":
            m.add_component(
                f"load_{c}_couple",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, rated=load.max_power_kw: (
                        model.load_power[c, t] == rated * model.load_on[c, t]
                    ),
                ),
            )
        elif load.control_kind == "stepped":
            levels = load.levels_kw
            L = range(len(levels))
            sel = Var(m.T, L, domain=Binary)
            m.add_component(f"load_{c}_level_sel", sel)
            m.add_component(
                f"load_{c}_level_one",
                Constraint(
                    m.T,
                    rule=lambda model, t, sel=sel, L=L: (
                        sum(sel[t, l] for l in L) == 1
                    ),
                ),
            )
            m.add_component(
                f"load_{c}_level_power",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, sel=sel, levels=levels: (
                        model.load_power[c, t]
                        == sum(levels[l] * sel[t, l] for l in range(len(levels)))
                    ),
                ),
            )
            m.add_component(
                f"load_{c}_level_on",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, sel=sel, levels=levels: (
                        model.load_on[c, t]
                        == sum(sel[t, l] for l in range(1, len(levels)))
                    ),
                ),
            )
            for t in range(n):
                if t not in windows[c]:
                    sel[t, 0].fix(1)
                    for l in range(1, len(levels)):
                        sel[t, l].fix(0)
        elif load.power_ranges_kw:
            # D4 non-convex ranges: one binary per range, at most one active
            # (Σ = on), power inside the active range; a range ENTRY dwells
            # like a start (min_on_slots), so 1-/3-phase flapping is planned
            # out just like on/off flapping.
            ranges = load.power_ranges_kw
            R = range(len(ranges))
            sel = Var(m.T, R, domain=Binary)
            m.add_component(f"load_{c}_range_sel", sel)
            # Range entry detector: >= the selection delta; spurious values
            # only tighten the dwell, so continuous [0,1] suffices here.
            rstart = Var(m.T, R, domain=NonNegativeReals, bounds=(0.0, 1.0))
            m.add_component(f"load_{c}_range_start", rstart)
            m.add_component(
                f"load_{c}_range_on",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, sel=sel, R=R: (
                        sum(sel[t, r] for r in R) == model.load_on[c, t]
                    ),
                ),
            )
            m.add_component(
                f"load_{c}_range_lo",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, sel=sel, ranges=ranges: (
                        model.load_power[c, t]
                        >= sum(ranges[r][0] * sel[t, r] for r in range(len(ranges)))
                    ),
                ),
            )
            m.add_component(
                f"load_{c}_range_hi",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, sel=sel, ranges=ranges: (
                        model.load_power[c, t]
                        <= sum(ranges[r][1] * sel[t, r] for r in range(len(ranges)))
                    ),
                ),
            )
            m.add_component(
                f"load_{c}_range_entry",
                Constraint(
                    m.T,
                    R,
                    rule=lambda model, t, r, sel=sel, rstart=rstart: (
                        rstart[t, r]
                        >= sel[t, r] - (sel[t - 1, r] if t > 0 else 0)
                    ),
                ),
            )
            dwell = load.min_on_slots
            if dwell > 1:
                m.add_component(
                    f"load_{c}_range_dwell",
                    Constraint(
                        m.T,
                        R,
                        rule=lambda model, t, r, sel=sel, rstart=rstart, dwell=dwell, n=n: (
                            sum(sel[tau, r] for tau in range(t, min(t + dwell, n)))
                            >= min(dwell, n - t) * rstart[t, r]
                        ),
                    ),
                )
            for t in range(n):
                if t not in windows[c]:
                    for r in R:
                        sel[t, r].fix(0)
        else:  # plain continuous
            m.add_component(
                f"load_{c}_hi",
                Constraint(
                    m.T,
                    rule=lambda model, t, c=c, hi=load.max_power_kw: (
                        model.load_power[c, t] <= hi * model.load_on[c, t]
                    ),
                ),
            )
            if load.min_power_kw > 0.0:
                m.add_component(
                    f"load_{c}_lo",
                    Constraint(
                        m.T,
                        rule=lambda model, t, c=c, lo=load.min_power_kw: (
                            model.load_power[c, t] >= lo * model.load_on[c, t]
                        ),
                    ),
                )

    # -- unit commitment (§12.2) --------------------------------------------
    def _min_on_rule(model, c, t):
        L = loads[c].min_on_slots
        if L <= 1:
            return Constraint.Skip
        end = min(t + L, n)
        return sum(model.load_on[c, tau] for tau in range(t, end)) >= (
            end - t
        ) * model.load_start[c, t]

    m.load_min_on = Constraint(C, m.T, rule=_min_on_rule)

    def _min_off_rule(model, c, t):
        L = loads[c].min_off_slots
        if L <= 1:
            return Constraint.Skip
        end = min(t + L, n)
        return sum(1 - model.load_on[c, tau] for tau in range(t, end)) >= (
            end - t
        ) * model.load_stop[c, t]

    m.load_min_off = Constraint(C, m.T, rule=_min_off_rule)

    def _max_starts_rule(model, c):
        cap = loads[c].max_starts_per_horizon
        if cap is None:
            return Constraint.Skip
        return sum(model.load_start[c, t] for t in model.T) <= cap

    m.load_max_starts = Constraint(C, rule=_max_starts_rule)

    # Ramp while running; a start/stop relaxes it for the transition slot
    # (classic UC form). Slot 0 has no known previous power - the edge cycle
    # guard owns the live transition (Inkrement 3), so it is skipped here.
    def _ramp_up_rule(model, c, t):
        R = loads[c].ramp_kw_per_slot
        if R is None or t == 0:
            return Constraint.Skip
        return (
            model.load_power[c, t] - model.load_power[c, t - 1]
            <= R + loads[c].max_power_kw * model.load_start[c, t]
        )

    m.load_ramp_up = Constraint(C, m.T, rule=_ramp_up_rule)

    def _ramp_down_rule(model, c, t):
        R = loads[c].ramp_kw_per_slot
        if R is None or t == 0:
            return Constraint.Skip
        return (
            model.load_power[c, t - 1] - model.load_power[c, t]
            <= R + loads[c].max_power_kw * model.load_stop[c, t]
        )

    m.load_ramp_down = Constraint(C, m.T, rule=_ramp_down_rule)

    # -- requirements as constraints with honest slack (§12.3) ---------------
    order = _requirement_order(loads)
    slack_refs: dict[tuple[int, str], list[tuple]] = {}
    for c, req in order:
        rid = req.requirement_id
        name = "load_%d_req_%s" % (
            c,
            rid.replace(".", "_").replace("-", "_").replace("@", "_"),
        )
        dims: list[tuple] = []
        if req.kind == "fixed_window":
            w = list(req.window_slots)
            sl = Var(w, domain=NonNegativeReals, bounds=(0.0, req.target_kw))
            m.add_component(name + "_slack", sl)
            m.add_component(
                name + "_hold",
                Constraint(
                    w,
                    rule=lambda model, t, c=c, sl=sl, target=req.target_kw: (
                        model.load_power[c, t] + sl[t] >= target
                    ),
                ),
            )
            dims.append(("kw_slots", None, req.target_kw * len(w), sl, w))
        else:  # flexible_task
            w = list(req.window_slots)
            if req.required_minutes is not None:
                smin = Var(
                    domain=NonNegativeReals,
                    bounds=(0.0, float(req.required_minutes)),
                )
                m.add_component(name + "_slack_min", smin)
                m.add_component(
                    name + "_runtime",
                    Constraint(
                        expr=sum(m.load_on[c, t] for t in w) * inp.slot_minutes
                        + smin
                        >= req.required_minutes
                    ),
                )
                dims.append(("minutes", smin, float(req.required_minutes), None, None))
            if req.required_kwh is not None:
                skwh = Var(
                    domain=NonNegativeReals, bounds=(0.0, req.required_kwh)
                )
                m.add_component(name + "_slack_kwh", skwh)
                m.add_component(
                    name + "_energy",
                    Constraint(
                        expr=sum(m.load_power[c, t] for t in w) * dt + skwh
                        >= req.required_kwh
                    ),
                )
                dims.append(("kwh", skwh, req.required_kwh, None, None))
            if req.contiguous:
                # Exactly one run block inside the window (E5): every block
                # begins with a start, and outside-window slots are fixed off,
                # so <= 1 in-window start = one contiguous block.
                m.add_component(
                    name + "_contiguous",
                    Constraint(expr=sum(m.load_start[c, t] for t in w) <= 1),
                )
        slack_refs[(c, rid)] = dims
    m._vp_load_slacks = slack_refs

    # -- stage-1 expression: strict lexicography over normalized slacks ------
    stage1_terms = []
    tiers = min(len(order), _STAGE1_MAX_TIERS)
    for i, (c, req) in enumerate(order):
        tier = min(i, _STAGE1_MAX_TIERS - 1)
        weight = _STAGE1_WEIGHT_BASE ** (tiers - 1 - min(tier, tiers - 1))
        for unit, scalar, normalizer, per_slot, w in slack_refs[(c, req.requirement_id)]:
            expr = (
                sum(per_slot[t] for t in w) / normalizer
                if per_slot is not None
                else scalar / normalizer
            )
            stage1_terms.append(weight * expr)
    m._vp_stage1_expr = sum(stage1_terms) if stage1_terms else None
    m._vp_stage2_expr = None  # set by the allocation matrix when 'avoid' exists


def _allocation_matrix_needed(inp: CoOptimizationInput, m: ConcreteModel) -> bool:
    """D2: the matrix exists only when a consumer actually restricts or
    prefers a source - a grid policy other than allow, a storage-discharge
    ban (with storages present), or the storage_first preference (which needs
    the matrix to price WHERE the consumer's energy comes from; see the
    CONSUMER_PREFERENCE_TIEBREAK note). A consumer_first load alone builds no
    matrix: at a true tie the battery-throughput epsilon already yields the
    optional storage charge to the consumer, so the small model suffices."""
    grid_policy, storage_ok = _slot_masks(inp)
    for c, load in enumerate(inp.controllable_loads):
        if any(pol != "allow" for pol in grid_policy[c].values()):
            return True
        if inp.storages and any(not ok for ok in storage_ok[c].values()):
            return True
        if inp.storages and load.storage_relation == "storage_first":
            return True
    return False


def _add_allocation_matrix(m: ConcreteModel, inp: CoOptimizationInput) -> None:
    """The bilanztreue Quellen/Senken-Zuordnung (§6/§12.2): per slot, every
    physical source's power is split exactly over the sinks and every sink's
    power is covered exactly by sources - no kWh twice, and the physical
    balance is untouched (the matrix restricts the SPLIT, not the flows).

    Sources: uncurtailed PV, storage discharge, grid import (+ a defensive
    ``residual`` source for pathological negative base-load forecasts).
    Sinks: uncontrollable base load (+ negative producer forecasts), each
    consumer, storage charge, grid export.
    """
    loads = inp.controllable_loads
    n = inp.slots
    dt = inp.slot_hours
    E = range(len(inp.storages))
    P = range(len(inp.producers))
    grid_policy, storage_ok = _slot_masks(inp)

    sources = ["grid"]
    if inp.producers:
        sources.append("pv")
    if inp.storages:
        sources.append("storage")
    pos_gen = [
        sum(max(p.generation_kw[t], 0.0) for p in inp.producers) for t in range(n)
    ]
    neg_gen = [
        sum(max(-p.generation_kw[t], 0.0) for p in inp.producers) for t in range(n)
    ]
    base_pos = [max(inp.base_load_kw[t], 0.0) for t in range(n)]
    base_neg = [max(-inp.base_load_kw[t], 0.0) for t in range(n)]
    if any(v > 0.0 for v in base_neg):
        sources.append("residual")

    sinks = ["base", "export"] + [f"load{c}" for c in range(len(loads))]
    if inp.storages:
        sinks.append("charge")

    m.alloc = Var(sources, sinks, m.T, domain=NonNegativeReals)

    def _source_total(model, s, t):
        if s == "pv":
            return pos_gen[t] - sum(model.curtail[p, t] for p in P)
        if s == "storage":
            return sum(model.discharge[e, t] for e in E)
        if s == "grid":
            return model.grid_import[t]
        return base_neg[t]  # residual

    def _sink_total(model, k, t):
        if k == "base":
            return base_pos[t] + neg_gen[t]
        if k == "export":
            return model.grid_export[t]
        if k == "charge":
            return sum(model.charge[e, t] for e in E)
        return model.load_power[int(k[4:]), t]

    m.alloc_source = Constraint(
        sources,
        m.T,
        rule=lambda model, s, t: sum(model.alloc[s, k, t] for k in sinks)
        == _source_total(model, s, t),
    )
    m.alloc_sink = Constraint(
        sinks,
        m.T,
        rule=lambda model, k, t: sum(model.alloc[s, k, t] for s in sources)
        == _sink_total(model, k, t),
    )

    # Restrictions: fixed cells, never penalties (§6).
    avoid_terms = []
    for c in range(len(loads)):
        sink = f"load{c}"
        for t in range(n):
            pol = grid_policy[c].get(t)
            if pol == "forbid":
                m.alloc["grid", sink, t].fix(0.0)
            elif pol == "avoid":
                avoid_terms.append(m.alloc["grid", sink, t])
            if "storage" in sources and not storage_ok[c].get(t, False):
                m.alloc["storage", sink, t].fix(0.0)
    # Stage 2 (D2): ONLY the avoid-consumers' allocated grid energy, in kWh.
    m._vp_stage2_expr = sum(avoid_terms) * dt if avoid_terms else None

    # The Energiepräferenz as an allocation epsilon (§6/D6, stage-3 class).
    # storage_first prices LOCAL energy (PV/storage) feeding that consumer:
    # at a true cost tie the consumer draws grid and local energy stays with
    # the storage. consumer_first deliberately needs NO term of its own - the
    # existing battery-throughput epsilon IS its tie-break (optional storage
    # cycling costs epsilon, so at a tie the consumer is served first), and an
    # explicit pv->charge label penalty could perversely nudge charge timing
    # toward import slots at exact ties. A pure preference: never a permission,
    # never a stage (D2).
    pref_terms = []
    if inp.storages:
        for c, load in enumerate(loads):
            if load.storage_relation != "storage_first":
                continue
            sink = f"load{c}"
            for t in range(n):
                if "pv" in sources:
                    pref_terms.append(m.alloc["pv", sink, t])
                if "storage" in sources:
                    pref_terms.append(m.alloc["storage", sink, t])
    if pref_terms:
        m._vp_pref_expr = CONSUMER_PREFERENCE_TIEBREAK_EUR_PER_KW * sum(pref_terms)


def _lexicographic_solve(model: ConcreteModel) -> None:
    """The (up to) three-stage lexicographic driver (D2, §12.4).

    Without consumer slacks and without an avoid-consumer this is a SINGLE
    solve - the pre-consumer path byte for byte. Otherwise each present stage
    is solved on its own objective and fixed as a capped constraint
    (``STAGE_FIX_TOLERANCE``, documented above the pinned MIP gap) before the
    unchanged economic objective decides within the remaining freedom.
    Infeasibility propagates so the §14a fallback semantics stay intact.
    """
    stage1 = getattr(model, "_vp_stage1_expr", None)
    stage2 = getattr(model, "_vp_stage2_expr", None)
    if stage1 is None and stage2 is None:
        _solve(model)
        return
    model.total_cost.deactivate()
    try:
        if stage1 is not None:
            model.stage1_obj = Objective(expr=stage1, sense=minimize)
            _solve(model)
            j1 = float(value(model.stage1_obj))
            model.stage1_obj.deactivate()
            model.stage1_cap = Constraint(
                expr=stage1 <= j1 + STAGE_FIX_TOLERANCE * max(1.0, abs(j1))
            )
        if stage2 is not None:
            model.stage2_obj = Objective(expr=stage2, sense=minimize)
            _solve(model)
            j2 = float(value(model.stage2_obj))
            model.stage2_obj.deactivate()
            model.stage2_cap = Constraint(
                expr=stage2 <= j2 + STAGE_FIX_TOLERANCE * max(1.0, abs(j2))
            )
    finally:
        model.total_cost.activate()
    _solve(model)


def co_optimize(
    inp: CoOptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SitePlan:
    """Solve the multi-entity MILP and assemble the :class:`SitePlan`.

    Raises :class:`voltpilot_optimization.solver.InfeasiblePlanError` when no
    feasible dispatch exists; callers retry via
    :func:`co_optimize_ignoring_grid_limit` (the v1 §14a fallback semantics).
    """
    model = build_co_model(inp)
    _lexicographic_solve(model)
    return _extract_site_plan(model, inp, plan_id, generated_at)


def co_optimize_ignoring_grid_limit(
    inp: CoOptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SitePlan:
    """Fallback solve with the §14a module deselected (see :func:`co_optimize`)."""
    model = build_co_model(inp, enforce_grid_limit=False)
    _lexicographic_solve(model)
    return _extract_site_plan(model, inp, plan_id, generated_at)


def _extract_loads(
    model: ConcreteModel, inp: CoOptimizationInput
) -> list[LoadDispatch]:
    """Consumer dispatch extraction: per-slot on/power plus the honest reason
    attribution (§15) - a served slot names its highest-priority covering
    requirement (fixed windows before flexible tasks, then the E9 order); an
    off slot names nothing. Unserved shortfalls surface per requirement with
    a cause: the §14a grid limit when that module constrained the site, else
    the only other structural cause - no permitted energy source."""
    n = inp.slots
    slack_refs = getattr(model, "_vp_load_slacks", {})
    grid_limited = hasattr(model, "grid_import_cap")
    dispatches: list[LoadDispatch] = []
    for c, load in enumerate(inp.controllable_loads):
        with_sets = [(req, set(req.window_slots)) for req in load.requirements]
        slots: list[LoadSlot] = []
        for t in range(n):
            power = float(value(model.load_power[c, t]))
            on = float(value(model.load_on[c, t])) > 0.5
            reason = None
            rid = None
            if on:
                covering = [req for req, s in with_sets if t in s]
                covering.sort(
                    key=lambda r: (
                        0 if r.kind == "fixed_window" else 1,
                        r.service_rank if r.service_rank is not None else 1_000_000,
                        r.deadline_slot,
                        r.requirement_id,
                    )
                )
                if covering:
                    reason = covering[0].reason_code
                    rid = covering[0].requirement_id
            slots.append(
                LoadSlot(
                    start=inp.slot_starts[t],
                    on=on,
                    power_kw=round(max(power, 0.0), 4),
                    reason_code=reason,
                    requirement_id=rid,
                )
            )
        unserved: list[UnservedRequirement] = []
        for req in load.requirements:
            for unit, scalar, norm, per_slot, w in slack_refs.get(
                (c, req.requirement_id), []
            ):
                total = (
                    sum(float(value(per_slot[t])) for t in w)
                    if per_slot is not None
                    else float(value(scalar))
                )
                # Report NORMALIZED shortfalls above 1e-4 (0.01% of the
                # demand): the stage-1 cap tolerates STAGE_FIX_TOLERANCE of
                # normalized slack, so stage 3 may legally shave epsilon-dust
                # off a fully-served requirement - dust is not a shortfall.
                if total / norm > 1e-4:
                    unserved.append(
                        UnservedRequirement(
                            requirement_id=req.requirement_id,
                            shortfall=round(total, 4),
                            unit=unit,
                            reason_code=(
                                REASON_GRID_LIMIT
                                if grid_limited
                                else REASON_NO_PERMITTED_ENERGY
                            ),
                        )
                    )
        dispatches.append(
            LoadDispatch(
                entity_id=load.entity_id,
                control_kind=load.control_kind,
                slots=slots,
                unserved=tuple(unserved),
                # K2 (P5): reiche das Flag DURCH - der Solver plant unveraendert,
                # nur der Publisher liest es.
                has_local_source=load.has_local_source,
            )
        )
    return dispatches


def _extract_site_plan(
    model: ConcreteModel,
    inp: CoOptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SitePlan:
    dt = inp.slot_hours
    n = inp.slots

    # Unrounded solver values first (the v1 extraction rule: grid/cost derive
    # from the raw optimum, rounding happens only at the artifact boundary).
    raw_setpoint = [
        [
            float(value(model.charge[e, t])) - float(value(model.discharge[e, t]))
            for t in range(n)
        ]
        for e in range(len(inp.storages))
    ]
    raw_throughput = [
        [
            float(value(model.charge[e, t])) + float(value(model.discharge[e, t]))
            for t in range(n)
        ]
        for e in range(len(inp.storages))
    ]
    # Clamp solver tolerance noise: curtailment is [0, gen] by construction
    # (the v1 extraction rule per producer).
    raw_curtail = [
        [
            min(
                max(float(value(model.curtail[p, t])), 0.0),
                max(inp.producers[p].generation_kw[t], 0.0),
            )
            for t in range(n)
        ]
        for p in range(len(inp.producers))
    ]

    storages: list[StorageDispatch] = []
    for e, entity in enumerate(inp.storages):
        wear_each_way = entity.params.wear_cost_eur_per_kwh_each_way
        slots = [
            StorageSlot(
                start=inp.slot_starts[t],
                setpoint_kw=round(raw_setpoint[e][t], 4),
                soc_kwh=round(float(value(model.soc[e, t + 1])), 4),
                wear_cost_eur=round(
                    wear_each_way * raw_throughput[e][t] * dt, 6
                ),
            )
            for t in range(n)
        ]
        storages.append(
            StorageDispatch(
                entity_id=entity.entity_id,
                params=entity.params,
                charge_from_grid_allowed=inp.grid_charge_allowed(entity),
                slots=slots,
                terminal_value_eur_per_kwh=round(
                    inp.effective_terminal_value_eur_per_kwh(entity), 6
                ),
            )
        )

    producers: list[ProducerDispatch] = []
    for p, producer in enumerate(inp.producers):
        producers.append(
            ProducerDispatch(
                entity_id=producer.entity_id,
                slots=[
                    ProducerSlot(
                        start=inp.slot_starts[t],
                        generation_kw=round(producer.generation_kw[t], 4),
                        curtail_kw=round(raw_curtail[p][t], 4),
                    )
                    for t in range(n)
                ],
            )
        )

    loads = _extract_loads(model, inp) if inp.controllable_loads else []

    site_slots: list[SiteSlot] = []
    for t in range(n):
        # Net grid power recovered from the balance on the UNROUNDED optimum
        # (exact by the is_importing binary, the v1 extraction rule). The
        # consumer dispatch is part of the balance; the BASELINE stays the
        # uncontrollable residual (no battery, no controllable consumers) -
        # SitePlan.savings_eur is therefore NOT consumer-adjusted (an internal
        # shadow metric; no customer surface reads it for consumer sites).
        grid_kw = (
            inp.base_load_kw[t]
            + sum(
                raw_curtail[p][t] - inp.producers[p].generation_kw[t]
                for p in range(len(inp.producers))
            )
            + sum(raw_setpoint[e][t] for e in range(len(inp.storages)))
            + sum(
                float(value(model.load_power[c, t]))
                for c in range(len(inp.controllable_loads))
            )
        )
        site_slots.append(
            SiteSlot(
                start=inp.slot_starts[t],
                grid_kw=round(grid_kw, 4),
                base_load_kw=round(inp.base_load_kw[t], 4),
                price_eur_mwh=inp.prices_eur_mwh[t],
                cost_eur=round(inp.cashflow_cost_eur(t, grid_kw), 6),
                baseline_cost_eur=round(inp.baseline_cost_eur(t), 6),
            )
        )

    return SitePlan(
        plan_id=plan_id,
        tenant_id=inp.tenant_id,
        site_id=inp.site_id,
        device_id=inp.device_id,
        generated_at=generated_at,
        storages=storages,
        producers=producers,
        loads=loads,
        site_slots=site_slots,
        slot_minutes=inp.slot_minutes,
        peak_target_kw=(
            round(float(value(model.peak)), 4)
            if inp.leistungspreis_eur_kw is not None and hasattr(model, "peak")
            else None
        ),
        objective_eur=float(value(model.total_cost)),
    )

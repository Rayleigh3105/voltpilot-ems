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
- **Controllable loads are declared, not yet dispatched** (empty list
  enforced in the input; the E4 follow-ups add their semantics).
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
    CoOptimizationInput,
    ProducerDispatch,
    ProducerSlot,
    SitePlan,
    SiteSlot,
    StorageDispatch,
    StorageSlot,
)
from voltpilot_optimization.modules import SolverModule, select_modules
from voltpilot_optimization.solver import (
    BATTERY_WEAR_TIEBREAK_EUR_PER_KW,
    CURTAIL_TIEBREAK_EUR_PER_KW,
    EARLY_CHARGE_TIEBREAK_EUR_PER_KW,
    _solve,
)


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

    # The tightest physical bounds on a slot's site import/export (the v1
    # big-Ms generalized by summation; max(-x, 0) guards pathological negative
    # forecasts only).
    def _m_import(t: int) -> float:
        return (
            max(inp.base_load_kw[t], 0.0)
            + sum(s.params.max_charge_kw for s in storages)
            + sum(max(-p.generation_kw[t], 0.0) for p in producers)
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
    # connection point.
    m.grid_balance = Constraint(
        m.T,
        rule=lambda model, t: model.grid_import[t] - model.grid_export[t]
        == inp.base_load_kw[t]
        + sum(model.curtail[p, t] - producers[p].generation_kw[t] for p in P)
        + sum(model.charge[e, t] - model.discharge[e, t] for e in E),
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
            for t in m.T
        )
        + module_cost
        - terminal_credit,
        sense=minimize,
    )
    return m


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
    _solve(model)
    return _extract_site_plan(model, inp, plan_id, generated_at)


def co_optimize_ignoring_grid_limit(
    inp: CoOptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SitePlan:
    """Fallback solve with the §14a module deselected (see :func:`co_optimize`)."""
    model = build_co_model(inp, enforce_grid_limit=False)
    _solve(model)
    return _extract_site_plan(model, inp, plan_id, generated_at)


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

    site_slots: list[SiteSlot] = []
    for t in range(n):
        # Net grid power recovered from the balance on the UNROUNDED optimum
        # (exact by the is_importing binary, the v1 extraction rule).
        grid_kw = (
            inp.base_load_kw[t]
            + sum(
                raw_curtail[p][t] - inp.producers[p].generation_kw[t]
                for p in range(len(inp.producers))
            )
            + sum(raw_setpoint[e][t] for e in range(len(inp.storages)))
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
        site_slots=site_slots,
        slot_minutes=inp.slot_minutes,
        peak_target_kw=(
            round(float(value(model.peak)), 4)
            if inp.leistungspreis_eur_kw is not None and hasattr(model, "peak")
            else None
        ),
        objective_eur=float(value(model.total_cost)),
    )

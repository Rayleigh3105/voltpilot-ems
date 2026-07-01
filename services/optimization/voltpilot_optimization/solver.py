"""The battery-dispatch MILP (architecture section 11).

Deterministic cost minimization over a rolling 24h horizon in 15-min slots -
the *optimize* half of predict-then-optimize. Inputs (prices, load/PV
forecasts, SoC, battery params) arrive as a plain :class:`OptimizationInput`;
the solver never knows where a forecast came from, so the forecasting layer can
later be replaced by learned models without touching this module.

Formulation (per slot t, dt = 0.25 h):

    minimize   sum_t  price_t [EUR/MWh] * grid_t [kW] * dt / 1000
    where      grid_t = load_t - pv_t + charge_t - discharge_t     (+import/-export)
    s.t.       0 <= charge_t    <= max_charge    * is_charging_t
               0 <= discharge_t <= max_discharge * (1 - is_charging_t)
               soc_{t+1} = soc_t + (eta * charge_t - discharge_t / eta) * dt
               soc_min <= soc_t <= soc_max
               |grid_t| <= grid_limit                              (observed §14a, hard cap)
               soc_T >= soc_0                                      (terminal condition)

Design decisions, deliberately:

- **Energy pricing is symmetric** at the day-ahead spot price for import and
  export (the Direktvermarktung MVP assumption; feed-in tariffs / spreads are
  future work). The objective therefore uses one signed grid variable.
- **Simultaneous charge+discharge is excluded with binaries** (``is_charging``),
  not by an efficiency argument: with only round-trip losses in the model, an
  LP would happily charge AND discharge in the same slot whenever the price is
  NEGATIVE (burning energy through the round trip is "profitable" then), and
  negative day-ahead prices are a normal occurrence in DE-LU. 96 binaries are
  trivial for HiGHS (solves in milliseconds).
- **Terminal condition ``soc_T >= soc_0``**: the plan may not "earn" its savings
  by simply dumping stored energy; whatever it discharges it must have charged
  within the horizon. On a flat price curve the optimum is exactly idle.
- **Efficiency is split symmetrically** (sqrt of the round trip per direction),
  so stored energy is charged and discharged at the same marginal loss.

The solver toolchain is Pyomo + HiGHS via ``highspy`` (the repo-wide choice,
see AGENTS.md); ``highspy`` stays a lazy import behind the optional ``solver``
extra so the package imports (and non-solver tests run) without the wheel.
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

from voltpilot_optimization.domain import (
    OptimizationInput,
    PlanSlot,
    SchedulePlan,
)


class InfeasiblePlanError(RuntimeError):
    """The MILP has no feasible solution (in practice: the §14a grid limit is
    tighter than the site's residual load even with full battery support)."""


def build_model(inp: OptimizationInput, enforce_grid_limit: bool = True) -> ConcreteModel:
    """Build the dispatch MILP for one site over the horizon.

    Kept separate from solving so the formulation is testable without the
    HiGHS wheel installed.
    """
    p = inp.battery
    n = inp.slots
    dt = inp.slot_hours
    eta = p.one_way_efficiency
    soc0 = p.clamp_soc_kwh(inp.initial_soc_kwh)

    m = ConcreteModel()
    m.T = RangeSet(0, n - 1)  # decision slots
    m.S = RangeSet(0, n)  # SoC nodes (slot boundaries)

    m.charge = Var(m.T, domain=NonNegativeReals, bounds=(0, p.max_charge_kw))
    m.discharge = Var(m.T, domain=NonNegativeReals, bounds=(0, p.max_discharge_kw))
    m.is_charging = Var(m.T, domain=Binary)
    m.soc = Var(m.S, bounds=(p.soc_min_kwh, p.soc_max_kwh))
    m.soc[0].fix(soc0)

    def _grid(model, t):
        return inp.load_kw[t] - inp.pv_kw[t] + model.charge[t] - model.discharge[t]

    m.soc_dynamics = Constraint(
        m.T,
        rule=lambda model, t: model.soc[t + 1]
        == model.soc[t] + (eta * model.charge[t] - model.discharge[t] / eta) * dt,
    )
    # Mutually exclusive charge/discharge (see module docstring).
    m.charge_gate = Constraint(
        m.T, rule=lambda model, t: model.charge[t] <= p.max_charge_kw * model.is_charging[t]
    )
    m.discharge_gate = Constraint(
        m.T,
        rule=lambda model, t: model.discharge[t]
        <= p.max_discharge_kw * (1 - model.is_charging[t]),
    )
    if enforce_grid_limit and inp.grid_limit_kw is not None:
        m.grid_import_cap = Constraint(
            m.T, rule=lambda model, t: _grid(model, t) <= inp.grid_limit_kw
        )
        m.grid_export_cap = Constraint(
            m.T, rule=lambda model, t: _grid(model, t) >= -inp.grid_limit_kw
        )
    # Terminal condition: never plan a net battery drain over the horizon.
    m.terminal_soc = Constraint(rule=lambda model: model.soc[n] >= soc0)

    m.total_cost = Objective(
        expr=sum(inp.prices_eur_mwh[t] * _grid(m, t) * dt / 1000.0 for t in m.T),
        sense=minimize,
    )
    return m


def optimize(
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SchedulePlan:
    """Solve the dispatch MILP and assemble the resulting :class:`SchedulePlan`.

    Raises :class:`InfeasiblePlanError` when no feasible dispatch exists (the
    engine then retries without the grid-limit constraint - the physical §14a
    limit is enforced by the grid operator and the edge guards regardless, and
    an advisory plan is better than none).
    """
    model = build_model(inp)
    _solve(model)
    return _extract_plan(model, inp, plan_id, generated_at)


def optimize_ignoring_grid_limit(
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SchedulePlan:
    """Fallback solve with the §14a cap dropped (see :func:`optimize`)."""
    model = build_model(inp, enforce_grid_limit=False)
    _solve(model)
    return _extract_plan(model, inp, plan_id, generated_at)


def _solve(model: ConcreteModel) -> None:
    # Lazy import so this module (and the model-building tests) never hard-fail
    # where the HiGHS wheel is unavailable.
    from pyomo.contrib.appsi.base import TerminationCondition
    from pyomo.contrib.appsi.solvers.highs import Highs

    solver = Highs()
    solver.config.load_solution = False
    results = solver.solve(model)
    if results.termination_condition != TerminationCondition.optimal:
        raise InfeasiblePlanError(
            f"dispatch MILP not solved to optimality: {results.termination_condition}"
        )
    results.solution_loader.load_vars()


def _extract_plan(
    model: ConcreteModel,
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SchedulePlan:
    dt = inp.slot_hours
    slots: list[PlanSlot] = []
    for t in range(inp.slots):
        charge = float(value(model.charge[t]))
        discharge = float(value(model.discharge[t]))
        battery_kw = charge - discharge
        grid_kw = inp.load_kw[t] - inp.pv_kw[t] + battery_kw
        price = inp.prices_eur_mwh[t]
        slots.append(
            PlanSlot(
                start=inp.slot_starts[t],
                battery_kw=round(battery_kw, 4),
                grid_kw=round(grid_kw, 4),
                soc_kwh=round(float(value(model.soc[t + 1])), 4),
                load_kw=round(inp.load_kw[t], 4),
                pv_kw=round(inp.pv_kw[t], 4),
                price_eur_mwh=price,
                cost_eur=round(price * grid_kw * dt / 1000.0, 6),
                baseline_cost_eur=round(inp.baseline_cost_eur(t), 6),
            )
        )
    return SchedulePlan(
        plan_id=plan_id,
        tenant_id=inp.tenant_id,
        site_id=inp.site_id,
        device_id=inp.device_id,
        generated_at=generated_at,
        battery=inp.battery,
        slots=slots,
        slot_minutes=inp.slot_minutes,
    )

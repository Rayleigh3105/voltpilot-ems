"""The battery-dispatch MILP (architecture section 11).

Deterministic cost minimization over a rolling 24h horizon in 15-min slots -
the *optimize* half of predict-then-optimize. Inputs (prices, load/PV
forecasts, SoC, battery params) arrive as a plain :class:`OptimizationInput`;
the solver never knows where a forecast came from, so the forecasting layer can
later be replaced by learned models without touching this module.

Formulation (per slot t, dt = 0.25 h):

    minimize   sum_t  price_t [EUR/MWh] * grid_t [kW] * dt / 1000
                      + epsilon * curtail_t                        (tie-break, see below)
    where      grid_t = load_t - pv_t + curtail_t + charge_t - discharge_t   (+import/-export)
    s.t.       0 <= charge_t    <= max_charge    * is_charging_t
               0 <= discharge_t <= max_discharge * (1 - is_charging_t)
               0 <= curtail_t   <= pv_t                            (only ever a REDUCTION)
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
- **PV curtailment is a first-class decision** (``curtail_t``, Phase 3 of the
  fleet overview): without it, ``grid = load - pv + charge - discharge`` FORCES
  the plant to export surplus PV even at negative prices - with a full battery
  the plan then literally pays to feed in. Curtailment is bounded by the PV
  forecast (only ever a *reduction* of feed-in, never negative generation - the
  safety property the edge re-clamps), and there is deliberately NO price
  condition in the model: with symmetric spot pricing, discarding energy is
  optimal exactly when the price is negative (at positive prices it burns
  revenue), so the economics pick the right slots on their own. A tiny
  tie-break penalty (``CURTAIL_TIEBREAK_EUR_PER_KW``) keeps the solution
  deterministic where the price makes curtailing cost-neutral (price == 0, or
  PV already fully consumed on site): prefer NOT curtailing. It corresponds to
  a price threshold of ~-0.004 EUR/MWh - negligible against real negative
  prices, but it means hairline-negative slots (0 > price > -0.004) stay
  uncurtailed rather than churning the inverter for fractions of a cent.
- **A twin tie-break on battery throughput** (``BATTERY_WEAR_TIEBREAK_EUR_PER_KW``,
  on charge + discharge) keeps the battery IDLE when cycling earns nothing.
  Without it, curtailment introduces a degenerate tie: routing
  otherwise-curtailed PV through the battery (charge now, discharge into a
  capped export later) moves no money but slightly lowers total curtailment,
  so the curtailment tie-break alone would PREFER that pointless wear. The
  wear tie-break is the same epsilon scale (~0.008 EUR/MWh equivalent), so
  real arbitrage is never distorted - it only breaks exact ties toward the
  battery-friendly plan.

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


# Tie-break penalty on curtailment (EUR per kW per slot): strictly prefer NOT
# curtailing whenever the price makes it cost-neutral. See the module docstring.
CURTAIL_TIEBREAK_EUR_PER_KW = 1e-6

# Tie-break penalty on battery throughput (EUR per kW charge/discharge per
# slot): strictly prefer an idle battery when cycling moves no money. See the
# module docstring for why curtailment makes this necessary.
BATTERY_WEAR_TIEBREAK_EUR_PER_KW = 1e-6


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
    # Curtailment can only ever REDUCE feed-in: bounded per slot by the PV
    # forecast, so pv - curtail (the published inverter cap) is never negative.
    m.curtail = Var(
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, t: (0.0, max(inp.pv_kw[t], 0.0)),
    )
    m.soc = Var(m.S, bounds=(p.soc_min_kwh, p.soc_max_kwh))
    m.soc[0].fix(soc0)

    def _grid(model, t):
        return (
            inp.load_kw[t]
            - inp.pv_kw[t]
            + model.curtail[t]
            + model.charge[t]
            - model.discharge[t]
        )

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
        expr=sum(
            inp.prices_eur_mwh[t] * _grid(m, t) * dt / 1000.0
            + CURTAIL_TIEBREAK_EUR_PER_KW * m.curtail[t]
            + BATTERY_WEAR_TIEBREAK_EUR_PER_KW * (m.charge[t] + m.discharge[t])
            for t in m.T
        ),
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
        # Clamp solver tolerance noise: curtailment is [0, pv] by construction.
        curtail_kw = min(max(float(value(model.curtail[t])), 0.0), max(inp.pv_kw[t], 0.0))
        grid_kw = inp.load_kw[t] - inp.pv_kw[t] + curtail_kw + battery_kw
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
                curtail_kw=round(curtail_kw, 4),
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

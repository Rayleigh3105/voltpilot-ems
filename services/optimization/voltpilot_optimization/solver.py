"""The battery-dispatch MILP (architecture section 11).

Deterministic market-revenue maximization over a rolling 24h horizon in 15-min
slots - the *optimize* half of predict-then-optimize. Inputs (prices, load/PV
forecasts, SoC, battery params) arrive as a plain :class:`OptimizationInput`;
the solver never knows where a forecast came from, so the forecasting layer can
later be replaced by learned models without touching this module.

Formulation (per slot t, dt = 0.25 h):

    minimize   sum_t  (import_price_t * import_t - export_value_t * export_t) * dt / 1000
                      + c_wear/2 * (charge_t + discharge_t) * dt   (battery wear, see below)
                      + epsilon * curtail_t                        (tie-break, see below)
               - V_end * (soc_T - soc_0)                           (terminal energy value, see below)
    where      import_t - export_t = load_t - pv_t + curtail_t + charge_t - discharge_t
    s.t.       0 <= charge_t    <= max_charge    * is_charging_t
               0 <= discharge_t <= max_discharge * (1 - is_charging_t)
               0 <= import_t    <= M_imp_t * is_importing_t        (never import AND export)
               0 <= export_t    <= M_exp_t * (1 - is_importing_t)
               0 <= curtail_t   <= pv_t                            (only ever a REDUCTION)
               soc_{t+1} = soc_t + (eta * charge_t - discharge_t / eta) * dt
               soc_floor <= soc_t <= soc_max                       (soc_floor: 5% technical
                                                                    floor, raised by the P11
                                                                    backup reserve, see below)
               import_t <= grid_limit, export_t <= grid_limit      (observed §14a, hard cap)
    and, ONLY when netzladen_erlaubt is False (EEG mode, see below):
               charge_t <= max(pv_t - load_t, 0)                   (charge from PV surplus only)
               import_t <= M_imp_t * (1 - is_charging_t)           (never import while charging)

Design decisions, deliberately:

- **Import and export are priced ASYMMETRICALLY per slot (P1, Stage 2 of the
  optimizer redesign - the market-revenue objective).** ``import_price_t`` is
  what an imported kWh really costs the site (its supply tariff: spot +
  Aufschlag for a dynamic tariff, the flat retail price for a fixed one, bare
  spot for a spot-settled load); ``export_value_t`` is what an exported kWh
  really earns (spot + Marktprämie for Direktvermarktung, the feste
  EEG-Einspeisevergütung for an eigenverbrauch plant, bare spot otherwise) -
  built by :mod:`voltpilot_optimization.pricing`. Minimizing this signed
  cashflow IS maximizing market revenue. The pre-P1 symmetric bare-spot model
  (critique finding F1: economically wrong for nearly every real DACH
  prosumer) is the exact special case import_price == export_value == spot,
  which remains the fallback whenever tariff/remuneration data is absent.
  Under asymmetric prices, energy routing decisions become real: PV can serve
  the battery while the load imports cheaply, and a stored kWh goes to
  whichever flow (avoided import vs. export) earns more per slot - no
  hard-coded self-consumption preference anywhere (target report §2.2).
- **Simultaneous import+export is excluded with a second binary**
  (``is_importing``). With asymmetric prices this is not just a degeneracy
  guard: whenever export_value_t > import_price_t (a real configuration - a
  spot-settled Direktvermarktung site's premium makes export worth MORE than
  import costs), an LP would import and export unboundedly in the same slot to
  farm the difference without any physical flow. The big-Ms are the tightest
  physical bounds: M_imp_t = max(load_t, 0) + max_charge (+ any negative-PV
  guard), M_exp_t = max(pv_t, 0) + max_discharge (+ any negative-load guard).
- **Simultaneous charge+discharge is excluded with binaries** (``is_charging``),
  not by an efficiency argument: with only round-trip losses in the model, an
  LP would happily charge AND discharge in the same slot whenever the price is
  NEGATIVE (burning energy through the round trip is "profitable" then), and
  negative day-ahead prices are a normal occurrence in DE-LU. 192 binaries are
  trivial for HiGHS (solves in milliseconds).
- **Terminal ENERGY VALUE instead of a hard terminal floor (P3, Stage 3 of the
  optimizer redesign, critique finding F3).** The old constraint
  ``soc_T >= soc_0`` froze the battery on every low-PV day in EEG mode (no PV
  surplus means nothing may charge, so nothing may discharge either - a full
  battery idled through a 250 EUR/MWh evening peak, and through whole German
  winters) and forced merchant plans into uneconomic end-of-horizon buy-backs.
  Instead the objective credits ``V_end * (soc_T - soc_0)``: stored energy
  left at the horizon end is WORTH something, so the plan discharges whenever
  a slot genuinely beats that value and holds otherwise. ``V_end`` comes from
  :meth:`OptimizationInput.effective_terminal_value_eur_per_kwh` - a
  conservative low quantile of the horizon's own best-use prices, times the
  one-way efficiency, minus the pending discharge wear (derivation + config
  knobs in :mod:`voltpilot_optimization.config`). Because the same
  eta/wear terms price the in-horizon discharge, "discharge at exactly the
  anchor price" is an EXACT tie broken toward holding by the epsilon
  tie-breaks below: a flat price curve still plans an idle battery (zero
  savings on flat, preserved by construction), a trough or cheap
  end-of-horizon tail never triggers a dump (its value is below the anchor),
  and any genuinely better slot discharges. Note the plan may now realize
  energy stored BEFORE the horizon (that is the F3 fix); the ex-ante savings
  figure reflects it, the realized-earnings engine stays the honest number.
- **The backup-reserve SoC floor is a HARD constraint (P11).** A customer-
  configured ``site.backup_reserve_soc_pct`` raises the battery's lower SoC
  bound (``BatteryParams.soc_floor_kwh``): the plan NEVER schedules below it,
  no matter what the terminal value or any price says - reserve is a hard
  floor, V_end a soft value. (The Deye-Copilot scout documented that product
  silently draining below its configured min-SoC; VoltPilot's must hold.) A
  battery currently BELOW its reserve relaxes the floor to the actual start
  (feasibility; it may not discharge any further, and the rolling MPC re-plan
  ratchets the floor back up as it recovers).
- **Efficiency is split symmetrically** (sqrt of the round trip per direction),
  so stored energy is charged and discharged at the same marginal loss.
- **PV curtailment is a first-class decision** (``curtail_t``, Phase 3 of the
  fleet overview): without it, the grid balance FORCES the plant to export
  surplus PV even when feeding in costs money - with a full battery the plan
  then literally pays to feed in. Curtailment is bounded by the PV forecast
  (only ever a *reduction* of feed-in, never negative generation - the safety
  property the edge re-clamps), and there is deliberately NO price condition
  in the model: discarding energy is optimal exactly when the EXPORT VALUE is
  negative (at a positive export value it burns revenue), so the economics
  pick the right slots on their own. Under P1 that automatically fixes
  critique finding F6: a Direktvermarktung plant curtails at negative spot
  (the premium is suspended there, export value = spot < 0), while a
  feste-Vergütung plant commissioned before the Solarspitzengesetz NEVER
  curtails (its export value is the fixed rate, positive regardless of spot).
  A tiny tie-break penalty (``CURTAIL_TIEBREAK_EUR_PER_KW``) keeps the
  solution deterministic where the export value makes curtailing cost-neutral
  (value == 0, e.g. a post-Solarspitzengesetz plant in a negative-price slot,
  or PV already fully consumed on site): prefer NOT curtailing. It corresponds
  to a value threshold of ~-0.004 EUR/MWh - negligible against real negative
  prices, but it means hairline-negative slots stay uncurtailed rather than
  churning the inverter for fractions of a cent.
- **Battery degradation is PRICED, not epsilon-scale (P2 of the optimizer
  redesign, critique finding F2).** ``c_wear`` is the asset's wear cost per kWh
  cycled (``BatteryParams.wear_cost_ct_per_kwh``: the per-asset
  ``asset.wear_cost_ct_per_kwh`` override or the platform default, see
  :mod:`voltpilot_optimization.config` for the LFP derivation), levied as
  ``c_wear/2`` on every AC-side kWh of charge AND discharge - a full round
  trip of one kWh costs exactly ``c_wear``. A cycle therefore happens only
  when the spread genuinely clears wear on top of round-trip losses:
  ``eta^2 * p_discharge - p_charge > c_wear * 5 * (1 + eta^2)`` [EUR/MWh]
  (~38 EUR/MWh at the 4 ct default) - the pre-P2 model cycled ~3 full
  cycles/day chasing sub-cent spreads because its only wear signal was the
  1e-6 tie-break below. The spent wear is persisted per slot
  (``PlanSlot.wear_cost_eur`` -> ``schedule.wear_cost_eur``) so reporting can
  show the honest net savings.
- **A twin tie-break on battery throughput** (``BATTERY_WEAR_TIEBREAK_EUR_PER_KW``,
  on charge + discharge) keeps the battery IDLE when cycling earns nothing
  even when ``c_wear`` is configured to 0. Without it, curtailment introduces
  a degenerate tie: routing otherwise-curtailed PV through the battery
  (charge now, discharge into a capped export later) moves no money but
  slightly lowers total curtailment, so the curtailment tie-break alone would
  PREFER that pointless wear. The tie-break is the same epsilon scale
  (~0.008 EUR/MWh equivalent), so real economics are never distorted - it
  only breaks exact ties toward the battery-friendly plan.

- **The per-site grid-charging switch (``netzladen_erlaubt``, captain decision
  2026-07-07)** is exactly ONE conditional pair of constraints - merchant mode
  (``True``) builds the identical model as before, so the two modes share every
  other rule (prices, forecasts, §14a, efficiency, curtailment, tie-breaks)
  and merchant plans are regression-identical to the pre-switch optimizer.
  EEG mode (``False``, the DB default) enforces the Ausschliesslichkeitsprinzip:
  the battery charges ONLY from the site's own PV surplus, never from the grid.
  Two constraints, deliberately:

  1. ``charge_t <= max(pv_t - load_t, 0)`` - the headline rule on the forecast
     PV surplus (parameter-only, keeps the LP relaxation tight).
  2. ``import_t <= M_imp_t * (1 - is_charging_t)`` - no import while charging.
     This closes the CURTAILMENT loophole the first rule alone leaves open: at
     negative prices the model could otherwise curtail the PV fully AND charge
     "from PV" per rule 1 - the balance then imports the charge power from the
     grid (paid import replacing the discarded PV), which is precisely the
     Graustrom the EEG mode must exclude. With rule 2, a charging slot can
     never be an importing slot, so charge <= pv - curtail - load holds and
     the stored energy is provably solar (which is also why the pricing layer
     may credit EEG remuneration on ALL export in EEG mode - see
     :mod:`voltpilot_optimization.pricing`). ``M_imp_t`` is the same physical
     import bound the import/export exclusion uses, so the big-M never binds
     when the battery is not charging. Curtailment itself stays unrestricted -
     it limits FEED-IN, not charge availability, and full curtailment while
     importing the LOAD is still a legitimate (and EEG-clean) negative-price
     play.

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
    # SoC lower bound: the 5% technical floor, raised by the customer's backup
    # reserve (P11, hard), relaxed to the actual start when the battery
    # currently sits below it (see BatteryParams.soc_floor_kwh).
    soc_floor = p.soc_floor_kwh(soc0)
    m.soc = Var(m.S, bounds=(soc_floor, p.soc_max_kwh))
    m.soc[0].fix(soc0)

    # The tightest physical bounds on a slot's import/export (see module
    # docstring): import <= load + charge (curtail cancels at most the full
    # PV), export <= pv + discharge. The max(-x, 0) terms only guard against
    # pathological negative forecasts ever making the big-M cut into the
    # feasible region.
    def _m_import(t: int) -> float:
        return max(inp.load_kw[t], 0.0) + p.max_charge_kw + max(-inp.pv_kw[t], 0.0)

    def _m_export(t: int) -> float:
        return max(inp.pv_kw[t], 0.0) + p.max_discharge_kw + max(-inp.load_kw[t], 0.0)

    m.grid_import = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_import(t))
    )
    m.grid_export = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_export(t))
    )
    m.is_importing = Var(m.T, domain=Binary)

    # The grid balance ties the split import/export to the physical flows.
    m.grid_balance = Constraint(
        m.T,
        rule=lambda model, t: model.grid_import[t] - model.grid_export[t]
        == inp.load_kw[t]
        - inp.pv_kw[t]
        + model.curtail[t]
        + model.charge[t]
        - model.discharge[t],
    )
    # Mutually exclusive import/export (see module docstring: with
    # export_value > import_price this is load-bearing, not just a tie-break).
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
    if not inp.netzladen_erlaubt:
        # EEG mode (site.netzladen_erlaubt = false): the battery charges ONLY
        # from the site's own PV surplus (Ausschliesslichkeitsprinzip). Present
        # in BOTH builds - the infeasible-§14a fallback must stay EEG-clean.
        # (1) The headline rule on the forecast surplus.
        m.solar_only_charge = Constraint(
            m.T,
            rule=lambda model, t: model.charge[t]
            <= max(inp.pv_kw[t] - inp.load_kw[t], 0.0),
        )
        # (2) Never an importing slot while charging - closes the curtailment
        # loophole (see the module docstring): without it the model could
        # curtail PV fully and cover the "solar" charge with paid grid import
        # at negative prices.
        m.no_import_while_charging = Constraint(
            m.T,
            rule=lambda model, t: model.grid_import[t]
            <= _m_import(t) * (1 - model.is_charging[t]),
        )
    if enforce_grid_limit and inp.grid_limit_kw is not None:
        m.grid_import_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_import[t] <= inp.grid_limit_kw
        )
        # DELIBERATELY still symmetric (export capped by the observed IMPORT
        # envelope): section 14a is an import-side dimming instrument, so
        # mirroring it onto export can force curtailment of healthy PV
        # (critique F4 part 2 / question D5) - changing the semantics is
        # regulatory-adjacent and awaits the captain's D5 answer. Stage 1 only
        # fixed the STALENESS of the reading (inputs._fresh_measurement).
        m.grid_export_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_export[t] <= inp.grid_limit_kw
        )
    # Real degradation cost per AC-side kWh in each direction (see module
    # docstring); the epsilon tie-break below stays for the c_wear = 0 case.
    wear_eur_per_kwh = p.wear_cost_eur_per_kwh_each_way
    import_prices = inp.import_prices
    export_values = inp.export_values
    # Terminal energy value (P3): credit the energy left in the battery at the
    # horizon end, replacing the old hard soc_T >= soc_0 floor (see module
    # docstring - this is what un-freezes an EEG battery on low-PV days while
    # keeping end-of-horizon dumps unattractive).
    v_end = inp.effective_terminal_value_eur_per_kwh()
    m.total_cost = Objective(
        expr=sum(
            (
                import_prices[t] * m.grid_import[t]
                - export_values[t] * m.grid_export[t]
            )
            * dt
            / 1000.0
            + wear_eur_per_kwh * (m.charge[t] + m.discharge[t]) * dt
            + CURTAIL_TIEBREAK_EUR_PER_KW * m.curtail[t]
            + BATTERY_WEAR_TIEBREAK_EUR_PER_KW * (m.charge[t] + m.discharge[t])
            for t in m.T
        )
        - v_end * (m.soc[n] - soc0),
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
    wear_eur_per_kwh = inp.battery.wear_cost_eur_per_kwh_each_way
    slots: list[PlanSlot] = []
    for t in range(inp.slots):
        charge = float(value(model.charge[t]))
        discharge = float(value(model.discharge[t]))
        battery_kw = charge - discharge
        # Clamp solver tolerance noise: curtailment is [0, pv] by construction.
        curtail_kw = min(max(float(value(model.curtail[t])), 0.0), max(inp.pv_kw[t], 0.0))
        # Net grid power from the balance (the import/export split is exact by
        # the is_importing binary, so max(grid, 0)/max(-grid, 0) recovers it
        # without solver noise).
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
                cost_eur=round(inp.cashflow_cost_eur(t, grid_kw), 6),
                baseline_cost_eur=round(inp.baseline_cost_eur(t), 6),
                curtail_kw=round(curtail_kw, 4),
                wear_cost_eur=round(
                    wear_eur_per_kwh * (charge + discharge) * dt, 6
                ),
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
        # P5: hand the site's EEG posture to the edge so the solar-only-charge
        # rule is also enforced against MEASURED values, not just the forecast.
        grid_charge_allowed=inp.netzladen_erlaubt,
    )

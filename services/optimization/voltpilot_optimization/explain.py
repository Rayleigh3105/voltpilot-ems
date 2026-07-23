"""Per-slot "Warum" extraction from a solved dispatch MILP (Fahrplan-Warum).

After a plan is solved and extracted, this module answers - per 15-min slot -
the customer question "warum macht der Speicher das gerade?" with the only
facts the model honestly provides (design scout vp-fahrplan-why-design):

- **Layer 3, the marginal economics (LP duals).** HiGHS provides no duals for
  a MILP (mathematically undefined), so the standard fix-and-relax trick is
  applied to the ALREADY-SOLVED model: every binary is fixed to its
  MILP-optimal value AND its domain is relaxed to ``Reals`` - BOTH steps are
  required (``.fix()`` alone leaves APPSI/HiGHS treating the model as a MIP
  and refusing duals; verified empirically on this exact model). A fresh
  APPSI ``Highs()`` then re-solves the resulting LP (~30 ms for 96 slots,
  objective drift <= 1e-13 EUR - the identical optimum) and its duals ARE the
  marginal economics the optimizer itself decided with:

  * ``lambda_t = -dual(soc_dynamics[t])`` - the value of a stored kWh at the
    END of slot t (EUR/kWh; the "Wasserwert"). Persisted in ct/kWh as
    ``stored_value_ct_kwh`` - the EXACT number the admin diagnostics'
    ``storedEnergyValuesCtKwh`` could previously only approximate.
  * ``pi_t = dual(grid_balance[t]) / dt`` - the effective per-kWh energy
    value at the grid connection point (EUR/kWh): the import price when
    importing, the export value when exporting, and deviating exactly when
    §14a or the peak module deforms the slot's economics.
  * ``mu_t = -dual(peak_epigraph[t]) - dual(peak_below_epigraph[t])`` - the
    Leistungspreis pressure allocated to this slot (EUR/kW). Summed over the
    horizon (plus the anchor's dual) this reproduces the Leistungspreis +
    ratchet EXACTLY - the honest "this slot belongs to peak shaving" signal.

  Sign conventions verified empirically on APPSI-HiGHS against the KKT
  stationarity identities (max error 0.000 ct/kWh beyond the documented
  epsilon tie-breaks): charging interior slots satisfy
  ``eta * lambda = pi + wear``, discharging ones ``lambda = eta * (pi - wear)``.

- **Layer 2, the slot role + binding flags.** Bindings come from a plain
  primal-slack/bounds scan on the MILP solution (no duals needed); the role is
  a small precedence rule-tree over primal + bindings (vocabulary of the
  design report §6). Deadbands mirror the shared portal/SlotEconomics
  constants (``schedule.ts`` / ``SlotEconomics.java``) so all three
  classifiers agree.

**Safety contract:** the LP re-solve MUTATES the model (binaries fixed,
domains relaxed), so :func:`explain` must run strictly AFTER the plan has been
extracted - the solver sequences it that way, and the LP's variable values are
never loaded back (``load_solution = False``, no ``load_vars()``): the model
keeps its MILP primal values, the committed plan is untouched by construction.
Any failure in here is caught by the solver and merely drops the why-fields
(warn log); the flag ``OPTIMIZER_EXPLAIN_ENABLED`` turns the whole layer off.

**Maintenance coupling (design report §11.6):** whoever adds a constraint to
``build_model`` must extend :data:`KNOWN_CONSTRAINTS` (and, if it can bind in
an explainable way, the binding scan + role tree). :func:`explain` REFUSES a
model with unmapped constraints (raising :class:`ExplainMappingError`, so the
plan ships without a why-layer rather than with a dishonest one), and
``tests/test_explain.py`` carries the matching inventory guard that fails at
development time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pyomo.environ import ConcreteModel, Constraint, Reals, value

from voltpilot_optimization.domain import BatteryParams, OptimizationInput

logger = logging.getLogger("voltpilot.optimization.explain")


class ExplainMappingError(RuntimeError):
    """The model carries a constraint the explain layer has no mapping for -
    refusing beats fabricating an explanation that ignores it."""


#: Every constraint component ``build_model`` can attach. A model constraint
#: outside this set makes :func:`explain` refuse (see module docstring).
KNOWN_CONSTRAINTS: frozenset[str] = frozenset(
    {
        "grid_balance",
        "import_gate",
        "export_gate",
        "soc_dynamics",
        "charge_gate",
        "discharge_gate",
        "solar_only_charge",
        "grid_import_cap",
        "grid_export_cap",
        "feed_in_cap",
        "peak_epigraph",
        "peak_anchor",
        "peak_below_epigraph",
    }
)

# Deadbands - the THIRD copy of the shared classification constants
# (frontend/portal src/schedule.ts <-> services/api SlotEconomics.java);
# change all three together.
SLOT_DEADBAND_KW = 0.05
PV_SOURCE_DEADBAND_KW = 0.1
CURTAIL_DEADBAND_KW = 0.01

#: Primal slack tolerance for the binding scan (kW / kWh) - well above HiGHS
#: feasibility noise, well below any real decision's footprint.
BINDING_TOL = 1e-3

#: Peak-pressure threshold (EUR/kW): above the epsilon tie-break noise
#: (~4e-6 EUR scale), far below any real Leistungspreis allocation.
MU_EPS = 1e-3


@dataclass(frozen=True)
class SlotDuals:
    """Raw (unrounded) per-slot duals of the fixed-binary LP re-solve."""

    lambda_eur_kwh: float  # value of a stored kWh at slot END
    pi_eur_kwh: float  # effective energy value at the connection point
    mu_eur_kw: float | None  # peak-pressure allocation; None = module off


@dataclass(frozen=True)
class SlotWhy:
    """The persisted why-facts of one plan slot (data contract §5.1)."""

    slot_role: str
    slot_flags: tuple[str, ...]
    stored_value_ct_kwh: float  # lambda, rounded to 0.1 ct (degeneracy rounding)
    grid_value_ct_kwh: float  # pi, rounded to 0.1 ct
    peak_pressure_eur_kw: float | None  # mu; None when the peak module is off


def explain(
    model: ConcreteModel,
    inp: OptimizationInput,
    fallback_14a: bool = False,
) -> list[SlotWhy]:
    """Extract the per-slot why-facts from a SOLVED dispatch model.

    MUTATES the model (fixes binaries, relaxes their domain) - call strictly
    after the plan has been extracted, never re-solve the model afterwards.
    ``fallback_14a`` marks the advisory build without the §14a constraint
    (which structurally cannot flag ``grid_limit_14a``). Raises on any
    problem; the solver wraps the call fail-soft.
    """
    _check_constraint_inventory(model)
    primal = [_slot_primal(model, inp, t) for t in range(inp.slots)]
    duals = slot_duals(model, inp)
    whys: list[SlotWhy] = []
    for t in range(inp.slots):
        flags = _binding_flags(model, inp, primal[t], fallback_14a)
        role = _classify_role(inp, primal[t], flags, duals[t])
        whys.append(
            SlotWhy(
                slot_role=role,
                slot_flags=tuple(flags),
                stored_value_ct_kwh=round(duals[t].lambda_eur_kwh * 100.0, 1),
                grid_value_ct_kwh=round(duals[t].pi_eur_kwh * 100.0, 1),
                peak_pressure_eur_kw=(
                    None
                    if duals[t].mu_eur_kw is None
                    else round(
                        0.0 if abs(duals[t].mu_eur_kw) < MU_EPS else duals[t].mu_eur_kw,
                        4,
                    )
                ),
            )
        )
    return whys


def _check_constraint_inventory(model: ConcreteModel) -> None:
    unknown = sorted(
        c.local_name
        for c in model.component_objects(Constraint, active=True)
        if c.local_name not in KNOWN_CONSTRAINTS
    )
    if unknown:
        raise ExplainMappingError(
            f"model carries constraint(s) without an explain mapping: {unknown} "
            "- extend explain.KNOWN_CONSTRAINTS + the binding scan/role tree "
            "(see tests/test_explain.py inventory guard)"
        )


def resolve_lp_duals(model: ConcreteModel):
    """Fix-and-relax the binaries, re-solve as an LP with a fresh APPSI HiGHS,
    and return ``(duals, reduced_costs)`` ComponentMaps.

    Both steps of the fix are required (see module docstring). The LP solution
    is deliberately NOT loaded back into the model: the primal keeps its MILP
    values, only the duals are read.
    """
    from pyomo.contrib.appsi.base import TerminationCondition
    from pyomo.contrib.appsi.solvers.highs import Highs

    for t in model.T:
        for var in (model.is_charging[t], model.is_importing[t]):
            var.fix(round(value(var)))
            var.domain = Reals
    solver = Highs()
    solver.config.load_solution = False
    results = solver.solve(model)
    if results.termination_condition != TerminationCondition.optimal:
        raise RuntimeError(
            "explain LP re-solve not optimal: "
            f"{results.termination_condition}"
        )
    return (
        results.solution_loader.get_duals(),
        results.solution_loader.get_reduced_costs(),
    )


def slot_duals(model: ConcreteModel, inp: OptimizationInput) -> list[SlotDuals]:
    """The raw per-slot duals (lambda/pi/mu) of the fixed-binary LP - the
    unrounded values the tests pin the stationarity identities on."""
    duals, _reduced_costs = resolve_lp_duals(model)
    dt = inp.slot_hours
    peak_on = inp.leistungspreis_eur_kw is not None
    out: list[SlotDuals] = []
    for t in range(inp.slots):
        lam = -duals[model.soc_dynamics[t]]
        pi = duals[model.grid_balance[t]] / dt
        mu = (
            -duals[model.peak_epigraph[t]] - duals[model.peak_below_epigraph[t]]
            if peak_on
            else None
        )
        out.append(SlotDuals(lambda_eur_kwh=lam, pi_eur_kwh=pi, mu_eur_kw=mu))
    return out


@dataclass(frozen=True)
class _SlotPrimal:
    charge_kw: float
    discharge_kw: float
    battery_kw: float
    curtail_kw: float
    grid_kw: float  # net, +import/-export (the _extract_plan formula)
    grid_import_kw: float
    grid_export_kw: float
    soc_end_kwh: float
    pv_kw: float


def _slot_primal(model: ConcreteModel, inp: OptimizationInput, t: int) -> _SlotPrimal:
    charge = float(value(model.charge[t]))
    discharge = float(value(model.discharge[t]))
    battery = charge - discharge
    curtail = min(max(float(value(model.curtail[t])), 0.0), max(inp.pv_kw[t], 0.0))
    return _SlotPrimal(
        charge_kw=charge,
        discharge_kw=discharge,
        battery_kw=battery,
        curtail_kw=curtail,
        grid_kw=inp.load_kw[t] - inp.pv_kw[t] + curtail + battery,
        grid_import_kw=float(value(model.grid_import[t])),
        grid_export_kw=float(value(model.grid_export[t])),
        soc_end_kwh=float(value(model.soc[t + 1])),
        pv_kw=inp.pv_kw[t],
    )


def _binding_flags(
    model: ConcreteModel,
    inp: OptimizationInput,
    s: _SlotPrimal,
    fallback_14a: bool,
) -> list[str]:
    """Primal-slack/bounds scan on the MILP solution (design report §5.1
    binding codes). Order is the vocabulary's - stable for the CSV column."""
    p = inp.battery
    flags: list[str] = []
    soc_lb = model.soc[1].lb  # the model's actual floor (reserve stack/relaxed)
    soc_ub = model.soc[1].ub
    if s.soc_end_kwh >= soc_ub - BINDING_TOL:
        flags.append("soc_max")
    if s.soc_end_kwh <= soc_lb + BINDING_TOL:
        flags.append("soc_floor")
        if soc_lb > p.soc_min_kwh + BINDING_TOL:
            reserve = _argmax_reserve(p)
            if reserve is not None:
                flags.append(reserve)
    if s.charge_kw > SLOT_DEADBAND_KW and s.charge_kw >= p.max_charge_kw - BINDING_TOL:
        flags.append("charge_cap")
    if (
        s.discharge_kw > SLOT_DEADBAND_KW
        and s.discharge_kw >= p.max_discharge_kw - BINDING_TOL
    ):
        flags.append("discharge_cap")
    if (
        hasattr(model, "solar_only_charge")
        and s.charge_kw > SLOT_DEADBAND_KW
        and s.charge_kw >= max(s.pv_kw, 0.0) - s.curtail_kw - BINDING_TOL
    ):
        flags.append("solar_only")
    if (
        not fallback_14a
        and hasattr(model, "grid_import_cap")
        and inp.grid_limit_kw is not None
        and (
            s.grid_import_kw >= inp.grid_limit_kw - BINDING_TOL
            or s.grid_export_kw >= inp.grid_limit_kw - BINDING_TOL
        )
    ):
        flags.append("grid_limit_14a")
    if (
        inp.max_feed_in_kw is not None
        and s.grid_export_kw >= inp.max_feed_in_kw - BINDING_TOL
    ):
        flags.append("feed_in_cap")
    if (
        inp.leistungspreis_eur_kw is not None
        and s.grid_import_kw > SLOT_DEADBAND_KW
        and s.grid_import_kw >= float(value(model.peak)) - BINDING_TOL
    ):
        flags.append("peak_defining")
    if s.curtail_kw > CURTAIL_DEADBAND_KW:
        flags.append("curtailing")
    return flags


def _argmax_reserve(p: BatteryParams) -> str | None:
    """Which reservation-stack component supplies the binding floor (the
    report's argmax rule; ``max`` binds in the stack, never additive)."""
    best: str | None = None
    best_kwh = float("-inf")
    for name, pct in (
        ("reserve_backup", p.backup_reserve_pct),
        ("reserve_peak", p.peak_reserve_pct),
    ):
        if pct is None:
            continue
        kwh = min(p.capacity_kwh * pct / 100.0, p.soc_max_kwh)
        if kwh > best_kwh:
            best, best_kwh = name, kwh
    if best is None or best_kwh <= p.soc_min_kwh + BINDING_TOL:
        return None
    return best


def _classify_role(
    inp: OptimizationInput,
    s: _SlotPrimal,
    flags: list[str],
    duals: SlotDuals,
) -> str:
    """The §6 role rule-tree (order = precedence) over primal + bindings + mu."""
    idle = abs(s.battery_kw) <= SLOT_DEADBAND_KW
    if idle:
        if s.curtail_kw > CURTAIL_DEADBAND_KW:
            return "abregeln"
        if "soc_floor" in flags and (
            "reserve_backup" in flags or "reserve_peak" in flags
        ):
            return "reserve_halten"
        return "warten"
    if s.battery_kw > 0:  # charging
        # The chargeKind FK3 rule (schedule.ts / SlotEconomics.decisionLabel):
        # grid energy can only flow INTO the battery while the slot net-imports,
        # and a charging slot is grid-fed only when the charge EXCEEDS the
        # slot's available PV.
        if s.grid_kw <= SLOT_DEADBAND_KW:
            return "pv_speichern"
        available = max(s.pv_kw - s.curtail_kw, 0.0)
        return (
            "guenstig_laden"
            if s.battery_kw > available + PV_SOURCE_DEADBAND_KW
            else "pv_speichern"
        )
    # discharging
    if inp.leistungspreis_eur_kw is not None and (
        (duals.mu_eur_kw is not None and duals.mu_eur_kw > MU_EPS)
        or "peak_defining" in flags
    ):
        return "spitze_kappen"
    if s.grid_kw < -SLOT_DEADBAND_KW:
        return "verkaufen"
    return "eigenverbrauch"

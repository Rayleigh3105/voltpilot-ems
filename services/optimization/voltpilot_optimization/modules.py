"""Declarative solver-module contributions (E4-Basis, plan-draft §2.3).

The v1 solver's conditional blocks - EEG solar-only charge, §14a caps, the
FK1 static feed-in cap, the PS-1 peak epigraph + ratchet, the P11/PS-2
reservation stack - become DECLARED constraint/objective contributions that
are SELECTED per site instead of inline ``if`` blocks. Behavior is identical
(the golden suite proves it); the structure is what the v2 strategy nodes
register against later: a strategy node announces its contribution
(Peak-Ziel, HLZF-Fenster, DV-Fahrplan, ...) and the co-optimizer folds every
selected contribution into ONE model - the solver stays a pure function.

Each module contributes up to three things to :func:`co_solver.build_co_model`:

- ``constrain(m, inp)`` - add Pyomo constraints (and helper variables),
- ``objective(m, inp)`` - return an expression ADDED to the objective
  (0.0 for pure-constraint modules),
- ``storage_soc_floor_kwh(storage, soc0)`` - raise a storage's SoC lower
  bound (the reservation stack's channel; consulted at variable-construction
  time because a bound is not a constraint row).

Selection (:func:`select_modules`) is derived from the input exactly like the
v1 conditionals were - same predicates, same both-builds semantics:
the §14a module is the ONLY one dropped in the infeasible-fallback build
(``enforce_grid_limit=False``); solar-only, feed-in cap and peak shaving are
deliberately present in BOTH builds (they can never cause infeasibility -
curtailment can zero any export, the peak term is economic, and solar-only
only bounds charging).
"""

from __future__ import annotations

from dataclasses import dataclass

from pyomo.environ import ConcreteModel, Constraint, NonNegativeReals, Var

from voltpilot_optimization.config import peak_ratchet_eur_per_kw
from voltpilot_optimization.entities import CoOptimizationInput, StorageEntity


class SolverModule:
    """Base contribution: no constraints, no objective term, no floor."""

    name: str = "base"

    def constrain(self, m: ConcreteModel, inp: CoOptimizationInput) -> None:
        return None

    def objective(self, m: ConcreteModel, inp: CoOptimizationInput):
        return 0.0

    def storage_soc_floor_kwh(
        self, storage: StorageEntity, initial_soc_kwh: float
    ) -> float | None:
        return None


@dataclass(frozen=True)
class ReservationStackModule(SolverModule):
    """The P11 backup reserve + PS-2 peak reserve as a SoC-floor contribution.

    Always selected: the technical 5% floor is part of the stack, and per
    entity the highest configured absolute floor binds (max, never additive),
    relaxed to the actual start when the battery currently sits below it -
    verbatim :meth:`BatteryParams.soc_floor_kwh`, which stays the single
    implementation."""

    name: str = "reservation-stack"

    def storage_soc_floor_kwh(
        self, storage: StorageEntity, initial_soc_kwh: float
    ) -> float | None:
        return storage.params.soc_floor_kwh(initial_soc_kwh)


@dataclass(frozen=True)
class SolarOnlyChargeModule(SolverModule):
    """EEG/DV solar-only charging (the netzladen_erlaubt machinery, FK3
    PV-bus Bilanzierung): the subset of storages WITHOUT effective grid-charge
    permission may jointly charge at most the site's uncurtailed produced PV -
    ``sum(charge_e) <= sum(max(pv_p, 0) - curtail_p)`` per slot. For one EEG
    storage and one producer this is byte-identical to v1's
    ``charge <= max(pv, 0) - curtail``. Selected whenever at least one storage
    lacks the effective permission (per-entity flag AND'd with the site's
    DV-konform mode); present in BOTH builds - the §14a fallback must stay
    EEG-clean. Storages WITH permission are unconstrained by it (a mixed site
    arbitrages with the merchant battery while the EEG battery stays solar)."""

    name: str = "solar-only-charge"

    def constrain(self, m: ConcreteModel, inp: CoOptimizationInput) -> None:
        solar_only = [
            e for e, s in enumerate(inp.storages) if not inp.grid_charge_allowed(s)
        ]

        def rule(model, t):
            produced = sum(
                max(p.generation_kw[t], 0.0) for p in inp.producers
            ) - sum(model.curtail[pi, t] for pi in range(len(inp.producers)))
            return sum(model.charge[e, t] for e in solar_only) <= produced

        m.solar_only_charge = Constraint(m.T, rule=rule)


@dataclass(frozen=True)
class GridLimitModule(SolverModule):
    """The observed §14a envelope as a hard cap on import AND export (the
    deliberately-symmetric v1 semantics - see solver.py for the D5 note).
    The ONLY module dropped in the infeasible-fallback build."""

    name: str = "grid-limit-14a"

    def constrain(self, m: ConcreteModel, inp: CoOptimizationInput) -> None:
        m.grid_import_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_import[t] <= inp.grid_limit_kw
        )
        m.grid_export_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_export[t] <= inp.grid_limit_kw
        )


@dataclass(frozen=True)
class FeedInCapModule(SolverModule):
    """FK1: the site's static feed-in cap at the connection point - EXPORT
    only, in BOTH builds (curtailment can always zero the export, so it can
    never cause infeasibility)."""

    name: str = "max-feed-in"

    def constrain(self, m: ConcreteModel, inp: CoOptimizationInput) -> None:
        m.feed_in_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_export[t] <= inp.max_feed_in_kw
        )


@dataclass(frozen=True)
class PeakShavingModule(SolverModule):
    """PS-1: the Leistungspreis epigraph over the billing period's import peak
    plus the capped shave-target ratchet - economic, never a hard cap, in BOTH
    builds. Constraint half adds the epigraph variables; objective half prices
    them (verbatim v1 weights, see config.peak_ratchet_eur_per_kw)."""

    name: str = "peak-shaving"

    def constrain(self, m: ConcreteModel, inp: CoOptimizationInput) -> None:
        m.peak = Var(domain=NonNegativeReals)
        m.peak_epigraph = Constraint(
            m.T, rule=lambda model, t: model.peak >= model.grid_import[t]
        )
        m.peak_anchor = Constraint(expr=m.peak >= inp.peak_so_far_kw)
        m.peak_below = Var(domain=NonNegativeReals)
        m.peak_below_epigraph = Constraint(
            m.T, rule=lambda model, t: model.peak_below >= model.grid_import[t]
        )

    def objective(self, m: ConcreteModel, inp: CoOptimizationInput):
        return inp.leistungspreis_eur_kw * (
            m.peak - inp.peak_so_far_kw
        ) + peak_ratchet_eur_per_kw(inp.leistungspreis_eur_kw) * m.peak_below


def select_modules(
    inp: CoOptimizationInput, enforce_grid_limit: bool = True
) -> tuple[SolverModule, ...]:
    """The contributions this site's model is built from - the same predicates
    the v1 inline conditionals used, in the same build order. This is the seam
    where v2 strategy nodes will REGISTER contributions instead of the input
    deriving them; :func:`co_solver.build_co_model` accepts an explicit module
    list override for exactly that."""
    modules: list[SolverModule] = [ReservationStackModule()]
    if any(not inp.grid_charge_allowed(s) for s in inp.storages):
        modules.append(SolarOnlyChargeModule())
    if enforce_grid_limit and inp.grid_limit_kw is not None:
        modules.append(GridLimitModule())
    if inp.max_feed_in_kw is not None:
        modules.append(FeedInCapModule())
    if inp.leistungspreis_eur_kw is not None:
        modules.append(PeakShavingModule())
    return tuple(modules)

"""The MIP optimality tolerance must leave the tie-break epsilons decisive.

Scout ``vp-fahrplan-idle-n7`` ("latent defect found in passing"): the model's
``CURTAIL_TIEBREAK_EUR_PER_KW`` / ``BATTERY_WEAR_TIEBREAK_EUR_PER_KW`` epsilons
(1e-6 EUR per kW per slot) exist to decide EXACT ties - "prefer not curtailing",
"prefer an idle battery when cycling moves no money". HiGHS's default
``mip_rel_gap`` of 1e-4 stops the search ~1e-3 EUR short of the true optimum on
a ~10 EUR objective, which is orders of magnitude ABOVE the total tie-break
penalty of a full battery cycle (~6.6e-4 EUR at 15 kW over 44 slots). The
epsilons were therefore not deciding anything: two structurally different plans
were tolerance-equivalent and which one came back was effectively arbitrary -
and could flip between two consecutive 15-min re-plans.

These tests pin the fix (``MIP_REL_GAP`` / ``MIP_ABS_GAP`` in
:mod:`voltpilot_optimization.solver`): the ordering invariant that makes the
epsilons meaningful, that the tightened solve never returns a WORSE objective
than the default one, and that repeated solves of one instance are identical.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.domain import (
    SLOT_MINUTES,
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.solver import (
    BATTERY_WEAR_TIEBREAK_EUR_PER_KW,
    CURTAIL_TIEBREAK_EUR_PER_KW,
    MIP_ABS_GAP,
    MIP_REL_GAP,
    _solve,
    build_model,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)


def make_input(prices, *, load, battery, soc0, netzladen_erlaubt=True, pv=0.0,
               import_price=None):
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[load] * n,
        pv_kw=[pv] * n if isinstance(pv, (int, float)) else pv,
        initial_soc_kwh=soc0,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=None if import_price is None else [import_price] * n,
        export_value_eur_mwh=None if import_price is None else list(prices),
    )


# ---- the ordering invariant (pure) -------------------------------------------


def test_the_gap_tolerance_stays_far_below_the_tiebreak_scale():
    """The whole point of tightening the gap: the tie-break penalty separating
    two structurally different plans must sit far ABOVE what the solver treats
    as "close enough", or the epsilons decide nothing.

    The scale that matters is a plan-level difference, not one kW in one slot:
    idle-versus-full-cycle on the scout's instance is 15 kW of throughput over
    44 slots. That is what the default 1e-4 relative gap was swamping."""
    smallest_tiebreak = min(
        CURTAIL_TIEBREAK_EUR_PER_KW, BATTERY_WEAR_TIEBREAK_EUR_PER_KW
    )
    cycle_tiebreak_eur = smallest_tiebreak * 15.0 * 44.0  # ~6.6e-4 EUR
    assert MIP_ABS_GAP < cycle_tiebreak_eur / 100.0

    # Across the objective magnitudes real single-site plans carry (a household
    # day is single-digit EUR, a large C&I day low hundreds), the relative gap
    # must stay two orders of magnitude under that same difference. At HiGHS's
    # 1e-4 default this FAILS for every magnitude above ~0.7 EUR - which is the
    # defect.
    for objective_eur in (1.0, 10.0, 100.0, 1000.0):
        assert MIP_REL_GAP * objective_eur < cycle_tiebreak_eur / 100.0, (
            f"gap tolerance at a {objective_eur} EUR objective swamps the "
            f"tie-break that must decide idle-vs-cycle"
        )


def test_slot_length_is_the_one_the_tiebreak_scale_assumes():
    """The tie-breaks are priced per kW per SLOT, so their value per kWh of
    throughput is ``epsilon / slot_hours``. The reasoning in the solver module
    (and the terminal-value margin that must stay under it) assumes the
    platform's 15-min grid."""
    assert SLOT_MINUTES == 15


# ---- behavioral: the tightened solve is never worse, and is deterministic ----


def _objective(model):
    from pyomo.environ import value

    return float(value(model.total_cost))


def _solve_with(inp, options):
    """Solve one input with explicit HiGHS options (None = library defaults)."""
    from pyomo.contrib.appsi.solvers.highs import Highs

    model = build_model(inp)
    solver = Highs()
    solver.config.load_solution = False
    if options is not None:
        solver.highs_options = dict(options)
    solver.solve(model).solution_loader.load_vars()
    return model


@needs_highs
def test_tightened_gap_never_returns_a_worse_objective_than_the_default():
    """The direct proof of the defect: on the scout's flat-retail instance the
    default gap returned a plan measurably worse than the true optimum. The
    tightened solve must be at least as good - never worse - on both a flat and
    an arbitrage-shaped curve."""
    battery = BatteryParams(
        capacity_kwh=40.0, max_charge_kw=15.0, max_discharge_kw=15.0,
        roundtrip_efficiency=0.92, wear_cost_ct_per_kwh=1.0,
    )
    curves = {
        # flat retail tariff over a dispersed spot curve (the scout's shape)
        "flat-retail": make_input(
            [0.0] * 20 + [200.0] * 24, load=14.0, battery=battery,
            soc0=battery.soc_max_kwh, import_price=300.0,
        ),
        "arbitrage": make_input(
            [50.0] * 22 + [250.0] * 22, load=14.0, battery=battery,
            soc0=battery.soc_max_kwh,
        ),
    }
    for name, inp in curves.items():
        default = _objective(_solve_with(inp, None))
        tightened = _objective(
            _solve_with(inp, {"mip_rel_gap": MIP_REL_GAP, "mip_abs_gap": MIP_ABS_GAP})
        )
        assert tightened <= default + 1e-9, (
            f"{name}: tightening the gap must never worsen the objective "
            f"(default {default!r}, tightened {tightened!r})"
        )


@needs_highs
def test_repeated_solves_of_one_instance_return_an_identical_plan():
    """The operational hazard the gap fix removes: with the plan re-solved
    every 15 minutes, two tolerance-equivalent optima meant the committed
    setpoints could oscillate between 'idle' and 'serve the evening' on
    unchanged inputs. Under the tightened gap the optimum is unique enough to
    reproduce exactly."""
    battery = BatteryParams(
        capacity_kwh=40.0, max_charge_kw=15.0, max_discharge_kw=15.0,
        roundtrip_efficiency=0.92, wear_cost_ct_per_kwh=1.0,
    )
    inp = make_input(
        [0.0] * 20 + [200.0] * 24, load=14.0, battery=battery,
        soc0=battery.soc_max_kwh, import_price=300.0,
    )

    def plan_signature():
        from pyomo.environ import value

        model = build_model(inp)
        _solve(model)
        return [
            round(float(value(model.charge[t])) - float(value(model.discharge[t])), 6)
            for t in model.T
        ]

    first = plan_signature()
    for _ in range(3):
        assert plan_signature() == first

"""GOLDEN SUITE: the co-optimizer reproduces the v1 solver, scenario by
scenario, slot by slot - the E4 cutover acceptance basis.

Eight representative pilot-shaped inputs live as committed JSON fixtures in
``tests/golden/`` (provenance + regeneration: ``tests/golden/README.md`` and
``generate_scenarios.py`` - deterministic, drift-guarded below). For each
scenario BOTH solvers run on the identical input - the v1 single-battery MILP
(:mod:`voltpilot_optimization.solver`) and the generalized multi-entity
co-optimizer (:mod:`voltpilot_optimization.co_solver`) fed through the N=1
adapter (:func:`voltpilot_optimization.entities.from_v1_input`) - and the
results must agree:

- **objective value** within :data:`OBJECTIVE_TOL_EUR`,
- **every slot's decisions** (battery setpoint, grid power, SoC trajectory,
  curtailment) within :data:`SLOT_TOL`,
- **the economics** (cost, baseline, wear, savings, peak target, terminal
  value) within their stated tolerances.

Tolerance policy: the two models are mathematically identical for N=1 (the
co-model generalizes every v1 rule by summation), so agreement is expected to
be EXACT in practice; the tolerances only leave headroom for solver-version
noise. They are chosen strictly below any economic decision's footprint - a
genuine behavioral difference (one flipped charge slot, one changed
curtailment) moves slots by >= 0.01 kW and the objective by at least the
tie-break scale, far above these bounds - so the suite can never green-wash a
real divergence.

Cutover role: when the engine later switches existing sites from
``solver.optimize`` to the co-optimizer, THIS suite (green, unchanged) is the
acceptance evidence that plans do not change. Extend it with new scenarios
before extending the model.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import pytest

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.solver import build_model, _extract_plan
from voltpilot_optimization.co_solver import build_co_model, _extract_site_plan

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
SCENARIO_FILES = sorted(GOLDEN_DIR.glob("*.json"))
SCENARIO_IDS = [p.stem for p in SCENARIO_FILES]

# Tolerances (see module docstring for the policy).
OBJECTIVE_TOL_EUR = 1e-5
SLOT_TOL = 1e-3  # kW / kWh per slot
ECONOMICS_TOL_EUR = 1e-5


def load_scenario(path: Path) -> OptimizationInput:
    doc = json.loads(path.read_text())
    series = doc["series"]
    start = datetime.fromisoformat(doc["start"].replace("Z", "+00:00"))
    n = len(series["prices_eur_mwh"])
    battery = BatteryParams(**doc["battery"])
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(start, n),
        prices_eur_mwh=series["prices_eur_mwh"],
        load_kw=series["load_kw"],
        pv_kw=series["pv_kw"],
        initial_soc_kwh=doc["initial_soc_kwh"],
        netzladen_erlaubt=doc["netzladen_erlaubt"],
        grid_limit_kw=doc["grid_limit_kw"],
        max_feed_in_kw=doc["max_feed_in_kw"],
        import_price_eur_mwh=series["import_price_eur_mwh"],
        export_value_eur_mwh=series["export_value_eur_mwh"],
        terminal_value_eur_per_kwh=doc["terminal_value_eur_per_kwh"],
        leistungspreis_eur_kw=doc["leistungspreis_eur_kw"],
        peak_so_far_kw=doc["peak_so_far_kw"],
    )


def solve_both(inp: OptimizationInput, enforce_grid_limit: bool = True):
    """Solve the identical input through the v1 model and the co-model."""
    from pyomo.environ import value

    from voltpilot_optimization.solver import _solve

    generated_at = inp.slot_starts[0]
    m1 = build_model(inp, enforce_grid_limit=enforce_grid_limit)
    _solve(m1)
    v1_plan = _extract_plan(m1, inp, plan_id=uuid4(), generated_at=generated_at)
    v1_objective = float(value(m1.total_cost))

    co_inp = from_v1_input(inp)
    m2 = build_co_model(co_inp, enforce_grid_limit=enforce_grid_limit)
    _solve(m2)
    site_plan = _extract_site_plan(
        m2, co_inp, plan_id=uuid4(), generated_at=generated_at
    )
    return v1_plan, v1_objective, site_plan


def assert_equivalent(v1_plan, v1_objective, site_plan) -> None:
    """The slot-by-slot + economics equivalence contract of the golden suite."""
    assert site_plan.objective_eur == pytest.approx(
        v1_objective, abs=OBJECTIVE_TOL_EUR
    )

    (storage,) = site_plan.storages
    (producer,) = site_plan.producers
    assert len(storage.slots) == len(v1_plan.slots)
    for t, (v1_slot, st_slot, pv_slot, site_slot) in enumerate(
        zip(v1_plan.slots, storage.slots, producer.slots, site_plan.site_slots)
    ):
        context = f"slot {t} ({v1_slot.start.isoformat()})"
        assert st_slot.setpoint_kw == pytest.approx(
            v1_slot.battery_kw, abs=SLOT_TOL
        ), f"battery setpoint diverged at {context}"
        assert site_slot.grid_kw == pytest.approx(
            v1_slot.grid_kw, abs=SLOT_TOL
        ), f"grid power diverged at {context}"
        assert st_slot.soc_kwh == pytest.approx(
            v1_slot.soc_kwh, abs=SLOT_TOL
        ), f"SoC trajectory diverged at {context}"
        assert pv_slot.curtail_kw == pytest.approx(
            v1_slot.curtail_kw, abs=SLOT_TOL
        ), f"curtailment diverged at {context}"
        assert site_slot.cost_eur == pytest.approx(
            v1_slot.cost_eur, abs=ECONOMICS_TOL_EUR
        ), f"slot cost diverged at {context}"
        assert site_slot.baseline_cost_eur == pytest.approx(
            v1_slot.baseline_cost_eur, abs=ECONOMICS_TOL_EUR
        ), f"baseline cost diverged at {context}"
        assert st_slot.wear_cost_eur == pytest.approx(
            v1_slot.wear_cost_eur, abs=ECONOMICS_TOL_EUR
        ), f"wear cost diverged at {context}"

    assert site_plan.cost_eur == pytest.approx(
        v1_plan.cost_eur, abs=len(v1_plan.slots) * ECONOMICS_TOL_EUR
    )
    assert site_plan.savings_eur == pytest.approx(
        v1_plan.savings_eur, abs=len(v1_plan.slots) * ECONOMICS_TOL_EUR
    )
    assert site_plan.wear_cost_eur == pytest.approx(
        v1_plan.wear_cost_eur, abs=len(v1_plan.slots) * ECONOMICS_TOL_EUR
    )
    assert storage.terminal_value_eur_per_kwh == pytest.approx(
        v1_plan.terminal_value_eur_per_kwh, abs=1e-6
    )
    if v1_plan.peak_target_kw is None:
        assert site_plan.peak_target_kw is None
    else:
        assert site_plan.peak_target_kw == pytest.approx(
            v1_plan.peak_target_kw, abs=SLOT_TOL
        )
    # The N=1 storage entity's effective grid-charge permission mirrors the
    # site switch (the v2 payload's D-8 field).
    assert storage.charge_from_grid_allowed is (
        v1_plan.grid_charge_allowed is True
    )


@needs_highs
@pytest.mark.parametrize("path", SCENARIO_FILES, ids=SCENARIO_IDS)
def test_cooptimizer_reproduces_v1_on_golden_scenario(path):
    inp = load_scenario(path)
    v1_plan, v1_objective, site_plan = solve_both(inp)
    assert_equivalent(v1_plan, v1_objective, site_plan)


@needs_highs
def test_cooptimizer_reproduces_v1_in_the_infeasible_fallback_build():
    # The section-14a fallback build (enforce_grid_limit=False) is part of the
    # cutover surface too: the module gets DESELECTED, everything else stays.
    path = GOLDEN_DIR / "grid-limit-14a.json"
    inp = load_scenario(path)
    v1_plan, v1_objective, site_plan = solve_both(inp, enforce_grid_limit=False)
    assert_equivalent(v1_plan, v1_objective, site_plan)


def test_golden_scenarios_cover_every_module():
    # The suite's claim "modules are behavior-identical" is only as strong as
    # its coverage: together the scenarios must select every declared module
    # at least once (and both pricing models).
    from voltpilot_optimization.modules import select_modules

    seen: set = set()
    symmetric = asymmetric = False
    for scenario_path in SCENARIO_FILES:
        inp = load_scenario(scenario_path)
        for module in select_modules(from_v1_input(inp)):
            seen.add(module.name)
        if inp.import_price_eur_mwh is None:
            symmetric = True
        else:
            asymmetric = True
    assert seen == {
        "reservation-stack",
        "solar-only-charge",
        "grid-limit-14a",
        "max-feed-in",
        "peak-shaving",
    }
    assert symmetric and asymmetric


def test_fixtures_match_the_generator():
    # Drift guard: the committed fixtures are exactly what the deterministic
    # generator produces - a fixture edit must be a conscious regeneration.
    import sys

    sys.path.insert(0, str(GOLDEN_DIR))
    try:
        import generate_scenarios
    finally:
        sys.path.pop(0)
    generated = {s["name"]: s for s in generate_scenarios.scenarios()}
    committed = {
        p.stem: json.loads(p.read_text()) for p in SCENARIO_FILES
    }
    assert generated == committed


def test_the_suite_has_its_documented_scenarios():
    # A missing/renamed fixture must fail loudly, not silently skip.
    assert SCENARIO_IDS == [
        "custom-soc-band-reserves",
        "dv-negative-prices",
        "eeg-household-pv-summer",
        "excel-reference-day",
        "grid-limit-14a",
        "kitchen-sink-all-modules",
        "merchant-arbitrage-winter",
        "peak-shaving-ci",
    ]


# ---------------------------------------------------------------------------
# Rollout invariance of the structured Bezugspreis (site_supply_price)
# ---------------------------------------------------------------------------

# Each golden fixture's committed import series embodies the SiteTariff shape
# it was generated from (generate_scenarios.py): the flat 21-ct retail day,
# the dynamisch spot+Aufschlag households/C&I, and the bare-spot (None) merchant
# scenarios. None = SiteTariff without a supply-price row.
GOLDEN_TARIFFS = {
    "excel-reference-day": ("fest", 21.0),
    "eeg-household-pv-summer": ("dynamisch", 18.0),
    "merchant-arbitrage-winter": ("ohne", None),
    "peak-shaving-ci": ("dynamisch", 15.0),
    "dv-negative-prices": ("dynamisch", 17.0),
    "grid-limit-14a": ("ohne", None),
    "custom-soc-band-reserves": ("dynamisch", 19.0),
    "kitchen-sink-all-modules": ("dynamisch", 16.0),
}


@pytest.mark.parametrize("path", SCENARIO_FILES, ids=SCENARIO_IDS)
def test_supply_price_rollout_is_byte_identical_without_a_maintained_row(
    path, monkeypatch
):
    """The site_supply_price rollout rule, proven against the golden suite:
    WITHOUT a maintained components row and with
    OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS off, ``pricing.import_prices``
    reproduces every golden scenario's committed import series EXACTLY (``==``
    on the float lists, no tolerance). The import series is the solver's only
    pricing input on that side, and the two solvers are deterministic over it
    (pinned by test_cooptimizer_reproduces_v1_on_golden_scenario +
    test_fixtures_match_the_generator), so identical series = byte-identical
    plans for every existing site. The dynamisch-with-NULL-Aufschlag legacy
    case (bare spot + the new S1 warning) is pinned in test_pricing.py.
    """
    from voltpilot_optimization.pricing import SiteTariff, import_prices

    monkeypatch.delenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", raising=False)
    doc = json.loads(path.read_text())
    tarif_art, param = GOLDEN_TARIFFS[path.stem]
    tariff = SiteTariff(tarif_art=tarif_art, tarif_param_ct_kwh=param)
    assert tariff.supply_price is None  # no row = the legacy model
    spot = doc["series"]["prices_eur_mwh"]
    committed = doc["series"]["import_price_eur_mwh"]
    expected = committed if committed is not None else spot
    assert import_prices(tariff, spot) == expected

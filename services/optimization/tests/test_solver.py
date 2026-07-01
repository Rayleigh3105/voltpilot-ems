"""Smoke test for the Pyomo + HiGHS solver toolchain.

Skips gracefully if the HiGHS wheel (``highspy``) is not installable on the
current platform/CI, per the task guidance.
"""

import pytest

from voltpilot_optimization.solver import build_model


def test_model_builds_without_solver():
    """The Pyomo model builds even if no solver is installed."""
    model = build_model()
    assert model.nconstraints() == 2


def test_highs_solves_lp():
    pytest.importorskip("highspy", reason="HiGHS wheel unavailable on this platform")
    from voltpilot_optimization.solver import solve_2var_lp

    solution = solve_2var_lp()
    assert solution["objective"] == pytest.approx(12.0, abs=1e-6)
    assert solution["x"] == pytest.approx(4.0, abs=1e-6)
    assert solution["y"] == pytest.approx(0.0, abs=1e-6)

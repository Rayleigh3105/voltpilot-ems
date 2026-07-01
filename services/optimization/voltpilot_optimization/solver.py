"""Solver toolchain smoke test.

A tiny 2-variable LP solved with Pyomo + HiGHS. Its only job in the MVP skeleton
is to prove the solver toolchain (Pyomo modelling layer -> HiGHS via ``highspy``)
is correctly wired end to end. The production engine will replace this with the
rolling-horizon battery-dispatch MILP described in architecture section 11.
"""

from __future__ import annotations

from pyomo.environ import (
    ConcreteModel,
    Constraint,
    NonNegativeReals,
    Objective,
    Var,
    maximize,
    value,
)


def build_model() -> ConcreteModel:
    """Build the smoke-test LP.

    maximize  3x + 2y
    s.t.      x +  y <= 4
              x + 3y <= 6
              x, y   >= 0

    Optimum is at (x=4, y=0) with objective 12.
    """
    m = ConcreteModel()
    m.x = Var(domain=NonNegativeReals)
    m.y = Var(domain=NonNegativeReals)
    m.obj = Objective(expr=3 * m.x + 2 * m.y, sense=maximize)
    m.c1 = Constraint(expr=m.x + m.y <= 4)
    m.c2 = Constraint(expr=m.x + 3 * m.y <= 6)
    return m


def solve_2var_lp() -> dict[str, float]:
    """Solve the smoke-test LP with HiGHS and return the solution."""
    # Imported lazily so importing this module never hard-fails when the HiGHS
    # wheel is unavailable; callers/tests can guard on the import.
    from pyomo.contrib.appsi.solvers.highs import Highs

    model = build_model()
    Highs().solve(model)
    return {
        "x": float(value(model.x)),
        "y": float(value(model.y)),
        "objective": float(value(model.obj)),
    }

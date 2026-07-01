"""Trivial entrypoint: run the solver smoke test and print the result."""

from __future__ import annotations

from voltpilot_optimization.solver import solve_2var_lp


def main() -> None:
    solution = solve_2var_lp()
    print(f"voltpilot-optimization smoke LP solved: {solution}")


if __name__ == "__main__":
    main()

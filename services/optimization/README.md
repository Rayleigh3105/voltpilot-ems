# services/optimization - Optimization Engine

**Language:** Python 3.10+ (Pyomo + HiGHS)
**State:** stateless (job)
**Responsibility (architecture section 8/11):** MILP/MPC-Fahrplan (HiGHS).

The heart of the system: a MILP in MPC style (rolling 24-48h horizon, 15-min slots) that minimizes net energy cost - purchase cost minus feed-in/marketing revenue, self-consumption aware - subject to SoC limits, charge/discharge power, efficiencies, grid limits and the **observed §14a limit as a hard cap**.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev,solver]'      # drop 'solver' where the HiGHS wheel is unavailable
python -m voltpilot_optimization    # runs the HiGHS smoke LP (needs the 'solver' extra)
pytest                              # test_highs_solves_lp (skips if wheel unavailable)
```

`highspy` (HiGHS) lives in the optional `solver` extra because its wheel isn't
available on every platform. Installing without it still succeeds; the solver
smoke test then skips instead of failing.

## Status

MVP skeleton. Only the Pyomo + HiGHS **solver toolchain smoke test** (a 2-variable LP, optimum 12 at x=4) is wired, to prove the toolchain. The real battery-dispatch MILP, ENTSO-E price inputs, forecasts and §14a constraint are future work.

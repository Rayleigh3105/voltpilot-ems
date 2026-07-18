# Golden co-optimizer suite — the v1 → v2 cutover acceptance basis

**What this is.** Eight committed input scenarios (`*.json`) of the pilot-site
shape, each solved through BOTH solvers on identical data — the v1
single-battery MILP (`voltpilot_optimization/solver.py`) and the generalized
multi-entity co-optimizer (`co_solver.py`) via the N=1 adapter
(`entities.from_v1_input`) — with the results compared **slot by slot**:
objective value, battery setpoint, grid power, SoC trajectory, curtailment,
and the per-slot economics (cost / baseline / wear), plus peak target and
terminal value. The suite lives in `tests/test_golden_cooptimizer.py`.

**Why it exists (ticket E4-Basis).** The co-optimizer will eventually REPLACE
the v1 solver for existing sites. This suite is the acceptance evidence for
that cutover: as long as it is green, the generalized solver provably makes
the same decisions on representative real-shaped inputs, so the switch
changes no plan. Rules:

- **Extend before you change.** A model change (new module, new entity
  semantics) must land with the golden suite green. If a scenario legitimately
  must change behavior, that is a CONTRACT change — regenerate deliberately
  and say so in the PR, never loosen tolerances to make it pass.
- **Tolerances are policy, not tuning.** Objective 1e-5 EUR, slots 1e-3 kW /
  kWh (`OBJECTIVE_TOL_EUR` / `SLOT_TOL` in the test module). They only absorb
  solver-version noise; any real decision flip exceeds them by orders of
  magnitude. Do not raise them.
- **Inputs, never DB dumps.** Scenarios come from existing repo fixtures: the
  captain's Excel reference workbook day (`tests/test_excel_spec_day.py`,
  scout vp-solver-xlsx-f2 — the pilot plant), the simulation service's
  synthetic household profile, and deterministic C&I/price shapes. No live
  telemetry, no tenant data.

**Coverage.** Together the scenarios select every declared solver module at
least once (pinned by `test_golden_scenarios_cover_every_module`): EEG
solar-only charge, §14a grid limit (incl. the infeasible-fallback build),
FK1 feed-in cap, PS-1 peak shaving, the P11/PS-2 reservation stack — plus
both pricing models (symmetric bare-spot and asymmetric import/export) and a
kitchen-sink scenario with every module at once.

| Scenario | Shape | Modules exercised |
|---|---|---|
| `excel-reference-day` | the captain's Solver-PV.xlsx day (pilot) | feed-in cap, flat-tariff pricing |
| `eeg-household-pv-summer` | EEG household, duck-curve day | solar-only, dyn. tariff + feste Vergütung |
| `merchant-arbitrage-winter` | merchant winter spreads | backup reserve, symmetric spot |
| `peak-shaving-ci` | RLM C&I, 95 kW noon peak | peak epigraph + ratchet, peak reserve |
| `dv-negative-prices` | DV plant, negative midday | curtailment, solar-only, feed-in cap |
| `grid-limit-14a` | §14a 11 kW envelope, binding | grid-limit (both builds) |
| `custom-soc-band-reserves` | admin-tuned 10–90 % band | SoC band, backup reserve, wear 8 ct |
| `kitchen-sink-all-modules` | everything at once | all of the above |

**Regenerating.** The fixtures are produced by the deterministic
`generate_scenarios.py` (no clock, no randomness):

```bash
.venv/bin/python tests/golden/generate_scenarios.py
```

`test_fixtures_match_the_generator` pins committed JSON == generator output,
so drift is impossible and every fixture edit is a conscious regeneration.

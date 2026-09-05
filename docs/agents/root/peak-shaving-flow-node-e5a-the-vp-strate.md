# Peak-shaving flow node (E5a): the `vp.strategy.peakshaving` runtime path

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 59).


The honest remainder of E5a - the peak-shaving FUNCTION was already built (see "Peak Shaving / Lastspitzenkappung"); this makes the `vp.strategy.peakshaving` catalog node ACTIVATABLE through the flow platform, driving the SAME machinery (no new economics). `vp.strategy.atypical-grid` stays reserved for E5b (its economics are NOT built).

- **flowc compile (`edge-app/nodered/flowc/catalog.js`):** `strategyType(label, inputs)` is parameterized so each strategy declares the input set the api flow-catalog gives it (peakshaving/atypical-grid: `soc`; market: price + PV) + the delegated `wunsch` plan output; peakshaving compiles to the SAME delegation no-op as market (the co-optimizer + PS-3 edge peak guard drive execution - never re-implemented on the edge). Pinned by the new `flow-graph.valid.peakshaving-battery.json` fixture + `pinned-peakshaving-hash.txt` (compile.test.js + serve.test.js). The Go `flowdeploy` crosscheck only uses the strategy-less pv-surplus artifact, so it is untouched.
- **Activation coupling (`AdminFlowController`):** after the AE7 governance gate and before compile, `peakShavingGate` refuses (422 `peakshaving_not_configured`, German) when a peakshaving flow's site has no `leistungspreis_eur_kw` (admin optimizer-config) - never deploy a no-op strategy the co-optimizer would ignore. With governance enabled + a Leistungspreis + the activation flag on, activation compiles + deploys normally.
- **Dry-run (`FlowSimulationMapper`):** peakshaving → the co-optimized "voltpilot" scenario (folds in the Leistungspreis epigraph). atypical-grid is deliberately NOT simulable → an honest German refusal at the dry-run, so it never reaches a simulated state (and thus never activates).
- **Co-solver:** the `PeakShavingModule` already participates (registered when `leistungspreis_eur_kw` is set; golden `peak-shaving-ci.json` pins v1↔co equivalence). Proven-not-changed by `test_cooptimizer.py::test_peak_shaving_module_shaves_the_import_peak_in_the_co_optimizer`.
- **Tests:** flowc `serve.test.js`/`compile.test.js` (peakshaving fixture + pinned hash), api `FlowPeakShavingApiTest` (Testcontainers e2e: build → validate → dry-run → gated → 422-no-price → activated:true; atypical-grid refused at dry-run - a SEPARATE class from `FlowApiTest` because it runs with the activation flag ON), `FlowSimulationMapperTest` (peakshaving→voltpilot, atypical→refused), `test_cooptimizer.py`.


# go-e Charger CONTROL adapter (certified, arbiter-driven, single-writer)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 19).


The write/execution counterpart to the read-only go-e driver (`fm/vp-goe-control`).
Unlike Deye/Fronius (guessed firmware registers → `bench_pending`), go-e's HTTP API v2
is documented + deterministic, so the whole write→readback loop is software-provable and
the family is **CERTIFIED** (may go live behind the kill-switch `VP_CONTROL_ENABLED`).

- **Canonical mapping = `nodered/goe/goe-control.js`** (the write twin of `goe-api.js`):
  pure `controlPlan(config, command, opts)` — kW→A (`I = P/(phases·voltage)`, **FLOORED**
  so actual charge never exceeds the arbitrated setpoint) → tri-state `frc` (go-e
  forceState: Neutral=0/Off=1/On=2) + `amp` (requestedCurrent), clamped to the go-e
  current band [min≈6, max]. Below-min/zero/`on_off=false` → **Off**; stale/loss/no-command
  → **Neutral** (hands control back, never a stuck forced current — the §4.2 `release`
  failsafe for native wallboxes); kill-switch off → **no writes, readback still runs**.
  Plus `evalReadback` (commanded-vs-actual match from `/api/status` frc/amp/psm;
  car/nrg[11]/acu/alw/pnp informational) and `makeExecutor(deps)` (the deps-injected
  HTTP set→readback loop, the `test-read.js makeReadOnce` pattern). Tests
  `goe/goe-control.test.js` (offline + in-process HTTP server: match/mismatch/unreachable/
  kill-switch).
- **⚠ `psm` (phaseSwitchMode: Auto=0/Force_1=1/Force_3=2) IS settable — the earlier
  "not a settable v2 key" claim was a DOCS-vs-REALITY gap** (corrected with the D4
  phase-switch build): psm is absent from the official `apikeys-en.md`, but evcc
  (`charger/go-e.go phases1p3p`: psm=1/2) and Home Assistant (`marq24/ha-goecharger-api2`
  Config filter) provably phase-switch go-e chargers with it, and the official docs
  DO document the surrounding machinery (`fsp` R/W, `mptwt`, `psh`, `pnp` R) - the
  ha-solarman/Victron secondary-source discipline. Whether a given model actually
  moves its contactor on psm stays VERIFY-on-device (CONTROL-BENCH.md → go-e).
- **D4 phase switching is a per-device CONFIG opt-in (`phase_switching`), never
  assumed.** The driver derives the two non-convex power ranges from the DEVICE's
  current band (`goe.Ranges`: 1p ≈1.38–3.68 / 3p ≈4.14–11.04 kW at 6–16 A @230 V),
  picks the range from the setpoint (a GAP wish snaps DOWN restrict-only - no value
  between the ranges ever reaches the device), and paces switches with the stateful
  **`goe.PhaseSwitcher`** (the CycleGuard pattern: 60 s dwell = the new desired range
  must be stable, 300 s minimum pause between switches - `phase_switch_dwell_s`/
  `phase_switch_pause_s`, conservative + config-adjustable, on TOP of the charger's
  own `mptwt`). A paced switch holds restrict-only in the ACTIVE range (1p: its max;
  3p below its min: Off) with the honest reason `guard_phase_switch` / "wartet -
  Phasenumschaltpause" - carried in the readback payload, the heartbeat consumers
  block (state `clamped`; the api listener + portal map know the word) and the plan
  fingerprint. UNKNOWN phase position (no readback yet) converts restrict-safe at 3
  phases and NEVER writes psm blind; the position adopts from the psm/pnp readback
  (psm Force_1/Force_3 outright, pnp while psm=Auto). A reboot forgets pacing state
  deliberately (a pause the switcher cannot know is not owed); a failed write never
  burns the pause budget (`NoteSwitchExecuted` only after a transport-error-free set).
- **The D11 self-service control check** rides "Verbindung testen": a go-e test with
  `control_test:true` (sources.js sets it for the go-e brand) makes the CORE re-write
  the charger's CURRENT `amp` value and read it back (`goe.ControlCheck` -
  non-disruptive by construction, a value-identical write; frc/psm NEVER touched;
  no amp readable → honestly "nicht prüfbar", never a guessed write). Result =
  `testconn.Result.ControlCheck`, rendered by verify.js ("Steuer-Schreibtest
  bestätigt"). Deliberately INDEPENDENT of the control flags - the wizard proves the
  write path BEFORE an operator arms them; a plain test (no flag) never writes.
- **The physical writer lives in the GO CORE** (`internal/goe` = the Go twin of
  goe-control.js, pinned to the SAME golden vectors `goe/goe-control-vectors.json` — the
  refCheckChar/EdgeRef + SocPlausible cross-language lockstep; `TestSharedVectors` on both
  sides). Chosen as the **single writer** (avoids a dual-writer on the same wallbox HTTP
  socket): the E2 arbiter already owns the clamped consumer command + the entity `Driver`
  block (go-e ip) + the readback plumbing, and go-e is HTTP-native. `agent/consumer_control.go`
  reads `arb.DecisionFor(id).Granted` for each go-e-backed wallbox entity (driver
  `communication:"goe_http_api"`), runs `goe.Execute`, and publishes `edge/entities/{id}/readback`
  (the v1 all_match shape the arbitration layer's `onEntityReadback` already folds into the
  heartbeat; a FAILED execute publishes its `error_code` in the payload - an honest status,
  never a silent success, and `confirmed` stays tri-state nil). **Gated on
  `VP_CONTROL_ENABLED` AND `VP_CONSUMER_CONTROL_ENABLED`: OFF (default) = ZERO HTTP** — a
  read-only deployment (the two live sites) is never touched, and with the flags off the
  whole driver incl. D4 is byte-identical inert. Periodic re-assert (60 s) so a rebooted
  wallbox re-adopts; change-detected so an unchanged command is not re-written every tick.
  Proof: `agent/consumer_control_test.go` (desired 22 kW → arbiter clamps to the 11 kW band
  → go-e set frc=On/amp=15 @ 3×230 → readback all_match on the bus; kill-switch-off = no HTTP;
  non-go-e entity skipped; the D4 scenario on a synthetic clock: unknown→readback→dwell
  hold→psm Force_3 lands→pause holds the down-switch at Off→psm Force_1 lands; gap wish
  never reaches the device; cycle-guard composition; failsafe release; named write error;
  consumer-flag-off byte-identical).
- **Node-RED is deliberately NOT the go-e writer** (single-writer). `goe-control.js` stays
  the canonical JS reference (embedding-ready) but is not embedded into a flow; `flows.json`
  is unchanged and `flows-sync.test.js` stays green. If the captain prefers a flow-side
  executor, embed `goe-control.js` via `build-flows.js` and retire the Go path — do not run
  both.
- **VERIFY-on-device** on the first real wallbox (frc/amp semantics + the REAL phase
  behaviour: contactor switch, vehicle re-negotiation, `mptwt` interplay) is the honest
  final step — see `nodered/CONTROL-BENCH.md` → "go-e Charger" (incl. the defined
  closure: the consumer-TYPE certification flip of `wallbox` in the api entitytypes
  catalog is a SEPARATE mini-PR after the captain's bench session, D11 — the type stays
  `simulator_only` until then; the EDGE control-family certification is orthogonal).
  Operator prerequisites (local HTTP API v2 on, fixed IP/mDNS, phase-capable models,
  config fields): `nodered/GOE.md`. Control safety: off by default, upstream guard
  authoritative (executor never widens the clamped setpoint; the arbiter's cycle guard
  composes upstream), fail-safe neutral/release, readback published.


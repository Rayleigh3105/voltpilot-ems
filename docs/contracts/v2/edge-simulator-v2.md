# Edge Simulator v2 — Test Rig Specification

**Status: BINDING specification (v2 track).** The rig every v2 increment proves itself against —
the hardware-free, end-to-end proof of the chain
**Flow → desired → arbitration → guards → write-readback**. It is a Stufe-1 deliverable
(roadmap: "v2-Skelett läuft gegen den bereits zertifizierten sunspec-Simulator" by end of
September) and later the conversion/rollback probe for the E13a pilot cutover.

## 1. What must be provable, without hardware

| # | Proof | Contracts exercised |
|---|---|---|
| P1 | A deployed flow artifact's action node emits a desired; the core's arbitration event confirms acceptance and holder. | flow-artifact, edge-desired |
| P2 | A desired beyond bounds is **clamped** (granted < requested) with the correct guard stage in `reasons`, and the readback proves the device received the clamped value — never the raw wish. | edge-desired, readback |
| P3 | Two same-class desires on one entity: holder keeps, challenger `rejected` (`arbitration:conflict`); no oscillation on the device. | edge-desired §4 |
| P4 | An `override: true` flow desired supersedes the plan slot, and the plan resumes on TTL expiry. | edge-desired §3–4, schedule 2.0 |
| P5 | A v2 plan drives multiple entities per slot (storage setpoint + generation limit); staleness (>20 min / aged `generated_at`) drops every entity to its registry failsafe while the peak target keeps being defended. | schedule 2.0 x-failsafe |
| P6 | Deployment set semantics: apply, replace (redeploy same tab ids), refuse (`unsupported` on version gate / missing capability), clear; each acked correctly in the heartbeat `flows` block. | flow-artifact |
| P7 | v1/v2 coexistence: a v1 retained schedule on `…/schedule` and a v2 plan on `…/v2/plan` exist side by side; the v1 consumer path is byte-for-byte unaffected (the shadow-phase precondition). | schedule 1.0 + 2.0 |

## 2. Reused building blocks (verified, not rebuilt)

| Asset | Role in the v2 rig |
|---|---|
| `edge/sim/sunspec-sim.js` | The **certified control family** (`sunspec` is the only entry in `CERTIFIED_CONTROL_FAMILIES`). Its FC6-writable regs 40/41/42 + FC3 readback (incl. the 0xFFFF no-limit sentinel) remain the canonical write→readback proof target. The v2 storage entity in the rig IS this simulator, unchanged. |
| `tools/edge-simulator` | The cloud-side contract publisher (telemetry 1.0, zero-touch handshake, mTLS). Stays v1 — it proves P7's "v1 path untouched" leg and remains the fleet-facing v1 device stand-in. |
| `edge-app/test/e2e-compose.sh` | The isolation pattern: own compose project name, high ports, stand-in cloud broker (mosquitto), assertion-by-subscription. The v2 rig extends this harness rather than inventing a new one. |
| In-process test servers | `modbus-tcp.e2e.test.js` / `sources-read.e2e.test.js` in-process Modbus servers, the vp-palette aedes bus harness, `node-red-node-test-helper` — the unit/integration tier below the compose rig. |
| Go in-process integration tests | `edge-app/core`'s mTLS mochi cloud-broker tests — the pattern for core-level arbitration tests without containers. |

## 3. New components

### 3.1 Simulated entity fleet (`edge/sim` growth)

Additional simulated devices, each a small TCP/HTTP endpoint in the `edge/sim` style with
**declared capabilities** matching an entity-registry fixture:

| Sim entity | Capabilities | Transport |
|---|---|---|
| storage (existing sunspec sim) | `measure:power_kw, soc_pct, pv_power_kw, load_kw` · `actuate:setpoint_kw, limit_kw` | Modbus TCP (regs 40/41/42, unchanged) |
| wallbox | `measure:power_kw` · `actuate:setpoint_kw, limit_pct, on_off` | Modbus TCP (new compact register map, FC3/FC6, readback-capable) |
| heat rod | `measure:power_kw` · `actuate:on_off` | Modbus TCP coil or HTTP (go-e/Shelly-style HTTP is acceptable — the driver layer is not under test here) |
| grid meter | `measure:power_kw` (signed) | Modbus TCP (existing sim profile) |
| PV inverter | `measure:pv_power_kw` · `actuate:limit_kw, limit_pct` | Modbus TCP |

Every controllable sim entity MUST implement **readback fidelity** (written value is readable
back, with an optional configurable mismatch mode to test the mismatch path) — the reg-40/41/42
discipline generalized. Sim register maps are rig-internal, not product driver contracts.

### 3.2 Scriptable telemetry

Each sim entity accepts a **timeline script** (JSON: `[{at_s, channels:{…}}, …]`, linear
interpolation optional per channel) plus the deterministic-seed and `--time-scale` conventions
from `tools/edge-simulator`. Scripts make guard scenarios reproducible: PV ramps for the
solar-only clamp, load steps for peak-guard quarters, SoC trajectories for floor/reserve tests.

### 3.3 Desired injection + assertion CLI (`vp-sim-assert`)

A dependency-light CLI (Node or Python, rig-only) that talks to the local bus:

- `emit-desired <entity> <json>` — publish a desired (any source/class, to test rejection paths
  too);
- `expect-arbitration <entity> --outcome clamped --stage guard:solar_only_charge --timeout 10s`
  — subscribe and assert on arbitration events;
- `expect-readback <entity> --match --value 6.2` — assert the register-level proof;
- `expect-command <entity> --setpoint-kw 6.2` — assert the retained core command.

Assertions are the machine half of P1–P4; the compose rig scripts them exactly like
`e2e-compose.sh` scripts today's telemetry/setpoint assertions.

### 3.4 Guard-clamp assertion pack

Canned scenario scripts (timeline + injected desires + expected outcomes) for every guard
stage: rated band, SoC window (floor + ceiling), EEG solar-only (incl. unknown-PV → charge 0),
§14a envelope import AND export, peak defense (projected quarter mean, reserve floor vs.
defense-below-reserve). Each scenario pins `reasons[].stage` — the guard ORDER is contract
(verified v1 chain), so a reordering regression fails the pack.

### 3.5 Flow fixture runner

Drives P1/P4/P6 end to end: take a flow-graph fixture (e.g.
[`examples/flow-graph.valid.pv-surplus-heatrod.json`](./examples/flow-graph.valid.pv-surplus-heatrod.json)),
compile it (the E2 compiler as a library call), wrap the artifact in a deployment, publish it
retained on `…/v2/flows` via the stand-in cloud broker, then assert the heartbeat `flows` ack
and run the P1–P4 assertions against the deployed flow. Until the compiler exists, the runner
accepts a pre-compiled artifact fixture
([`examples/flow-artifact.valid.artifact.json`](./examples/flow-artifact.valid.artifact.json))
so arbitration/guard proofs (P2–P5) don't wait on E2.

### 3.6 v2 plan publisher

A `tools/edge-simulator`-style helper (or an extension flag on the existing e2e harness) that
publishes schedule-2.0 fixtures retained on `…/v2/plan` — including the staleness scenarios
(aged `generated_at`, republish silence) — plus the v1 schedule side by side for P7.

## 4. Layering (what runs where)

| Tier | Harness | Covers |
|---|---|---|
| Unit / in-process | Go tests (arbitration, TTL, priority, guard composition), Node tests (palette desire node, compiled-wiring shaping) | logic, no containers |
| Integration | Go in-process bus + stub cloud broker; Node aedes harness | topic contracts, retained semantics, heartbeat blocks |
| Compose e2e | extended `e2e-compose.sh` rig: core + nodered + sim fleet + stand-in cloud broker | P1–P7, the full chain incl. real Node-RED and real Modbus writes |

The compose rig is also the **E13a conversion/rollback probe** venue: run a v1-configured edge,
convert to v2, roll back — before any real device is touched.

## 5. Non-goals

- No hardware certification: the rig proves the CHAIN, never a vendor driver — bench
  certification (CONTROL-BENCH.md) stays the only path to `CERTIFIED_CONTROL_FAMILIES` /
  per-device enablement.
- No cloud-stack simulation beyond the stand-in broker: the co-optimizer, portal and compiler
  are exercised via fixtures here; their own test suites own their correctness.
- No load/perf benchmarking in v1 of the rig.

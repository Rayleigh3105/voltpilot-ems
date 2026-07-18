# Contracts v2 (EMS replatforming track)

**BINDING interface contracts for the VoltPilot EMS-v2 track** — the flow-based, multi-entity
platform (E0 "Contract-Artefakte"). Everything under `docs/contracts/` (the 1.0 files) is
**FROZEN and untouched**; v2 lives here, alongside.

| File | Contract |
|---|---|
| [`edge-desired-arbitration.md`](./edge-desired-arbitration.md) + [`edge-desired.schema.json`](./edge-desired.schema.json) | Local-bus v2 entity topic family; desired ("Wunsch") payloads from flows; priority classes, TTL, ownership/conflicts; arbitration result events. |
| [`mqtt-schedule-2.0.md`](./mqtt-schedule-2.0.md) + [`mqtt-schedule-2.0.schema.json`](./mqtt-schedule-2.0.schema.json) | Multi-entity plan Cloud → Edge on `ems/{t}/{s}/{d}/v2/plan` (retained); generic command vocabulary; 1.0 staleness/x-failsafe semantics carried over and generalized per entity. |
| [`plan-execution-ownership.md`](./plan-execution-ownership.md) | Decision record: the Go core remains the executor; flows emit desires, never register writes. Sequence diagrams for the four canonical situations. |
| [`flow-graph.md`](./flow-graph.md) + [`flow-graph.schema.json`](./flow-graph.schema.json) | The typed flow model: catalog node instances, typed ports, edges, triggers, validation rules, lifecycle. |
| [`flow-artifact.md`](./flow-artifact.md) + [`flow-artifact.schema.json`](./flow-artifact.schema.json) | The deployable compiled flow: manifest (hash, version gates, capability requirements), Node-RED tab bundle, retained deployment set on `…/v2/flows`, heartbeat ack, rollback, reseed coexistence. |
| [`edge-simulator-v2.md`](./edge-simulator-v2.md) | The hardware-free test rig proving Flow → desired → arbitration → guards → write-readback; reused v1 assets vs. new components. |
| [`examples/`](./examples/) | ajv-validated fixtures: ≥ 2 valid + 1 invalid per schema ([`examples/README.md`](./examples/README.md)). |

## v1 / v2 coexistence philosophy

1. **The 1.0 contracts are frozen.** Deployed edges keep speaking them forever; no dual-publish
   obligation ever lands on an old device. Evolution of 1.0 remains what it always was:
   additive optional fields only.
2. **Dual-consume, not migration.** The cloud consumes both eras side by side (writer/ingest
   learn v2 inputs next to v1 in E1a); a device is EITHER v1 OR v2 at any moment, and switching
   is an explicit, reversible cutover (E13a), rehearsed on the simulator rig first.
3. **Separation by topic, not by version negotiation.** All v2 cloud topics live in the
   per-device `ems/{t}/{s}/{d}/v2/#` subtree; the ACL's default-deny keeps v1 devices blind to
   it. Retained slots of the two eras can never collide — which is what makes the shadow phase
   (v2 publishes, v1 controls) possible at all.
4. **Per-contract `schema_version`.** Version numbers belong to a contract, not to the platform
   era: `mqtt-schedule-2.0` is genuinely the second version of the schedule contract; brand-new
   contracts (desired, flow-graph, flow-artifact) start at `1.0` even though they are v2-track
   artifacts. Bump on breaking change; consumers stay tolerant of unknown additive fields.
5. **The guard line is non-negotiable in every era.** Whatever commands an entity — 1.0
   schedule, 2.0 plan, a user flow, later an EEBUS master — the Go core's restrict-only guard
   chain clamps it before any certified register write. v2 changes who may WISH, never who
   ENFORCES.

## Decision log

| # | Decision | Chosen | Rationale (short — details in the linked doc) |
|---|---|---|---|
| D-1 | Schedule 2.0 coexistence: separate topic vs `schema_version` negotiation on `…/schedule` | **Separate topic** `…/v2/plan` | One retained message per topic — negotiation would clobber the v1 retained plan; shadow phase needs both plans side by side; subscription IS the negotiation; rollback trivial. ([schedule 2.0 §1](./mqtt-schedule-2.0.md)) |
| D-2 | v2 cloud topic namespace | **One `v2/#` subtree per device**, two wildcard ACL grant lines (sub down / pub up) | The ACL grant template lives in three hand-lockstep writers (three real prod outages); one template change covers ALL current and future v2 topics (plan, flows, prices, telemetry). E14 ACL consolidation is the prerequisite. ([schedule 2.0 §1](./mqtt-schedule-2.0.md)) |
| D-3 | Local entity topic family | **Per-entity topics** `edge/entities/{id}/config·telemetry·desired·command·readback·arbitration` | Follows the proven per-source `edge/sources/{id}/telemetry` scaling + error isolation; per-entity retained config beats the v1 all-in-one array (subscribe-what-you-use, retained-clear per entity, wildcard enumeration). ([desired §1](./edge-desired-arbitration.md)) |
| D-4 | Priority model | **5 classes** safety > grid > contract > market > flow; safety/grid/contract manifest today as guard clamps, reserved as desired classes for the E8 masters; flows are always class `flow` (core-enforced) | Compliance never competes — it clamps; matches D9 (co-optimization reconciles upstream, the edge cascade secures) and the E8 research ("Netzbetreiber gewinnt immer" > DV > site optimizer). ([desired §3](./edge-desired-arbitration.md)) |
| D-5 | Flow vs. plan on one entity | **`market` > `flow` by default; explicit TTL-bounded `override` (≤ 4 h) elevates a flow desire above market only** | D9 makes the solver the arbiter of multi-use; the override is the "boost" escape hatch — owner intent may cost money ("kann nerven"), never compliance. ([desired §4](./edge-desired-arbitration.md)) |
| D-6 | Same-class conflicts | **Holder keeps; challenger rejected (`conflict`) until TTL lapse** — no last-writer-wins; activation-time exclusive-resource validation prevents the case | Two flows must never oscillate a physical device; the editor refuses the conflict before it exists. ([desired §4](./edge-desired-arbitration.md), [flow-graph V-5](./flow-graph.md)) |
| D-7 | Desired retention/TTL | **Desires are never retained; `ttl_s` required** | A retained wish from a dead flow is a command from the past; core-owned OUTPUTS stay retained (command topic), inputs expire. ([desired §2/§5](./edge-desired-arbitration.md)) |
| D-8 | `charge_from_grid_allowed` default | **Absent = NOT allowed** (only explicit `true` releases the solar-only clamp) | Promotes the shipped edge's deliberate fail-safe deviation into the contract — see discrepancy log #1. ([schedule 2.0 §4](./mqtt-schedule-2.0.md)) |
| D-9 | Failsafe location | **Entity registry config, not the plan** — except the PS-3 staleness survivors (`grid_import_limit_kw`, `reserve_soc_pct`), which stay plan-carried | A failsafe carried only in the plan dies with the plan; the peak survivors are restrict-only, verified v1 behavior. ([schedule 2.0 §3](./mqtt-schedule-2.0.md)) |
| D-10 | Execution ownership | **Go core remains the executor**; flows consume plan data and emit desires; drivers execute only core-published commands | The reliability substrate and guard chain are the proven asset; safety separation must be structural (D1: editor for everyone). ([plan-execution-ownership.md](./plan-execution-ownership.md)) |
| D-11 | Flow artifact delivery | **Inline retained deployment set** on `…/v2/flows`, size-budgeted (256/512 KiB); out-of-band fetch reserved | The retained-config self-wiring pattern is proven three times over; retained = convergence on reconnect with zero round-trips. ([flow-artifact §3](./flow-artifact.md)) |
| D-12 | Reseed coexistence | **Per-tab ownership markers** (`@vp-flow`); reseed replaces the vendor tab group only; retained deployment self-heals dropped artifact tabs | Today's wholesale `flows.json` reseed is fatal to user flows — see discrepancy log #3. ([flow-artifact §4](./flow-artifact.md)) |
| D-13 | Control claims in the graph | **Explicit `claims` on node instances** (editor-filled from the catalog) | Exclusive-resource validation must work generically, without the validator knowing every node type's parameter schema. ([flow-graph §1](./flow-graph.md)) |
| D-14 | Command vocabulary | `setpoint_kw`, `on_off`, `limit_pct`, `limit_kw`, `mode` — shared verbatim between desired and plan | `limit_kw` added to the ticket's four: absolute caps are what curtailment/§14a plans emit (v1 `pv_limit_kw` precedent); limits are reduce-only by contract. ([desired §2](./edge-desired-arbitration.md)) |

## Discrepancy log (v1 reality vs. planning documents — the CODE wins)

| # | Discrepancy | Consequence here |
|---|---|---|
| 1 | The **1.0 schedule contract text** says absent `grid_charge_allowed` = allowed; the shipped Go edge (`plan.go SolarOnlyCharge()`) deliberately clamps fail-safe — only explicit `true` releases. | v2 adopts the code's reading as contract (D-8); the v2 optimizer must always publish the field for merchant storage. |
| 2 | The plan draft (§2.2) speaks of flows consuming `edge/entities/{id}/telemetry` as if the family existed; **in code it does not** — today there are `edge/telemetry` + `edge/sources/{id}/telemetry` (`localbus.go`, `sources.go`). | The entity family is defined HERE for the first time, justified against the per-source precedent (D-3); E1a builds it. |
| 3 | The plan draft says the reseed mechanism "learns" vendor-vs-user tab groups; **today's `reseed-entrypoint.sh` replaces `flows.json` wholesale** on template-hash change. | The contract binds the target per-tab-group behavior (D-12); until E2 lands it, deploying user flows to a device would be unsafe — the rig's P6 proof gates this. |
| 4 | The plan draft's §2.1 telemetry-2.0 shape (`entities.{id}.channels`) and the prices down-channel are named but unauthored. | Deliberately OUT of E0 scope; their topic homes are reserved in the `v2/#` subtree ([schedule 2.0 §1](./mqtt-schedule-2.0.md)) so the ACL template already covers them. |

## Validating the schemas

All four schemas are JSON Schema 2020-12 and ajv-compatible (like the 1.0 contracts, they use
`x-*` annotation keywords — compile with `strict: false` or declare the keywords). Fixture
expectations are pinned in [`examples/README.md`](./examples/README.md).

## Versioning

Every payload carries `schema_version` (per contract — see coexistence philosophy #4). Bump on
any breaking change; keep consumers tolerant of unknown additive fields. Changing anything in
this directory after E0 is accepted is a contract change and needs the same discipline as
`docs/contracts/`.

# M5 · Automationen — the editor at Node-RED quality

> Realizes report §4 **P5** · concept tab **6 · Automationen** (the star).
> Read [`BUILD.md`](./BUILD.md) §2 (**D1** and **D2** are locked), §4 and §5 first.
> **Largest milestone.** Its canvas/compiler track may start right after M1, in parallel.

## Goal

Make the deep automation surface feel like **real Node-RED**, in VoltPilot's brand and German
language: a dark canvas with a grid, **freely draggable nodes whose positions are saved**, bezier
wires, **live value chips on the wires** ("2,9 kW", "EIN") and per-node states ("erfüllt", "EIN seit
14:02"), a palette in the four catalog groups **plus a "Funktion (Code)" node** (amber), a guard
footer with the non-editable protection chips, and — crucially — the editor **opens the version that
is actually running on the device** ("Läuft auf dem Gerät", green). Editing visibly forks a draft
("Sie bearbeiten eine Kopie — das Gerät läuft weiter mit v4"); **"Ausrollen"** bundles
prüfen → simulieren → ausrollen into one guided step. On phones the automation is a **read-only
step list**, not a mini canvas.

The simple path (templates + guided builder from M4) stays the default; the editor is exactly one
click deeper.

## Scope

**In**
1. **Drag + persisted positions** in `FlowCanvas`, stored **outside** the hashed document.
2. **Deployed-version-first editor**: default view = the active version + its device ack; edit forks
   a draft; one guided "Ausrollen" orchestrating the existing validate → simulate → activate calls.
3. **Live values**: channel values from entity telemetry (shipped) + an **additive, feature-flagged
   per-node status** contributed by the edge heartbeat, with a defined fallback.
4. **Code node `vp.logic.function`** in all three catalogs + flowc compilation into a Node-RED
   function node **wrapped in a watchdog** (D1), plus the contract amendment that permits it.
5. **Phone read view**: the flow as a vertical step list with the same live values + a pause switch.

**Out**
- No tunnelling of the edge's Node-RED into the portal (D2 rejected that).
- No change to the guard chain, the arbitration path or the activation gates. Code nodes emit
  **wishes** through `vp-desired` like every other node.
- No new deployment mechanism: flowc artifacts, `@vp-flow` tabs, reseed coexistence stay as they are.

---

## Part A — drag + persisted positions

**The hard rule:** the flow-graph schema is `additionalProperties: false` and carries **no**
positions (`docs/contracts/v2/flow-graph.schema.json`); the artifact bundle's node `x`/`y` are
assigned **by flowc itself** (`compile.js` ~L460) and therefore sit **inside `content_hash`**.
So a dragged position must never reach the document or the artifact — otherwise every drag changes
the hash and re-deploys the device.

| File | New? | What |
|---|---|---|
| `services/api/src/main/resources/db/migration/V20260723010000__flow_layout.sql` | **new** | `flow_layout(flow_id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, site_id UUID NOT NULL REFERENCES site(id) ON DELETE CASCADE, positions JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` + grants + `FORCE ROW LEVEL SECURITY` + the tenant policy (copy `V20260719000000__flow_definition.sql`). **Keyed on `flow_id`, not `(flow_id, flow_version)`** — layout follows the flow identity, so a forked draft inherits its positions. |
| `services/api/…/repo/FlowLayoutRepository.java` | **new** | RLS-scoped get/upsert. |
| `services/api/…/web/SiteFlowController.java` | edit | `GET`/`PUT /sites/{siteId}/flows/{flowId}/layout`. Mirror on `AdminFlowController`. Body `{positions: {<nodeId>: {x, y}}}`; unknown node ids are dropped server-side. |
| `frontend/portal/src/flows/positions.ts` | **new** | Pure: merge saved positions with the deterministic `layout.ts` fallback (`resolvePositions(doc, saved)` — a node without a saved position gets its auto-layout slot), plus drag maths (snap, bounds, `dragTo`). |
| `frontend/portal/src/components/flows/FlowCanvas.tsx` | edit | Pointer-event drag (`pointerdown`/`move`/`up` with capture), grid background, positions from `resolvePositions`, debounced `onPositionsChange`. Click-to-connect stays (see risk note); wire dragging is optional polish. |
| `frontend/portal/src/flows/layout.ts` | keep | Stays the fallback for position-less flows; **do not delete**. |

---

## Part B — deployed-version-first + guided rollout

| File | What |
|---|---|
| `frontend/portal/src/pages/admin/FlowEditorPage.tsx` (edit, ~881 lines) | Default view = the **active** version; a green "Läuft auf dem Gerät · v{N}" badge fed by the device ack; editing an active version calls the existing save (which server-side creates a NEW draft version) and shows the fork banner; the "Ausrollen" button runs validate → simulate → activate with a progress UI over the **existing** endpoints (`…/validate`, `…/simulate` + poll, `…/activate`). |
| `frontend/portal/src/flows/rollout.ts` (**new**, pure) | The step machine `rolloutSteps(state)` → the German labels/states of prüfen/simulieren/ausrollen incl. failure mapping (`compiler_unavailable` / `compiler_rejected` / `gated_node_not_enabled` / `activation_disabled` → honest German copy). |
| Device ack source | The heartbeat's existing `flows` block (`edge-app/core/internal/cloud/cloud.go` `FlowsSummary`/`AppliedFlow`: `flow_id`, `flow_version`, `content_hash`, `state` = `active`\|`error`\|`unsupported`, `detail`). If the api does not yet persist it, add a small RLS table + read endpoint alongside Part C's listener — **do not invent a per-flow ack endpoint** beyond that. |

---

## Part C — live values

**Channel values (works today, no edge change):** the editor subscribes the plant's entity telemetry
(`api.siteEntities` / `api.entityHistory` / `api.telemetry`, poll) and renders a chip on each wire
leaving a data node.

**Per-node states (needs the additive edge contribution, feature-flagged):**

| Layer | File | What |
|---|---|---|
| Node-RED | `edge-app/nodered/vp-palette/nodes/vp-node-status.{js,html}` (**new**) | A tiny status tap publishing `{flow_id, node_id, state, since}` on the local bus; flowc wires it from the compiled nodes. The graph node id is recoverable because flowc's NR ids are deterministic: `nrId = tabId + '-' + graphNodeId` (`compile.js` ~L335). |
| Edge core | `edge-app/core/internal/cloud/cloud.go` + `internal/agent/*` | An **additive** `flow_node_status` block on the status heartbeat (the `SourcesSummary`/`ControlSummary` precedent: bounded entry count, absent values stay absent). Behind `VP_FLOW_NODE_STATUS_ENABLED` (default off in this milestone, on once proven). |
| api | `services/api/…/flows/FlowNodeStatusListener.java` (**new**) + migration `V20260723020000__flow_node_status.sql` + `GET /sites/{siteId}/flow-node-status` | The **fourth** sibling on `ems/+/+/+/status` next to the control / entity / source listeners — same authorization posture (broker ACL + mTLS CN, topic == payload identity re-validated, device resolved through the RLS repository under the topic tenant), replacing the device's set wholesale. Flag `VOLTPILOT_FLOW_NODE_STATUS_LISTENER_ENABLED`. |
| Portal | `src/flows/liveValues.ts` (**new**, pure) | Maps channel values + node statuses onto wires/nodes; **fallback**: without node status the editor shows channel values only and **no** node state — never a guessed one. |

---

## Part D — the code node `vp.logic.function` (D1)

**Contract first.** `docs/contracts/v2/flow-graph.md` §6 says *"No free code (function nodes,
expressions) — v1 scope, per D1"* (that is the **v2-track** D1, a different decision from this
project's D1 — do not confuse them). Adding the node therefore **requires a contract amendment**,
exactly the way D-15 amended §6 for `vp.modbus.*`:

1. Add **decision `D-16`** to the table in `docs/contracts/v2/README.md`: a sandboxed code node is
   permitted as a **catalog addition** (no graph-schema change), runtime `edge` only, wrapped in a
   CPU/time watchdog, with no network handles in the sandbox context and every device effect going
   through desired → arbitration → guard chain.
2. Amend `flow-graph.md` §6's first bullet to reference D-16 (the entity abstraction and the
   guard/arbitration model remain the only certified path).

**Then the three catalogs, in lockstep** (`compile.test.js` guards three axes: type-set equality,
per-type port shape incl. `requires_any_input` ↔ `requiresAnyInput`, and feed reachability):

| File | What |
|---|---|
| `services/api/src/main/resources/flowcatalog/catalog.json` | New type `vp.logic.function`, `group: "logik"`, `runtimes: ["edge"]`, inputs `in` (any), outputs `out`, parameters `{code: string (maxLength ~4000), timeout_ms: int ≤ 500}`. |
| `frontend/portal/src/flows/catalog.json` | **Byte-equal copy** (`catalog.sync.test.ts` asserts structural equality). |
| `edge-app/nodered/flowc/catalog.js` `TYPES` | The compiler side with the same ports; `minPalette` stays `0.2.0` (a plain NR `function` node needs no palette node). |
| `edge-app/nodered/flowc/compile.js` | Emit a Node-RED `function` node whose body is the **watchdog wrapper**: a deadline check around the user code, `try/catch` → `node.status({fill:'red', …})` + `node.error`, no `net`/`http` in scope. The user code is embedded as data, never concatenated into control flow that could escape the wrapper. |
| `edge-app/nodered/flowc/testdata/` + `flow-graph.valid.function-node.json` + `pinned-function-hash.txt` | New fixture + its pinned hash. |
| `frontend/portal/src/flows/model.ts` | `ID_PREFIX` entry + editor parameter shape for the code node. |
| `frontend/portal/src/components/flows/CodeNodeEditor.tsx` (**new**) | A plain textarea-based editor (no CDN Monaco — the portal CSP is `script-src 'self'` with no `unsafe-inline`), amber node styling, character counter, and the three-clamp explainer from the concept. |
| `designsystem/components/core/Icon.jsx` + `.d.ts` | Add a `code` glyph. |

**Node-RED settings:** confirm `functionGlobalContext` exposes **no** `net`/`http` for customer flow
tabs (`edge-app/nodered/settings.js` currently exposes `net`/`http`/`https` for the **vendor**
self-wiring tabs). If the runtime cannot scope that per tab, the wrapper must shadow those names
inside the function scope — state which mechanism you used in the PR body.

---

## Part E — phone read view

`frontend/portal/src/flows/stepList.ts` (**new**, pure): `stepList(doc, liveValues)` → the ordered
German sentences ("Wenn PV-Überschuss > 3,5 kW … dann Wallbox EIN") derived from the graph
(topological order, one step per node with its live value). Rendered by
`components/flows/FlowStepList.tsx` (**new**) below 720 px, plus the existing pause action.
**No mini canvas on phones.**

---

## Acceptance criteria

1. Nodes drag with the mouse and with touch; positions survive a reload and a page change; a
   position-less flow still renders the deterministic auto-layout.
2. **Dragging a node does not change `content_hash`** — proven by a test that compiles the same
   document before and after a layout write and compares hashes, and by the fact that no layout
   value reaches `flow_definition.document`.
3. Opening an automation shows the **deployed** version with the green "Läuft auf dem Gerät" badge
   (or an honest "noch nicht ausgerollt"); editing shows the fork banner naming the running version.
4. "Ausrollen" runs prüfen → simulieren → ausrollen with visible progress and maps every backend
   refusal to German copy; a refused rollout leaves the active version untouched.
5. Data nodes show live channel values on their wires. With the edge flag **off**, no per-node state
   is shown anywhere (no guessed states) and the editor stays fully usable.
6. A `vp.logic.function` node can be placed, edited, validated, simulated, activated and deployed;
   the compiled function node is wrapped in the watchdog; the three-catalog guards are green; the
   new pinned hash is committed.
7. Customer code cannot reach the network from the sandbox context and cannot bypass the guard chain
   — a code node commanding a device produces a **desire** that is clamped exactly like any other.
8. At ≤ 720 px an automation renders as a step list with live values and a pause switch, no canvas.

## Tests to add / adjust

- `src/flows/positions.test.ts` (**new**): merge with fallback, drag maths, unknown-id drop.
- `src/components/flows/FlowCanvas.test.tsx` — drag updates positions; the read-only preview
  (`pointer-events: none`) stays non-interactive.
- `src/flows/rollout.test.ts` (**new**): the step machine incl. every failure mapping.
- `src/flows/liveValues.test.ts` (**new**): channel chips; **no** node state without the block.
- `src/flows/stepList.test.ts` (**new**): sentence derivation for the two customer templates.
- `edge-app/nodered/flowc/compile.test.js` — new function-node fixture: compiles, watchdog present,
  pinned hash; the three catalog guards stay green.
- `edge-app/nodered/flowc/serve.test.js` — the fixture through the sidecar.
- `services/api` `FlowLayoutApiTest` (**new**): layout round-trip, RLS 404, layout never appears in
  the stored document/artifact. `FlowNodeStatusListener` unit + a Testcontainers ingest test
  mirroring `ControlStatusListener`'s (spoofed identity skipped).
- `edge-app/core` `go test ./...` — the heartbeat block builder (bounded, absent-stays-absent).
- `src/flows/catalog.sync.test.ts`, `src/flows/validate.test.ts`, `FlowGraphValidatorTest` — the new
  type validates and is refused where it should be (runtime `cloud`).

## Dependencies

**M1** (shell) for mounting; **M4** for the single "＋" entry point (build against today's
`FlowEditorPage`, re-point when M4 lands). Independent of M2/M3/M6.

## Gotchas

- **Positions must live outside the hashed document.** Both ends matter: the schema is
  `additionalProperties: false`, and flowc assigns the bundle's `x`/`y` itself inside `content_hash`.
  Portal positions are a *portal* concern; they never travel to the device.
- **The three-catalog guard bites hard.** A type the editor offers but flowc cannot compile makes
  activation die with `compiler_rejected` *after* the flow validated and simulated (the real #518
  bug). Add the type to all three catalogs in the same commit and run `compile.test.js`.
- **Pinned hashes regenerate deliberately.** The tests no longer self-seed a missing pin. Only the
  new fixture's pin is added; existing pins must stay unchanged (adding a catalog type does not
  change an artifact that does not use it — if an existing pin moves, you changed something else).
- **The v2-track "D1" is not this project's D1.** Do not delete the §6 sentence; amend it through a
  logged decision (D-16) the way D-15 did.
- **CSP:** the portal's prod nginx is `script-src 'self'` **without** `unsafe-inline`. No CDN editor,
  no inline `<script>`. `npm run test:csp` will catch a violation.
- **Heartbeat additions are additive and bounded.** Follow `SourcesSummary`: cap entries, omit
  absent values, keep `schema_version` untouched; old edges simply do not send the block.
- **Risk fallback (report §risks ①):** if drag + wire-dragging cannot both land, ship **drag +
  live values** first and keep click-to-connect for wiring. Do not ship a canvas that loses
  click-to-connect.
- Node-RED's `settings.js` fails closed on the admin password — do not weaken it while wiring the
  status tap.

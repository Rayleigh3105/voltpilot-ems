# Flow Graph Contract (v2)

**Status: BINDING (v2 track). Schema: [`flow-graph.schema.json`](./flow-graph.schema.json). Examples: [`examples/`](./examples/).**

The typed flow model: the editable, versioned source document behind the portal flow editor
(captain D1/D2 — an own typed editor for everyone, **no free code nodes**; Node-RED stays the
invisible runtime). The graph is what gets validated and simulated; the compiler turns an
activated graph into a [flow artifact](./flow-artifact.md).

## 1. Node instances and the catalog

A node instance references a **catalog type** (`vp.<domain>.<name>`) at a **semver
`type_version`**. The node catalog (port signatures, parameter schemas, runtime support,
claim derivation) is a versioned platform artifact owned by E2/E4 — the graph document never
embeds type definitions, only references. Initial catalog domains (from plan §2.3):
`vp.entity.*` (read/control, capability-based), `vp.strategy.*` (market, peakshaving,
selfconsumption, atypical-grid — strategy nodes register constraint/objective contributions
with the cloud co-optimizer), `vp.price.*`, `vp.schedule.*` (time windows), `vp.logic.*`
(threshold/hysteresis, and/or/compare), `vp.notify.*`.

**Explicit `claims`.** Control-capable nodes carry their entity claims in the document (filled
by the editor from catalog type + parameters). This makes exclusive-resource validation
possible generically — the validator does not need every type's parameter schema to know what
the flow controls. `delegated: true` marks a strategy node handing the entity to the cloud
co-optimizer (the plan will command it, class `market`); a direct action node claim
(`delegated` absent) emits class-`flow` desires. Both claim the same exclusive resource.

## 2. Typed ports

Port **names** appear in the graph (edges reference `{node, port}`); port **types** are declared
by the catalog type. The type system:

| Type | Meaning |
|---|---|
| `number` | scalar (dimension per port declaration, e.g. kW, %, EUR) |
| `bool` | logic level |
| `timeseries` | time-indexed numbers (slot-aligned or sampled) |
| `price` | a price timeseries (EUR/MWh or ct/kWh per port declaration) |
| `plan` | the site's active plan (read-only view of [mqtt-schedule 2.0](./mqtt-schedule-2.0.md) data) |
| `event` | discrete occurrences (fires downstream evaluation) |
| `entityRef` | a reference to a registry entity (wiring-time binding, not a runtime value) |

**Compatibility** (validator rule V-1): a connection `from → to` is legal iff the source type
equals the sink type, or is one of the declared widenings: `price → timeseries` (a price IS a
timeseries; the unit annotation is preserved), `number → timeseries` (a scalar is a constant
series). Everything else — including `bool → number`, `timeseries → number` (would need an
explicit aggregate node), and anything → `entityRef` — is a validation error. There are no
implicit unit conversions; unit mismatches on otherwise-compatible ports are errors.

## 3. Triggers and evaluation semantics

Triggers declare **when** the flow evaluates: `interval` (fixed cadence), `value-change`
(watched output port, optional `deadband`), `slot-boundary` (the platform slot grid,
aligned with `slot_minutes` of the active plan), `event` (named platform events, e.g.
`plan-received`, `entity-offline`, `entity-online`).

Evaluation is **single-threaded per flow and non-reentrant**: a trigger firing during an
evaluation is coalesced, never interleaved. Each evaluation is bounded by the runtime's
evaluation timeout; on timeout the evaluation is aborted and logged — emitted desires simply
expire via their TTL, so a hung flow degrades exactly like a stopped one (no cleanup protocol
needed). Feedback edges deliver the **previous** evaluation's value (one-step delay), which is
what makes declared cycles terminate.

## 4. Validation rules (the platform validator)

JSON Schema pins the document shape; these semantic rules run at save/activation and in the
editor live:

| # | Rule |
|---|---|
| V-1 | **Port type compatibility** per §2, on every edge; required input ports of every node connected (or parameter-defaulted per catalog); at most one edge into any input port. |
| V-2 | **Acyclic modulo feedback**: the graph with `feedback: true` edges removed must be a DAG. |
| V-3 | **Node/edge/trigger id uniqueness**; every edge/trigger endpoint references an existing node and a port that exists on its catalog type. |
| V-4 | **Catalog resolution**: every `type`@`type_version` exists in the catalog, supports the flow's `runtime`, and `parameters` validate against the type's parameter schema. |
| V-5 | **Exclusive resources**: no two claims on the same `entity_id` — neither within this flow nor across the site's ACTIVE (and concurrently activating) flows of the same runtime. `delegated` and direct claims conflict with each other too. Violations are shown in the editor at the offending nodes; activation is refused. |
| V-6 | **Capability match**: every claim's commands and every `vp.entity.read` channel must exist in the entity registry's capability set for that entity (`actuate:*` / `measure:*`). |
| V-7 | **Trigger sanity**: at least one trigger; `every_s` bounds per schema; a `value-change` source must be an existing output port. |
| V-8 | **Runtime whitelist**: cloud flows may not use edge-only nodes and vice versa (catalog-declared, per D8's runner-specific node whitelist). |

The validator's output is part of the editor UX contract: machine-readable
`{rule, node/edge ids, message}` findings, German customer-facing copy layered in the portal.

## 5. Lifecycle

`draft → simulated → active → retired`, per flow **version**:

- **draft** — editable. Every save re-validates; V-findings are advisory here.
- **simulated** — a recorded simulation run exists for exactly this version (dry-run against
  historical site data + prices; the simulate-serve/JobStore pattern). Any edit produces a new
  draft version.
- **active** — validation passed, compiled, deployed (see [flow-artifact](./flow-artifact.md)).
  **At most one active version per flow.** Activating version N+1 supersedes N atomically
  (the deployment set replaces the artifact). Activation of customer-authored flows SHOULD be
  policy-gated on a prior simulation (D1 safety net); the gate itself is portal policy (E3),
  not this contract.
- **retired** — terminal for a version; the flow (identity) is retired when no version is
  active and none is meant to be.

Rollback = re-activating the previous version (its artifact is re-deployed; see
flow-artifact §rollback). `lifecycle` in the document is an informative snapshot; the
authoritative state machine lives in the platform API.

## 6. What is deliberately NOT in the graph

- **No free code** (function nodes, expressions) — v1 scope, per D1; a sandboxed expression
  node is a possible later catalog addition, not a graph-schema change.
- **No guard parameters, no priorities.** Guard limits live in the entity registry; desired
  priority is fixed to class `flow` by the runtime. A flow cannot state "I am more important".
- **No topics, no registers, no driver details.** The graph speaks entities and capabilities;
  transport/driver wiring is the vendor layer's self-wiring, unchanged. ONE scoped exception,
  logged as decision D-15 in the [README decision log](./README.md): catalog types in the
  `vp.modbus.*` domain MAY carry transport-level parameters (host/register/data type) as a
  runtime-`edge`-only power-user escape hatch — read free, write governance-gated and outside
  the guard/arbitration model; the entity abstraction remains the default and the only
  certified path.

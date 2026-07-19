# Anlagen-Topologie-Read-Model (AE1)

The ONE UI-ready read model from which BOTH the portal and the edge derive the
adaptive energy-flow diagram (spec `adaptive-ems-ui-v1-spec.md` §10, milestone
M8 / epic AE1). A site is an **entity graph**; each entity carries **N
capabilities**; each capability is assignable to a **role**; roles aggregate
across entities into the hub topology the diagram renders (AE2 portal / AE6
edge).

This contract is **additive**: a site without v2 entities (every v1 site)
produces an empty topology and behaves byte-for-byte v1. Nothing here touches
the frozen 1.0 telemetry/schedule contracts.

## Roles (extensible vocabulary)

| role key | German label | aggregation | flow sign convention |
|---|---|---|---|
| `pv` | PV-Erzeugung | Σ over all assigned pv capabilities | always generation → **in** (node→hub) |
| `storage` | Speicher | Σ battery power; SoC from the primary | measured `battery_power_kw` +charge → **out** (hub→node), −discharge → **in** |
| `grid` | Netz | the **maßgebliche** (primary) grid measurement, never a sum | `power_kw` + = Bezug (import) → **in**, − = Einspeisung (export) → **out** |
| `consumer` | Verbraucher | Σ over all assigned consumer capabilities | consumption → **out** (hub→node) |

`in` = the spoke flows node → hub; `out` = hub → node. This mirrors the existing
`live.ts` / edge `dashboard.js` spoke semantics (PV in, Haus out, Netz reverses
on export, Batterie reverses on charge). A magnitude below the **0.05 kW
deadband** counts as idle (`direction: ""`, `flow_active: false`).

The **maßgeblich** flag (`primary`) picks THE authoritative measurement when a
role has several candidates: for `grid` it selects which of several grid
readings is the connection-point truth (the others are secondary); for `storage`
it selects which battery supplies the displayed SoC. `pv` / `consumer` sum every
member, so `primary` is informational there.

## Capability → role: the default mapping

Roles are **freely assignable** by customer/admin (stored as overrides, see the
`entity_role_assignment` table); absent an override the role is DERIVED from the
capability's measure channel + the entity's `category` — one pure function shared
Go↔TS↔Java (`DefaultRole`), so a device with no overrides resolves identically on
the edge (no DB) and in the cloud:

| measure channel | category | → role |
|---|---|---|
| `pv_power_kw` | any | `pv` |
| `battery_power_kw` | any | `storage` |
| `soc_pct` | any | `storage` (SoC input, not a flow) |
| `power_kw` | `storage` | `storage` |
| `power_kw` | `producer` | `pv` |
| `power_kw` | `consumer` | `consumer` |
| `power_kw` | `meter` / `measure-only` | `grid` |
| anything else (`energy_kwh`, …) | any | `` (informational, no role) |

`category` is `storage|producer|meter|consumer` on the cloud (the type catalog)
and the edge's `entities.Entity.category()` (`measure-only` == `meter` here) — the
pilot types are pinned on both sides, so they never drift.

A **hybrid inverter maps to several roles at once**: the battery-hybrid entity's
`pv_power_kw` → `pv` AND its `battery_power_kw`/`soc_pct` → `storage`. A pure
producer (Fronius) → `pv` only. Several entities aggregate into one role (Σ PV).

## Shared derivation (`Derive`)

The load-bearing piece: ONE pure function turning {resolved capabilities + live
values} into the hub topology. Implemented three times — Go
(`edge-app/core/internal/topology`), TS (`frontend/portal/src/topology.ts`),
Java (`services/api …/topology/TopologyDeriver`) — and pinned to ONE shared
vector file `topology-vectors.json` (the JCS-vectors precedent): the Go and TS
outputs are **byte-identical node sets**; the Java output is the same structure.

### Input

```
Input { entities: EntityInput[] }
EntityInput {
  id, type, label, category, health: string
  capabilities: CapabilityInput[]
}
CapabilityInput {
  channel: string         // the measure channel, e.g. "pv_power_kw"
  role: string            // resolved role, "" = unassigned/informational
  primary: boolean        // maßgeblich
  value: number | null    // latest live value, null = unknown (never a fabricated 0)
}
```

### Output (`topology-vectors.json` `expected`)

```
Topology {
  schema_version: "1.0"
  nodes: FlowNode[]        // only PRESENT roles, canonical order pv, storage, consumer, grid
}
FlowNode {
  role: "pv"|"storage"|"consumer"|"grid"
  value_kw?: number        // DISPLAY magnitude (≥0, 3dp) — drives the value text AND the spoke width; absent when unknown
  soc_pct?: number         // storage only; absent otherwise / when unknown
  flow_active: boolean     // value_kw present AND > deadband
  direction?: "in"|"out"   // absent when idle/unknown
  members: FlowMember[]
}
FlowMember {
  entity_id: string
  label: string
  primary: boolean         // the maßgeblich member of this role
  value_kw?: number        // this member's RAW SIGNED contribution (3dp); absent when unknown
}
```

Rules: all kW rounded to 3 decimals (`round(v*1000)/1000`, the guards precedent).
An **absent** value is never coerced to 0 — a role whose only member is unknown
has no `value_kw`/`direction` and `flow_active: false`. `pv`/`consumer` value_kw =
`|Σ members|`; `storage` value_kw = `|Σ battery_power|` and `soc_pct` = the
primary (else first) SoC; `grid` value_kw = `|primary member value|` (never a
sum — the maßgebliche measurement wins, the primary is the first member flagged
`primary`, else the first grid member). Members list the flow contributions in
input order (a `soc_pct` capability feeds the node SoC, not a member). Optional
fields are OMITTED when absent (never `null` in the wire form) so the three
implementations serialize congruently.

## Surfaces

- **Cloud:** `GET /api/v1/sites/{siteId}/topology` (RLS-scoped, foreign site
  404; `openapi.yaml` tag `topology`) returns `{schema_version, entities[],
  topology}` — the entity graph (id/type/label/category/health, per-capability
  role+primary+value), plus the server-derived `topology` (identical structure
  to the shared output). Live values are the latest `telemetry_v2` sample per
  (entity, channel). A fresh site returns empty `entities` + empty `topology`.
- **Edge:** the `/api/state` (+ `/api/stream`) envelope gains an additive
  `topology` block (schema-versioned) built from the applied entity registry +
  the latest per-entity local readings. The existing scalar
  `pv_kw`/`load_kw`/`grid_limit_kw`/`soc_pct` fields stay for backward compat.

## Assignment overrides (`entity_role_assignment`)

Additive table (migration `V20260719040000`): per (entity, capability) an
optional `role` + `is_primary` override. No row = the `DefaultRole` mapping (so
v1/pilot sites need none). Admin sets them via
`PUT /api/v1/admin/sites/{siteId}/topology-roles` (platform-admin, X-Tenant-Id
switcher over the RLS path). The edge uses defaults only (overrides are a
cloud-side refinement; the pilot acceptance runs on defaults, which is why Go and
TS agree on the shared vectors).

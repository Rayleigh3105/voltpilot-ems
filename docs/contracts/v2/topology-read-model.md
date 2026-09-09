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

**Self-built entity types never get a default role** (`IsSelfBuiltType`:
`modbus-generic`, `modbus-load`, `user-defined-battery`) — the TYPE is checked
FIRST, before the channel/category table above. Two reasons, and the first is a
promise the assistant already prints: Bilanz-Ehrlichkeit (Einheitsmodell
Stufe 3) — a self-built device is a topology node with its own measurements and
does NOT enter the energy balance; and the category would otherwise decide
(a `modbus-generic` is `meter`, a `user-defined-battery` is `storage`), so a
channel merely NAMED `power_kw` or `soc_pct` would walk into the grid resp. the
storage node by itself. For the customer's own battery that automatic binding is
exactly what captain decision **E6** (09.09.2026) rules out — it joins the
storage node only through the explicit Speiser-Bindung below.

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
  soc_source?: NodeSource  // WHICH entity supplied soc_pct; present whenever soc_pct is (P6)
  limits?: NodeLimits      // storage only; the BMS envelope, absent when nobody reports one (P6)
  flow_active: boolean     // value_kw present AND > deadband
  direction?: "in"|"out"   // absent when idle/unknown
  members: FlowMember[]
}
NodeSource { entity_id: string, label: string }
NodeLimits {
  source: NodeSource       // ALL fields come from this ONE entity
  charge_limit_a?: number
  discharge_limit_a?: number
  charge_allowed?: boolean
  discharge_allowed?: boolean
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

**Storage ATTRIBUTE channels** (`soc_pct`, `charge_limit_a`,
`discharge_limit_a`, `charge_allowed`, `discharge_allowed`) are never flow
members and never sum into `value_kw` — an ampere and a yes/no are not
kilowatts, and summing them would make the spoke width a number with two
meanings. `soc_pct` feeds `soc_pct` + `soc_source`; the other four feed
`limits`, all of them from the ONE entity that wins the same primary-else-first
rule the SoC uses (a charge limit from one BMS next to a discharge limit from
another would be one block with two meanings). A permission travels as a NUMBER
through telemetry (the v2 channel contract knows only numbers): anything but 0
is `true`. An unmapped or silent limit channel is ABSENT — never a fabricated 0
(which on a limit would read as "charging forbidden") and never a fabricated
`true`.

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

## Die SPEISER-BINDUNG (P6, captain decision E6 (a))

A `user-defined-battery` (the customer's own BMS read over MQTT, P5/P5b) joins
the storage node ONLY through an **explicit** binding made in the assistant —
never by channel name. Three answers, stored in the battery's own
`connection_json` as `binding: {mode, inverter_entity_id?}`:

| mode | meaning | what it feeds into the storage node |
|---|---|---|
| `unbound` (default) | it stands on its own | nothing — a topology node with its own measurements, outside the energy balance |
| `feeds_inverter` | it hangs on hybrid inverter X (`inverter_entity_id`, mandatory) | `soc_pct` + the four limit/permission channels. **Never `power_kw`** — the inverter measures the battery power, and counting the same kilowatts twice would be plainly wrong |
| `standalone` | there is no hybrid; it IS the storage node | the same, PLUS `power_kw` |

Only channels the battery ACTUALLY delivers are fed (a derived `soc_pct` from
P5b counts); a binding that could feed nothing is refused rather than promising
an effect that never arrives.

**The binding IS a role assignment.** Saving the battery writes one
`entity_role_assignment` row (role `storage`, `is_primary` true) per fed channel
and deletes the rows for every channel no longer fed. Nothing new travels: the
read-model resolves the override before the default, and the registry push
carries it to the box as `descriptor.role_assignment` (Befund L4), so `:8484`
draws the same energy flow as the portal. `is_primary` is half the statement —
the customer says THIS battery supplies the storage SoC, so a hybrid inverter
reporting its own (in voltage mode: invented) value must not outvote it. Should
the bound battery fall silent, the derivation still falls back to another
member's SoC — but `soc_source` then names that other device, so the surface
says whose number it shows instead of quietly substituting one.

## Assignment overrides (`entity_role_assignment`)

Additive table (migration `V20260719040000`): per (entity, capability) an
optional `role` + `is_primary` override. No row = the `DefaultRole` mapping (so
v1/pilot sites need none). Admin sets them via
`PUT /api/v1/admin/sites/{siteId}/topology-roles` (platform-admin, X-Tenant-Id
switcher over the RLS path). The edge uses defaults only (overrides are a
cloud-side refinement; the pilot acceptance runs on defaults, which is why Go and
TS agree on the shared vectors).

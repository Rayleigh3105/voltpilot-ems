# Edge Entity Config / Telemetry / Command + Registry Push (v2, E1a)

**Status: BINDING (v2 track). Schema: [`edge-entity.schema.json`](./edge-entity.schema.json).
Examples: [`examples/`](./examples/).**

This contract authors the E1a half of the v2 entity topic family whose skeleton
[edge-desired-arbitration.md §1](./edge-desired-arbitration.md) defined (desired + arbitration
stay there): the retained per-entity **config**, the local per-entity **telemetry**, the
core-owned retained **command**, and the cloud → edge **entity-registry push** that transports
the config set. It is a brand-new contract and starts at `schema_version` **1.0**
(coexistence philosophy #4).

## 1. The registry push: `ems/{t}/{s}/{d}/v2/entities` (retained)

The cloud entity registry (the `measurement_point` rows carrying `entity_type` /
`capabilities` / `guard_config`) is the **owner**; the edge receives it as ONE retained message
per device — the proven `edge/inverter/config` / `edge/sources/config` pattern lifted onto the
cloud link (plan §2.1 "Stammdaten-Sync": Cloud ist Soll, Edge meldet Ist). `$defs/registry_push`:
identity + `revision` + `published_at` + the full `entities` descriptor array.

- **Full-set semantics.** The edge diffs the pushed set against its persisted one
  (`entities.json`, the plan-store pattern): new/changed descriptors are (re)published as
  per-entity retained local configs; entities missing from the push get their retained
  `config` AND `command` cleared (empty retained payload — the provisioning `clearRetained`
  precedent). An empty `entities` array = the device has no v2 entities. An empty PAYLOAD
  clears the retained slot outright (device unclaimed).
- **Soll down, Ist up (bidirectional since E1b).** The push stays the one-way Soll (cloud →
  edge); the edge reports its Ist back through the additive status-heartbeat `entities` block
  (§5): the applied `revision` plus per-entity observed health AND the edge-local
  commissioning view (`:8484` inverter/sources — which keeps working unchanged). The cloud
  RECONCILES and surfaces drift; it never silently overwrites in either direction.
- Publishing is **best-effort** on registry change (the on-claim provisioning-publish posture:
  a broker outage never fails the registry write); retained delivery makes the next
  (re)connect converge.

## 2. Per-entity retained config: `edge/entities/{id}/config`

`$defs/config` — the registry descriptor per entity (D-3: per-entity topics, wildcard
`edge/entities/+/config` gives any consumer the complete set on subscribe). Contents:

- **`entity_type`** — an OPEN kebab-case vocabulary since E1b (D-10: capabilities as the
  foundation, domain types on top). The data-driven platform type CATALOG
  (`services/api` `entitytypes/catalog.json`) is the truth for known types — today
  `battery-hybrid` | `producer` | `grid-meter` (the pilots) plus the E1b consumer types
  `wallbox` | `heating-rod` | `generic-load`; adding a type is catalog data + an optional
  driver, never a schema release. Consumers of this contract key BEHAVIOR on the declared
  capabilities and guards, never on the type string alone (an unknown well-formed type is
  data, not an error).
- **`capabilities`** — `measure` channel descriptors + `actuate` command descriptors from the
  D-14 vocabulary (`setpoint_kw`, `on_off`, `limit_pct`, `limit_kw`, `mode`) with optional
  bounds. A measure-only entity (grid meter) has no `actuate` list. Generators are never
  commanded to produce — `limit_*` reduce-only (the v1 safety posture). Consumers are only
  ever commanded to CONSUME (`setpoint_kw` + = consume, clamped ≥ 0 — V2G out of scope).
- **`guards`** — per D-9 the guard limits AND the failsafe live HERE, in registry config, never
  in plans: `limits` (rated charge/discharge band, SoC window, `charge_from_grid_allowed` with
  the D-8 absent-=-NOT-allowed reading, producer `max_generation_kw`, consumer
  `max_consumption_kw` — E1b, additive) and
  `failsafe.behavior` (`self-consumption` | `off` | `release` | `measure-only`) — what the
  entity falls back to when nothing commands it (no desired, stale plan). The core builds its
  per-entity guard chain instance from this block — the generalization of the v1 env-derived
  `guards.Limits`.
- **`driver`** — OPTIONAL opaque connection block (the v1 sources `busEntry` shape) for later
  Layer-1 self-wiring; E1a carries it through verbatim.

## 3. Local per-entity telemetry: `edge/entities/{id}/telemetry`

`$defs/telemetry` — Layer 1 → core, QoS1, not retained: `{schema_version, entity_id, ts?,
channels}`. Successor of `edge/sources/{id}/telemetry` with the same error-isolation property
(a dead entity is absent, never a fabricated 0). The topic==payload identity rule applies; the
core ignores mismatches. The core keeps the latest reading per entity (feeding the per-entity
guard chain with SoC/PV context) and forwards accepted readings to the cloud uplink
([mqtt-telemetry-2.0](./mqtt-telemetry-2.0.md)).

## 4. Core-owned retained command: `edge/entities/{id}/command`

`$defs/command` — published ONLY by the core, after arbitration + guards (D-10 ownership; in
E1a the arbitration is stubbed — the plan executor and desired arbitration land with E2/E3, but
whatever commands an entity already flows through the per-entity guard clamp). Shape mirrors
today's `edge/setpoint` fields generalized: `control_enabled` (the v1 two-gate posture per
entity), `source` (`plan` | `desired` | `failsafe`), and `commands` keyed by the D-14
vocabulary. An absent `limit_kw`/`limit_pct` means NO limit and MUST clear a previously applied
one (the 1.0 `pv_limit_kw` clearing rule). Retained; an empty payload clears the slot
(nothing commanded — the entity runs its registry failsafe).

The per-entity **readback** (`edge/entities/{id}/readback`, Layer 1 → core) keeps the v1
`edge/control/readback` payload shape verbatim (documented in
`edge-app/core/internal/localbus/localbus.go`), addressed per entity; it is not re-schematized
here — E2 formalizes it together with arbitration events.

## 5. Status-heartbeat `entities` block (additive)

The edge folds an additive block into its status heartbeat (no frozen schema on `…/status` —
the v1 `control`/`purge_request` precedent, `schema_version` stays "1.0"):

```json
"entities": { "revision": "<applied registry revision>", "applied_at": "<RFC3339>",
              "count": 3, "ids": ["…", "…", "…"] }
```

Since E1b the block additionally carries the per-entity **Ist** (all additive; absent fields
mean "nothing to report", never fabricated):

```json
"entities": {
  "revision": "…", "applied_at": "…", "count": 2, "ids": ["…", "…"],
  "observed": {
    "<entity_id>": { "entity_type": "wallbox", "health": "ok",
                     "last_telemetry_at": "<RFC3339>", "channels": ["power_kw"] }
  },
  "local_setup": [
    { "id": "inverter", "kind": "inverter", "brand": "deye", "model": "SUN-12K-SG04LP3-EU" },
    { "id": "<source id>", "kind": "source", "role": "pv-generation", "brand": "fronius_sunspec" }
  ]
}
```

- **`observed`** — per applied entity: the type as applied, `health` (`ok` = local telemetry
  within the 5-min liveness window | `stale` = had readings, none recently | `never` = none
  since boot) and the channels actually seen. This is the edge's honest Ist per entity.
- **`local_setup`** — the edge-authoritative commissioning view (`:8484` inverter selection +
  sources), reported verbatim so the cloud can SEE edge-side master data that has no registry
  counterpart. The cloud never auto-imports it; reconciliation surfaces it as drift.

The cloud compares `revision` against the latest push and the `observed` map against the
registry Soll (api `EntityStatusListener` → `entity_observed_state`); drift is surfaced in the
portal, never silently resolved.

## 6. Coexistence

A v2 edge build runs the v1 topics (`edge/telemetry`, `edge/setpoint`, `edge/sources/…`) and
this family side by side (E1a/E13a shadow phase); nothing in the v1 local namespace changes.
Entities exist on a device only after a registry push; a device without one behaves
byte-for-byte v1.

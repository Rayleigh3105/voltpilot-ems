# mqtt-schedule 2.0 — Multi-Entity Plan (Cloud → Edge)

**Status: BINDING (v2 track). Schema: [`mqtt-schedule-2.0.schema.json`](./mqtt-schedule-2.0.schema.json). Examples: [`examples/`](./examples/).**

The v2 successor of the frozen [`mqtt-schedule.schema.json`](../mqtt-schedule.schema.json) (1.0):
one plan per site commanding **N entities** with the generic command vocabulary shared with the
[edge-desired contract](./edge-desired-arbitration.md). The 1.0 contract is **not touched**;
existing edges keep consuming it unchanged.

## 1. Coexistence with the frozen 1.0 schedule — the decision

**DECIDED: separate topic in a new per-device `v2/#` subtree — `ems/{tenant_id}/{site_id}/{device_id}/v2/plan`
(QoS1, retained). NOT schema_version negotiation on the frozen `…/schedule` topic.**

Rationale (see also README decision log D-1/D-2):

1. **Retained-slot isolation.** MQTT keeps exactly one retained message per topic. Version
   negotiation on `…/schedule` would make the v2 plan *replace* the v1 retained plan — a v1 edge
   (whose `plan.Parse` rejects `schema_version != "1.0"` and falls back to self-consumption,
   verified in `edge-app/core/internal/plan/plan.go`) would degrade safely but lose optimization
   the moment the cloud switches. With separate topics both retained plans exist side by side.
2. **The E13a shadow phase requires it.** "v2 publishes, v1 controls, jederzeit rückholbar" is
   only possible when the v2 plan lives on its own retained topic while the v1 plan keeps
   driving. Dual-publish is a per-site cloud-side choice during transition; **old devices carry
   no dual-consume/dual-publish obligation** — they never subscribe the v2 topic.
3. **No negotiation protocol needed.** The cloud does not have to learn each edge's supported
   version and the edge does not have to advertise one; subscription IS the negotiation. The
   broker ACL (default-deny, per-device grants) keeps a v1 device blind to v2 topics outright.
4. **Rollback is trivial.** Re-point the site to the v1 path; the v1 retained plan is still (or
   again) there. Nothing about the frozen contract moved.

**Why a `v2/` subtree instead of a bare new verb (`…/plan`):** the per-device broker ACL grants
enumerate exact topics, and the grant template is maintained in **three hand-lockstep writers**
(`AclGrantWriter`, `voltpilot-ca.sh`, `merge-acl-grants.sh` — three real production outages live
in that history). A v2 device adds exactly **two wildcard grant lines** — subscribe
`ems/{t}/{s}/{d}/v2/#` (down) and publish `ems/{t}/{s}/{d}/v2/#` (up) — and then **never touches
the ACL template again** no matter how many v2 topic kinds appear (plan, flows, prices,
entity telemetry). The security property is unchanged: a device may only touch its own subtree.
The E14 "ACL-Grant-Konsolidierung vor den ersten v2-Topics" enabler is the prerequisite for
rolling this template change out.

Reserved siblings under the same subtree (contracts to be authored by their owning epics; listed
here so the family is named once): `…/v2/telemetry` (entity telemetry uplink, E1a),
`…/v2/flows` ([flow-artifact](./flow-artifact.md)), `…/v2/prices` (the price down-channel, E4),
`…/v2/entities` (entity-registry push, E1a).

## 2. Payload

See the schema. Deltas vs. 1.0, in one view:

| 1.0 | 2.0 |
|---|---|
| `slots[].battery_setpoint_kw` — one implicit battery | `entities[].slots[].commands.setpoint_kw` — per entity |
| `slots[].pv_limit_kw` on the same (battery) slot | `commands.limit_kw` / `limit_pct` on the PV **entity** (or the hybrid entity's generation channel) |
| top-level `grid_charge_allowed` | per storage entity `charge_from_grid_allowed` |
| top-level `peak_reserve_soc_pct` (one battery) | per storage entity `reserve_soc_pct` (multi-battery ready) |
| top-level `grid_import_limit_kw` | unchanged — **site-level** (the billing peak is a property of the connection point, not of an entity) |

Rules carried over verbatim from 1.0 (all verified against the shipped edge, not just the 1.0
contract text):

- **The plan is ADVISORY.** Every command is arbitrated (class `market`) and clamped through the
  per-entity guard chain before any register write. Guards only ever restrict.
- **Slot selection**: the edge executes the slot whose `[start, start + slot_minutes)` contains
  *now*; slots are contiguous, ascending, on one shared grid.
- **Absent `limit_kw`/`limit_pct` = no limit** and MUST clear any previously applied limit
  (the 1.0 `pv_limit_kw` clearing rule). A limit can only ever reduce generation — never a
  command to produce.
- **`limit_pct`/`limit_kw` on consumers** cap consumption the same way (reduce-only relative to
  the entity's native behavior).

## 3. Staleness and fail-safe (`x-failsafe`)

Carried over from 1.0 with the same constants, then generalized per entity:

- **20-minute staleness window** from receipt, additionally bounded by `generated_at` age with a
  **5-minute redelivery slack** — a broker redelivery of an old retained payload is anchored to
  its generation time and can never look fresh again (verified semantics:
  `plan.StaleAfter = 20min`, `redeliverySlack = 5min` in `plan.go`). The optimizer republishes
  every 15 minutes, well inside the window.
- **On staleness** every entity falls back to its **own failsafe declared in the entity registry
  config** (`edge/entities/{id}/config`) — *not* carried in the plan, so it survives total plan
  loss and a never-provisioned plan alike. Storage default: self-consumption (v1
  `guards.SelfConsumption`). Consumers: configured safe state. Limits: cleared.
- **A new plan that omits a previously commanded entity releases it** (its market desire is
  withdrawn; lower-priority desires or the failsafe take over). Unknown entity ids are logged
  and skipped, never fatal.
- **Deliberate staleness survivors** (restrict-only, so a dead optimizer can never widen
  anything — the PS-3 posture, verified in `plan.go` `PeakImportLimit`/`PeakReserveSoc`):
  - `grid_import_limit_kw`: the edge peak guard keeps defending the **last known** target inside
    the fallback. A NEW plan without the field clears it.
  - `entities[].reserve_soc_pct`: ordinary fallback discharge stops at the reserve; peak defense
    alone may go below it, down to the technical SoC floor.

## 4. `charge_from_grid_allowed` — fail-safe by contract

**Absent = NOT allowed.** Only an explicit `true` releases the solar-only-charge clamp
(charge ≤ measured available PV, the v1 EEG guard with PV-bus semantics; unknown PV blocks
charging entirely — a compliance guard never charges blind). Discharge is never affected.

This **promotes the shipped edge's behavior into the contract**: the 1.0 contract text says
"ABSENT = treat as allowed", but the Go edge deliberately deviates fail-safe
(`plan.go` `SolarOnlyCharge()`: only an explicit `true` releases the clamp — a documented,
captain-approved deviation). v2 ends the divergence by adopting the code's reading; the v2
optimizer MUST therefore always publish the field for merchant storage entities. Recorded in the
README decision log (D-8).

## 5. Consumption on the edge

The core parses and validates the plan (unknown fields ignored — the 1.0 tolerance rule),
persists it to disk (reboot-without-network, the v1 plan store pattern), and its **plan executor
injects each entity's active slot as a standing class-`market` desired** into the arbitration
([edge-desired-arbitration.md](./edge-desired-arbitration.md)). Execution ownership — who runs
slots, fallbacks, and guards — is specified in
[plan-execution-ownership.md](./plan-execution-ownership.md). The flow runtime receives plan
DATA read-only (a `plan`-typed input port); it never executes slots itself.

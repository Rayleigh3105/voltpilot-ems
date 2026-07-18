# mqtt-telemetry 2.0 — Multi-Entity Telemetry (Edge → Cloud)

**Status: BINDING (v2 track, authored by E1a — the topic home was reserved in
[mqtt-schedule-2.0 §1](./mqtt-schedule-2.0.md)). Schema:
[`mqtt-telemetry-2.0.schema.json`](./mqtt-telemetry-2.0.schema.json). Examples: [`examples/`](./examples/).**

The v2 successor of the frozen [`mqtt-telemetry.schema.json`](../mqtt-telemetry.schema.json) (1.0):
instead of one implicit device with a frozen 5-channel measurement whitelist, one uplink message
carries **N entities**, each with free-form numeric channels declared by the entity registry.
The 1.0 contract is **not touched**; v1 edges keep publishing it unchanged.

## 1. Topic and coexistence

**`ems/{tenant_id}/{site_id}/{device_id}/v2/telemetry`** (QoS1, not retained) — the reserved
sibling in the per-device `v2/#` subtree (decisions D-1/D-2). Coexistence is the cloud-side
**dual-consume** (philosophy #2): ingest + writer consume 1.0 on `…/telemetry` and 2.0 on
`…/v2/telemetry` side by side; a device is either v1 or v2 at any moment, and old devices never
publish (or may even see) the v2 topic. The v1 pipeline (`telemetry.raw` → `telemetry`
hypertable) is byte-identical untouched; v2 events flow on their own Kafka topic
([`telemetry-v2-raw.event.schema.json`](./telemetry-v2-raw.event.schema.json)) into the generic
`(entity_id, channel, value)` hypertable `telemetry_v2`.

## 2. Payload

See the schema. Essentials:

- **`entities`** — object keyed by entity id (registry row UUID recommended; MQTT-topic-safe
  pattern). Each entry: `channels` (flat snake_case → number map, min 1) + optional per-entity
  `ts` overriding the top-level one. An entity with nothing to report is absent — never
  fabricated zeros (the v1 sources discipline).
- **Values are always numbers.** A boolean state is 0/1. Sign conventions are per capability,
  shared with the command vocabulary (D-14): storage `battery_power_kw` + = charge / − =
  discharge; grid `power_kw` + = import / − = export; generation ≥ 0.
- **Pilot channel vocabulary** (declared per entity in the registry, not enforced by ingest):
  `battery-hybrid` → `soc_pct`, `battery_power_kw`, `pv_power_kw`; `producer` → `pv_power_kw`;
  `grid-meter` → `power_kw`.

## 3. Validation split (envelope only in the cloud)

Ingest validates the **envelope**: `schema_version == "2.0"`, topic identity == payload identity
(the v1 rule), UUID formats, `ts` RFC 3339, entity ids topic-safe, channels flat numeric maps.
It deliberately does **not** validate channel names against the entity registry or check that an
entity id exists — capability conformance is an edge/portal concern; an unknown channel or a
not-yet-synced entity is data, not an error. Malformed messages are logged and skipped (never
crash the stream — the v1 posture).

## 4. Liveness and replay

Carried over from 1.0 verbatim: `ts` is the ORIGINAL observation time; a store-and-forward edge
replays with original timestamps. The cloud writer stamps arrival time (`received_at`) per row
and any liveness derivation MUST use arrival time, never `ts`. Writes are idempotent per
`(entity_id, channel, time)`, so Kafka redelivery and edge replay are safe.

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
not-yet-synced entity is data, not an error. Malformed messages never crash the stream (the v1
posture).

**Refusal granularity (UEMS AP-07 IP-5).** The ENVELOPE (`schema_version`, identity, `ts`, `seq`,
the `entities` object) is refused as a whole; a VALUE is one channel of one entity: a bad channel
drops only itself, an entity without a readable id, `ts` or channel block drops its channels. The
measurement-time plausibility of E13 applies per entity (the entity carries the time): more than
300 s after arrival → `clock_ahead`, more than 90 days before → `too_old`; an implausible top-level
`ts` means the box clock is off and no value is taken. Every refusal lands as a `datenannahme`
event on `events.raw` ([`events-vocabulary.md`](./events-vocabulary.md) §7), bundled per envelope
and reason with a count — not only in the log.

## 4. Liveness and replay

Carried over from 1.0 verbatim: `ts` is the ORIGINAL observation time; a store-and-forward edge
replays with original timestamps. The cloud writer stamps arrival time (`received_at`) per row
and any liveness derivation MUST use arrival time, never `ts`. Writes are idempotent per
`(entity_id, channel, time)`, so Kafka redelivery and edge replay are safe.

## 5. `seq` — optional for the box, a MUST-forward for the cloud (UEMS AP-07 IP-2)

No schema change: `seq` stays OPTIONAL in the payload, and a box that omits it stays valid.
What changes is the cloud's obligation. When a box sends `seq`, ingest MUST pass it on
unchanged with the message's `telemetry-v2.raw` event. It is never dropped, renumbered or
filled in when absent, because absent means "not reported", never 0. Downstream, the sequence
per box is evaluated exactly like `sequence` of the additional measurements: a jump up is a
`sequence_gap`, a jump down a `sequence_reset` (AP-07 §4.5 rule 5, E11;
[`events-vocabulary.md`](./events-vocabulary.md)). `seq` is a marker, not part of the write key.

Since AP-07 IP-5 ingest forwards it: the additive optional field `seq` of
[`telemetry-v2-raw.event.schema.json`](./telemetry-v2-raw.event.schema.json) (absent when the box
sent none; a present `seq` that is not an integer ≥ 0 refuses the envelope, `schema_verletzt`).
The writer does not evaluate it yet (IP-7/IP-9) — until then a gap in `seq` is not detected.

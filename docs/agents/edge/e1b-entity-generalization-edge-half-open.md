# E1b entity generalization (edge half): open types, capability guards, v2 buffering

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 12).


Extends the E1a entity layer (root AGENTS.md "v2 entity model - generalization (E1b)"). Edge specifics:

- **Open types + category-inferred guards** (`internal/entities`): `ParseRegistryPush`
  accepts any well-formed kebab-case `entity_type` (skips only MALFORMED, never a
  known-vs-unknown gate). `Entity.category()` derives the guard semantics from
  what the entity DECLARES, not its name — pilots pinned; storage-shaped guard
  limits → the full battery chain incl. D-8; `max_generation_kw` → producer
  reduce-only; measure-only-failsafe / no actuate list → drop-everything;
  otherwise the CONSUMER clamp `[0, min(capability max, max_consumption_kw)]`
  (setpoint ≥ 0, on_off pass-through, `mode` validated against the declared set).
  So a wallbox/heating-rod/generic-load works with zero edge release; a real
  DRIVER for it is E6.
- **v2 uplink store-and-forward** (`internal/buffer` + `agent/entities.go`): the v2
  entity uplink rides the SAME disk ring as v1 (E1a was live-only, dropped on
  outage). `buffer.Entry` gained an optional `entity_id` discriminator (old JSONL
  stays v1 — no on-disk migration); `AppendEntity` enters accepted readings with
  their ORIGINAL ts; the ONE `publisherLoop` drains both eras confirm-then-ack,
  branching on `e.EntityID` to `PublishTelemetryV2(buffer.Entry)`; the purge
  watermark + unclaim-pause apply verbatim. The E1a `entityUplinkLoop`/`entUplink`
  channel are retired.
- **Bidirectional Ist in the heartbeat** (`cloud.EntitiesSummary`): the `entities`
  block gains `observed` (per-entity applied type + health ok|stale|never +
  last_telemetry_at + channels, from `entReadings` with a 5-min liveness window)
  and `local_setup` (the edge-authoritative `:8484` inverter selection + sources
  — the commissioning Ist the cloud reconciles but never auto-imports). Only ships
  once the device has v2 entities (a registry-less device stays byte-for-byte v1).
- **Proof**: `agent/entities_buffer_integration_test.go`
  `TestWallboxEntityBuffersUplinkAndArbitratesDesired` — the rig-level chain in
  one test: retained wallbox registry push → retained local config → buffered v2
  uplink → cloud outage → ordered original-ts replay → observed-health heartbeat →
  flow desired → E2 arbitration clamps 22→11 kW consumer band. Plus
  `internal/entities` consumer-clamp + open-type units, `internal/buffer` entity
  round-trip.


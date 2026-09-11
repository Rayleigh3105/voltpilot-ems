# services/ingest - MQTT -> Redpanda Ingest

**Language:** Java 21 / Spring Boot 3.3
**State:** stateless
**Responsibility (architecture section 8):** MQTT konsumieren, validieren, in Redpanda publizieren.

First hop of the MVP data path: subscribes to `ems/+/+/+/telemetry` on EMQX at **QoS1**, validates/normalizes against [`mqtt-telemetry.schema.json`](../../docs/contracts/mqtt-telemetry.schema.json) (incl. topic-vs-payload identity check), and publishes `telemetry.raw` events ([`telemetry-raw.event.schema.json`](../../docs/contracts/telemetry-raw.event.schema.json)) to Redpanda **keyed by `{tenant_id}:{site_id}`**. Malformed messages are logged and skipped. See the "Live ingest pipe" section in the repo `AGENTS.md` for the full design.

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8091
./mvnw test
./mvnw clean package
```

Health: `GET /health`. Broker/topic targets come from `REDPANDA_BOOTSTRAP_SERVERS`, `MQTT_BROKER_URL`, `MQTT_TELEMETRY_TOPIC_FILTER`, `REDPANDA_TELEMETRY_TOPIC`.

## Topics (MQTT → Redpanda)

| MQTT (QoS 1) | Redpanda | Env | Contract |
|---|---|---|---|
| `ems/+/+/+/telemetry` | `telemetry.raw` | `REDPANDA_TELEMETRY_TOPIC` | `docs/contracts/telemetry-raw.event.schema.json` |
| `ems/+/+/+/v2/telemetry` | `telemetry-v2.raw` | `REDPANDA_TELEMETRY_V2_TOPIC` | `docs/contracts/v2/telemetry-v2-raw.event.schema.json` (carries `seq`) |
| `ems/+/+/+/v2/measurement-samples` | `measurements.raw` | `REDPANDA_MEASUREMENTS_TOPIC` | `docs/contracts/v2/measurements-raw.event.schema.json` |
| `ems/+/+/+/v2/events` (+ every refusal of the three v2 legs) | `events.raw` | `REDPANDA_EVENTS_TOPIC` | `docs/contracts/v2/events-raw.event.schema.json` |

UEMS AP-07 IP-5 (the Datenannahme): on the v2 legs a refused VALUE drops only itself, the envelope is refused as a whole only for its version, shape or identity, and the measurement-time plausibility of E13 (`voltpilot.datenannahme` in `application.yml`: > 300 s ahead `clock_ahead`, > 90 days old `too_old`) applies per value. Every refusal is an event on `events.raw` (urheber `datenannahme`, bundled per envelope and reason with a count), not only a log line; box envelopes on `v2/events` become one `events.raw` record per entry (urheber `box`). Details: `docs/agents/root/uems-datenannahme-ereignisse.md`.

⚠ **Create `events.raw` before the next deploy of this ingest.** Production runs in the k3s cluster (since the cutover 03.08.2026), deployed through the gitops repo `mamotec/gitops` (Argo CD): create the topic THERE, where the other production Redpanda topics are created. The `rpk topic create` in `redpanda-init` of both compose files covers the local stack. Redpanda creates a topic on first send only with `auto_create_topics_enabled` (off by default, on in the Testcontainers dev mode), and a send to a missing topic would block the producer for `max.block.ms` (60 s) — so the ingest never sends to it blindly:

**While `events.raw` is missing (fallback, decision b07-recreate D):** `EventsTopicPruefung` asks Redpanda through the Kafka admin client (3 s timeout, at most every 10 s, cached for the process lifetime once seen).
- `measurement-samples` and `v2/telemetry` send NO event: every refusal is a log line as before IP-5, counted by the Micrometer counter `voltpilot.ingest.events.undelivered` (tags `reason=events_raw_missing`, `strom`; the ingest has no scrape endpoint yet), and the envelope is acked as soon as its values are confirmed on Redpanda — the value path never waits for `events.raw`.
- The box adapter on `v2/events` does not connect until the topic exists (`BoxEreignisTor`; no box sends events before the edge release, the persistent session holds them at the broker afterwards).
- `/health/readiness` = `readinessState` + `eventsTopic` stays DOWN (the ingest serves no business HTTP, so a not-ready pod loses nothing) and the log says `Redpanda-Topic events.raw FEHLT - …` (WARN once, then every 10 min).

Once the check sees the topic, events flow and the strict ack (only after Redpanda confirmed every send) applies as built.

## Status

Implemented and wired into compose (the `edge` profile). The inbound MQTT adapter (`MqttIngestConfig`), contract validation (`TelemetryValidator`) and the Redpanda producer (`TelemetryIngestHandler`) are live. Proven by `TelemetryValidatorTest` (unit) and `IngestPipeTest` (Testcontainers EMQX + Redpanda); the v2 legs by `TelemetryV2ValidatorTest`, `MeasurementSamplesValidatorTest`, `BoxEventsValidatorTest`, `MesszeitregelTest` and `DatenannahmeTest` (all pure). Future hardening: MQTT mTLS/authn. The v1 leg still logs and skips a malformed message.

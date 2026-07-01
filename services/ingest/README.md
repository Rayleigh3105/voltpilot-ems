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

## Status

Implemented and wired into compose (the `edge` profile). The inbound MQTT adapter (`MqttIngestConfig`), contract validation (`TelemetryValidator`) and the Redpanda producer (`TelemetryIngestHandler`) are live. Proven by `TelemetryValidatorTest` (unit) and `IngestPipeTest` (Testcontainers EMQX + Redpanda). Future hardening: a dead-letter topic for malformed messages (today log+skip) and MQTT mTLS/authn.

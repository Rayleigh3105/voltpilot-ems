# services/ingest - MQTT -> Redpanda Ingest

**Language:** Java 21 / Spring Boot 3.3
**State:** stateless
**Responsibility (architecture section 8):** MQTT konsumieren, validieren, in Redpanda publizieren.

First hop of the MVP data path: subscribes to `ems/+/+/+/telemetry` on EMQX, validates against [`mqtt-telemetry.schema.json`](../../docs/contracts/mqtt-telemetry.schema.json), and publishes `telemetry.raw` events ([`telemetry-raw.event.schema.json`](../../docs/contracts/telemetry-raw.event.schema.json)) to Redpanda, partitioned by tenant/site.

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8091
./mvnw test
./mvnw clean package
```

Health: `GET /health`. Broker/topic targets come from `REDPANDA_BOOTSTRAP_SERVERS`, `MQTT_BROKER_URL`, `MQTT_TELEMETRY_TOPIC_FILTER`, `REDPANDA_TELEMETRY_TOPIC`.

## Status

MVP skeleton. `spring-integration-mqtt` and `spring-kafka` are declared; the inbound MQTT adapter and Redpanda producer are future work.

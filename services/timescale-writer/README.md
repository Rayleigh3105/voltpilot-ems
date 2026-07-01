# services/timescale-writer - Redpanda -> TimescaleDB Writer

**Language:** Java 21 / Spring Boot 3.3 (JVM)
**State:** stateless
**Responsibility (architecture section 8):** Redpanda -> TimescaleDB schreiben.

Final hop of the MVP data path: consumes `telemetry.raw` from Redpanda and writes into the TimescaleDB `telemetry` hypertable (schema owned by `services/api` Flyway `V1`/`V2`; dev bootstrap in [`infra/local/timescale/01-init.sql`](../../infra/local/timescale/01-init.sql)). Connects as the non-privileged `voltpilot_app` role and sets `app.tenant_id` per event so writes land under the message's tenant and RLS-scoped portal reads surface them; inserts are idempotent on `(device_id, time)`. See the "Live ingest pipe" section in the repo `AGENTS.md` for the full design.

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8092
./mvnw test
./mvnw clean package
```

Health: `GET /health`. Targets: `REDPANDA_BOOTSTRAP_SERVERS`, `REDPANDA_TELEMETRY_TOPIC`, `POSTGRES_JDBC_URL`, `APP_DB_USER`, `APP_DB_PASSWORD` (the RLS-scoped `voltpilot_app` role).

## Status

Implemented and wired into compose (the `edge` profile, `depends_on` `api` for the Flyway-owned schema/RLS/role). The Kafka consumer (`TelemetryRawConsumer`), tenant-scoped idempotent writer (`TelemetryWriteRepository`) are live. Proven by `WriterPipeTest` (Testcontainers Redpanda + TimescaleDB: insert mapping, idempotency on redelivery, RLS scoping). Future hardening: back the idempotent insert with a real hypertable unique index on `(device_id, time)` (added by the api schema owner).

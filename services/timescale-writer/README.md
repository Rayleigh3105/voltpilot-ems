# services/timescale-writer - Redpanda -> TimescaleDB Writer

**Language:** Java 21 / Spring Boot 3.3 (JVM)
**State:** stateless
**Responsibility (architecture section 8):** Redpanda -> TimescaleDB schreiben.

Final hop of the MVP data path: consumes `telemetry.raw` from Redpanda and batch-writes into the TimescaleDB `telemetry` hypertable (schema in [`infra/local/timescale/01-init.sql`](../../infra/local/timescale/01-init.sql)).

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8092
./mvnw test
./mvnw clean package
```

Health: `GET /health`. Targets: `REDPANDA_BOOTSTRAP_SERVERS`, `POSTGRES_JDBC_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.

## Status

MVP skeleton. `spring-kafka` and the PostgreSQL driver are declared. `DataSourceAutoConfiguration` is currently excluded (see `WriterApplication`) so the skeleton starts without a live DB; the Kafka consumer, JDBC writer and idempotent upserts are future work.

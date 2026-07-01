# AGENTS.md - Voltpilot-EMS project knowledge

Durable, project-intrinsic knowledge for anyone (human or agent) working in this repo.
The product architecture is in [`docs/architecture.md`](docs/architecture.md); this file is the operational "how it's built and run" reference.

## What this is

Self-hosted multi-tenant EMS (PV / battery / load management), DACH market. Monorepo.
This repo currently holds the **MVP scaffold**: the runnable local backbone, thin service skeletons, and the binding contracts. No business logic yet (see "Status" per service README).

MVP data path (architecture section 4/7): `Node-RED edge -> EMQX (MQTT) -> Ingest -> Redpanda (telemetry.raw) -> TimescaleDB-Writer -> TimescaleDB`.

## Stack & versions

| Concern | Choice | Version |
|---|---|---|
| JVM services | Java + Spring Boot (Maven, wrapper committed) | Java 21, Spring Boot 3.3.5 |
| Python services | setuptools + pyproject, pytest | Python >= 3.10 |
| Optimization solver | Pyomo + HiGHS (`highspy`) | pyomo >= 6.7 |
| Frontend | React + Vite + TypeScript | React 18, Vite 5 |
| Edge | Node-RED (container) | node-red 4.0 |
| Timeseries + master data | TimescaleDB (one Postgres instance) | timescale/timescaledb 2.17.2-pg16 |
| MQTT broker | EMQX | 5.8.3 |
| Event log | Redpanda (Kafka API) | v24.2.7 |
| Auth (OIDC) | Keycloak | 26.0.5 |

## Service map

| Path | Lang | Responsibility (architecture section 8) | State |
|---|---|---|---|
| `services/api` | Spring Boot | Portal backend / API: REST/WS, tenancy, business logic | stateless |
| `services/ingest` | Spring Boot | Consume MQTT (EMQX), validate, publish to Redpanda | stateless |
| `services/timescale-writer` | Spring Boot | Redpanda -> TimescaleDB writer | stateless |
| `services/optimization` | Python | MILP/MPC schedule (HiGHS) | stateless (job) |
| `services/forecast` | Python | Load/PV forecast (baseline in v1) | stateless |
| `services/marketing-adapter` | Python | Generic Direktvermarktung adapter (stub) | stateless |
| `edge/node-red` | Node-RED | Thin edge: acquisition, publish, schedule-exec, watchdog, guards | edge |
| `frontend/portal` | React/Vite | Web portal | - |

## Ports (local dev)

| Port | Service |
|---|---|
| 5432 | TimescaleDB / Postgres |
| 1883 / 8883 / 8083 | EMQX MQTT / MQTT-TLS / MQTT-WS |
| 18083 | EMQX dashboard |
| 9092 | Redpanda Kafka API (external listener; internal is `redpanda:29092`) |
| 9644 | Redpanda admin |
| 8080 | Redpanda Console |
| 8081 | Keycloak (maps to container 8080) |
| 8090 / 8091 / 8092 | api / ingest / timescale-writer (Spring Boot) |
| 5173 | frontend/portal (Vite dev) |
| 1880 | Node-RED editor |

## Run the local stack

```bash
cp .env.example .env
docker compose up -d          # backbone: timescaledb, emqx, redpanda (+init, console), keycloak
docker compose ps             # all four core services report healthy
docker compose down           # stop (keep volumes) ; add -v to wipe data
```

Notes:
- The app services (`services/*`) are NOT started by compose yet (backbone-first). Each has a `Dockerfile` for later.
- `.env` holds **dev-only** secrets, clearly marked. Never reuse them outside local dev.
- Data persists in named volumes `timescale-data`, `emqx-data`, `redpanda-data`.
- Redpanda advertises two listeners: `redpanda:29092` (in-cluster) and `localhost:9092` (host). Services inside compose must use the internal one.
- Keycloak realm `voltpilot` is imported on start from `infra/local/keycloak/` with clients `voltpilot-api` (confidential) and `voltpilot-frontend` (public/PKCE), plus a demo user `demo`/`demo` carrying a `tenant_id` attribute.
- TimescaleDB is bootstrapped once from `infra/local/timescale/*.sql` (extension + example `telemetry` hypertable + tenant/site/device/asset + a deterministic dev seed). Production owns the schema via Flyway/Liquibase migrations (future, in `services/api`).

## Build & test per service

```bash
# JVM (Maven wrapper committed; distributionUrl points at Maven Central)
(cd services/api && ./mvnw test)
(cd services/ingest && ./mvnw test)
(cd services/timescale-writer && ./mvnw test)

# Python
(cd services/optimization && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev,solver]' && pytest)  # 'solver' extra pulls the HiGHS wheel; drop it where unavailable and the solver test skips
(cd services/forecast && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)
(cd services/marketing-adapter && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)

# Frontend (also runs tsc type-check)
(cd frontend/portal && npm install && npm run build)
```

Health endpoints on the JVM services are mapped to root: `GET /health` (Spring Boot Actuator).

## Contracts (binding)

`docs/contracts/` holds the interface contracts (architecture section 20 item 8). Changing them is a breaking change; every payload/event carries `schema_version`.
- `mqtt-telemetry.schema.json` - MQTT topic convention + telemetry payload (incl. observed §14a `grid_limit_kw`).
- `telemetry-raw.event.schema.json` - Redpanda `telemetry.raw` event.
- `openapi.yaml` - portal API stub.

## Conventions & decisions worth knowing

- **Maven over Gradle** for JVM services: `mvn` is available and the wrapper is self-contained; keeps one build tool across the JVM tier. Each service is an independent Maven project (no shared reactor) to preserve clean service boundaries.
- The committed Maven wrapper `distributionUrl` targets **Maven Central**, not any private mirror, so `./mvnw` works on a clean machine.
- JVM skeletons are startable offline: `api` OIDC is toggled off by default (`VOLTPILOT_SECURITY_OIDC_ENABLED`), `timescale-writer` excludes `DataSourceAutoConfiguration` until the writer is wired.
- One Postgres instance intentionally serves **both** timeseries (hypertables) and master data (architecture section 10).

## Known future work (not in this scaffold)

Cloud/K8s/Hetzner manifests + GitOps; real optimization MILP; Modbus/SunSpec edge I/O; forecasting models; direct-marketing provider integrations; ENTSO-E ingestion; Flyway/Liquibase migrations; Prometheus/Grafana/Loki/OTel; Mender OTA. RLS is designed for (tenant_id everywhere) but not yet enforced.

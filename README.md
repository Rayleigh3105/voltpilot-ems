# Voltpilot-EMS

Self-hosted, multi-tenant **Energy Management System (EMS)** for PV, battery storage and load management in the DACH market.
It computes the economically optimal operating schedule per customer site (charge on cheap/PV-surplus power, discharge when expensive), maximizing self-consumption and - later - marketing flexibility via a direct marketer.

Intelligence lives in the **cloud** (multi-tenant portal, optimization, forecasting, marketing); the **edge** (Node-RED on Raspberry-Pi-class hardware) stays deliberately thin.

> Canonical architecture: [`docs/architecture.md`](docs/architecture.md). This repository is the MVP scaffold derived from it (section 4 MVP-Schnitt: C&I + DE first, backbone `EMQX -> Ingest -> Redpanda -> TimescaleDB-Writer -> TimescaleDB`).

## Repository layout

```
docker-compose.yml          # local dev stack (stateful backbone)
.env.example                # every env var, with dev defaults
docs/architecture.md        # canonical architecture document
docs/contracts/             # BINDING interface contracts (MQTT, Redpanda, OpenAPI)
infra/local/                # per-service config + init scripts for the stack
services/api/               # Spring Boot: portal backend / API (REST + WebSocket)
services/ingest/            # Spring Boot: MQTT -> Redpanda ingest
services/timescale-writer/  # Spring Boot: Redpanda -> TimescaleDB writer
services/optimization/      # Python: MILP/MPC engine (HiGHS via Pyomo)
services/forecast/          # Python: load/PV forecast (baseline in v1)
services/marketing-adapter/ # Python: generic Direktvermarktung adapter (stub)
services/market-data/       # Python: ENTSO-E day-ahead price adapter -> day_ahead_prices
edge/node-red/              # Node-RED edge container skeleton (thin flows)
frontend/portal/            # React (Vite) web portal skeleton
```

## Quickstart - local dev stack

Prerequisites: Docker (with Compose v2), and for building the services: JDK 21, Python 3.10+, Node 20+.

```bash
cp .env.example .env          # dev-only secrets, clearly marked
docker compose up -d          # bring up the stateful backbone
docker compose ps             # wait until all show healthy
```

This brings up the MVP data-path backbone:

| Service | URL / port | Notes |
|---|---|---|
| TimescaleDB | `localhost:5432` | db `voltpilot`, extension enabled, example `telemetry` hypertable + stammdaten seeded |
| EMQX (MQTT) | `localhost:1883` | dashboard at http://localhost:18083 (admin / see `.env`) |
| EMQX (WS/TLS) | `8083` / `8883` | |
| Redpanda (Kafka API) | `localhost:9092` | topic `telemetry.raw` created on startup |
| Redpanda Console | http://localhost:8080 | topic/consumer web UI |
| Keycloak | http://localhost:8081 | realm `voltpilot`, clients `voltpilot-api` + `voltpilot-frontend` (admin / see `.env`) |

Tear down (keep data): `docker compose down` - wipe data too: `docker compose down -v`.

### Verify the backbone

```bash
# TimescaleDB: extension + seeded schema
docker compose exec timescaledb psql -U voltpilot -d voltpilot -c "\dt"
docker compose exec timescaledb psql -U voltpilot -d voltpilot -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';"
# Redpanda: topic exists
docker compose exec redpanda rpk topic list --brokers localhost:29092
# Keycloak: realm reachable
curl -s http://localhost:8081/realms/voltpilot/.well-known/openid-configuration | head -c 200
```

## Building & running the services

Each service is independently buildable; see its own README.

```bash
# JVM services (Spring Boot, Java 21) - Maven wrapper included
(cd services/api && ./mvnw test)
(cd services/ingest && ./mvnw test)
(cd services/timescale-writer && ./mvnw test)

# Python services
(cd services/optimization && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev,solver]' && pytest)  # 'solver' extra pulls the HiGHS wheel; drop it where unavailable and the solver test skips
(cd services/forecast && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)
(cd services/marketing-adapter && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)
(cd services/market-data && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)  # add ',db' for the psycopg TimescaleDB writer; tests run fixture-only, no live ENTSO-E

# Frontend
(cd frontend/portal && npm install && npm run build)
```

## Contracts

The binding interface contracts live in [`docs/contracts/`](docs/contracts/): the MQTT topic + telemetry payload schema (incl. the observed §14a effective power limit), the Redpanda `telemetry.raw` event schema, and the portal OpenAPI stub. Treat changes there as breaking and versioned.

## Scope & future work

This scaffold delivers the **runnable local backbone + service skeletons + contracts** only. It deliberately excludes:

- Cloud / Kubernetes / Hetzner deployment manifests and GitOps (Argo CD/Flux).
- Real business logic: the optimization MILP, Modbus/SunSpec edge I/O, forecasting models, direct-marketing provider integrations. (ENTSO-E day-ahead price ingestion now exists in `services/market-data`.)
- Wiring Flyway/Liquibase into `services/api` - the local DB is bootstrapped by `infra/local/timescale/` init SQL, and `services/market-data` ships the first forward-only migration (`day_ahead_prices`); running migrations from `services/api` is still future work.
- Observability stack (Prometheus/Grafana/Loki/OTel) and Edge OTA (Mender).

See [`AGENTS.md`](AGENTS.md) for the durable stack/ports/run/build/test reference.

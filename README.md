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
edge/node-red/              # Node-RED thin edge (runnable against the SunSpec sim)
edge/sim/                   # Simulated SunSpec Modbus TCP inverter/battery (dev only)
frontend/portal/            # React (Vite) web portal skeleton
```

## Quickstart - local dev stack

Prerequisites: Docker (with Compose v2), and for building the services: JDK 21, Python 3.10+, Node 20+.

```bash
cp .env.example .env          # dev-only secrets, clearly marked
docker compose up -d          # bring up the backbone + the portal API
docker compose ps             # wait until all show healthy
```

This brings up the MVP data-path backbone plus the portal API:

| Service | URL / port | Notes |
|---|---|---|
| TimescaleDB | `localhost:5432` | db `voltpilot`, extension enabled, example `telemetry` + `forecast` hypertables + stammdaten seeded |
| EMQX (MQTT) | `localhost:1883` | dashboard at http://localhost:18083 (admin / see `.env`) |
| EMQX (WS/TLS) | `8083` / `8883` | |
| Redpanda (Kafka API) | `localhost:9092` | topic `telemetry.raw` created on startup |
| Redpanda Console | http://localhost:8080 | topic/consumer web UI |
| Keycloak | http://localhost:8081 | realm `voltpilot`, clients `voltpilot-api` + `voltpilot-frontend` (admin / see `.env`) |
| Portal API | http://localhost:8090 | Spring Boot; OIDC resource server + RLS tenant isolation; `GET /health` |

The web portal runs outside compose via Vite: `(cd frontend/portal && npm install && npm run dev)` -> http://localhost:5173. Log in as `demo`/`demo` (tenant A) or `demo2`/`demo2` (tenant B).

Tear down (keep data): `docker compose down` - wipe data too: `docker compose down -v`.

The **edge** (Node-RED + a simulated SunSpec Modbus source) is guarded behind the compose `edge` profile, so the default `up` stays backbone-only. Bring it up with `docker compose --profile edge up -d --build edge-sim edge-nodered`; see [`edge/node-red/README.md`](edge/node-red/README.md) for the end-to-end walkthrough.

### Verify the backbone

```bash
# TimescaleDB: extension + seeded schema
docker compose exec timescaledb psql -U voltpilot -d voltpilot -c "\dt"
docker compose exec timescaledb psql -U voltpilot -d voltpilot -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';"
# Redpanda: topic exists
docker compose exec redpanda rpk topic list --brokers localhost:29092
# Keycloak: realm reachable
curl -s http://localhost:8081/realms/voltpilot/.well-known/openid-configuration | head -c 200
# Portal API: healthy, and rejects unauthenticated calls
curl -s http://localhost:8090/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/v1/sites   # 401
```

### Verify the portal + tenant isolation

```bash
# Mint a tenant-A token and call the API (tenant B: demo2/demo2)
TOKEN=$(curl -s http://localhost:8081/realms/voltpilot/protocol/openid-connect/token \
  -d grant_type=password -d client_id=voltpilot-api -d client_secret=voltpilot-api-dev-secret \
  -d username=demo -d password=demo -d scope=openid | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8090/api/v1/sites   # only tenant A's sites
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

The binding interface contracts live in [`docs/contracts/`](docs/contracts/): the MQTT topic + telemetry payload schema (incl. the observed §14a effective power limit), the Redpanda `telemetry.raw` event schema, and the portal OpenAPI (auth/sites/devices/telemetry/claim implemented; schedules/KPIs still stubs). Treat changes there as breaking and versioned.

## Scope & future work

Delivered so far: the **runnable local backbone**, the binding **contracts**, the **portal + authentication spine** (Spring Boot API in compose with Keycloak OIDC + Postgres RLS tenant isolation + device claiming, and a React portal with OIDC login + telemetry view - see [`AGENTS.md`](AGENTS.md)), the baseline **forecast** service, the **ENTSO-E market-data** adapter, and the Node-RED **edge** (SunSpec simulator). The remaining services (`ingest`, `writer`, `optimization`, `marketing-adapter`) are thin skeletons. Still excluded:

- The real **ingest** data path (EMQX->ingest->Redpanda->writer) feeding real telemetry - the Node-RED edge already publishes, but `ingest`/`writer` are still skeletons, so the portal currently reads dev-seeded demo telemetry - plus the portal's schedules/KPIs endpoints and a live telemetry channel (WS/SSE).
- Cloud / Kubernetes / Hetzner deployment manifests and GitOps (Argo CD/Flux).
- Real business logic: the optimization MILP, ML forecasting models (the v1 baseline load/PV forecast is built - see `services/forecast`), direct-marketing provider integrations, and real hardware Modbus/SunSpec edge I/O (the Node-RED edge already runs end-to-end against the simulated SunSpec source in `edge/sim`). ENTSO-E day-ahead price ingestion now exists in `services/market-data`.
- Migration-version coordination across services - `services/api` now runs core-schema Flyway migrations (RLS enforced), `services/market-data` ships the forward-only `day_ahead_prices` migration, and `services/forecast` its own `V3__forecast_hypertable.sql`; a unified scheme is still to be reconciled.
- Observability stack (Prometheus/Grafana/Loki/OTel) and Edge OTA (Mender).

See [`AGENTS.md`](AGENTS.md) for the durable stack/ports/run/build/test reference.

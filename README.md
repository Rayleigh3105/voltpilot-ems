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

## Run the full stack locally

This is the verified, copy-paste path to a healthy full stack (stateful backbone + portal API + edge) plus a working portal login and telemetry view.

**Prerequisites:** Docker with Compose v2 (tested on Docker 29 / Compose v2), and - to run the web portal - Node 20+ (Node 22 works).
Building the services from source additionally needs JDK 21 and Python 3.10+, but the containers build those images for you.

### 1. Configure env

```bash
cp .env.example .env          # dev-only secrets, clearly marked - never reuse outside local dev
```

The defaults in `.env` work as-is.
`ENTSOE_SECURITY_TOKEN` is intentionally blank (only a live market-data fetch needs it - not the stack).
If a host port is already taken on your machine, override it in `.env` (it is git-ignored) - e.g. `API_PORT=18090` if something else already listens on `8090`; if you change `API_PORT`, also set `VITE_API_BASE=http://localhost:<that port>` so the portal targets the API.

### 2. Bring the whole stack up

```bash
docker compose --profile edge up -d --build   # backbone + api + edge (Node-RED + SunSpec sim)
docker compose --profile edge ps              # wait until every service shows healthy
```

The `edge` profile adds the Node-RED edge and the simulated SunSpec Modbus source; drop `--profile edge` for a backbone-only bring-up.
First start runs the TimescaleDB init scripts in `infra/local/timescale/` **once** (they create the `telemetry`, `forecast` and `day_ahead_prices` hypertables), then the api applies its Flyway migrations (`V1` core schema + app role, `V2` RLS, `V100` dev seed) idempotently over that bootstrap.

> **Upgrading an existing volume:** the init scripts only run on a *fresh* data volume.
> If you ran an earlier (backbone-only) stack and then pulled the merged increments, the newer `02-forecast.sql` / `02-day-ahead-prices.sql` scripts will **not** re-run, so those two tables stay absent.
> Recreate the volume to pick them up: `docker compose --profile edge down -v && docker compose --profile edge up -d --build`.

Services and where to reach them:

| Service | URL / port | Notes |
|---|---|---|
| TimescaleDB | `localhost:5432` | db `voltpilot`; `telemetry` + `forecast` + `day_ahead_prices` hypertables + stammdaten seeded |
| EMQX (MQTT) | `localhost:1883` | dashboard at http://localhost:18083 (admin / see `.env`) |
| EMQX (WS/TLS) | `8083` / `8883` | |
| Redpanda (Kafka API) | `localhost:9092` | topic `telemetry.raw` created on startup |
| Redpanda Console | http://localhost:8080 | topic/consumer web UI |
| Keycloak | http://localhost:8081 | realm `voltpilot`, clients `voltpilot-api` + `voltpilot-frontend` (admin / see `.env`) |
| Portal API | http://localhost:8090 | Spring Boot; OIDC resource server + RLS tenant isolation; `GET /health` |
| Node-RED edge | http://localhost:1880 | thin edge (only with `--profile edge`); publishes telemetry to EMQX |

### 3. Run the web portal

The portal runs outside compose via the Vite dev server:

```bash
(cd frontend/portal && npm install && npm run dev)   # http://localhost:5173
```

Open http://localhost:5173, click **Anmelden mit Keycloak**, and log in with a seeded **dev-only** user:

| User | Password | Tenant | Sees |
|---|---|---|---|
| `demo`  | `demo`  | A | Demo Site Berlin + its telemetry |
| `demo2` | `demo2` | B | Nordwind Hamburg + its telemetry |

After login the portal shows that tenant's sites, a live telemetry chart (PV / load / net power / battery SoC), and its devices - never the other tenant's data (enforced by Postgres RLS).

### 4. Verify it's up (backbone + auth + RLS)

```bash
# TimescaleDB: hypertables present
docker compose exec timescaledb psql -U voltpilot -d voltpilot \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1;"
# api: healthy, and rejects unauthenticated calls
curl -s http://localhost:8090/health                                              # {"status":"UP",...}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/v1/sites       # 401

# Mint a tenant-A token (password grant) and call the tenant-scoped API
TOKEN=$(curl -s http://localhost:8081/realms/voltpilot/protocol/openid-connect/token \
  -d grant_type=password -d client_id=voltpilot-api -d client_secret=voltpilot-api-dev-secret \
  -d username=demo -d password=demo -d scope=openid | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8090/api/v1/sites       # only tenant A's site
# RLS proof: tenant A cannot see tenant B's site -> 404 (not 403; the row is invisible)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  http://localhost:8090/api/v1/sites/10000000-0000-0000-0000-000000000002/telemetry?channel=power_kw
```

### 5. Verify the edge -> MQTT path (with `--profile edge`)

The Node-RED edge reads the SunSpec simulator and publishes contract-conformant telemetry to EMQX.
Subscribe to one message (needs a broker container on the compose network):

```bash
T='ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003'
docker run --rm --network voltpilot_default eclipse-mosquitto:2 \
  mosquitto_sub -h emqx -p 1883 -t "$T/telemetry" -C 1 -v -W 25
```

See [`edge/node-red/README.md`](edge/node-red/README.md) for the full walkthrough (schedule execution, watchdog, guards).

### Tear down

```bash
docker compose --profile edge down       # stop, keep data volumes
docker compose --profile edge down -v    # stop and wipe data (forces a fresh init on next up)
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

## Connect a real device (secure mTLS broker)

For onboarding a physical remote edge device over the internet - mTLS on `8883`, per-tenant/-device ACL, a device CA + cert-issuance/revocation tool - see [`docs/connect-a-device.md`](docs/connect-a-device.md) (device guide) and [`docs/security-mqtt.md`](docs/security-mqtt.md) (security model + hardening checklist). The dev stack (plaintext `1883`) is unaffected; the hardened `8883` broker is part of the standalone production stack (`docker compose -f docker-compose.prod.yml up -d`). Docker-free proof: `python3 tools/pki/verify_mqtt_security.py`.

## Production deployment

Single-VPS deploy (external Caddy TLS + Forgejo push-to-deploy), modeled on saalo: [`docs/deploy.md`](docs/deploy.md). The full server-side stack is `docker-compose.prod.yml` (images pulled from the Forgejo registry, pinned per rollout); the CI/CD lives in [`.forgejo/workflows/`](.forgejo/workflows/) (`deploy.yaml` gated, `deploy-fast.yaml` manual). Prod secrets template: [`.env.prod.example`](.env.prod.example).

## Scope & future work

Delivered so far: the **runnable local backbone**, the binding **contracts**, the **portal + authentication spine** (Spring Boot API in compose with Keycloak OIDC + Postgres RLS tenant isolation + device claiming, and a React portal with OIDC login + telemetry view - see [`AGENTS.md`](AGENTS.md)), the baseline **forecast** service, the **ENTSO-E market-data** adapter, and the Node-RED **edge** (SunSpec simulator). The remaining services (`ingest`, `writer`, `optimization`, `marketing-adapter`) are thin skeletons. Still excluded:

- The real **ingest** data path (EMQX->ingest->Redpanda->writer) feeding real telemetry - the Node-RED edge already publishes, but `ingest`/`writer` are still skeletons, so the portal currently reads dev-seeded demo telemetry - plus the portal's schedules/KPIs endpoints and a live telemetry channel (WS/SSE).
- Cloud / Kubernetes / Hetzner deployment manifests and GitOps (Argo CD/Flux).
- Real business logic: the optimization MILP, ML forecasting models (the v1 baseline load/PV forecast is built - see `services/forecast`), direct-marketing provider integrations, and real hardware Modbus/SunSpec edge I/O (the Node-RED edge already runs end-to-end against the simulated SunSpec source in `edge/sim`). ENTSO-E day-ahead price ingestion now exists in `services/market-data`.
- Migration-version coordination across services - `services/api` now runs core-schema Flyway migrations (RLS enforced), `services/market-data` ships the forward-only `day_ahead_prices` migration, and `services/forecast` its own `V3__forecast_hypertable.sql`; a unified scheme is still to be reconciled.
- Observability stack (Prometheus/Grafana/Loki/OTel) and Edge OTA (Mender).

See [`AGENTS.md`](AGENTS.md) for the durable stack/ports/run/build/test reference.

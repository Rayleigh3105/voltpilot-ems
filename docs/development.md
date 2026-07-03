# Local development & full-stack bring-up

This is the verified, copy-paste path to a healthy full stack (stateful backbone + portal API + edge) plus a working portal login and telemetry view.
The [README](../README.md) carries a condensed quickstart; this page keeps the complete detail.

**Prerequisites:** Docker with Compose v2 (tested on Docker 29 / Compose v2), and - to run the web portal - Node 20+ (Node 22 works).
Building the services from source additionally needs JDK 21 and Python 3.10+, but the containers build those images for you.

## 1. Configure env

```bash
cp .env.example .env          # dev-only secrets, clearly marked - never reuse outside local dev
```

The defaults in `.env` work as-is.
`ENTSOE_SECURITY_TOKEN` is intentionally blank (only a live market-data fetch needs it - not the stack).
If a host port is already taken on your machine, override it in `.env` (it is git-ignored) - e.g. `API_PORT=18090` if something else already listens on `8090`; if you change `API_PORT`, also set `VITE_API_BASE=http://localhost:<that port>` so the portal targets the API.

## 2. Bring the whole stack up

```bash
docker compose --profile edge up -d --build   # backbone + api + edge (Node-RED + SunSpec sim)
docker compose --profile edge ps              # wait until every service shows healthy
```

The `edge` profile adds the Node-RED edge and the simulated SunSpec Modbus source; drop `--profile edge` for a backbone-only bring-up.
Two further profiles are opt-in: `feeds` (keyless day-ahead prices + weather collectors) and `optimize` (the battery-dispatch optimizer - plans every 15 min against the collected prices and publishes retained MQTT schedules): `docker compose --profile feeds --profile optimize up -d --build`.
First start runs the TimescaleDB init scripts in `infra/local/timescale/` **once** (they create the `telemetry`, `forecast` and `day_ahead_prices` hypertables), then the api applies its Flyway migrations (`V1` core schema + app role, `V2` RLS, `V100` dev seed) idempotently over that bootstrap.

> **Upgrading an existing volume:** the init scripts only run on a *fresh* data volume.
> If you ran an earlier (backbone-only) stack and then pulled the merged increments, the newer `02-forecast.sql` / `02-day-ahead-prices.sql` scripts will **not** re-run, so those two tables stay absent.
> Recreate the volume to pick them up: `docker compose --profile edge down -v && docker compose --profile edge up -d --build`.

Services and where to reach them:

| Service | URL / port | Notes |
|---|---|---|
| TimescaleDB | `localhost:5432` | db `voltpilot`; `telemetry` + `forecast` + `day_ahead_prices` hypertables + master data seeded |
| EMQX (MQTT) | `localhost:1883` | dashboard at http://localhost:18083 (admin / see `.env`) |
| EMQX (WS/TLS) | `8083` / `8883` | |
| Redpanda (Kafka API) | `localhost:9092` | topic `telemetry.raw` created on startup |
| Redpanda Console | http://localhost:8080 | topic/consumer web UI |
| Keycloak | http://localhost:8081 | realm `voltpilot`, clients `voltpilot-api` + `voltpilot-frontend` (admin / see `.env`) |
| Portal API | http://localhost:8090 | Spring Boot; OIDC resource server + RLS tenant isolation; `GET /health` |
| Ingest | http://localhost:8091 | MQTT -> Redpanda (only with `--profile edge`) |
| Timescale-writer | http://localhost:8092 | Redpanda -> TimescaleDB (only with `--profile edge`) |
| Node-RED edge | http://localhost:1880 | thin edge (only with `--profile edge`); publishes telemetry to EMQX |
| SunSpec simulator | `localhost:15020` | Modbus TCP (host debug; in-cluster `edge-sim:502`) |

## 3. Run the web portal

The portal runs outside compose via the Vite dev server:

```bash
(cd frontend/portal && npm install && npm run dev)   # http://localhost:5173
```

Open http://localhost:5173, click **Anmelden** (the branded German VoltPilot login page appears), and log in with a seeded **dev-only** user:

| User | Password | Tenant | Sees |
|---|---|---|---|
| `demo`  | `demo`  | A | Demo Site Berlin + its telemetry |
| `demo2` | `demo2` | B | Nordwind Hamburg + its telemetry |

After login the portal shows that tenant's sites, a live telemetry chart (PV / load / net power / battery SoC), and its devices - never the other tenant's data (enforced by Postgres RLS).
Log in as `admin`/`admin` for the same portal with the additive **Plattform** nav group (Mandanten/Benutzer/Geräte-Registry) and the tenant switcher in the top bar.
Alternatively, create a fresh customer account via **Konto erstellen** (public self-registration): you land signed-in in the guided onboarding wizard (Standort → Gerät → Startklar).

### Access the portal from another machine on the LAN

All SPA URLs are env-driven (`VITE_*`); the dev realm already allows the LAN origin `http://192.168.2.77:5173` (adjust `infra/local/keycloak/voltpilot-realm.json` for a different host IP - Keycloak only imports it on a **fresh** volume, so `docker compose down -v && up -d` after changing it). On the machine hosting the stack:

```bash
# 1. Keycloak must issue tokens with an issuer the OTHER machine can resolve:
#    set KC_HOSTNAME + the api's expected issuer to the host's LAN IP in .env:
#      KC_HOSTNAME=http://192.168.2.77:8081
#      OIDC_ISSUER_URI=http://192.168.2.77:8081/realms/voltpilot
#      VOLTPILOT_CORS_ALLOWED_ORIGINS=http://localhost:5173,http://192.168.2.77:5173
#    then: docker compose up -d (recreates keycloak + api with the new env)

# 2. Run Vite bound to all interfaces, pointing the SPA at the LAN URLs:
(cd frontend/portal && \
  VITE_KEYCLOAK_URL=http://192.168.2.77:8081 \
  VITE_API_BASE=http://192.168.2.77:8090 \
  npm run dev -- --host 0.0.0.0)
```

Then open `http://192.168.2.77:5173` from the other machine and log in as usual.

## 4. Verify it's up (backbone + auth + RLS)

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

## 5. Verify the edge -> MQTT path (with `--profile edge`)

The Node-RED edge reads the SunSpec simulator and publishes contract-conformant telemetry to EMQX.
Subscribe to one message (needs a broker container on the compose network):

```bash
T='ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003'
docker run --rm --network voltpilot_default eclipse-mosquitto:2 \
  mosquitto_sub -h emqx -p 1883 -t "$T/telemetry" -C 1 -v -W 25
```

See [`../edge/node-red/README.md`](../edge/node-red/README.md) for the full walkthrough (schedule execution, watchdog, guards).

## Tear down

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

# Frontend (also runs the tsc type-check)
(cd frontend/portal && npm install && npm run build)

# Customer-side edge app (Go core + Node-RED palette)
(cd edge-app/core && go test ./...)
(cd edge-app/nodered/vp-palette && npm install && npm test)
```

Health endpoints on the JVM services are mapped to root: `GET /health` (Spring Boot Actuator).

Dependency resolution uses **Maven Central** and **public npm** (the committed Maven wrapper and `frontend/portal/.npmrc` both target the public registries), so a clean machine builds without extra configuration.
If your `~/.m2/settings.xml` pins a corporate mirror that a sandbox/CI can't reach, build the JVM services with a Central-only override: `./mvnw -s .mvn-central-settings.xml test`.

See [`../AGENTS.md`](../AGENTS.md) for the durable stack/ports/run/build/test reference.

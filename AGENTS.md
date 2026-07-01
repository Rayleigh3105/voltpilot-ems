# AGENTS.md - Voltpilot-EMS project knowledge

Durable, project-intrinsic knowledge for anyone (human or agent) working in this repo.
The product architecture is in [`docs/architecture.md`](docs/architecture.md); this file is the operational "how it's built and run" reference.

## What this is

Self-hosted multi-tenant EMS (PV / battery / load management), DACH market. Monorepo.
On top of the runnable local backbone and binding contracts, several increments now add real functionality: the **portal + authentication spine** (the Spring Boot `api` runs in compose, validates Keycloak JWTs, and serves tenant-scoped sites/devices/telemetry plus device-claiming, enforced end-to-end by Postgres Row-Level-Security; the React portal has real OIDC login and a telemetry view), the baseline **`services/forecast`** (load/PV, no ML), the **`services/market-data`** ENTSO-E day-ahead price adapter, and the Node-RED **edge** (SunSpec Modbus simulator). The remaining services (ingest, writer, optimization, marketing-adapter) are still thin skeletons - see the service map and "Status" per service README.

MVP data path (architecture section 4/7): `Node-RED edge -> EMQX (MQTT) -> Ingest -> Redpanda (telemetry.raw) -> TimescaleDB-Writer -> TimescaleDB`. The ingest path is not built yet; the portal reads **dev-seeded** demo telemetry.

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
| `services/market-data` | Python | ENTSO-E day-ahead price adapter (anti-corruption layer) -> `day_ahead_prices` | stateless (job) |
| `edge/node-red` | Node-RED | Thin edge: acquisition, publish, schedule-exec, watchdog, guards (runnable via the SunSpec sim) | edge |
| `edge/sim` | Node.js | Simulated SunSpec Modbus TCP inverter/battery (dev only, no hardware) | dev tool |
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
| 1880 | Node-RED editor (edge) |
| 15020 | SunSpec Modbus TCP simulator (host debug; in-cluster `edge-sim:502`) |

## Run the local stack

```bash
cp .env.example .env
docker compose up -d          # backbone (timescaledb, emqx, redpanda, keycloak) + the api service
docker compose ps             # all report healthy, including voltpilot-api
docker compose down           # stop (keep volumes) ; add -v to wipe data

# The web portal runs outside compose (Vite dev server):
(cd frontend/portal && npm install && npm run dev)   # http://localhost:5173
```

The **edge** (Node-RED + SunSpec simulator) is guarded behind the compose `edge` profile, so the default `docker compose up -d` stays backbone-only:

```bash
docker compose up -d emqx                                        # broker
docker compose --profile edge up -d --build edge-sim edge-nodered
# telemetry flows to EMQX; publish a retained schedule to drive setpoints.
# Details + copy-paste test commands: edge/node-red/README.md
docker compose --profile edge down
```

Notes:
- `compose` now starts **`api`** alongside the backbone (built from `services/api`, healthy once Keycloak + TimescaleDB are up). The remaining app services (`ingest`, `writer`, and the Python services) are still NOT started (backbone-first); each has a `Dockerfile` for later.
- The edge (`edge/*`) is likewise not started by the default `up`; use `--profile edge`. It reaches EMQX at `emqx:1883` and the simulator at `edge-sim:502` over the compose network.
- `.env` holds **dev-only** secrets, clearly marked. Never reuse them outside local dev.
- Data persists in named volumes `timescale-data`, `emqx-data`, `redpanda-data`.
- Redpanda advertises two listeners: `redpanda:29092` (in-cluster) and `localhost:9092` (host). Services inside compose must use the internal one.
- Keycloak realm `voltpilot` is imported on start from `infra/local/keycloak/` with clients `voltpilot-api` (confidential) and `voltpilot-frontend` (public/PKCE, `tenant_id` mapper), plus two dev users (see the auth section): `demo`/`demo` (tenant A) and `demo2`/`demo2` (tenant B).
- TimescaleDB is bootstrapped once from `infra/local/timescale/*.sql`, applied in filename order (`01-init.sql`: extension + example `telemetry` hypertable + tenant/site/device/asset + a deterministic dev seed; `02-day-ahead-prices.sql`: the market-data hypertable; `02-forecast.sql`: the `forecast` hypertable) so the backbone works without the app services. The **core schema is owned by Flyway migrations in `services/api`** (`db/migration`), which run on api start and are idempotent, so they layer cleanly over that bootstrap and own a fresh DB outright; the `forecast` and `market-data` services ship their own migrations (see their sections for version coordination).

## Portal API: auth, tenancy & RLS (services/api)

The user-facing spine. See `services/api/README.md` for the endpoint list.

**Auth (Keycloak OIDC).** The api is an OAuth2 resource server validating realm `voltpilot` JWTs. The frontend logs in via the public `voltpilot-frontend` client (Authorization Code + PKCE); every token carries a `tenant_id` claim (a Keycloak user attribute, mapped on both clients).

- **Issuer/JWKS split (the "issuer trap" fix).** `KC_HOSTNAME=http://localhost:8081` pins Keycloak's public URL, so browser- and script-minted tokens all carry `iss=http://localhost:8081/realms/voltpilot`. The api validates that issuer (`OIDC_ISSUER_URI`) but fetches signing keys from the compose-internal `OIDC_JWK_SET_URI=http://keycloak:8080/.../certs` - so it never needs to resolve `localhost:8081`. Spring's resource server accepts both `issuer-uri` + `jwk-set-uri` set together: keys from the latter, `iss` checked against the former.
- OIDC is off by default (`VOLTPILOT_SECURITY_OIDC_ENABLED=false`) for offline unit tests; compose sets it `true`. CORS origins via `VOLTPILOT_CORS_ALLOWED_ORIGINS` (default `http://localhost:5173`).

**Multi-tenancy via Postgres RLS.** `TenantFilter` reads `tenant_id` from the JWT into a request-scoped `TenantContext`; `TenantAwareDataSource` stamps it onto each borrowed connection via `set_config('app.tenant_id', ...)` and RESETs on return to the pool. RLS policies (migration `V2`) scope every table (`tenant`/`site`/`device`/`asset`/`telemetry`) with `tenant_id = current_setting('app.tenant_id')`. No tenant set => **default-deny** (zero rows).

- **Two DB roles, on purpose.** The compose `POSTGRES_USER` (`voltpilot`) is a Postgres **superuser**, and superusers BYPASS RLS. So the api connects at runtime as a dedicated **`voltpilot_app`** role (NOSUPERUSER/NOBYPASSRLS, created by Flyway `V1` with a placeholder password from `APP_DB_PASSWORD`) for which RLS is enforced. **Flyway** runs as the superuser (`spring.flyway.user`) to own the schema, create the role/policies, and seed both tenants (bypassing RLS). Tables are also `FORCE ROW LEVEL SECURITY` so even the owner is scoped.

**Migrations (Flyway).** In `services/api/src/main/resources/db/`: `migration/` = prod-safe core (`V1` idempotent schema + app role, `V2` RLS); `dev/` = the DEV-ONLY seed (`V100`, two tenants + demo telemetry), added to `spring.flyway.locations` only under the `local` profile (compose sets `SPRING_PROFILES_ACTIVE=local`; tests activate it too). `baseline-on-migrate` + `baseline-version=0` let the idempotent `V1` run over the compose bootstrap DB.

**Seeded dev tenants/users (dev-only, disjoint data):**

| Keycloak user | Password | tenant_id | Site | Device |
|---|---|---|---|---|
| `demo`  | `demo`  | `00000000-…-0001` | Demo Site Berlin | `demo-inverter-01` |
| `demo2` | `demo2` | `10000000-…-0001` | Nordwind Hamburg | `nordwind-inverter-01` |

**Device claiming** (`POST /api/v1/devices/claim`) is one insert into the caller's tenant. `external_ref` is **globally unique**, so claiming a device already owned by another tenant (which RLS hides) fails the unique constraint -> HTTP 409; a site outside the tenant -> 404.

**Tests** (`./mvnw test`, auto-skip without Docker via `disabledWithoutDocker`): `TenantFilterTest` (unit, always runs); `RlsIsolationTest` (Testcontainers TimescaleDB, JDBC-level RLS proof); `PortalApiTest` (Testcontainers TimescaleDB + Keycloak, full OIDC + tenant-isolation + claim e2e). Note: Docker 25+ enforces API >= 1.40, so surefire pins `-Dapi.version` (property `docker.api.version`, default 1.44) for the Testcontainers docker-java client.

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
(cd services/market-data && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)  # add ',db' for the psycopg TimescaleDB writer; tests run fixture-only, no live ENTSO-E

# Frontend (also runs tsc type-check)
(cd frontend/portal && npm install && npm run build)

# Edge simulator (SunSpec Modbus TCP source; sanity syntax check)
(cd edge/sim && npm install && node -e "require('./sunspec-sim.js')" & sleep 2; kill %1)
```

Health endpoints on the JVM services are mapped to root: `GET /health` (Spring Boot Actuator).

The edge flows are exercised end-to-end against the simulator (not a unit test): bring up `emqx` + the `edge` profile, subscribe to `.../telemetry`, publish a retained `.../schedule`, and watch `edge-sim` log the slot setpoint writes. See `edge/node-red/README.md`. Telemetry conformance to `docs/contracts/mqtt-telemetry.schema.json` was validated with ajv (2020-12).

## Contracts (binding)

`docs/contracts/` holds the interface contracts (architecture section 20 item 8). Changing them is a breaking change; every payload/event carries `schema_version`.
- `mqtt-telemetry.schema.json` - MQTT topic convention + telemetry payload (incl. observed §14a `grid_limit_kw`).
- `telemetry-raw.event.schema.json` - Redpanda `telemetry.raw` event.
- `openapi.yaml` - portal API. The auth/sites/devices/telemetry/claim endpoints are **implemented** in `services/api`; schedules and KPIs are still stubs. Keep this file in sync when changing those endpoints.

## Web portal (frontend/portal)

React + Vite + TypeScript SPA. `npm run dev` (5173) / `npm run build` (tsc type-check + bundle).

- **Design system** lives in `frontend/portal/designsystem/` - the shared VoltPilot tokens (`tokens/*.css`: colors/typography/spacing/effects/fonts, cornflower-blue brand, Inter/Inter Tight), core/form components (`.jsx` + `.d.ts`), and visual guideline cards. Import all `tokens/*.css` once at the app root (done in `src/main.tsx`); **new UI must build on these components/tokens**, not hand-rolled equivalents. Read each component's `.prompt.md` for its props.
- Auth via `keycloak-js` (`src/auth.ts`, silent-SSO check + PKCE); the access token is attached to API calls in `src/api.ts` (`freshToken()` refreshes it). Config via `VITE_KEYCLOAK_*` / `VITE_API_BASE`.
- Telemetry chart uses **ECharts** (`src/TelemetryChart.tsx`). Live channel is REST polling on load (WebSocket/SSE deferred - acceptable per the increment scope).
- **npm registry:** `frontend/portal/.npmrc` points at **public npm** (`registry.npmjs.org`) so the portal builds on a clean machine (mirrors the Maven-Central decision). The scaffold's lockfile had a corporate mirror baked in; it was repointed. Override `.npmrc` locally if you build behind a mirror.

**Gap:** the `.../schedule` (Cloud -> Edge, retained) payload is referenced by `x-topics` but **not yet frozen** in `docs/contracts`. Until it is, the edge consumes the shape documented in `edge/node-red/README.md` (`{ schema_version, slot_minutes, slots:[{ start, battery_setpoint_kw }] }`, `+`=charge/`-`=discharge). Any task that freezes the schedule contract should reconcile with that shape.

## Market data (ENTSO-E day-ahead prices)

`services/market-data` is the anti-corruption adapter that feeds day-ahead spot prices into the optimizer (architecture section 11/13: "Marktdaten: ENTSO-E Transparency, hinter Adapter").

- **Port / providers.** `DayAheadPriceSource` (in `source.py`) is the provider-agnostic port; every caller depends on it, never on ENTSO-E. `EntsoeDayAheadPriceSource` is the first implementation; a commercial provider is a drop-in replacement. `ResilientPriceSource` decorates any source with retry (exponential backoff), a circuit breaker, and a **last-good cache**, so the optimizer always gets a usable series even when ENTSO-E is down.
- **Internal representation.** `PriceSeries` / `PricePoint` (EUR/MWh, UTC slot bounds, `PT15M`/`PT60M`). No vendor vocabulary crosses this boundary.
- **Zone -> EIC mapping** lives only in `zones.py`: `DE-LU -> 10Y1001A1001A82H`, `AT -> 10YAT-APG------L`, `CH -> 10YCH-SWISSGRIDZ`. DE-LU is implemented end to end; adding AT/CH is a one-line edit there.
- **Storage.** Prices are timeseries -> the `day_ahead_prices` **hypertable**, keyed by `(bidding_zone, resolution, ts)`. Prices are market-wide **per bidding zone, not per tenant**, so there is deliberately **no `tenant_id`** (and no RLS) on this table, unlike `telemetry`. Schema is owned by the forward-only migration `services/market-data/db/migration/V20260701001200__day_ahead_prices_hypertable.sql` (Flyway/Liquibase-compatible; **date-based version chosen so it does not collide with the api service's future `V1, V2, ...` baseline** - coordinate future market-data migrations to stay in this `V2026...` scope). The local dev stack mirrors it via `infra/local/timescale/02-day-ahead-prices.sql` (additive; the existing `01-init.sql` is untouched).
- **Token.** `ENTSOE_SECURITY_TOKEN` is a **captain-provided secret** (blank in `.env.example`); obtain via ENTSO-E Transparency registration + a "Restful API access" email (see `services/market-data/README.md`). It is **not** needed for tests/CI - parsing, mapping and resilience run entirely off recorded fixtures in `tests/fixtures/`. A live token is needed only for a real end-to-end fetch; that end-to-end verification is still open.
- **Fetch cadence.** ENTSO-E publishes the next day's prices ~12:45 market time; run `python -m voltpilot_market_data fetch --zone DE-LU --persist` daily after that (cron `0 13 * * *`, or a future K8s CronJob from the service `Dockerfile`). The CLI `--zone` defaults to the `MARKET_DATA_ZONE` env var (fallback `DE-LU`) when omitted, so the container `CMD` is just `fetch --persist` and picks its zone from the environment. Following the backbone-first convention, the service is **not** wired into `docker-compose.yml`.

## Forecast service (`services/forecast`)

Baseline load/PV forecasts for the optimizer (architecture section 12; **no ML in v1**). Pure Python, dependency-free core, offline-first (demo + tests need no DB/network). Full detail in `services/forecast/README.md`.

- **Methods.** Load = baseline (`SeasonalPersistenceLoadForecaster`, `ProfileLoadForecaster`; persistence/profile per architecture 12). PV = physical model (`PhysicalPvForecaster`): solar geometry -> clear-sky irradiance -> plane-of-array transposition -> PVWatts-style capacity/derate. Day-ahead price is not forecast (ENTSO-E-given).
- **Interfaces (swap points).** `LoadForecaster`, `PvForecaster`, `WeatherProvider` (weather anti-corruption layer, default `ClearSkyWeatherProvider`), `ForecastRepository`. `ForecastService` is the façade the optimizer calls. The later XGBoost/LightGBM load model and a real EU-hosted weather API implement these same interfaces - consumers are unaffected (architecture 12.2/12.3).
- **Exposure.** Forecasts are timeseries (architecture section 10) -> TimescaleDB `forecast` hypertable, read via `TimescaleForecastRepository` (`.[db]` extra pulls psycopg); `InMemoryForecastRepository` is the offline default. Horizon is 24-48h in 15-min slots.
- **Migration version coordination.** The `forecast` hypertable ships as Flyway `services/forecast/migrations/V3__forecast_hypertable.sql`. **V1/V2 are reserved** for the core schema (master data, telemetry) that `services/api` will own when it adopts Flyway; forecast deliberately takes **V3** to avoid collision. `infra/local/timescale/02-forecast.sql` mirrors the same DDL for the dev bootstrap - keep the two in sync (migration is the source of truth).
- **Run/test.** `(cd services/forecast && python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)`; `python -m voltpilot_forecast` prints a 24h demo forecast for the seeded demo site. Not wired into `docker compose` yet (backbone-first, consistent with the other app services).

## Conventions & decisions worth knowing

- **Maven over Gradle** for JVM services: `mvn` is available and the wrapper is self-contained; keeps one build tool across the JVM tier. Each service is an independent Maven project (no shared reactor) to preserve clean service boundaries.
- The committed Maven wrapper `distributionUrl` targets **Maven Central**, not any private mirror, so `./mvnw` works on a clean machine.
- `api` OIDC is toggled off by default (`VOLTPILOT_SECURITY_OIDC_ENABLED`) so unit tests run offline; `timescale-writer` still excludes `DataSourceAutoConfiguration` until the writer is wired.
- One Postgres instance intentionally serves **both** timeseries (hypertables) and master data (architecture section 10).
- **RLS needs a non-superuser connection.** Never point the api's runtime datasource at the `voltpilot` superuser - it would silently bypass RLS. Use `voltpilot_app` (see the auth section). New tenant-owned tables must add an RLS policy in a migration and be granted to `voltpilot_app`.
- Tenant scoping is enforced in the DB, not the queries: repositories carry **no** `tenant_id` predicate. Out-of-tenant rows are invisible, so "not found" is 404, not 403.

## Known future work (not yet built)

Real ingest data path (EMQX->ingest->Redpanda->writer) feeding real telemetry (the Node-RED edge already publishes, but `ingest`/`writer` are still skeletons); real optimization MILP; forecasting ML (XGBoost/LightGBM load model, ML PV correction, real weather API); direct-marketing provider integrations; portal schedules/KPIs endpoints; live telemetry channel (WS/SSE); real Modbus/SunSpec hardware I/O (only the simulator exists today); Cloud/K8s/Hetzner manifests + GitOps; Prometheus/Grafana/Loki/OTel; Mender OTA. Core-schema Flyway migrations now run in `services/api` (RLS enforced), and `services/market-data` (`day_ahead_prices`) and `services/forecast` (`forecast` hypertable, V3) ship their own migrations; a unified migration-version scheme across services is still to be reconciled.

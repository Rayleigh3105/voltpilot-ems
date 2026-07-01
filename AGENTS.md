# AGENTS.md - Voltpilot-EMS project knowledge

Durable, project-intrinsic knowledge for anyone (human or agent) working in this repo.
The product architecture is in [`docs/architecture.md`](docs/architecture.md); this file is the operational "how it's built and run" reference.

## What this is

Self-hosted multi-tenant EMS (PV / battery / load management), DACH market. Monorepo.
This repo currently holds the **MVP scaffold**: the runnable local backbone, thin service skeletons, and the binding contracts. Business logic is mostly deferred (see "Status" per service README); the exception is `services/forecast`, which ships its baseline v1 load/PV forecast.

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
| `services/market-data` | Python | ENTSO-E day-ahead price adapter (anti-corruption layer) -> `day_ahead_prices` | stateless (job) |
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
- TimescaleDB is bootstrapped once from `infra/local/timescale/*.sql`, applied in filename order: `01-init.sql` (extension + example `telemetry` hypertable + tenant/site/device/asset + a deterministic dev seed) then `02-forecast.sql` (the `forecast` hypertable). Production owns the schema via Flyway/Liquibase migrations (core schema future, in `services/api`); the forecast hypertable already ships a Flyway migration `services/forecast/migrations/V3__forecast_hypertable.sql` (see the Forecast section for version coordination).

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
```

Health endpoints on the JVM services are mapped to root: `GET /health` (Spring Boot Actuator).

## Contracts (binding)

`docs/contracts/` holds the interface contracts (architecture section 20 item 8). Changing them is a breaking change; every payload/event carries `schema_version`.
- `mqtt-telemetry.schema.json` - MQTT topic convention + telemetry payload (incl. observed §14a `grid_limit_kw`).
- `telemetry-raw.event.schema.json` - Redpanda `telemetry.raw` event.
- `openapi.yaml` - portal API stub.

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
- JVM skeletons are startable offline: `api` OIDC is toggled off by default (`VOLTPILOT_SECURITY_OIDC_ENABLED`), `timescale-writer` excludes `DataSourceAutoConfiguration` until the writer is wired.
- One Postgres instance intentionally serves **both** timeseries (hypertables) and master data (architecture section 10).

## Known future work (not in this scaffold)

Cloud/K8s/Hetzner manifests + GitOps; real optimization MILP; Modbus/SunSpec edge I/O; forecasting ML (XGBoost/LightGBM load model, ML PV correction, real weather API); direct-marketing provider integrations; Prometheus/Grafana/Loki/OTel; Mender OTA. RLS is designed for (tenant_id everywhere) but not yet enforced. ENTSO-E day-ahead ingestion now exists (`services/market-data`) with a Flyway/Liquibase-style migration (`day_ahead_prices`), and the baseline forecast service ships its own (`forecast` hypertable, V3 - see the Forecast section); wiring core-schema Flyway/Liquibase migrations into `services/api` to actually run them is still future work.

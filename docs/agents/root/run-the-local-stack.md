# Run the local stack

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 5).


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
- `compose` now starts **`api`** alongside the backbone (built from `services/api`, healthy once Keycloak + TimescaleDB are up). The Python services are still NOT started (backbone-first); each has a `Dockerfile` for later.
- The edge (`edge/*`) **and the live ingest pipe (`ingest` + `writer`)** are guarded behind the `edge` profile, so the default `docker compose up -d` stays backbone-only. `docker compose --profile edge up -d --build` brings up the whole live path (edge -> EMQX -> ingest -> Redpanda -> writer -> TimescaleDB); see "Live ingest pipe" below. Services reach EMQX at `emqx:1883`, Redpanda at `redpanda:29092`, TimescaleDB at `timescaledb:5432` and the simulator at `edge-sim:502` over the compose network.
- The **optimizer** is guarded behind its own `optimize` profile (see "Optimization engine"): `docker compose --profile feeds --profile optimize up -d --build` runs the full plan-and-publish loop against real day-ahead prices.
- `.env` holds **dev-only** secrets, clearly marked. Never reuse them outside local dev.
- Data persists in named volumes `timescale-data`, `emqx-data`, `redpanda-data`.
- Redpanda advertises two listeners: `redpanda:29092` (in-cluster) and `localhost:9092` (host). Services inside compose must use the internal one.
- Keycloak realm `voltpilot` is imported on start from `infra/local/keycloak/` with clients `voltpilot-api` (confidential; its service account holds `realm-management` roles for the admin API) and `voltpilot-frontend` (public/PKCE, `tenant_id` mapper), plus dev users (see the auth + admin sections): `admin`/`admin` (Portal-Admin, `platform-admin`), `demo`/`demo` (tenant A) and `demo2`/`demo2` (tenant B).
- TimescaleDB is bootstrapped once from `infra/local/timescale/*.sql`, applied in filename order (`01-init.sql`: extension + example `telemetry` hypertable + tenant/site/device/asset + a deterministic dev seed; `02-day-ahead-prices.sql`: the market-data hypertable; `02-forecast.sql`: the `forecast` hypertable; `03-weather.sql`: site geo + `weather_forecast`; `04-schedule.sql`: battery efficiency + the `schedule` hypertable) so the backbone works without the app services. The **core schema is owned by Flyway migrations in `services/api`** (`db/migration`), which run on api start and are idempotent, so they layer cleanly over that bootstrap and own a fresh DB outright; the `forecast` and `market-data` services ship their own migrations (see their sections for version coordination).
- **The full stack has been verified end-to-end from a clean bring-up** (`docker compose --profile edge up -d --build`): all five merged increments co-run, the api's Flyway `V1/V2/V100` apply cleanly over the init-script bootstrap, all three hypertables (`telemetry`/`forecast`/`day_ahead_prices`) exist, OIDC auth + RLS isolation + the telemetry API + the React portal login/telemetry view all work, and the edge publishes contract-conformant telemetry to EMQX. See the README "Run the full stack locally" section for the exact commands + verification. Two footguns worth knowing: (1) the `infra/local/timescale/*.sql` init scripts only run on a **fresh** data volume, so after pulling newly-merged increments you must `down -v` (or the new `forecast`/`day_ahead_prices` tables silently stay absent on an already-initialized volume); (2) host-port collisions on `8090`/`5432`/etc. are resolved by overriding the port in the git-ignored `.env` (e.g. `API_PORT`, and matching `VITE_API_BASE`), not by editing compose.


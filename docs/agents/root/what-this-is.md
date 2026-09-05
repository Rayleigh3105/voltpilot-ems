# What this is

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1).


Self-hosted multi-tenant EMS (PV / battery / load management), DACH market. Monorepo.
On top of the runnable local backbone and binding contracts, several increments now add real functionality: the **portal + authentication spine** (the Spring Boot `api` runs in compose, validates Keycloak JWTs, and serves tenant-scoped sites/devices/telemetry plus device-claiming, enforced end-to-end by Postgres Row-Level-Security; the React portal has real OIDC login and a telemetry view), the **live ingest pipe** (`services/ingest` + `services/timescale-writer`, wired into the `edge` compose profile - real edge telemetry now flows MQTT -> Redpanda -> TimescaleDB and surfaces in the portal), **`services/forecast`** (load/PV: baseline models active + a shadow-mode ML model registry with XGBoost challengers, daily evaluation and the portal "Prognosequalität" view - see its sections), the **`services/market-data`** ENTSO-E day-ahead price adapter, the Node-RED **edge** (SunSpec Modbus simulator), and the **`services/optimization`** battery-dispatch engine (MILP over prices + forecasts -> retained MQTT schedule + portal Fahrplan view; see its section). The remaining service (marketing-adapter) is still a thin skeleton - see the service map and "Status" per service README.

MVP data path (architecture section 4/7): `Node-RED edge -> EMQX (MQTT) -> Ingest -> Redpanda (telemetry.raw) -> TimescaleDB-Writer -> TimescaleDB`. This path is **built** (see "Live ingest pipe" below); it runs under the compose `edge` profile. A plain backbone `up` still leaves the portal reading only **dev-seeded** demo telemetry.


# AGENTS.md - Voltpilot-EMS project knowledge

Durable, project-intrinsic knowledge for anyone (human or agent) working in this repo.
The product architecture is in [`docs/architecture.md`](docs/architecture.md); this file is the operational "how it's built and run" reference.

## What this is

Self-hosted multi-tenant EMS (PV / battery / load management), DACH market. Monorepo.
On top of the runnable local backbone and binding contracts, several increments now add real functionality: the **portal + authentication spine** (the Spring Boot `api` runs in compose, validates Keycloak JWTs, and serves tenant-scoped sites/devices/telemetry plus device-claiming, enforced end-to-end by Postgres Row-Level-Security; the React portal has real OIDC login and a telemetry view), the **live ingest pipe** (`services/ingest` + `services/timescale-writer`, wired into the `edge` compose profile - real edge telemetry now flows MQTT -> Redpanda -> TimescaleDB and surfaces in the portal), the baseline **`services/forecast`** (load/PV, no ML), the **`services/market-data`** ENTSO-E day-ahead price adapter, and the Node-RED **edge** (SunSpec Modbus simulator). The remaining services (optimization, marketing-adapter) are still thin skeletons - see the service map and "Status" per service README.

MVP data path (architecture section 4/7): `Node-RED edge -> EMQX (MQTT) -> Ingest -> Redpanda (telemetry.raw) -> TimescaleDB-Writer -> TimescaleDB`. This path is **built** (see "Live ingest pipe" below); it runs under the compose `edge` profile. A plain backbone `up` still leaves the portal reading only **dev-seeded** demo telemetry.

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
- `compose` now starts **`api`** alongside the backbone (built from `services/api`, healthy once Keycloak + TimescaleDB are up). The Python services are still NOT started (backbone-first); each has a `Dockerfile` for later.
- The edge (`edge/*`) **and the live ingest pipe (`ingest` + `writer`)** are guarded behind the `edge` profile, so the default `docker compose up -d` stays backbone-only. `docker compose --profile edge up -d --build` brings up the whole live path (edge -> EMQX -> ingest -> Redpanda -> writer -> TimescaleDB); see "Live ingest pipe" below. Services reach EMQX at `emqx:1883`, Redpanda at `redpanda:29092`, TimescaleDB at `timescaledb:5432` and the simulator at `edge-sim:502` over the compose network.
- `.env` holds **dev-only** secrets, clearly marked. Never reuse them outside local dev.
- Data persists in named volumes `timescale-data`, `emqx-data`, `redpanda-data`.
- Redpanda advertises two listeners: `redpanda:29092` (in-cluster) and `localhost:9092` (host). Services inside compose must use the internal one.
- Keycloak realm `voltpilot` is imported on start from `infra/local/keycloak/` with clients `voltpilot-api` (confidential; its service account holds `realm-management` roles for the admin API) and `voltpilot-frontend` (public/PKCE, `tenant_id` mapper), plus dev users (see the auth + admin sections): `admin`/`admin` (Portal-Admin, `platform-admin`), `demo`/`demo` (tenant A) and `demo2`/`demo2` (tenant B).
- TimescaleDB is bootstrapped once from `infra/local/timescale/*.sql`, applied in filename order (`01-init.sql`: extension + example `telemetry` hypertable + tenant/site/device/asset + a deterministic dev seed; `02-day-ahead-prices.sql`: the market-data hypertable; `02-forecast.sql`: the `forecast` hypertable) so the backbone works without the app services. The **core schema is owned by Flyway migrations in `services/api`** (`db/migration`), which run on api start and are idempotent, so they layer cleanly over that bootstrap and own a fresh DB outright; the `forecast` and `market-data` services ship their own migrations (see their sections for version coordination).
- **The full stack has been verified end-to-end from a clean bring-up** (`docker compose --profile edge up -d --build`): all five merged increments co-run, the api's Flyway `V1/V2/V100` apply cleanly over the init-script bootstrap, all three hypertables (`telemetry`/`forecast`/`day_ahead_prices`) exist, OIDC auth + RLS isolation + the telemetry API + the React portal login/telemetry view all work, and the edge publishes contract-conformant telemetry to EMQX. See the README "Run the full stack locally" section for the exact commands + verification. Two footguns worth knowing: (1) the `infra/local/timescale/*.sql` init scripts only run on a **fresh** data volume, so after pulling newly-merged increments you must `down -v` (or the new `forecast`/`day_ahead_prices` tables silently stay absent on an already-initialized volume); (2) host-port collisions on `8090`/`5432`/etc. are resolved by overriding the port in the git-ignored `.env` (e.g. `API_PORT`, and matching `VITE_API_BASE`), not by editing compose.

## Portal API: auth, tenancy & RLS (services/api)

The user-facing spine. See `services/api/README.md` for the endpoint list.

**Auth (Keycloak OIDC).** The api is an OAuth2 resource server validating realm `voltpilot` JWTs. The frontend logs in via the public `voltpilot-frontend` client (Authorization Code + PKCE); every token carries a `tenant_id` claim (a Keycloak user attribute, mapped on both clients).

- **Issuer/JWKS split (the "issuer trap" fix).** `KC_HOSTNAME=http://localhost:8081` pins Keycloak's public URL, so browser- and script-minted tokens all carry `iss=http://localhost:8081/realms/voltpilot`. The api validates that issuer (`OIDC_ISSUER_URI`) but fetches signing keys from the compose-internal `OIDC_JWK_SET_URI=http://keycloak:8080/.../certs` - so it never needs to resolve `localhost:8081`. Spring's resource server accepts both `issuer-uri` + `jwk-set-uri` set together: keys from the latter, `iss` checked against the former.
- OIDC is off by default (`VOLTPILOT_SECURITY_OIDC_ENABLED=false`) for offline unit tests; compose sets it `true`. CORS origins via `VOLTPILOT_CORS_ALLOWED_ORIGINS` (default `http://localhost:5173`).

**Multi-tenancy via Postgres RLS.** `TenantFilter` reads `tenant_id` from the JWT into a request-scoped `TenantContext`; `TenantAwareDataSource` stamps it onto each borrowed connection via `set_config('app.tenant_id', ...)` and RESETs on return to the pool. RLS policies (migration `V2`) scope every table (`tenant`/`site`/`device`/`asset`/`telemetry`) with `tenant_id = current_setting('app.tenant_id')`. No tenant set => **default-deny** (zero rows).

- **Two DB roles, on purpose.** The compose `POSTGRES_USER` (`voltpilot`) is a Postgres **superuser**, and superusers BYPASS RLS. So the api connects at runtime as a dedicated **`voltpilot_app`** role (NOSUPERUSER/NOBYPASSRLS, created by Flyway `V1` with a placeholder password from `APP_DB_PASSWORD`) for which RLS is enforced. **Flyway** runs as the superuser (`spring.flyway.user`) to own the schema, create the role/policies, and seed both tenants (bypassing RLS). Tables are also `FORCE ROW LEVEL SECURITY` so even the owner is scoped.

**Migrations (Flyway).** In `services/api/src/main/resources/db/`: `migration/` = prod-safe core (`V1` idempotent schema + app role, `V2` RLS, `V4` cross-tenant admin role - see the admin section; **V3 is skipped**, reserved by `services/forecast`); `dev/` = the DEV-ONLY seed (`V100`, two tenants + demo telemetry), added to `spring.flyway.locations` only under the `local` profile (compose sets `SPRING_PROFILES_ACTIVE=local`; tests activate it too). `baseline-on-migrate` + `baseline-version=0` let the idempotent `V1` run over the compose bootstrap DB.

**Seeded dev users (dev-only):**

| Keycloak user | Password | Role | tenant_id | Sees |
|---|---|---|---|---|
| `admin` | `admin` | `platform-admin` (Portal-Admin) | *none* | Admin console: all tenants + users |
| `demo`  | `demo`  | `operator` (Portal-User) | `00000000-…-0001` | Demo Site Berlin / `demo-inverter-01` |
| `demo2` | `demo2` | `operator` (Portal-User) | `10000000-…-0001` | Nordwind Hamburg / `nordwind-inverter-01` |

**Device claiming** (`POST /api/v1/devices/claim`) is one insert into the caller's tenant. `external_ref` is **globally unique**, so claiming a device already owned by another tenant (which RLS hides) fails the unique constraint -> HTTP 409; a site outside the tenant -> 404.

**Tests** (`./mvnw test`, auto-skip without Docker via `disabledWithoutDocker`): `TenantFilterTest` + `KeycloakRealmRoleConverterTest` (unit, always run); `RlsIsolationTest` (Testcontainers TimescaleDB, JDBC-level RLS proof); `PortalApiTest` (Testcontainers TimescaleDB + Keycloak, full OIDC + tenant-isolation + claim e2e); `AdminApiTest` (same stack - admin creates tenant + customer user, the new customer logs in tenant-scoped, a Portal-User gets 403 on admin routes). Note: Docker 25+ enforces API >= 1.40, so surefire pins `-Dapi.version` (property `docker.api.version`, default 1.44) for the Testcontainers docker-java client.

## Admin API & the Portal-Admin / Portal-User split (services/api + frontend)

Two distinct kinds of principal, separated in the **backend** (the UI only picks a surface):

- **Portal-Admin = platform operator.** Keycloak realm role **`platform-admin`**. **Not** tenant-scoped (carries **no** `tenant_id`). Manages tenants and customer users across the whole platform. Seeded login `admin`/`admin`.
- **Portal-User = customer.** Realm role **`operator`**, scoped to exactly one tenant via the `tenant_id` claim + RLS (the `demo`/`demo2` users). Unchanged from before.

**Role -> authority mapping.** `KeycloakRealmRoleConverter` maps the token's `realm_access.roles` onto `ROLE_*` authorities, wired into the `secured` chain via `jwtAuthenticationConverter`. `@EnableMethodSecurity` + `@PreAuthorize("hasRole('platform-admin')")` on `AdminController` is what makes a customer token get **403** on every `/api/v1/admin/**` route. This converter is the ONLY thing that turns a token into an authority; it is orthogonal to tenant scoping (still `TenantFilter` + RLS).

**Admin endpoints** (`AdminController`, all Portal-Admin-only): `GET/POST /api/v1/admin/tenants`; `GET/POST /api/v1/admin/tenants/{tenantId}/users`; `POST /api/v1/admin/tenants/{tenantId}/users/{userId}/disable`. Kept in `docs/contracts/openapi.yaml` (tag `admin`).

**Cross-tenant without weakening RLS.** Admin reads/writes span all tenants, but the customer-facing RLS must NOT be loosened. So there are **two DB roles / two datasources**: customer endpoints keep the `@Primary` tenant-aware `voltpilot_app` datasource (NOBYPASSRLS, RLS enforced); the admin repository (`TenantRepository`) uses a **separate** `adminJdbcTemplate` bound to the dedicated **`voltpilot_admin`** role (**BYPASSRLS**, created by Flyway **`V4`**, granted table privileges since BYPASSRLS skips policies not grants). The two never mix. Note: defining `adminJdbcTemplate` backs off Boot's auto `JdbcTemplate`, so `DataSourceConfig` declares an explicit **`@Primary` `jdbcTemplate`** on the tenant-aware datasource - customer repos must get that one.

**User provisioning via Keycloak Admin REST API.** `KeycloakAdminClient` authenticates as the **`voltpilot-api` service account** (`client_credentials`) which is granted `realm-management` roles (`manage-users`/`view-users`/`query-users`/`view-realm`) in the realm import; it creates the user with the `tenant_id` attribute + `operator` role (so the existing OIDC+RLS spine isolates them exactly like the seeded tenants), then sets the password. `base-url` is the compose-internal Keycloak (`KEYCLOAK_ADMIN_BASE_URL`, default `http://keycloak:8080`), decoupled from the browser-facing issuer like the JWKS split; secret via `KEYCLOAK_API_CLIENT_SECRET` (env only). **Keycloak-26 footgun:** the realm import declares a **declarative user profile** (in `voltpilot-realm.json` `components`) with `tenant_id` declared + `unmanagedAttributePolicy: ADMIN_EDIT` and firstName/lastName **optional** - without it, the Admin API silently drops the unmanaged `tenant_id` and password-grant login fails with "Account is not fully set up".

**Frontend.** `frontend/portal/src/auth.ts` exposes `isPlatformAdmin()` (reads `realm_access.roles`); `App.tsx` branches to `src/admin/AdminApp.tsx` (admin console: create/list tenants, create/list/disable customer users, built on the design system) for Portal-Admins and the existing `Portal` for customers. The admin surface is self-contained under `src/admin/` (keeps the customer portal free to evolve separately). Admin calls go through `src/admin/adminApi.ts` reusing `api.ts`'s exported `request`.

## Live ingest pipe (`services/ingest` + `services/timescale-writer`)

The MVP core data loop: real edge telemetry flows `Node-RED edge -> EMQX (MQTT) -> ingest -> Redpanda (telemetry.raw) -> timescale-writer -> TimescaleDB telemetry hypertable`, and the portal's telemetry view shows it live for the `demo` user. Both services are stateless Spring Boot apps in the compose **`edge` profile** (so `docker compose --profile edge up -d --build` runs the whole live path; a plain backbone `up` does not, leaving the portal on dev-seed only).

**Ingest (`services/ingest`, container port 8091).** A Spring Integration Paho adapter subscribes to `ems/+/+/+/telemetry` at **QoS1**. Each message is validated/normalized (`TelemetryValidator`) against `docs/contracts/mqtt-telemetry.schema.json`: `schema_version == "1.0"`, tenant/site/device are UUIDs, `ts` is RFC-3339, `measurements` is an object, **and the topic identity must equal the payload identity** (a device may not publish under another's topic). Valid messages become a `telemetry.raw` event (`docs/contracts/telemetry-raw.event.schema.json`: adds `event_id` + `ingested_at` + `source_topic`, carries `measurements` through unchanged) produced to Redpanda **keyed by `{tenant_id}:{site_id}`** so a site's samples share a partition and stay ordered. Malformed messages are **logged and skipped** (never crash the stream); the QoS1 delivery is already acked and Redpanda is the durable log.

**Writer (`services/timescale-writer`, container port 8092).** A `@KafkaListener` consumes `telemetry.raw` and inserts one row into `telemetry`, mapping `measurements.{power_kw,soc_pct,pv_power_kw,load_kw,grid_limit_kw}` to columns plus the full event JSON into `payload`, with `time=observed_at` and the event's `tenant_id`/`site_id`/`device_id`.
- **Tenant handling (RLS).** The writer connects as the **non-privileged `voltpilot_app`** role - the same role the portal reads with - and, per event, opens a transaction that runs `set_config('app.tenant_id', <event tenant>, true)` before the INSERT. The RLS `WITH CHECK` (api migration V2) then both permits the write and **guarantees the row's `tenant_id` equals the session tenant** - a mismatched tenant can never be written, and the row lands exactly where that tenant's portal read (also RLS-scoped) finds it. (This is why `writer` `depends_on` `api`: api's Flyway owns the schema, the RLS policies and the `voltpilot_app` role.)
- **Idempotency / at-least-once.** Insert is a guarded `INSERT ... WHERE NOT EXISTS` on `(device_id, time)`, so a Kafka redelivery is a no-op. Offsets commit only after the listener returns (`ack-mode: record`, auto-commit off); a transient DB failure re-throws so Kafka redelivers - safe because the insert is idempotent. Per-site partition ordering means redeliveries are sequential, not concurrent.

**Closing the loop for `demo`.** No seed/ID change was needed: the edge's default identity (`VP_TENANT_ID/SITE_ID/DEVICE_ID` = `…0001/…0002/…0003`) already matches Tenant A / Demo Site Berlin / `demo-inverter-01`, which is exactly what the `demo` login surfaces. Live rows therefore appear in the demo telemetry view alongside (newer than) the dev seed.

**Tests (Testcontainers, `disabledWithoutDocker`, `docker.api.version` pinned like api).** `services/ingest`: `TelemetryValidatorTest` (unit, always runs - mapping + every rejection case) and `IngestPipeTest` (real EMQX + Redpanda: publish an edge-shaped MQTT message, assert the contract-shaped `telemetry.raw` event with the right key/fields). `services/timescale-writer`: `WriterPipeTest` (real Redpanda + TimescaleDB: produce a `telemetry.raw` event, assert exactly one hypertable row with the right identity/measurements, **idempotency** on duplicate delivery, and **RLS scoping** - visible to the owning tenant, hidden from another). The two pipe tests meet at the frozen `telemetry.raw` contract and together cover MQTT -> Redpanda -> Timescale. They use throwaway containers on random ports and never touch the shared dev stack.

## Secure MQTT broker (real remote-device onboarding, mTLS)

The path for a physical Node-RED edge to reach a **self-hosted** broker over the internet and publish contract telemetry. Full model in [`docs/security-mqtt.md`](docs/security-mqtt.md); device-facing guide in [`docs/connect-a-device.md`](docs/connect-a-device.md). The dev experience is **unchanged** - the hardened broker lives in the production compose (`docker-compose.prod.yml`), not the dev `docker-compose.yml`, so the base EMQX block is untouched.

- **Two listeners.** Plaintext `1883` stays for local dev + the internal ingest consumer. A hardened **mTLS `8883`** listener (`verify_peer` + `fail_if_no_peer_cert`) is defined by the production compose `docker-compose.prod.yml` (server cert + device CA mounted from `infra/mqtt/certs/`, git-ignored). Devices make an **outbound-only** connection (architecture §6 - no inbound edge ports).
- **Identity binding.** Device cert subject `O={tenant_id}, OU={site_id}, CN={device_id}` (+ SPIFFE SAN). CN carries `device_id` (UUID fits the 64-char CN limit; the full `tenant/site/device` path does **not**, which is why it is NOT crammed into one CN). The listener sets `peer_cert_as_username=cn` / `peer_cert_as_clientid=cn`, so a device can't spoof its identity.
- **Per-tenant/-device ACL** in `infra/mqtt/acl.conf` (EMQX file authorizer, first-match): internal `vp-internal` user gets full `ems/#` (ingest); each device gets a **generated grant** allowing only its own `ems/{t}/{s}/{d}/telemetry|status` (up) and `…/schedule|command|config` (down); any UUID username without a grant is **default-denied everything** (that is how revocation works). Cross-tenant publish is denied.
- **CA + issuance tool** `tools/pki/voltpilot-ca.sh` (openssl, `openssl.cnf`): `init-ca` (CA once + broker server cert), `issue --tenant --site --device` (client cert + ACL grant), `revoke --device` (CRL + grant removal), `gen-crl`, `list`. Keys land in `tools/pki/out/` (git-ignored) - **never committed**.
- **Provisioning** `tools/pki/provision-device.sh` ties it together: calls the portal `POST /api/v1/devices/claim` (reusing device-claiming, tenant from the JWT `tenant_id` claim), then issues the cert bound to the returned `device_id`, and prints connection params.
- **Run it:** `docker compose -f docker-compose.prod.yml up -d` (the standalone production stack, which includes the hardened broker) after `init-ca` + staging `infra/mqtt/certs/`. Only `8883` is public (1883/dashboard → loopback); firewall is the real guarantee (hardening checklist in `docs/security-mqtt.md`). Full deploy flow: `docs/deploy.md`.
- **Verify (Docker-free):** `python3 tools/pki/verify_mqtt_security.py` - runs a real mutual-TLS handshake (valid cert connects, no/untrusted cert rejected, revoked cert fails CRL) and evaluates the real `acl.conf` with EMQX first-match semantics (own-path allow, cross-tenant deny, down-only enforcement, internal allow). This sandbox blocks Docker, so the live EMQX-on-18883 + mosquitto recipe is documented (not executed) in `docs/security-mqtt.md`.

## Standalone edge simulator (`tools/edge-simulator`)

An **installable-anywhere** simulated edge device: a single dependency-light Python program (only `paho-mqtt`) that publishes a believable PV/battery/load day to any VoltPilot broker, so a "device" on another LAN host writes into the captain's stack and shows up in the portal. It is **separate from** the Node-RED `edge/` (which models SunSpec/Modbus hardware) - do not conflate them. Full docs in `tools/edge-simulator/README.md`.

- **Contract-exact.** Publishes to `ems/{tenant_id}/{site_id}/{device_id}/telemetry` at QoS1 (+ `.../status` heartbeat), payload verbatim per `docs/contracts/mqtt-telemetry.schema.json` (`schema_version "1.0"`; note the field is **`ts`**, not `timestamp`). Feeds the existing ingest pipe unchanged. Identity defaults mirror the `demo` dev seed (`…0001/…0002/…0003`), so a no-arg local run lands in the demo telemetry view.
- **Config** via CLI > env (`EDGE_SIM_*`, also honors `VP_TENANT_ID/SITE_ID/DEVICE_ID`) > optional `.env`. Plain `1883` and **mTLS `8883`** (device certs from `tools/pki/provision-device.sh`; TLS auto-enables on 8883 or when a client cert is set). No SNI-override flag - `init-ca --domain --ip` puts both in the server cert SAN so dialing either verifies; `--insecure` is the dev escape hatch.
- **Simulation.** Diurnal PV (zero at night, noon peak), household load profile, battery charge-midday/discharge-evening (SoC clamped 10-100%), `power_kw = load - pv + battery` (signed +import/-export), mild noise (seedable). `--time-scale N` replays a full day fast (e.g. 288 → a day in 5 min); `--time-scale 1` tracks the real clock. `--count N` exits after N messages.
- **Packaging.** `requirements.txt`, `Dockerfile` (multi-arch, non-root), example `voltpilot-edge-sim.service` systemd unit for a Pi, and an **opt-in compose service `edge-simulator`** under its **own `sim` profile** (NOT `edge`, so it never double-publishes with `edge-nodered`): `docker compose --profile sim up -d --build edge-simulator`.
- **Tests/proof.** `python3 -m pytest tools/edge-simulator/test_edge_sim.py -q` (or `python3 test_edge_sim.py`) runs fully offline - validates generated payloads against the **real** schema, the power-balance identity, PV day/night, battery cycle, SoC bounds, topic format, config precedence. Live proof: `tools/edge-simulator/proof/publish_and_verify.sh` publishes N and shows rows land in TimescaleDB (needs the `edge`-profile ingest path up). The real paho wire path (CONNECT + QoS1 PUBLISH/PUBACK) was verified against an in-process broker stub since this sandbox blocks Docker.
## Production deployment (single VPS, "deploy like saalo")

MVP-on-one-VPS: external Caddy terminates TLS, the whole server-side stack runs from **`docker-compose.prod.yml`** (a self-contained, standalone file - NOT merged with the dev `docker-compose.yml`), and Forgejo does push-to-deploy. Full guide in [`docs/deploy.md`](docs/deploy.md); the recipe mirrors the saalo repo's proven pattern.

- **Two public ports only.** `frontend` on `APP_PORT` (plain HTTP, firewalled so only the Caddy host reaches it) and EMQX `8883` (mTLS, for devices). Everything else (api/keycloak/keycloak-db/timescaledb/redpanda/ingest/writer/collectors) is internal on the `voltpilot-prod` network; `1883`/`18083` are loopback-only. **The frontend's nginx is the single web entry point** (`frontend/portal/nginx.conf`): serves the SPA and reverse-proxies `/api/ -> api:8090` and `/auth/ -> keycloak:8080`, so the API and Keycloak stay internal. TLS terminates on the external Caddy which must forward `https://${DOMAIN} -> http://VPS:${APP_PORT}` with `X-Forwarded-Proto: https`.
- **Keycloak in prod mode.** `start --import-realm` against a **dedicated** `keycloak-db` (isolated from TimescaleDB, mirrors saalo). Served under the `/auth` relative path (`KC_HTTP_RELATIVE_PATH`, `KC_HOSTNAME=https://${DOMAIN}/auth`, `KC_PROXY_HEADERS=xforwarded`). Prod realm `infra/prod/keycloak/voltpilot-realm.json` parametrizes the browser origin + confidential secret via `${env.VP_PUBLIC_ORIGIN}` / `${env.VP_API_CLIENT_SECRET}` (Keycloak's realm-import placeholder replacement reads env vars with the `env.` prefix; both are set on the keycloak service). So the api's issuer is `https://${DOMAIN}/auth/realms/voltpilot` while JWKS is fetched internally at `http://keycloak:8080/auth/realms/voltpilot/...certs` (the same issuer-trap split as dev).
- **Images pulled, not built, on the VPS.** All six deployed images (`api`, `ingest`, `timescale-writer`, `frontend`, `market-data`, `forecast`) come from `git.tecmaxx.de/mamotec/voltpilot-ems/<svc>:${IMAGE_TAG}`; the deploy pins `IMAGE_TAG` to the commit SHA. Each has a prod Dockerfile; the **frontend** Dockerfile grew an nginx.conf + `VITE_*` build args (`VITE_API_BASE` empty => same-origin `/api`; `VITE_KEYCLOAK_URL=https://${DOMAIN}/auth`).
- **Collectors.** `market-data` (real `fetch --persist` on a daily loop, writes `day_ahead_prices` over the superuser conn) and `forecast` (currently the offline baseline demo on a loop - DB-persist via `TimescaleForecastRepository` is wired but not yet CLI-exposed). Their two non-RLS hypertables are created by the prod init script `infra/prod/timescale/00-collector-tables.sql` (mirrors the service migrations; runs on a fresh volume before the api's Flyway owns the core schema). Edge/Node-RED + the SunSpec sim are NOT in prod (they run on-device).
- **CI/CD** in `.forgejo/workflows/`: `deploy.yaml` (gated: test matrix over all services -> build+push all images -> SSH/SCP roll-out to `/srv/docker/voltpilot`, `docker compose pull && up -d --remove-orphans`) and `deploy-fast.yaml` (skips the test gate). Placeholder Forgejo Actions secrets to set later: `FORGEJO_USERNAME/PASSWORD`, `DEPLOY_HOST/USER/PASSWORD`, `DOMAIN`. No browser smoke suite yet, so that gate is deferred (the Testcontainers tests already cover ingest/RLS/OIDC).
- **Secrets** template: [`.env.prod.example`](.env.prod.example) (copied to `/srv/docker/voltpilot/.env`; `${VAR:?}` aborts the deploy if blank). Every required secret has an `openssl rand` hint. The device mTLS certs are staged on the VPS out of band (never in the repo/images); `SPRING_PROFILES_ACTIVE=local` seeds the demo tenants for a first look - blank it (and drop the demo realm users) for a real launch.
- **Host/domain are placeholders** throughout (captain fills `DOMAIN`, the VPS host, and the secrets later). Nothing here needs live infra to validate: `docker compose -f docker-compose.prod.yml config` and the workflow YAML both parse.

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

Dependency resolution uses **Maven Central** (matching the committed wrapper `distributionUrl`). On a clean machine `./mvnw test` just works. If your `~/.m2/settings.xml` pins a corporate mirror (`<mirrorOf>*</mirrorOf>`) that a sandbox/CI can't reach, build with a Central-only settings override: `./mvnw -s .mvn-central-settings.xml test` (that helper file is git-ignored, create it locally with a single `central-direct` mirror at `https://repo.maven.apache.org/maven2`).

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

Real optimization MILP; forecasting ML (XGBoost/LightGBM load model, ML PV correction, real weather API); direct-marketing provider integrations; portal schedules/KPIs endpoints; live telemetry channel (WS/SSE - the portal still polls REST); real Modbus/SunSpec hardware I/O (only the simulator exists today); Cloud/K8s/Hetzner manifests + GitOps; Prometheus/Grafana/Loki/OTel; Mender OTA. The **live ingest pipe now works** (EMQX -> ingest -> Redpanda -> writer -> TimescaleDB; see its section) - remaining hardening there: a real hypertable unique index on `(device_id, time)` to back the idempotent write with a DB constraint (today it is a guarded `WHERE NOT EXISTS`; a unique index would need to be added by the api Flyway schema owner), a malformed-message dead-letter topic (today is log+skip), and MQTT mTLS/authn on the EMQX ingress. Core-schema Flyway migrations run in `services/api` (RLS enforced), and `services/market-data` (`day_ahead_prices`) and `services/forecast` (`forecast` hypertable, V3) ship their own migrations; a unified migration-version scheme across services is still to be reconciled.

# services/api - Portal Backend / API

**Language:** Java 21 / Spring Boot 3.3
**State:** stateless
**Responsibility (architecture section 8):** REST/WS, Tenancy, Business-Logik.

Serves the portal REST API (OpenAPI, see [`docs/contracts/openapi.yaml`](../../docs/contracts/openapi.yaml)).
Multi-tenancy comes from the Keycloak `tenant_id` token claim; a request-scoped layer sets the Postgres RLS tenant context (`app.tenant_id`) on the connection so every query is transparently scoped to the caller's tenant. Full design and rationale are in the repo `AGENTS.md` ("Portal API: auth, tenancy & RLS").

## Endpoints (`/api/v1`, Bearer JWT required unless noted)

| Method | Path | Purpose |
|---|---|---|
| POST | `/registration` | **Public** (no token) self-registration: creates a tenant + its Keycloak login in one step (rate-limited, toggle `VOLTPILOT_REGISTRATION_ENABLED`) |
| GET | `/sites` | List the caller's sites |
| POST | `/sites` | Create a site for the caller's tenant (name, bidding zone, optional lat/lon) |
| GET | `/devices` | List the caller's devices (incl. `lastSeenAt` for the portal's live status) |
| POST | `/devices/claim` | Claim an edge device into a site (canonicalizes sticker `VP-` IDs; idempotent re-claim in the own tenant -> 200; 409 if claimed by another tenant, 404 if site not in tenant, 422 if the sticker ID is not in the provisioned-device registry) |
| GET | `/sites/{siteId}/telemetry?from&to` | Recent telemetry for a site (defaults to last 24h) |
| GET | `/sites/{siteId}/prices?from&to` | Day-ahead spot prices (15-min) for the site's bidding zone; defaults to ~today+tomorrow |
| GET | `/sites/{siteId}/weather` | Latest weather forecast (hourly, coming days) for the site |
| GET | `/sites/{siteId}/assets` | The site's asset master data incl. MaStR provenance |
| POST | `/sites/{siteId}/mastr-lookup` | Fetch one MaStR unit for confirmation (preview only; German error messages) |
| POST | `/sites/{siteId}/mastr-apply` | Persist confirmed registry values onto the site's PV/battery assets |
| GET | `/sites/{siteId}/schedule` | Latest optimizer battery-dispatch plan + projected savings |
| GET | `/sites/{siteId}/history?range&at` | History rollups (day/week/month/year), totals + Tagesprotokoll |

Platform-admin-only (`/api/v1/admin/**`, realm role `platform-admin`): tenants, per-tenant sites/users (incl. user `disable` and the support `reset-password`, which also lifts a brute-force lockout), and the `provisioned-devices` manufacturing registry gating sticker claims. See the repo `AGENTS.md` admin section.

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8090 (needs a Postgres + Keycloak; usually run via docker compose)
./mvnw test                  # unit test always; Testcontainers RLS + OIDC tests when Docker is available
./mvnw clean package         # build the jar
```

- Health: `GET /health` (Spring Boot Actuator, mapped to root).
- OIDC is off by default for offline unit tests. docker compose sets `VOLTPILOT_SECURITY_OIDC_ENABLED=true`, the issuer/JWKS URIs, and the DB roles.
- **DB roles:** runtime connects as the non-privileged `voltpilot_app` role (so RLS applies); Flyway migrates as the `voltpilot` superuser. Never run the app datasource as the superuser.

## Status

Implemented: OIDC resource-server, RLS tenant isolation (Flyway `db/migration` V1/V2/V4 + the date-versioned site-geo/data-feeds, battery-efficiency, history-rollup and provisioned-device migrations + dev seeds `db/dev` V100/V20260702020100), public **self-registration** (tenant + Keycloak login in one request, sliding-window rate-limited), site creation, sites/devices/telemetry reads, **device claiming** (canonicalized, idempotent per tenant, sticker IDs gated by the provisioned-device registry), the **admin API** (tenants, per-tenant sites/users incl. disable + support password-reset, provisioned devices), the **MaStR integration** (lookup/apply/assets, see the repo `AGENTS.md`), and the KEYLESS **day-ahead price** + **weather** reads plus the **schedule** and **history** reads (fed by the compose `feeds`/`optimize` profiles).
KPIs (see OpenAPI) remain a stub.
Live telemetry arrives via the separate ingest pipe (compose `edge` profile); without it the portal reads dev-seeded demo telemetry.

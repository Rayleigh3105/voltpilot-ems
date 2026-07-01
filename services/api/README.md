# services/api - Portal Backend / API

**Language:** Java 21 / Spring Boot 3.3
**State:** stateless
**Responsibility (architecture section 8):** REST/WS, Tenancy, Business-Logik.

Serves the portal REST API (OpenAPI, see [`docs/contracts/openapi.yaml`](../../docs/contracts/openapi.yaml)).
Multi-tenancy comes from the Keycloak `tenant_id` token claim; a request-scoped layer sets the Postgres RLS tenant context (`app.tenant_id`) on the connection so every query is transparently scoped to the caller's tenant. Full design and rationale are in the repo `AGENTS.md` ("Portal API: auth, tenancy & RLS").

## Endpoints (`/api/v1`, Bearer JWT required)

| Method | Path | Purpose |
|---|---|---|
| GET | `/sites` | List the caller's sites |
| GET | `/devices` | List the caller's devices |
| POST | `/devices/claim` | Claim an edge device into a site (409 if already claimed, 404 if site not in tenant) |
| GET | `/sites/{siteId}/telemetry?from&to` | Recent telemetry for a site (defaults to last 24h) |

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

Implemented: OIDC resource-server, RLS tenant isolation (Flyway `db/migration` V1/V2 + dev seed `db/dev` V100), sites/devices/telemetry reads, device claiming. Schedules and KPIs (see OpenAPI) remain stubs. Real telemetry ingest is a separate increment; the portal reads dev-seeded demo telemetry.

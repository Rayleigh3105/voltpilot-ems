# services/api - Portal Backend / API

**Language:** Java 21 / Spring Boot 3.3
**State:** stateless
**Responsibility (architecture section 8):** REST/WS, Tenancy, Business-Logik.

Serves the portal REST API (OpenAPI, see [`docs/contracts/openapi.yaml`](../../docs/contracts/openapi.yaml)) and WebSocket/SSE.
Multi-tenancy comes from the Keycloak `tenant_id` token claim; a central layer will set the Postgres RLS tenant context (`SET app.tenant_id`).

## Run / build / test

```bash
./mvnw spring-boot:run       # http://localhost:8090
./mvnw test                  # unit/context tests
./mvnw clean package         # build the jar
```

- Health: `GET /health` (Spring Boot Actuator, mapped to root).
- OIDC is off by default for offline dev/test. Set `VOLTPILOT_SECURITY_OIDC_ENABLED=true` and `OIDC_ISSUER_URI` (docker compose does) to enforce Bearer JWT validation.

## Status

MVP skeleton. Endpoints under `/api/v1/**` are stubs against the OpenAPI contract; the repository/RLS layer and TimescaleDB access are future work.

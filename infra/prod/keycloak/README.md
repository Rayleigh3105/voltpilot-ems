# Production Keycloak realm import

`voltpilot-realm.json` is the PRODUCTION realm import for the single-VM/VPS deploy (`docker-compose.prod.yml`).
It mirrors the dev realm (`infra/local/keycloak/voltpilot-realm.json`) but parametrizes everything host-specific or secret, so nothing is baked in.

Documentation lives here instead of a `_comment` field in the JSON: Keycloak 26 in production mode (`start --import-realm`) strict-parses the realm representation and ABORTS the boot on any unknown field (`Unrecognized field "_comment"`).

Key points:

- Keycloak substitutes the `${VAR}` / `${VAR:default}` placeholders from the container environment at import time.
  `VP_PUBLIC_ORIGIN` (redirect URIs / web origins), `VP_API_CLIENT_SECRET` (confidential client) and `VP_PORTAL_ADMIN_PASSWORD` (seeded Portal-Admin user) are set on the keycloak service in `docker-compose.prod.yml`.
  NOTE: the Wildfly-era `${env.VAR}` prefix syntax is NOT substituted by Keycloak 26 - it reaches client validation literally and aborts the import with "A redirect URI is not a valid URI" (verified against 26.0.5).
- `sslRequired=external`: HTTPS is required for external requests, which the external reverse proxy (Nginx Proxy Manager or Caddy) terminates and signals via `X-Forwarded-Proto` (`KC_PROXY_HEADERS=xforwarded`).
- `loginTheme: voltpilot` selects the branded login theme (`deploy/keycloak/themes/voltpilot`, bind-mounted by the compose).
- `voltpilot-frontend` has `directAccessGrantsEnabled=true` (same as dev): the portal's seamless post-registration auto-login mints tokens via the password grant on this public client.
- `bruteForceProtected` is on (temporary lockout: 10 failures -> 60 s wait escalating to 15 min, never permanent) to bound password guessing at the token endpoint; support lifts a lock via the admin console's "Passwort zurücksetzen" (which also sets a new password).
  Like every realm change, these reach an EXISTING Keycloak volume only after a fresh import.
- The `realm-management` roles on the `voltpilot-api` service account and the declarative user profile (`tenant_id`, `ADMIN_EDIT`) are required for Portal-Admin user provisioning - same as dev.
  Keycloak 26 silently drops unmanaged attributes without the profile ("Account is not fully set up" on login).
- The `admin` (Portal-Admin) and `demo`/`demo2` users are seeded so a fresh deploy is immediately loginable alongside `SPRING_PROFILES_ACTIVE=local`.
  Remove the demo users (and clear the api profile) before a real customer launch - see `docs/deploy.md`.

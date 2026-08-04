# Production Keycloak realm import

`voltpilot-realm.json` is the PRODUCTION realm import for the single-VM/VPS deploy (`docker-compose.prod.yml`).
It mirrors the dev realm (`infra/local/keycloak/voltpilot-realm.json`) but parametrizes everything host-specific or secret, so nothing is baked in.

Documentation lives here instead of a `_comment` field in the JSON: Keycloak 26 in production mode (`start --import-realm`) strict-parses the realm representation and ABORTS the boot on any unknown field (`Unrecognized field "_comment"`).

Key points:

- Keycloak substitutes the `${VAR}` / `${VAR:default}` placeholders from the container environment at import time.
  `VP_PUBLIC_ORIGIN` (redirect URIs / web origins), `VP_API_CLIENT_SECRET` (confidential client) and `VP_PORTAL_ADMIN_PASSWORD` (seeded Portal-Admin user) are set on the keycloak service in `docker-compose.prod.yml`.
  The secret placeholders deliberately carry NO in-file defaults: importing this realm outside the compose path (whose `${VAR:?}` guards enforce real values) with the vars unset leaves the un-substituted literal in place instead of silently seeding a well-known `admin`/`change-me` credential.
  NOTE: the Wildfly-era `${env.VAR}` prefix syntax is NOT substituted by Keycloak 26 - it reaches client validation literally and aborts the import with "A redirect URI is not a valid URI" (verified against 26.0.5).
- `sslRequired=external`: HTTPS is required for external requests, which the external reverse proxy (Nginx Proxy Manager or Caddy) terminates and signals via `X-Forwarded-Proto` (`KC_PROXY_HEADERS=xforwarded`).
- `loginTheme: voltpilot` selects the branded login theme (`deploy/keycloak/themes/voltpilot`, bind-mounted by the compose).
- `voltpilot-frontend` has `directAccessGrantsEnabled=true` (same as dev): the portal's seamless post-registration auto-login mints tokens via the password grant on this public client.
- `bruteForceProtected` is on (temporary lockout: 10 failures -> 60 s wait escalating to 15 min, never permanent) to bound password guessing at the token endpoint; support lifts a lock via the admin console's "Passwort zurücksetzen" (which also sets a new password).
  Like every realm change, these reach an EXISTING Keycloak volume only after a fresh import.
- The `realm-management` roles on the `voltpilot-api` service account and the declarative user profile (`tenant_id`, `ADMIN_EDIT`) are required for Portal-Admin user provisioning - same as dev.
  Keycloak 26 silently drops unmanaged attributes without the profile ("Account is not fully set up" on login).
- **`edge-release-publisher` + the `voltpilot-release-publisher` client ship DISABLED.**
  They are the OTA release automation's account (`git tag edge-*` → signed release → register entry): client-credentials only, no browser flow, no password grant, and the service account carries exactly ONE realm role that reaches exactly two api routes (`GET/POST /api/v1/admin/edge-releases[/next-seq]`) - never a rollout, never a device target.
  `enabled: false` is deliberate and fail-closed: the secret placeholder `${VP_RELEASE_PUBLISHER_SECRET:change-me}` carries an in-file default (unlike the others above) so a deploy that does not use OTA automation never has to set it, and a DISABLED client hands out no token whatever its secret is.
  To switch it on: set `VP_RELEASE_PUBLISHER_SECRET` in `.env`, recreate keycloak, then flip the client to Enabled.
  The EXISTING prod realm was imported long ago, so there this is a one-time manual setup - exact clicks and `kcadm` lines in [`docs/ota-signing.md`](../../../docs/ota-signing.md) §4d.
- The `admin` (Portal-Admin) and `demo`/`demo2` users are seeded so a fresh deploy is immediately loginable alongside `SPRING_PROFILES_ACTIVE=local`.
  Remove the demo users (and clear the api profile) before a real customer launch - see `docs/deploy.md`.

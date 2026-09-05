# Conventions & decisions worth knowing

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 108).


- **Maven over Gradle** for JVM services: `mvn` is available and the wrapper is self-contained; keeps one build tool across the JVM tier. Each service is an independent Maven project (no shared reactor) to preserve clean service boundaries.
- The committed Maven wrapper `distributionUrl` targets **Maven Central**, not any private mirror, so `./mvnw` works on a clean machine.
- `api` OIDC defaults ON (fail-secure); offline unit tests opt out via `VOLTPILOT_SECURITY_OIDC_ENABLED=false`; `timescale-writer` still excludes `DataSourceAutoConfiguration` until the writer is wired.
- One Postgres instance intentionally serves **both** timeseries (hypertables) and master data (architecture section 10).
- **RLS needs a non-superuser connection.** Never point the api's runtime datasource at the `voltpilot` superuser - it would silently bypass RLS. Use `voltpilot_app` (see the auth section). New tenant-owned tables must add an RLS policy in a migration and be granted to `voltpilot_app`.
- Tenant scoping is enforced in the DB, not the queries: repositories carry **no** `tenant_id` predicate. Out-of-tenant rows are invisible, so "not found" is 404, not 403.
- **⚠ `forecast` ist die EINZIGE Kundendaten-Tabelle ohne RLS - und sie kann keins bekommen** (komprimiert seit `V20260809000000`; RLS und Kompression schließen sich in jeder TimescaleDB-Version aus). Ihr Mandanten-Zaun ist deshalb Code-Disziplin: **jede App-Rollen-Query trägt einen site-Join bzw. eine vorab RLS-aufgelöste `site_id`**, direktes DELETE ist der App-Rolle entzogen (`V20260831010000`), und der einzige Löschweg ist die tenant-gebundene SECURITY-DEFINER-Funktion `purge_forecast_for_site` (das `purge_ocpp_action_scope`-Muster; sie löscht nur im Mandanten aus `app.tenant_id`). Wächter: `ForecastTableDisciplineTest` macht jede neue `forecast`-Query ohne Allowlist-Eintrag rot - erst den Zaun bauen, dann allowlisten. Restrisiko dokumentiert: INSERT/UPDATE hält die App-Rolle auf frischen DBs weiter über V2s Default-Privileges (kein App-Pfad schreibt forecast; Entzug ist ein benannter Folge-Kandidat).


-- =============================================================================
-- V4 - Platform-admin database role (cross-tenant, RLS-bypassing).
-- -----------------------------------------------------------------------------
-- Portal-Admins (platform operators) manage tenants and customer users ACROSS
-- the whole platform. The customer-facing datasource connects as the
-- NOBYPASSRLS `voltpilot_app` role (V1) so Row-Level-Security scopes every
-- customer query to one tenant - that must NOT be weakened.
--
-- So the admin API uses a SEPARATE, dedicated login role that BYPASSes RLS, and
-- only the admin repositories borrow it (see DataSourceConfig#adminDataSource).
-- The customer endpoints keep using `voltpilot_app` with RLS fully enforced;
-- the two roles never mix. BYPASSRLS skips row policies but NOT table grants, so
-- this role still needs explicit privileges below.
--
-- V3 is deliberately skipped: it is reserved by services/forecast for the
-- `forecast` hypertable (see AGENTS.md migration-version coordination).
-- Password is a Flyway placeholder so no secret is hard-coded (dev default in
-- application.yml; real value via ADMIN_DB_PASSWORD elsewhere).
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${adminDbUser}') THEN
        CREATE ROLE ${adminDbUser} LOGIN PASSWORD '${adminDbPassword}'
            NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
    ELSE
        -- Keep the password in sync with the configured secret on re-runs.
        ALTER ROLE ${adminDbUser} WITH LOGIN PASSWORD '${adminDbPassword}' BYPASSRLS;
    END IF;
END
$$;

-- BYPASSRLS lets this role see/manage every tenant's rows, but it still needs
-- table-level privileges. Grant them explicitly (schema + the master-data and
-- telemetry tables) so the admin API can create/list tenants and inspect data.
GRANT USAGE ON SCHEMA public TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, site, device, asset, telemetry TO ${adminDbUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${adminDbUser};

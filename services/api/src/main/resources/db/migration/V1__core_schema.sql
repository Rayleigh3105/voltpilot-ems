-- =============================================================================
-- V1 - Core schema (idempotent, prod-safe).
-- -----------------------------------------------------------------------------
-- Owns the master-data tables (tenant/site/device/asset) and the telemetry
-- hypertable. Mirrors infra/local/timescale/01-init.sql so a FRESH database
-- (Testcontainers, staging, prod) gets the full schema from Flyway, while the
-- dev-compose database - already bootstrapped by 01-init.sql - is left intact
-- (every statement is IF NOT EXISTS). Flyway runs as the Postgres superuser
-- (spring.flyway.user); the API connects as the non-privileged app role created
-- below so Row-Level-Security (V2) actually applies to it.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- -----------------------------------------------------------------------------
-- Application login role.
-- The dev-compose POSTGRES_USER (`voltpilot`) is a Postgres SUPERUSER, and
-- superusers BYPASS Row-Level-Security. So the API must connect as a dedicated
-- NOSUPERUSER / NOBYPASSRLS role for RLS to be enforced. Password comes from a
-- Flyway placeholder so no secret is hard-coded (dev default in application.yml,
-- real value via APP_DB_PASSWORD in every other environment).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appDbUser}') THEN
        CREATE ROLE ${appDbUser} LOGIN PASSWORD '${appDbPassword}'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Master data (TENANT -> SITE -> DEVICE / ASSET). tenant_id is carried on every
-- row so a single RLS predicate scopes each table to the caller's tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    segment     TEXT        NOT NULL DEFAULT 'CI'
                    CHECK (segment IN ('CI', 'B2C')),
    plan        TEXT        NOT NULL DEFAULT 'mvp',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    bidding_zone  TEXT        NOT NULL DEFAULT 'DE-LU',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_tenant ON site (tenant_id);

CREATE TABLE IF NOT EXISTS device (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id      UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    external_ref TEXT,
    kind         TEXT        NOT NULL DEFAULT 'inverter',
    status       TEXT        NOT NULL DEFAULT 'unclaimed',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_site ON device (site_id);

-- A device (identified by its edge external_ref) can be claimed by exactly one
-- tenant. Enforcing this GLOBALLY (not per-tenant) is what makes cross-tenant
-- claiming impossible even though RLS hides the other tenant's row: a second
-- claim of the same external_ref hits this constraint and fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_external_ref
    ON device (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    device_id        UUID        REFERENCES device(id) ON DELETE SET NULL,
    type             TEXT        NOT NULL,
    capacity_kwh     NUMERIC(10, 3),
    max_charge_kw    NUMERIC(10, 3),
    max_discharge_kw NUMERIC(10, 3),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_site ON asset (site_id);

-- -----------------------------------------------------------------------------
-- Telemetry hypertable (raw device timeseries). Column set mirrors
-- docs/contracts/mqtt-telemetry.schema.json incl. the observed §14a limit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry (
    time             TIMESTAMPTZ NOT NULL,
    tenant_id        UUID        NOT NULL,
    site_id          UUID        NOT NULL,
    device_id        UUID        NOT NULL,
    power_kw         NUMERIC(12, 4),
    soc_pct          NUMERIC(5, 2),
    pv_power_kw      NUMERIC(12, 4),
    load_kw          NUMERIC(12, 4),
    grid_limit_kw    NUMERIC(12, 4),
    payload          JSONB
);

SELECT create_hypertable('telemetry', 'time',
    chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_time ON telemetry (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_site_time   ON telemetry (site_id, time DESC);

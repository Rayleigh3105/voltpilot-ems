-- =============================================================================
-- Voltpilot-EMS - TimescaleDB init (runs once on first container start)
-- -----------------------------------------------------------------------------
-- Demonstrates the "one Postgres for timeseries + master data" idea from the
-- architecture (section 10): the timescaledb extension, the core stammdaten
-- tables (tenant, site, device, asset) and one example hypertable (telemetry).
--
-- This is a DEV bootstrap. In staging/prod the schema is owned by Flyway/
-- Liquibase migrations in services/api (incl. Timescale hypertable setup).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- -----------------------------------------------------------------------------
-- Master data (relational). Mirrors the section 10 data-model sketch:
--   TENANT -> SITE -> DEVICE / ASSET
-- tenant_id is carried everywhere to enable Postgres Row-Level-Security later.
-- -----------------------------------------------------------------------------

CREATE TABLE tenant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    segment     TEXT        NOT NULL DEFAULT 'CI'  -- 'CI' | 'B2C'
                    CHECK (segment IN ('CI', 'B2C')),
    plan        TEXT        NOT NULL DEFAULT 'mvp',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE site (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    bidding_zone  TEXT        NOT NULL DEFAULT 'DE-LU',  -- ENTSO-E Gebotszone
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_site_tenant ON site (tenant_id);

CREATE TABLE device (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id      UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    external_ref TEXT,                       -- edge/device identifier
    kind         TEXT        NOT NULL DEFAULT 'inverter',
    status       TEXT        NOT NULL DEFAULT 'unclaimed',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_device_site ON device (site_id);

CREATE TABLE asset (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    device_id        UUID        REFERENCES device(id) ON DELETE SET NULL,
    type             TEXT        NOT NULL,   -- 'battery' | 'pv' | 'meter' | 'load'
    capacity_kwh     NUMERIC(10, 3),
    max_charge_kw    NUMERIC(10, 3),
    max_discharge_kw NUMERIC(10, 3),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_site ON asset (site_id);

-- -----------------------------------------------------------------------------
-- Example timeseries hypertable: raw device telemetry.
-- Column set mirrors docs/contracts/mqtt-telemetry.schema.json, including the
-- observed §14a effective power limit (grid_limit_kw).
-- -----------------------------------------------------------------------------

CREATE TABLE telemetry (
    time             TIMESTAMPTZ NOT NULL,
    tenant_id        UUID        NOT NULL,
    site_id          UUID        NOT NULL,
    device_id        UUID        NOT NULL,
    -- Measurements (nullable: not every device reports every field).
    power_kw         NUMERIC(12, 4),   -- instantaneous active power (+ import / - export)
    soc_pct          NUMERIC(5, 2),    -- battery state of charge, 0..100
    pv_power_kw      NUMERIC(12, 4),   -- PV generation
    load_kw          NUMERIC(12, 4),   -- site load
    grid_limit_kw    NUMERIC(12, 4),   -- observed effective §14a power limit
    payload          JSONB             -- full original payload for forward-compat
);

SELECT create_hypertable('telemetry', 'time', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX idx_telemetry_device_time ON telemetry (device_id, time DESC);
CREATE INDEX idx_telemetry_tenant_time ON telemetry (tenant_id, time DESC);

-- -----------------------------------------------------------------------------
-- Minimal dev seed so the portal has something to show. Ids are deterministic
-- to make local testing reproducible.
-- -----------------------------------------------------------------------------
INSERT INTO tenant (id, name, segment)
VALUES ('00000000-0000-0000-0000-000000000001', 'Demo C&I Tenant', 'CI');

INSERT INTO site (id, tenant_id, name, bidding_zone)
VALUES ('00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001', 'Demo Site Berlin', 'DE-LU');

INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status)
VALUES ('00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002', 'demo-inverter-01', 'inverter', 'claimed');

INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw, max_discharge_kw)
VALUES ('00000000-0000-0000-0000-000000000004',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003', 'battery', 100.000, 50.000, 50.000);

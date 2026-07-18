-- Test schema for WriterPipeIT: a minimal, faithful mirror of the telemetry
-- hypertable + Row-Level-Security + app role that services/api owns via Flyway
-- (V1/V2). Runs once as the container superuser, so it can create the role and
-- the RLS policy. The writer then connects as voltpilot_app (RLS enforced),
-- exactly as in compose/prod.

CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltpilot_app') THEN
        CREATE ROLE voltpilot_app LOGIN PASSWORD 'voltpilot_app_test_pw'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

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
    payload          JSONB,
    -- Arrival time (device-liveness signal); mirrors api migration V20260703000000.
    received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT create_hypertable('telemetry', 'time',
    chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_received ON telemetry (device_id, received_at DESC);
-- Mirrors api migration V20260712000000: the UNIQUE index that backs the
-- writer's idempotent guarded insert against concurrent duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_device_time ON telemetry (device_id, time DESC);

GRANT USAGE ON SCHEMA public TO voltpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON telemetry TO voltpilot_app;

ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_isolation ON telemetry;
CREATE POLICY telemetry_isolation ON telemetry
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Minimal device table for the purge-watermark guard (api migrations V1 +
-- V20260706000000): the writer refuses samples observed at or before
-- device.data_purged_before. Same RLS pattern as telemetry.
CREATE TABLE IF NOT EXISTS device (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID NOT NULL,
    data_purged_before TIMESTAMPTZ
);

-- SELECT + UPDATE like the real grant (api V2 grants the app role full DML on
-- device): the writer's SELECT ... FOR SHARE watermark lock (audit B6b)
-- requires UPDATE privilege, which prod has.
GRANT SELECT, UPDATE ON device TO voltpilot_app;

ALTER TABLE device ENABLE ROW LEVEL SECURITY;
ALTER TABLE device FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_isolation ON device;
CREATE POLICY device_isolation ON device
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- v2 entity telemetry (mirrors api migration V20260718010000): the generic
-- (entity_id, channel, value) hypertable the v2 listener writes. Same RLS +
-- unique-index discipline as v1; the rollup table is NOT mirrored here (the
-- writer never touches it - it is refreshed by the api-owned background job).
CREATE TABLE IF NOT EXISTS telemetry_v2 (
    time        TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    device_id   UUID        NOT NULL,
    entity_id   TEXT        NOT NULL,
    channel     TEXT        NOT NULL,
    value       DOUBLE PRECISION NOT NULL
);

SELECT create_hypertable('telemetry_v2', 'time', if_not_exists => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_v2_entity_channel_time
    ON telemetry_v2 (entity_id, channel, time);

GRANT SELECT, INSERT ON telemetry_v2 TO voltpilot_app;

ALTER TABLE telemetry_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_v2 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_v2_isolation ON telemetry_v2;
CREATE POLICY telemetry_v2_isolation ON telemetry_v2
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

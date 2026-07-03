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

GRANT USAGE ON SCHEMA public TO voltpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON telemetry TO voltpilot_app;

ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_isolation ON telemetry;
CREATE POLICY telemetry_isolation ON telemetry
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

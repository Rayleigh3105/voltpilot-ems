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
    site_id            UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000002',
    data_purged_before TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_device_tenant_site_identity ON device(id, tenant_id, site_id);

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

-- The v2 entity registry the MIG-B1 fan-out reads (mirrors the columns of api
-- migrations V20260709000000 + V20260718000000 the writer touches). Same RLS
-- pattern: the writer binds app.tenant_id and the policy is the fence.
CREATE TABLE IF NOT EXISTS measurement_point (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    site_id     UUID NOT NULL,
    role        TEXT NOT NULL,
    label       TEXT,
    device_id   UUID,
    control     BOOLEAN NOT NULL DEFAULT FALSE,
    entity_type TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON measurement_point TO voltpilot_app;

ALTER TABLE measurement_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_point FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS measurement_point_isolation ON measurement_point;
CREATE POLICY measurement_point_isolation ON measurement_point
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

-- Slices 6-8 additional-measurement writer schema. This mirrors only columns
-- touched by MeasurementWriteRepository; the complete DDL is API migration
-- V20260841000000/V20260842000000 and is separately run by RlsIsolationTest.
CREATE TABLE measurement_catalog_point_metadata (
    catalog_version TEXT NOT NULL, point_key TEXT NOT NULL,
    aggregation_kind TEXT NOT NULL, long_term_cadence_s INTEGER,
    PRIMARY KEY(catalog_version,point_key)
);
GRANT SELECT ON measurement_catalog_point_metadata TO voltpilot_app;

CREATE TABLE device_measurement_selection (
    tenant_id UUID NOT NULL, site_id UUID NOT NULL, device_id UUID NOT NULL,
    point_key TEXT NOT NULL, enabled BOOLEAN NOT NULL, cadence_s INTEGER,
    desired_revision BIGINT NOT NULL, enabled_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ,
    catalog_version TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ DEFAULT now(),
    apply_status TEXT NOT NULL, apply_reason TEXT, applied_at TIMESTAMPTZ,
    custom_definition JSONB, retention_class TEXT NOT NULL, raw_retention_days INTEGER NOT NULL,
    long_term_cadence_s INTEGER, long_term_strategy TEXT NOT NULL,
    PRIMARY KEY(device_id,point_key),
    FOREIGN KEY(device_id,tenant_id,site_id) REFERENCES device(id,tenant_id,site_id)
);
GRANT SELECT,UPDATE ON device_measurement_selection TO voltpilot_app;
ALTER TABLE device_measurement_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_selection_isolation ON device_measurement_selection
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE device_measurement_selection_event (
    id BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL, site_id UUID NOT NULL, device_id UUID NOT NULL,
    point_key TEXT NOT NULL, desired_revision BIGINT NOT NULL, event_kind TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL, requested_enabled BOOLEAN NOT NULL,
    requested_cadence_s INTEGER, enabled_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ,
    catalog_version TEXT NOT NULL, actor TEXT NOT NULL, actor_name TEXT,
    apply_status TEXT NOT NULL, apply_reason TEXT, applied_at TIMESTAMPTZ,
    custom_definition JSONB, retention_class TEXT NOT NULL, raw_retention_days INTEGER NOT NULL,
    long_term_cadence_s INTEGER, long_term_strategy TEXT NOT NULL,
    UNIQUE(device_id,desired_revision,event_kind)
);
GRANT SELECT,INSERT ON device_measurement_selection_event TO voltpilot_app;
GRANT USAGE ON SEQUENCE device_measurement_selection_event_id_seq TO voltpilot_app;
ALTER TABLE device_measurement_selection_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_selection_event FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_selection_event_isolation ON device_measurement_selection_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE device_measurement_sample (
    time TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL, tenant_id UUID NOT NULL,
    site_id UUID NOT NULL, device_id UUID NOT NULL, point_key TEXT NOT NULL,
    raw_numeric NUMERIC, raw_text TEXT, decoded_numeric NUMERIC,
    decoded_text TEXT, quality TEXT NOT NULL, catalog_version TEXT NOT NULL,
    edge_sequence BIGINT NOT NULL, aggregation_kind TEXT NOT NULL, long_term_cadence_s INTEGER,
    gap BOOLEAN NOT NULL, dropped_samples BIGINT NOT NULL, signed_data TEXT,
    signed_data_format TEXT,
    -- UEMS AP-07 IP-6 (V20260912140000): die Reihe je Komponente und die
    -- Herkunftsspalten. Der Writer füllt sie NICHT - das ist IP-7. Sie stehen
    -- hier, damit dieser Test beweist, dass er unter der neuen Tabellenform
    -- zeichengleich weiterschreibt.
    entity_id UUID, device_install_id UUID, applied_revision BIGINT,
    value_kind TEXT, role TEXT, delivery TEXT, delay_s INTEGER,
    CHECK ((raw_numeric IS NOT NULL)::int + (raw_text IS NOT NULL)::int = 1)
);
SELECT create_hypertable('device_measurement_sample','time',if_not_exists=>TRUE);
CREATE UNIQUE INDEX uq_device_measurement_sample_idempotency
    ON device_measurement_sample(device_id,point_key,time,edge_sequence);
-- Der neue Doppel-Erkennungsschlüssel (Reihe + Messzeit) liegt ab IP-6 daneben.
-- Der Writer schreibt ohne `entity_id` und trifft ihn deshalb nie: sein
-- `ON CONFLICT DO NOTHING` ohne Ziel sieht alle Unique-Indexe der Tabelle, und
-- dieser darf keine Zeile abweisen, die vorher gespeichert wurde.
CREATE UNIQUE INDEX uq_device_measurement_sample_reihe
    ON device_measurement_sample(tenant_id,entity_id,point_key,time)
    WHERE entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel';
GRANT SELECT,INSERT ON device_measurement_sample TO voltpilot_app;
ALTER TABLE device_measurement_sample ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_sample FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_sample_isolation ON device_measurement_sample
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE device_measurement_point_state (
    tenant_id UUID NOT NULL, site_id UUID NOT NULL, device_id UUID NOT NULL,
    point_key TEXT NOT NULL, first_read_at TIMESTAMPTZ NOT NULL,
    last_read_at TIMESTAMPTZ NOT NULL, edge_sequence BIGINT NOT NULL,
    raw_numeric NUMERIC, raw_text TEXT, decoded_numeric NUMERIC, decoded_text TEXT,
    quality TEXT NOT NULL, gap BOOLEAN NOT NULL, dropped_samples BIGINT NOT NULL,
    catalog_version TEXT NOT NULL,
    PRIMARY KEY(tenant_id,site_id,device_id,point_key),
    CHECK ((raw_numeric IS NOT NULL)::int + (raw_text IS NOT NULL)::int = 1)
);
GRANT SELECT,INSERT,UPDATE ON device_measurement_point_state TO voltpilot_app;
ALTER TABLE device_measurement_point_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_point_state FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_point_state_isolation ON device_measurement_point_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE device_measurement_event (
    occurred_at TIMESTAMPTZ NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    device_id UUID NOT NULL, point_key TEXT NOT NULL, event_kind TEXT NOT NULL,
    previous_numeric NUMERIC, value_numeric NUMERIC,
    previous_text TEXT, value_text TEXT, catalog_version TEXT NOT NULL,
    edge_sequence BIGINT NOT NULL, details JSONB NOT NULL,
    UNIQUE(device_id,point_key,occurred_at,edge_sequence,event_kind)
);
SELECT create_hypertable('device_measurement_event','occurred_at',if_not_exists=>TRUE);
GRANT SELECT,INSERT ON device_measurement_event TO voltpilot_app;
ALTER TABLE device_measurement_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_event FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_event_isolation ON device_measurement_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- messreihe_ereignis (UEMS AP-07 IP-8): the table itself is NOT copied here.
-- The writer tests run the REAL migration
-- services/api/src/main/resources/db/migration/V20260911260000__uems_messreihe_ereignis.sql
-- on top of this schema (EreignisTabelleImTest), so the writer always writes into
-- exactly what Flyway builds. Below: only what that migration presupposes (the
-- admin role, the tenant it hangs RESTRICT on, the append-only trigger function of
-- V20260843000000) and the two code tables the events.raw path resolves DQ-n /
-- MS-n through (V20260911150000 / V20260911140000, reduced to their key columns).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltpilot_admin') THEN
        CREATE ROLE voltpilot_admin LOGIN PASSWORD 'voltpilot_admin_test_pw'
            NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO voltpilot_admin;

CREATE TABLE tenant (id UUID PRIMARY KEY, name TEXT);
GRANT SELECT ON tenant TO voltpilot_app, voltpilot_admin;

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are append-only';
END $$;

CREATE TABLE data_source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
    kennzeichen TEXT NOT NULL, UNIQUE (tenant_id, kennzeichen)
);
GRANT SELECT ON data_source TO voltpilot_app;
ALTER TABLE data_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source FORCE ROW LEVEL SECURITY;
CREATE POLICY data_source_tenant_isolation ON data_source
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE messstelle_kennzeichen (
    tenant_id UUID NOT NULL, kennzeichen TEXT NOT NULL, messstelle_id UUID NOT NULL,
    PRIMARY KEY (tenant_id, kennzeichen)
);
GRANT SELECT ON messstelle_kennzeichen TO voltpilot_app;
ALTER TABLE messstelle_kennzeichen ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_kennzeichen FORCE ROW LEVEL SECURITY;
CREATE POLICY messstelle_kennzeichen_tenant_isolation ON messstelle_kennzeichen
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

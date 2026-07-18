-- =============================================================================
-- V20260718010000 - v2 entity telemetry (E1a): generic hypertable + 15m rollup.
-- -----------------------------------------------------------------------------
-- The landing zone of the mqtt-telemetry-2.0 uplink (contract:
-- docs/contracts/v2/mqtt-telemetry-2.0.md; Kafka hop telemetry-v2.raw): the
-- timescale-writer's v2 listener explodes each event into GENERIC
-- (entity_id, channel, value) rows - per-entity free-form channels instead of
-- the frozen v1 5-column whitelist. The v1 `telemetry` hypertable and its
-- rollups are UNTOUCHED (dual-consume, v2 README coexistence philosophy #2).
--
-- Conventions carried over from v1 verbatim:
--   * time = the OBSERVATION timestamp; received_at = ARRIVAL. Any liveness
--     derivation MUST use received_at (store-and-forward replay rule).
--   * RLS-scoped per tenant; the writer connects as the app role and
--     set_config's the event tenant per transaction (WITH CHECK fences it).
--   * Idempotent writes: unique (entity_id, channel, time) backs the writer's
--     guarded insert (the V20260712000000 belt-and-braces pattern).
--   * entity_id is TEXT: the contract allows any MQTT-topic-safe id (registry
--     row UUIDs are the recommended form, not a constraint).
--
-- Minimal per-entity rollup (E1a): ONE 15-minute level, avg/min/max/last +
-- n_samples per (entity, channel), refreshed by its own background job over a
-- 7-day trailing window (the V20260701030000 job pattern, separate procedure -
-- the v1 refresh stays byte-identical). Portal read paths are later work.
-- =============================================================================

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
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_site_time ON telemetry_v2 (site_id, time DESC);

GRANT SELECT, INSERT ON telemetry_v2 TO ${appDbUser};

ALTER TABLE telemetry_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_v2 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_v2_isolation ON telemetry_v2;
CREATE POLICY telemetry_v2_isolation ON telemetry_v2
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---- Minimal per-entity 15m rollup ------------------------------------------

CREATE TABLE IF NOT EXISTS telemetry_v2_rollup_15m (
    bucket     TIMESTAMPTZ NOT NULL,
    tenant_id  UUID        NOT NULL,
    site_id    UUID        NOT NULL,
    entity_id  TEXT        NOT NULL,
    channel    TEXT        NOT NULL,
    avg_value  DOUBLE PRECISION,
    min_value  DOUBLE PRECISION,
    max_value  DOUBLE PRECISION,
    last_value DOUBLE PRECISION,
    n_samples  BIGINT      NOT NULL
);

SELECT create_hypertable('telemetry_v2_rollup_15m', 'bucket', if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_v2_rollup_15m
    ON telemetry_v2_rollup_15m (entity_id, channel, bucket);

GRANT SELECT ON telemetry_v2_rollup_15m TO ${appDbUser};

ALTER TABLE telemetry_v2_rollup_15m ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_v2_rollup_15m FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_v2_rollup_15m_isolation ON telemetry_v2_rollup_15m;
CREATE POLICY telemetry_v2_rollup_15m_isolation ON telemetry_v2_rollup_15m
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE PROCEDURE refresh_telemetry_v2_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO telemetry_v2_rollup_15m
    SELECT time_bucket('15 minutes', time) AS bucket,
           tenant_id,
           site_id,
           entity_id,
           channel,
           avg(value)         AS avg_value,
           min(value)         AS min_value,
           max(value)         AS max_value,
           last(value, time)  AS last_value,
           count(*)           AS n_samples
    FROM telemetry_v2
    WHERE time >= time_bucket('15 minutes', since)
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;
END
$$;

CREATE OR REPLACE PROCEDURE telemetry_v2_rollups_job(job_id INT, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
    CALL refresh_telemetry_v2_rollups(now() - INTERVAL '7 days');
END
$$;

-- Guarded so a re-applied migration (baseline quirks) never registers twice.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'telemetry_v2_rollups_job') THEN
        PERFORM add_job('telemetry_v2_rollups_job', INTERVAL '15 minutes');
    END IF;
END
$$;

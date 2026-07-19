-- =============================================================================
-- V20260719020000 - full per-entity rollup cascade (E1b): 15m -> 1h -> 1d.
-- -----------------------------------------------------------------------------
-- Extends the E1a minimal 15m rollup (V20260718010000) to the full v1
-- discipline (V20260701030000): hourly + Europe/Berlin-DAILY levels, ONE
-- idempotent upsert cascade refreshed by the existing background job (the
-- procedure body is replaced; the registered job keeps calling
-- telemetry_v2_rollups_job unchanged). The v1 telemetry rollups are UNTOUCHED.
--
-- Aggregation semantics per (entity, channel): channels are generic VALUES
-- (not energies), so the cascade carries avg (sample-WEIGHTED via n_samples -
-- a plain avg of averages would skew mixed-density buckets), min, max, last
-- and n_samples. Daily buckets are Europe/Berlin days (the v1 platform
-- timezone rule).
--
-- Backfill: the whole raw history once (epoch), so pre-E1b samples appear in
-- the new levels immediately; afterwards the job's 7-day trailing window
-- keeps all three levels fresh. Late data beyond 7 days needs a manual
-- CALL refresh_telemetry_v2_rollups('<since>') exactly like v1.
-- =============================================================================

CREATE TABLE IF NOT EXISTS telemetry_v2_rollup_1h (
    LIKE telemetry_v2_rollup_15m INCLUDING ALL
);
SELECT create_hypertable('telemetry_v2_rollup_1h', 'bucket',
                         chunk_time_interval => INTERVAL '90 days',
                         if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS telemetry_v2_rollup_1d (
    LIKE telemetry_v2_rollup_15m INCLUDING ALL     -- bucket = Europe/Berlin midnight
);
SELECT create_hypertable('telemetry_v2_rollup_1d', 'bucket',
                         chunk_time_interval => INTERVAL '365 days',
                         if_not_exists => TRUE);

GRANT SELECT ON telemetry_v2_rollup_1h, telemetry_v2_rollup_1d TO ${appDbUser};

ALTER TABLE telemetry_v2_rollup_1h ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_v2_rollup_1h FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_v2_rollup_1h_isolation ON telemetry_v2_rollup_1h;
CREATE POLICY telemetry_v2_rollup_1h_isolation ON telemetry_v2_rollup_1h
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE telemetry_v2_rollup_1d ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_v2_rollup_1d FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_v2_rollup_1d_isolation ON telemetry_v2_rollup_1d;
CREATE POLICY telemetry_v2_rollup_1d_isolation ON telemetry_v2_rollup_1d
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---- The cascade (replaces the E1a 15m-only procedure body) -----------------

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

    INSERT INTO telemetry_v2_rollup_1h
    SELECT time_bucket('1 hour', bucket), tenant_id, site_id, entity_id, channel,
           sum(avg_value * n_samples) / NULLIF(sum(n_samples), 0),
           min(min_value), max(max_value), last(last_value, bucket),
           sum(n_samples)
    FROM telemetry_v2_rollup_15m
    WHERE bucket >= time_bucket('1 hour', since)
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_v2_rollup_1d
    SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id, entity_id, channel,
           sum(avg_value * n_samples) / NULLIF(sum(n_samples), 0),
           min(min_value), max(max_value), last(last_value, bucket),
           sum(n_samples)
    FROM telemetry_v2_rollup_1h
    WHERE bucket >= time_bucket('1 day', since, 'Europe/Berlin')
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;
END
$$;

-- One-time backfill over the whole raw history (the job only trails 7 days).
CALL refresh_telemetry_v2_rollups('2020-01-01T00:00:00Z');

-- =============================================================================
-- V20260701030000 - Telemetry rollups for the portal "Historie" (history) view.
-- -----------------------------------------------------------------------------
-- Precomputed per-site energy rollups of the raw `telemetry` hypertable at
-- 15-minute, hourly and daily resolution, so the history endpoint can serve a
-- week/month/year without scanning the raw corpus. RAW telemetry stays fully
-- untouched (no retention here - the raw data is future ML training material).
--
-- WHY NOT TimescaleDB continuous aggregates: `telemetry` has (FORCE) row-level
-- security, and TimescaleDB hard-refuses caggs on RLS hypertables ("cannot
-- create continuous aggregate on hypertable with row security" - verified on
-- 2.17.2). Weakening the RLS spine is not an option, so the same outcome is
-- built from primitives that respect it: plain rollup HYPERTABLES that carry
-- tenant_id and get the SAME RLS policy as telemetry, refreshed by a
-- TimescaleDB background job (add_job) running an idempotent upsert as the
-- job owner (the Flyway superuser, which bypasses RLS to aggregate all
-- tenants). Reads go through the RLS-scoped app role like telemetry itself.
--
-- Semantics (documented once, used by the history endpoint):
--   * Energy per bucket = avg(power over the bucket's samples) * bucket hours.
--     Import/export (and battery charge/discharge) are split PER SAMPLE before
--     averaging, so a bucket that both imports and exports keeps both sides.
--   * Actual battery power is derived from the telemetry power balance
--     (power_kw = load_kw - pv_power_kw + battery_kw, see the edge contract):
--     battery_kw = power_kw - load_kw + pv_power_kw (+charge / -discharge).
--   * Rollups aggregate per (tenant, site) across the site's devices: the edge
--     reports SITE-level measurements, so multiple reporting devices would
--     average (not add). One reporting edge per site is the v1 assumption.
--   * Daily buckets are Europe/Berlin days (DACH B2C product; a per-tenant
--     timezone is future work), 15m/1h buckets are UTC-aligned (whole-hour
--     offset, so they match Berlin quarter-hours/hours either way).
--   * The refresh job re-aggregates a trailing 7-day window every 15 minutes;
--     telemetry arriving later than 7 days behind real time is not rolled up
--     automatically (re-run `CALL refresh_telemetry_rollups(<since>)` for
--     backfills). The migration itself backfills all existing history once.
--
-- Owned by the api (it owns the app role + every RLS policy); date-based
-- version per the AGENTS.md migration-version coordination. No infra/local
-- mirror is needed: only the api itself reads these tables, and its Flyway
-- creates them on any DB before the endpoint can be called.
-- =============================================================================

-- ---- 1. Rollup hypertables ---------------------------------------------------

CREATE TABLE IF NOT EXISTS telemetry_rollup_15m (
    bucket                TIMESTAMPTZ    NOT NULL,  -- slot start (UTC, 15-min grid)
    tenant_id             UUID           NOT NULL,  -- carried for RLS (like telemetry)
    site_id               UUID           NOT NULL,
    pv_kwh                NUMERIC(14, 6),           -- PV generation energy
    load_kwh              NUMERIC(14, 6),           -- consumption energy
    grid_import_kwh       NUMERIC(14, 6),           -- energy drawn from the grid
    grid_export_kwh       NUMERIC(14, 6),           -- energy fed into the grid
    battery_charge_kwh    NUMERIC(14, 6),           -- derived battery charging energy
    battery_discharge_kwh NUMERIC(14, 6),           -- derived battery discharging energy
    soc_min_pct           NUMERIC(5, 2),
    soc_max_pct           NUMERIC(5, 2),
    soc_last_pct          NUMERIC(5, 2),            -- SoC at bucket end (last sample)
    n_samples             BIGINT         NOT NULL,  -- transparency: how much raw data backs the bucket
    PRIMARY KEY (site_id, bucket)
);
SELECT create_hypertable('telemetry_rollup_15m', 'bucket',
                         chunk_time_interval => INTERVAL '30 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_telemetry_rollup_15m_tenant
    ON telemetry_rollup_15m (tenant_id, bucket DESC);

CREATE TABLE IF NOT EXISTS telemetry_rollup_1h (
    LIKE telemetry_rollup_15m INCLUDING ALL
);
SELECT create_hypertable('telemetry_rollup_1h', 'bucket',
                         chunk_time_interval => INTERVAL '90 days',
                         if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS telemetry_rollup_1d (
    LIKE telemetry_rollup_15m INCLUDING ALL       -- bucket = Europe/Berlin midnight
);
SELECT create_hypertable('telemetry_rollup_1d', 'bucket',
                         chunk_time_interval => INTERVAL '365 days',
                         if_not_exists => TRUE);

-- ---- 2. RLS + read grant (exactly the telemetry pattern) ----------------------

GRANT SELECT ON telemetry_rollup_15m, telemetry_rollup_1h, telemetry_rollup_1d
    TO ${appDbUser};

ALTER TABLE telemetry_rollup_15m ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_rollup_15m FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_rollup_15m_isolation ON telemetry_rollup_15m;
CREATE POLICY telemetry_rollup_15m_isolation ON telemetry_rollup_15m
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE telemetry_rollup_1h ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_rollup_1h FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_rollup_1h_isolation ON telemetry_rollup_1h;
CREATE POLICY telemetry_rollup_1h_isolation ON telemetry_rollup_1h
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE telemetry_rollup_1d ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_rollup_1d FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_rollup_1d_isolation ON telemetry_rollup_1d;
CREATE POLICY telemetry_rollup_1d_isolation ON telemetry_rollup_1d
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---- 3. Refresh procedure (idempotent upsert cascade: raw -> 15m -> 1h -> 1d) --

CREATE OR REPLACE PROCEDURE refresh_telemetry_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO telemetry_rollup_15m
    SELECT time_bucket('15 minutes', time)                                  AS bucket,
           tenant_id,
           site_id,
           avg(pv_power_kw) * 0.25                                          AS pv_kwh,
           avg(load_kw) * 0.25                                              AS load_kwh,
           avg(greatest(power_kw, 0)) * 0.25                                AS grid_import_kwh,
           avg(greatest(-power_kw, 0)) * 0.25                               AS grid_export_kwh,
           avg(greatest(power_kw - load_kw + pv_power_kw, 0)) * 0.25        AS battery_charge_kwh,
           avg(greatest(-(power_kw - load_kw + pv_power_kw), 0)) * 0.25     AS battery_discharge_kwh,
           min(soc_pct)                                                     AS soc_min_pct,
           max(soc_pct)                                                     AS soc_max_pct,
           last(soc_pct, time)                                              AS soc_last_pct,
           count(*)                                                         AS n_samples
    FROM telemetry
    WHERE time >= time_bucket('15 minutes', since)
    GROUP BY 1, 2, 3
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_rollup_1h
    SELECT time_bucket('1 hour', bucket), tenant_id, site_id,
           sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
           sum(battery_charge_kwh), sum(battery_discharge_kwh),
           min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket),
           sum(n_samples)
    FROM telemetry_rollup_15m
    WHERE bucket >= time_bucket('1 hour', since)
    GROUP BY 1, 2, 3
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_rollup_1d
    SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id,
           sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
           sum(battery_charge_kwh), sum(battery_discharge_kwh),
           min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket),
           sum(n_samples)
    FROM telemetry_rollup_1h
    WHERE bucket >= time_bucket('1 day', since, 'Europe/Berlin')
    GROUP BY 1, 2, 3
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;
END
$$;

-- Job entrypoint (TimescaleDB background-job signature): trailing-window refresh.
CREATE OR REPLACE PROCEDURE telemetry_rollups_job(job_id INT, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
    CALL refresh_telemetry_rollups(now() - INTERVAL '7 days');
END
$$;

-- ---- 4. Schedule the job + one-time full backfill ------------------------------

-- Guarded so a re-applied migration (baseline quirks) never registers twice.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'telemetry_rollups_job') THEN
        PERFORM add_job('telemetry_rollups_job', INTERVAL '15 minutes');
    END IF;
END
$$;

-- Backfill every rollup from the full raw history once, at install time.
CALL refresh_telemetry_rollups('2020-01-01T00:00:00Z');

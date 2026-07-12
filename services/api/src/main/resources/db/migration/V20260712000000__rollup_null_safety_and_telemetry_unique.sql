-- =============================================================================
-- V20260712000000 - Data-integrity fixes (audit findings B2 + B7).
-- -----------------------------------------------------------------------------
-- B2 (NULL-safe rollup aggregates). Postgres GREATEST ignores NULL arguments,
-- so `greatest(power_kw, 0)` returned 0 (not NULL) for a sample whose
-- `power_kw` was absent - but the telemetry contract makes every measurement
-- optional and the edge deliberately omits absent channels. Consequences of
-- the old expressions:
--   (a) a bucket mixing full and power-less samples understated grid
--       import/export and derived battery energy (the fabricated 0s entered
--       both numerator and denominator of the avg), while pv_kwh/load_kwh
--       (plain avg) correctly excluded NULLs;
--   (b) a generation-only site (Deye string/micro: only pv_power_kw) got
--       grid_import_kwh = 0 / grid_export_kwh = 0 instead of NULL, so
--       EarningsRepository.CHANNELS_OK wrongly passed and earnings were
--       computed from fabricated zero grid flows instead of degrading to the
--       honest `missing_channels` reason.
-- Fix: average only over samples where the source channel(s) exist -
-- `avg(CASE WHEN power_kw IS NOT NULL THEN greatest(power_kw, 0) END)` for
-- import/export, and gate the derived battery expression
-- (power_kw - load_kw + pv_power_kw) on ALL THREE channels being non-null.
-- An all-NULL bucket now yields NULL (honest "channel missing"), never 0.
--
-- The old refresh procedure lives in the ALREADY-APPLIED migration
-- V20260701030000; applied migrations are immutable (Flyway checksum), so this
-- migration CREATE OR REPLACEs the procedure and re-backfills every rollup
-- from raw history. The two in-sync Java copies of the same expressions
-- (HistoryRepository day view, SeriesRepository purge rebuild) are fixed in
-- the same change set.
--
-- B7 (real unique index behind the writer's idempotent insert). The
-- timescale-writer's guarded `INSERT ... WHERE NOT EXISTS` on
-- (device_id, time) kept normal sequential redeliveries idempotent, but two
-- CONCURRENT deliveries of the same sample (zombie consumer during a Kafka
-- rebalance) could both pass the guard and double-insert. A UNIQUE index makes
-- the second insert fail instead; the writer's redelivery then no-ops on the
-- guard. Defensive de-dup first: the guard has prevented duplicates in
-- practice, but the index build must never abort a deploy on a long-lived DB
-- that raced one in. Duplicate (device_id, time) rows share a chunk (same
-- time), so the ctid comparison is well-defined.
-- =============================================================================

-- ---- B7: de-dup, then enforce uniqueness ------------------------------------

DELETE FROM telemetry a
USING telemetry b
WHERE a.device_id = b.device_id
  AND a.time = b.time
  AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_device_time
    ON telemetry (device_id, time DESC);

-- ---- B2: NULL-safe refresh procedure (same shape as V20260701030000) ---------

CREATE OR REPLACE PROCEDURE refresh_telemetry_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO telemetry_rollup_15m
    SELECT time_bucket('15 minutes', time)                                  AS bucket,
           tenant_id,
           site_id,
           avg(pv_power_kw) * 0.25                                          AS pv_kwh,
           avg(load_kw) * 0.25                                              AS load_kwh,
           avg(CASE WHEN power_kw IS NOT NULL
                    THEN greatest(power_kw, 0) END) * 0.25                  AS grid_import_kwh,
           avg(CASE WHEN power_kw IS NOT NULL
                    THEN greatest(-power_kw, 0) END) * 0.25                 AS grid_export_kwh,
           avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL
                         AND pv_power_kw IS NOT NULL
                    THEN greatest(power_kw - load_kw + pv_power_kw, 0)
               END) * 0.25                                                  AS battery_charge_kwh,
           avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL
                         AND pv_power_kw IS NOT NULL
                    THEN greatest(-(power_kw - load_kw + pv_power_kw), 0)
               END) * 0.25                                                  AS battery_discharge_kwh,
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

    -- The 1h/1d cascades sum from the 15m stage; sum() already ignores NULLs
    -- and yields NULL when every input is NULL, so they stay unchanged.
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

-- ---- Backfill: recompute every rollup with the NULL-safe expressions ----------
-- The upsert overwrites each existing bucket in place; buckets whose fabricated
-- 0s become NULL are corrected, buckets with full channels are byte-identical.

CALL refresh_telemetry_rollups('2020-01-01T00:00:00Z');

-- =============================================================================
-- V20260809000000 - Data-retention & compression policies (Datenhaltung Phase 1)
-- -----------------------------------------------------------------------------
-- The time-series tables grow unbounded ("nichts wird aggregiert bzw. kleiner
-- gemacht"). This migration caps that growth with TimescaleDB background
-- policies, WITHOUT damaging any product function (Historie/Earnings/
-- Prognosequalität keep reading the rollups + small aggregate tables, which we
-- keep FOREVER). Decision basis: scout report vp-data-retention-d8 (empirical,
-- measured on the real timescale/timescaledb:2.17.2-pg16 image).
--
-- ⚠ THE LOAD-BEARING CONSTRAINT (measured, both directions): TimescaleDB 2.17.2
-- forbids native compression on a table with Row-Level-Security
-- ("compression cannot be used on table with row security"; the reverse -
-- enabling RLS on a compressed hypertable - also errors). It is the same class
-- as the documented cagg restriction (V20260701030000). Consequence:
--   * NON-RLS time series (forecast, day_ahead_prices) CAN be compressed.
--   * Every RLS/FORCE hypertable (telemetry, telemetry_rollup_*, schedule,
--     weather_forecast, telemetry_v2*) can only ever get RETENTION, never
--     compression.
-- So the ONLY compressed table here is `forecast` (the #1 disk driver, no RLS,
-- measured 32.9x); the RLS tables that are disposable get retention only.
--
-- WHAT WE DELIBERATELY DO **NOT** TOUCH (regression-guarded by the policy test):
--   * `telemetry` (raw): NO retention - captain decision 2026-08-09, the raw
--     corpus stays complete as future ML training material (the E1/E3 retention
--     question is deferred; only E2 - dropping payload - ships now, in the
--     writer, not here).
--   * `telemetry_rollup_15m/1h/1d`: the permanent reporting backbone - kept
--     forever, never a retention or compression policy.
--   * `day_ahead_prices`, `forecast_accuracy`, `plan_accuracy`,
--     `monthly_market_value`, `telemetry_v2*`: kept as-is (tiny / historical).
--
-- The policies are what this migration adds:
--   * forecast (no RLS): compress chunks older than 14 days + drop chunks older
--     than 30 days. The forecast collector re-writes only the current run_at
--     (24-48h horizon), so a 14-day compression boundary is far past the write
--     horizon - no decompression churn. Results the product actually needs live
--     permanently in forecast_accuracy (daily evaluation), so dropping the raw
--     predictions after 30 days loses no product feature.
--   * weather_forecast (RLS): retention 60 days. api reads only the latest run
--     per site; the PV forecaster's "weather as forecast then" is a daily-eval
--     lookback well inside 60 days.
--   * schedule (RLS): retention 180 days. The history "geplant" value + the
--     admin optimizer-diagnostics date picker lose depth beyond 180 days; the
--     measured numbers (plan_accuracy, savings latest-per-slot) are unaffected.
--
-- Idempotency: every step is guarded so a re-applied migration (baseline quirk /
-- a Flyway-on-Postgres rollback+retry after a mid-migration failure) is a clean
-- no-op. Owned by the api Flyway (the canonical runtime owner of the forecast
-- table's shape, like the `model` column addition); date-versioned above the
-- highest shipped migration per the AGENTS.md ordering rule. The TimescaleDB
-- job scheduler runs IN the database, not in the api replicas, so there is no
-- replica-singleton double-run concern (unlike the MQTT listeners).
-- =============================================================================

-- ---- 1. forecast: enable columnar compression (NON-RLS -> allowed) -----------
-- segmentby = the series identity (site/kind/model), orderby = newest run + slot
-- first. All PK columns (site_id, kind, model, run_at, time) are thereby covered
-- by segmentby ∪ orderby, which TimescaleDB requires for a compressed hypertable
-- with a unique constraint. Measured 32.9x on this exact layout.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'forecast' AND compression_enabled
    ) THEN
        ALTER TABLE forecast SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'site_id, kind, model',
            timescaledb.compress_orderby   = 'run_at DESC, time DESC'
        );
    END IF;
END
$$;

-- ---- 2. forecast: compression (14d) + retention (30d) policies ---------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_compression'
                     AND hypertable_name = 'forecast') THEN
        PERFORM add_compression_policy('forecast', INTERVAL '14 days');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'forecast') THEN
        PERFORM add_retention_policy('forecast', INTERVAL '30 days');
    END IF;
END
$$;

-- ---- 3. RLS tables: retention only (compression is blocked on RLS) -----------
-- Retention (drop_chunks) works on RLS/FORCE hypertables without restriction
-- (measured). NO compression is even attempted here - it would fail loudly.
-- weather_forecast: 60 days. Its retention frist is trivially >> the read
-- horizons (latest run + daily lookback).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'weather_forecast') THEN
        PERFORM add_retention_policy('weather_forecast', INTERVAL '60 days');
    END IF;

    -- schedule: 180 days. Well beyond the 7-day rollup-refresh window and the
    -- latest-run-per-slot reads; only the admin diagnostics date-picker depth is
    -- bounded.
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'schedule') THEN
        PERFORM add_retention_policy('schedule', INTERVAL '180 days');
    END IF;
END
$$;

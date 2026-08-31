-- =============================================================================
-- V20260831020000 - Retention cap on telemetry_v2 (Datenhaltung, revidiert)
-- -----------------------------------------------------------------------------
-- Captain decision 2026-08-31: cap the growth of the MIG-B1 display mirror
-- `telemetry_v2` at a 90-day retention. Decision basis: scout report
-- vp-scale-readiness-p4 §2.1 + §7 point 6 (measured on the real
-- timescale/timescaledb:2.17.2-pg16 image).
--
-- ⚠ THIS DELIBERATELY REVISES A DOCUMENTED-BUT-STALE EXCLUSION. The Phase-1
-- migration V20260809000000 (and the p12-k6 brief) explicitly left telemetry_v2
-- WITHOUT any policy, "kept as-is (tiny / historical)". That was correct when
-- the table was an empty v2 pilot. It no longer is: since the entity auto-
-- backfill, `ComposedEntityFanout` (services/timescale-writer) writes up to 5
-- `telemetry_v2` rows per v1 sample (battery-hybrid soc/pv/battery + grid-meter
-- power + house-load power) on EVERY composed plant - measured ~3,9 GB/year/
-- plant, unbounded, ~2,6x the bytes of the same v1 measurement. It is now the
-- single largest unbounded storage driver (bigger than the raw v1 telemetry
-- itself). The captain has revised the p12-k6 exclusion for this table only.
--
-- WHAT THIS TOUCHES:
--   * telemetry_v2 (RLS/FORCE hypertable, V20260718010000): add a 90-day
--     RETENTION policy. Compression is NOT added and never attempted - it is
--     blocked on RLS tables (the load-bearing constraint documented in
--     V20260809000000, measured both directions on 2.17.2).
--
-- WHAT THIS DELIBERATELY DOES **NOT** TOUCH (regression-guarded by
-- DataRetentionPolicyTest):
--   * telemetry_v2_rollup_15m/1h/1d: the permanent v2 reporting backbone -
--     kept FOREVER, exactly like the v1 rollups. NO retention, NO compression.
--   * telemetry (raw v1, the ML corpus, captain decision 2026-08-09): still NO
--     retention - completely untouched.
--   * telemetry_rollup_15m/1h/1d: still kept forever.
--
-- DISPLAY NEUTRALITY (verified in code, not assumed): no display/API path reads
-- raw telemetry_v2 older than 90 days. Every raw read is bounded to a single
-- DAY window (EntityHistoryRepository.v2Rows / HistoryRepository.v2DayBuckets -
-- both only for HistoryRange.DAY; ConsumerRequirement* over a current recurring
-- period; TopologyRepository.latestValues = the newest sample). Entity/site
-- Historie from WEEK up reads the v2 ROLLUPS (kept forever). The splice-boundary
-- reads (min(time) over the range window) only shift WHICH retained-forever
-- source - v1 rollups vs v2 rollups - provides the overlapping buckets, and the
-- fan-out writes the two as mirror images, so the merged series is unchanged.
--
-- Idempotency: guarded on the job's existence so a re-applied migration (baseline
-- quirk / Flyway-on-Postgres rollback+retry) is a clean no-op; runs cleanly on a
-- fresh Testcontainers DB AND a long-lived prod DB. Owned by the api Flyway;
-- date-versioned above the highest shipped migration per the AGENTS.md ordering
-- rule. The TimescaleDB job scheduler runs IN the database, not in the api
-- replicas, so there is no replica-singleton double-run concern.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'telemetry_v2') THEN
        PERFORM add_retention_policy('telemetry_v2', INTERVAL '90 days');
    END IF;
END
$$;

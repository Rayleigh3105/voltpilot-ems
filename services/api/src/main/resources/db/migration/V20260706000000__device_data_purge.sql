-- =============================================================================
-- V20260706000000 - Device data purge ("Datenaufzeichnungen löschen").
-- -----------------------------------------------------------------------------
-- A customer (or the device itself, via its authenticated MQTT identity) can
-- delete ALL recorded timeseries data of one device without unclaiming it.
--
-- 1. `device.data_purged_before` is the PURGE WATERMARK: the instant of the
--    last purge. The timescale-writer refuses any telemetry insert whose
--    OBSERVATION time is <= this watermark, so a store-and-forward edge that
--    replays old buffered samples after the purge can never resurrect deleted
--    history - correctness does not depend on the edge cooperating. New
--    samples (observed after the purge) flow and chart normally.
--
-- 2. The purge recomputes the site's telemetry rollups from the remaining raw
--    rows (rollups aggregate per SITE across its devices, see
--    V20260701030000), so the app role needs INSERT/UPDATE alongside the
--    SELECT (V20260701030000) and DELETE (V20260702030000) it already has.
--    RLS still scopes every write to the caller's tenant (the rollup policies
--    have no FOR clause, so their WITH CHECK covers INSERT/UPDATE too).
--
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

ALTER TABLE device ADD COLUMN IF NOT EXISTS data_purged_before TIMESTAMPTZ;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON telemetry_rollup_15m, telemetry_rollup_1h, telemetry_rollup_1d
    TO ${appDbUser};

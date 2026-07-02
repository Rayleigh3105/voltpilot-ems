-- =============================================================================
-- V20260702010000 - Plant-registry master data on `asset` (MaStR integration).
-- -----------------------------------------------------------------------------
-- The optional "Anlage verknüpfen" onboarding step fetches a unit's public
-- master data from the Marktstammdatenregister (or a future AT/CH registry)
-- and persists the CUSTOMER-CONFIRMED values onto the site's asset rows:
--
--   * PV parameters feeding the physical PV forecast (PlantSpec in
--     services/forecast): pv_capacity_kwp, azimuth_deg, tilt_deg. Orientation
--     is nullable on purpose - Balkonkraftwerke carry none in the registry and
--     Ost-West/nachgeführt maps to no single azimuth; the forecaster then
--     falls back to its DACH defaults (south, 30°).
--   * Battery parameters land in the EXISTING capacity_kwh / max_charge_kw /
--     max_discharge_kw columns the optimizer already reads - no new columns.
--   * Provenance: registry discriminator + unit number + fetch timestamp, kept
--     registry-NEUTRAL (not MaStR-specific column names) so an AT/CH registry
--     is a drop-in later. Registry data is a customer-confirmed prefill, not
--     ground truth - hence no NOT NULL, no FK to anything external.
--
-- RLS: `asset` is already policy-scoped + granted to the app role (V2); new
-- columns inherit both, so nothing security-related is needed here.
-- Version: date-based per the AGENTS.md migration-version coordination;
-- V20260702000000 is taken by services/forecast, so this one is ...010000 to
-- stay collision-free if migration schemes are ever unified.
-- =============================================================================

ALTER TABLE asset ADD COLUMN IF NOT EXISTS pv_capacity_kwp     NUMERIC(10, 3)
    CHECK (pv_capacity_kwp IS NULL OR pv_capacity_kwp >= 0);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS module_count        INTEGER
    CHECK (module_count IS NULL OR module_count > 0);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS azimuth_deg         NUMERIC(5, 1)
    CHECK (azimuth_deg IS NULL OR (azimuth_deg >= 0 AND azimuth_deg < 360));
ALTER TABLE asset ADD COLUMN IF NOT EXISTS tilt_deg            NUMERIC(4, 1)
    CHECK (tilt_deg IS NULL OR (tilt_deg >= 0 AND tilt_deg <= 90));
ALTER TABLE asset ADD COLUMN IF NOT EXISTS commissioned_on     DATE;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS registry            TEXT;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS registry_unit_id    TEXT;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS registry_fetched_at TIMESTAMPTZ;

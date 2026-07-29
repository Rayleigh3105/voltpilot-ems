-- =============================================================================
-- V20260729010000 - remove the "Eigenverbrauch" MODE (Grundverhalten, not a
-- selectable profile). ADDITIVE / data-only, prod-safe, idempotent.
-- -----------------------------------------------------------------------------
-- Self-consumption ("PV-Überschuss in den Speicher, abends nutzen") is the
-- platform's BASE behaviour - the optimizer does it unconditionally and the
-- shelf card / usage-profile override / strategy node never gated anything. So
-- the concept is removed as a CHOICE (report vp-nacht-bezug-e7 §3.3):
--
--   1. drop any stored `eigenverbrauch` intent in `site_profile_state`
--      (the M3 shelf toggle) - it steered only flow-seeding + display and now
--      has no card;
--   2. clear any `private` usage-profile OVERRIDE - `private` stays the DERIVED
--      household emphasis, but is no longer a settable override (the card + the
--      wizard choice are gone), so a stored value would be an orphan;
--   3. narrow the override CHECK to the two settable profiles ('arbitrage',
--      'peak').
--
-- What is NOT touched: `site.plant_kind = 'eigenverbrauch'` (the EEG
-- Vergütungsform), the Fahrplan-Warum slot role, and every Eigenverbrauchs-
-- KENNZAHL - those hang on data, not on the mode.
--
-- Deliberately NOT a dev seed: this runs on prod. It references no specific
-- tenant, so the DELETE/UPDATE simply no-op on any DB that never had these rows.
-- Date-based version per the AGENTS.md coordination.
-- =============================================================================

DELETE FROM site_profile_state WHERE profile = 'eigenverbrauch';

UPDATE site SET usage_profile_override = NULL WHERE usage_profile_override = 'private';

ALTER TABLE site DROP CONSTRAINT IF EXISTS site_usage_profile_override_check;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_usage_profile_override_check') THEN
        ALTER TABLE site ADD CONSTRAINT site_usage_profile_override_check
            CHECK (usage_profile_override IS NULL
                   OR usage_profile_override IN ('arbitrage', 'peak'));
    END IF;
END
$$;

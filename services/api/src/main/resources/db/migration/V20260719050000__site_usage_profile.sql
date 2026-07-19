-- =============================================================================
-- V20260719050000 - site.usage_profile_override (AE7 Nutzungsprofil), ADDITIVE.
-- -----------------------------------------------------------------------------
-- The usage profile (arbitrage | peak | private) is the SECOND adaptation axis
-- of the adaptive EMS UI (spec adaptive-ems-ui-v1-spec.md §2, contract
-- docs/contracts/v2/usage-profile.md). It is DERIVED from the site's strategy
-- nodes + entity mix + money master data (plant_kind, Leistungspreis) at read
-- time - ONE truth, no stored derived value to drift. Only the explicit
-- OVERRIDE is persisted here (customer / admin: "diese Anlage ist ein …").
--
-- NULL = derive automatically (the default). This generalises the existing
-- plant_kind money-story axis and the onboarding "Nutzung" step - it does not
-- add a competing profile picker.
--
-- Pure additive ALTER. The existing site RLS policy + grants (V2) cover the new
-- column. Date-based version per the AGENTS.md coordination.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS usage_profile_override TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_usage_profile_override_check') THEN
        ALTER TABLE site ADD CONSTRAINT site_usage_profile_override_check
            CHECK (usage_profile_override IS NULL
                   OR usage_profile_override IN ('arbitrage', 'peak', 'private'));
    END IF;
END
$$;

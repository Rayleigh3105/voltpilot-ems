-- =============================================================================
-- V20260710020000 - asset SoC band (admin-tunable usable state-of-charge window).
-- -----------------------------------------------------------------------------
-- The optimizer's usable SoC window was a hard-coded platform constant
-- (services/optimization voltpilot_optimization/domain.py: 5-95%). The
-- Portal-Admin optimizer surface (design vp-admin-optimizer-ui-design §2.7)
-- makes it a per-battery-asset override: NULL (the default) keeps the platform
-- band unchanged; a configured value replaces its side of the band. Lives on
-- the BATTERY asset (like wear_cost_ct_per_kwh, V20260710000000) because the
-- band is battery-technical master data, unlike the customer-facing
-- site.backup_reserve_soc_pct (V20260710010000) which layers ON TOP of it
-- (effective floor = max(technical band min, backup reserve)).
--
-- The optimizer reads both columns per battery asset
-- (inputs.load_battery_sites) and falls back to the platform band with a loud
-- warning when the effective band is inconsistent (only one side set,
-- crossing the other side's default) - the api additionally validates that on
-- write, so the DB CHECK only pins the both-set case.
--
-- Pure additive ALTER (the wear-cost precedent): layers over any existing
-- volume, no infra bootstrap mirror needed. The existing asset RLS policy +
-- grants (V2) cover the new columns.
-- =============================================================================

ALTER TABLE asset ADD COLUMN IF NOT EXISTS soc_min_pct NUMERIC(5, 2)
    CHECK (soc_min_pct IS NULL OR (soc_min_pct >= 0 AND soc_min_pct <= 100));

ALTER TABLE asset ADD COLUMN IF NOT EXISTS soc_max_pct NUMERIC(5, 2)
    CHECK (soc_max_pct IS NULL OR (soc_max_pct >= 0 AND soc_max_pct <= 100));

-- Both set => the band must be a real window.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'asset_soc_band_window' AND conrelid = 'asset'::regclass
    ) THEN
        ALTER TABLE asset ADD CONSTRAINT asset_soc_band_window
            CHECK (soc_min_pct IS NULL OR soc_max_pct IS NULL
                   OR soc_min_pct < soc_max_pct);
    END IF;
END $$;

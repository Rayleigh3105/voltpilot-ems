-- =============================================================================
-- V20260706010000 - site.plant_kind (Anlagentyp je Standort).
-- -----------------------------------------------------------------------------
-- The customer fleet is a MIX of Direktvermarktungs-Anlagen (spot revenue is
-- literally money on the settlement) and Eigenverbrauchs-Haushalte (avoided
-- cost). The portal words its money headline per plant kind ("mehr verdient"
-- vs. "gespart"), so every site carries its kind. Same formula, two stories.
--
-- Enum-like TEXT with a CHECK (the tenant.segment precedent) - a real enum
-- type would make adding a kind a harder migration for no gain. Default
-- 'eigenverbrauch': the safe reading for existing sites (avoided cost never
-- overpromises income). Pure additive ALTER: layers over any existing volume,
-- no infra bootstrap mirror needed (the asset_registry_link precedent). The
-- existing site RLS policy + grants (V2) cover the new column.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS plant_kind TEXT NOT NULL DEFAULT 'eigenverbrauch';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_plant_kind_check') THEN
        ALTER TABLE site ADD CONSTRAINT site_plant_kind_check
            CHECK (plant_kind IN ('direktvermarktung', 'eigenverbrauch'));
    END IF;
END
$$;

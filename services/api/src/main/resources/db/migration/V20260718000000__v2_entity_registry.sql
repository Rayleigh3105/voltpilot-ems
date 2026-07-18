-- =============================================================================
-- V20260718000000 - v2 entity registry (E1a pilot minimum), ADDITIVE.
-- -----------------------------------------------------------------------------
-- Extends measurement_point into the v2 entity registry (plan §2.1, contracts
-- docs/contracts/v2/edge-entity-config.md): a row with a non-NULL entity_type
-- IS a v2 entity; capabilities / guard_config carry the contract JSON objects
-- verbatim (capabilities per the D-14 command vocabulary; guard limits +
-- failsafe per decision D-9 - failsafe lives in registry config, never in
-- plans).
--
-- Deliberately ADDITIVE ONLY: every v1 constraint stays intact (the
-- control-only-battery CHECK, the one-control-per-site partial unique index,
-- asset UNIQUE(site_id, type)). Dropping/reworking them for multi-battery is
-- E1b. entity_type NULL = not a v2 entity (all existing rows); no live site is
-- converted automatically - the three pilot entities are created per site by
-- the admin bootstrap (POST /api/v1/admin/sites/{siteId}/v2-entities/bootstrap).
--
-- The pilot vocabulary CHECK is intentionally explicit; later entity types
-- (wallbox, heat-rod, load) extend it in their own additive migration.
-- =============================================================================

ALTER TABLE measurement_point ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE measurement_point ADD COLUMN IF NOT EXISTS capabilities JSONB;
ALTER TABLE measurement_point ADD COLUMN IF NOT EXISTS guard_config JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'measurement_point_entity_type_pilot') THEN
        ALTER TABLE measurement_point ADD CONSTRAINT measurement_point_entity_type_pilot
            CHECK (entity_type IS NULL
                   OR entity_type IN ('battery-hybrid', 'producer', 'grid-meter'));
    END IF;
END $$;

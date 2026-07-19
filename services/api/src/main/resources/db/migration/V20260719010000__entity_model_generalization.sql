-- =============================================================================
-- V20260719010000 - entity model generalization (E1b): constraint drops.
-- -----------------------------------------------------------------------------
-- Opens the registry beyond the three E1a pilot types and removes the v1
-- structural single-battery locks the v2 entity model needs gone (plan §2.1),
-- each with its v1 behavior PRESERVED for v1 sites:
--
-- 1. measurement_point_entity_type_pilot CHECK dropped: entity_type is an OPEN
--    kebab-case vocabulary since E1b (contract edge-entity.schema.json). The
--    data-driven platform type catalog (services/api entitytypes/catalog.json,
--    validated in EntityTypeCatalog/EntityRegistryService) replaces the DB
--    enum - adding a type is catalog data, never a schema release.
--
-- 2. measurement_point_control_only_battery CHECK + uq_measurement_point_one_control
--    dropped: v2 controllable-consumer entities (wallbox, heating-rod,
--    generic-load) are control points too, and a site may have SEVERAL
--    (multi-storage sites become representable at the registry level).
--    The v1 invariant is preserved behaviorally: the v1 customer paths
--    (MeasurementPointController) only ever create control=FALSE rows, and
--    control=TRUE is now granted by the SERVICE per the type catalog's
--    controllable flag (admin entity CRUD + the bootstrap's battery point).
--
-- 3. asset UNIQUE(site_id, type) reworked to a PRIMARY-scoped partial unique:
--    every existing row becomes the primary (is_primary defaults TRUE), all
--    v1 readers/upserts pin to the primary row (AssetRepository /
--    OptimizerConfigRepository / ScheduleRepository / SimulationDefaults /
--    optimizer inputs.py / forecast collect - all carry `is_primary`
--    predicates in lockstep with this migration), so v1 sites stay
--    byte-identical: exactly one primary battery/pv per site, the upsert
--    target `ON CONFLICT (site_id, type) WHERE is_primary` matches the
--    partial index. A SECOND storage becomes representable as a non-primary
--    row; nothing creates one yet (multi-storage asset composition is E4/E6
--    follow-up work - the registry level carries additional storages as
--    measurement_point entities with their own guard_config).
--
-- RLS: unchanged - measurement_point/asset policies and grants (V2,
-- V20260709000000) cover the reworked shapes; indexes/constraints carry no
-- privileges.
-- =============================================================================

ALTER TABLE measurement_point DROP CONSTRAINT IF EXISTS measurement_point_entity_type_pilot;
ALTER TABLE measurement_point DROP CONSTRAINT IF EXISTS measurement_point_control_only_battery;
DROP INDEX IF EXISTS uq_measurement_point_one_control;

ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;
DROP INDEX IF EXISTS uq_asset_site_type;
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_site_type_primary
    ON asset (site_id, type) WHERE is_primary;

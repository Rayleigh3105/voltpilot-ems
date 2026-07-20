-- =============================================================================
-- V20260720010000 - U2 "Geräte": the edge-source <-> entity adoption link +
-- richer edge-local commissioning metadata. ADDITIVE, v1 byte-identical.
-- -----------------------------------------------------------------------------
-- U2 (design data/vp-ems-ui-overhaul/report.md §3.3) turns the edge-reported
-- local commissioning view into the ADOPTION source: an edge source that has
-- no matching entity yet is adoptable in one click. Two additive facts make
-- that deterministic + idempotent:
--
--   * measurement_point.edge_source_id - the edge's own source id (from the
--     :8484 sources / inverter selection, reported in the heartbeat
--     local_setup). Stamped on adoption so the "Vom Gerät gemeldet" matcher is
--     deterministic (an entity carries the id of the source it was adopted
--     from), re-adoption is idempotent (the partial-unique index below), and
--     the E1b drift surface covers "entity exists but edge source vanished".
--     A partial unique index enforces at most ONE entity per (site, source).
--
--   * entity_observed_state.edge_role / edge_brand - the reported role/brand of
--     a source='local' item (today the listener squashes them into the label).
--     Persisting them lets the adoption drawer suggest the right catalog type
--     ("go-e Charger (Verbraucher) -> Wallbox"), report §3.3.
--
-- Both tables stay RLS-scoped exactly as before; these are nullable columns +
-- one partial index, so they layer cleanly over any volume.
-- =============================================================================

ALTER TABLE measurement_point ADD COLUMN IF NOT EXISTS edge_source_id TEXT;

-- At most one entity per (site, edge source): re-adopting a source is a no-op
-- (the service returns the existing entity), never a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_measurement_point_edge_source
    ON measurement_point (site_id, edge_source_id) WHERE edge_source_id IS NOT NULL;

ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_role TEXT;
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_brand TEXT;

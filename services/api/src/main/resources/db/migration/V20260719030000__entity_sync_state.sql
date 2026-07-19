-- =============================================================================
-- V20260719030000 - bidirectional entity master-data sync state (E1b).
-- -----------------------------------------------------------------------------
-- The cloud registry stays the Soll (E1a push); the edge now reports its Ist
-- back through the status-heartbeat `entities` block (contract
-- edge-entity-config.md §5). Two tables make the reconciliation honest -
-- drift is SURFACED, never silently resolved in either direction:
--
--   * entity_registry_state - the last COMPOSED Soll per site: the push
--     revision the edge is expected to echo. Written by
--     EntityRegistryService on every compose (even when the best-effort
--     publish fails - the Soll changed regardless).
--   * entity_observed_state - the edge-reported Ist per (device, entity):
--     applied type/health/last-telemetry plus the edge-local commissioning
--     view (source='local': the :8484 inverter selection + sources, which
--     have no registry counterpart and are never auto-imported). Written by
--     EntityStatusListener (the ControlStatusListener pattern), replaced
--     wholesale per heartbeat.
--
-- Both tenant-scoped + RLS exactly like measurement_point; the api writes
-- them through the RLS app datasource under the topic/caller tenant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_registry_state (
    site_id     UUID        PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id   UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    device_id   UUID        REFERENCES device(id) ON DELETE SET NULL,
    revision    TEXT        NOT NULL,
    composed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_registry_state TO ${appDbUser};

ALTER TABLE entity_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_registry_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_registry_state_isolation ON entity_registry_state;
CREATE POLICY entity_registry_state_isolation ON entity_registry_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS entity_observed_state (
    device_id        UUID        NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    entity_id        TEXT        NOT NULL,
    tenant_id        UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    -- 'registry' = an applied registry entity's observed state;
    -- 'local' = an edge-local commissioning item (inverter / source).
    source           TEXT        NOT NULL DEFAULT 'registry',
    entity_type      TEXT,
    health           TEXT,
    label            TEXT,
    last_telemetry_at TIMESTAMPTZ,
    applied_revision TEXT,
    channels         JSONB,
    reported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_observed_site ON entity_observed_state (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_observed_state TO ${appDbUser};

ALTER TABLE entity_observed_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_observed_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_observed_state_isolation ON entity_observed_state;
CREATE POLICY entity_observed_state_isolation ON entity_observed_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

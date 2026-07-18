-- =============================================================================
-- V20260719000000 - Flow definitions (E3a flow-editor MVP), ADDITIVE.
-- -----------------------------------------------------------------------------
-- Stores the typed flow documents the portal flow editor builds (contract:
-- docs/contracts/v2/flow-graph.md + flow-graph.schema.json). One row per
-- (flow_id, flow_version); the DOCUMENT column carries the contract JSON
-- verbatim, sibling columns denormalize what list queries and the lifecycle
-- state machine need. The AUTHORITATIVE lifecycle lives here (the document's
-- `lifecycle` field is an informative snapshot per contract §5):
--   draft -> simulated -> active -> retired, at most ONE active version per
--   flow (partial unique index below).
--
-- `simulation` records the last dry-run summary of the version (job id,
-- which scenario of the Ersparnis-Simulation represents this flow, headline
-- euros) - display data, never authoritative. `artifact` is reserved for the
-- compiled flow-artifact once the E2 compiler lands (activation stores it so
-- rollback = republishing a previous version's artifact); NULL until then.
--
-- Tenant-scoped + RLS exactly like measurement_point (admin surfaces reach it
-- through the X-Tenant-Id switcher over the RLS app datasource - no BYPASSRLS).
-- =============================================================================

CREATE TABLE IF NOT EXISTS flow_definition (
    flow_id      UUID        NOT NULL,
    flow_version INTEGER     NOT NULL CHECK (flow_version >= 1),
    tenant_id    UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id      UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    runtime      TEXT        NOT NULL DEFAULT 'edge' CHECK (runtime IN ('edge', 'cloud')),
    lifecycle    TEXT        NOT NULL DEFAULT 'draft'
                 CHECK (lifecycle IN ('draft', 'simulated', 'active', 'retired')),
    document     JSONB       NOT NULL,
    simulation   JSONB,
    artifact     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    simulated_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    PRIMARY KEY (flow_id, flow_version)
);

CREATE INDEX IF NOT EXISTS idx_flow_definition_site ON flow_definition (site_id);

-- Contract flow-graph.md §5: at most one ACTIVE version per flow.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_definition_one_active
    ON flow_definition (flow_id) WHERE lifecycle = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_definition TO ${appDbUser};

ALTER TABLE flow_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_definition_isolation ON flow_definition;
CREATE POLICY flow_definition_isolation ON flow_definition
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

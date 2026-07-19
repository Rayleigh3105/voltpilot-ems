-- =============================================================================
-- V20260719060000 - per-site gated strategy-node enablement (AE7 governance).
-- -----------------------------------------------------------------------------
-- Node governance (spec adaptive-ems-ui-v1-spec.md §3): market-/grid-near
-- strategy nodes (Arbitrage vp.strategy.market, Peak-Shaving
-- vp.strategy.peakshaving, atypische NN vp.strategy.atypical-grid) are GATED -
-- they need VoltPilot enablement/contract (Erlösbeteiligung/Messkonzept). They
-- stay placeable in a draft but a flow carrying such a node cannot be ACTIVATED
-- until a Portal-Admin enables that node type for the site.
--
-- The static gated/free classification lives in the flow catalog (the `gated`
-- flag per node type). This table records the per-SITE enablement of a gated
-- node type (a row = an explicit decision; no row = disabled, the fail-safe
-- default). Free node types never appear here.
--
-- Tenant-scoped + RLS exactly like flow_definition / measurement_point. The
-- admin writes it through the RLS-scoped app datasource via the X-Tenant-Id
-- switcher. Date-based version per the AGENTS.md coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS flow_gated_node_enablement (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id     UUID        NOT NULL REFERENCES site(id)  ON DELETE CASCADE,
    -- The gated catalog node type, e.g. 'vp.strategy.market'.
    node_type   TEXT        NOT NULL,
    -- Explicit enable/disable. A present row with FALSE keeps the node type
    -- gated but records that VoltPilot considered it (audit); absence = disabled.
    enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_flow_gated_node_enablement UNIQUE (site_id, node_type)
);

CREATE INDEX IF NOT EXISTS idx_flow_gated_node_enablement_site
    ON flow_gated_node_enablement (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_gated_node_enablement TO ${appDbUser};

ALTER TABLE flow_gated_node_enablement ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_gated_node_enablement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_gated_node_enablement_isolation ON flow_gated_node_enablement;
CREATE POLICY flow_gated_node_enablement_isolation ON flow_gated_node_enablement
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================================================
-- V20260723010000 - Flow canvas layout (Portal v3 M5 Part A), ADDITIVE.
-- -----------------------------------------------------------------------------
-- The portal's automation editor lets a customer DRAG nodes. Those positions
-- must never reach the flow document or the compiled artifact:
--   * docs/contracts/v2/flow-graph.schema.json is `additionalProperties: false`
--     and carries no positions, and
--   * flowc assigns the artifact bundle's x/y itself, INSIDE `content_hash`.
-- A position stored in the document would therefore change the content hash on
-- every mouse move and re-deploy the device. Layout is a PORTAL concern and
-- lives here, in its own table.
--
-- Keyed on flow_id, NOT (flow_id, flow_version): layout follows the flow
-- IDENTITY, so a forked draft inherits the positions the customer arranged.
-- `positions` is {"<nodeId>": {"x": <num>, "y": <num>}}; unknown node ids are
-- dropped server-side on write, so a stale layout can never resurrect a node.
--
-- Tenant-scoped + RLS exactly like flow_definition (V20260719000000): admin
-- surfaces reach it through the X-Tenant-Id switcher over the RLS app
-- datasource - no BYPASSRLS anywhere.
-- =============================================================================

CREATE TABLE IF NOT EXISTS flow_layout (
    flow_id    UUID        PRIMARY KEY,
    tenant_id  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id    UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    positions  JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_layout_site ON flow_layout (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_layout TO ${appDbUser};

ALTER TABLE flow_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_layout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_layout_isolation ON flow_layout;
CREATE POLICY flow_layout_isolation ON flow_layout
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

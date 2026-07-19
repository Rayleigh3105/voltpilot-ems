-- =============================================================================
-- V20260719040000 - capability -> role assignment overrides (AE1), ADDITIVE.
-- -----------------------------------------------------------------------------
-- The Anlagen-Topologie-Read-Model (spec adaptive-ems-ui-v1-spec.md §10,
-- contract docs/contracts/v2/topology-read-model.md) assigns EACH capability of
-- an entity to a ROLE (pv / storage / grid / consumer). A hybrid inverter maps
-- to several roles at once (its pv_power_kw -> pv, its battery_power_kw/soc_pct
-- -> storage); several entities aggregate into one role (Σ PV).
--
-- Absent an override the role is DERIVED from the measure channel + the entity
-- category (topology.DefaultRole, the ONE mapping shared Go↔TS↔Java), so v1 /
-- pilot sites need NO row here and resolve identically on the edge (no DB) and
-- in the cloud. This table records the FREELY-SETTABLE overrides (customer /
-- admin: "diese Fähigkeit gehört zu …") plus the maßgeblich (is_primary) flag
-- that picks THE authoritative measurement when a role has several candidates
-- (the connection-point grid reading; the battery that supplies the SoC).
--
-- Tenant-scoped + RLS exactly like measurement_point. Date-based version per the
-- AGENTS.md coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_role_assignment (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id     UUID        NOT NULL REFERENCES site(id)  ON DELETE CASCADE,
    -- The v2 entity this override belongs to (a measurement_point row with a
    -- non-NULL entity_type). CASCADE so deleting the entity drops its overrides.
    entity_id   UUID        NOT NULL REFERENCES measurement_point(id) ON DELETE CASCADE,
    -- The measure channel being (re)assigned, e.g. 'pv_power_kw', 'power_kw'.
    capability  TEXT        NOT NULL,
    -- The assigned role: 'pv' | 'storage' | 'grid' | 'consumer' (extensible);
    -- '' would mean "informational, no role", but a stored row always names one.
    role        TEXT        NOT NULL,
    -- maßgeblich: THE authoritative member of its role (grid connection point /
    -- SoC-supplying battery). At most one primary per (site, role) is the
    -- product rule; enforced by the service, not a DB constraint (a role's
    -- membership spans entities, and overrides are sparse).
    is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One override per (entity, capability); re-assigning UPSERTs it.
    CONSTRAINT uq_entity_role_assignment UNIQUE (entity_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_entity_role_assignment_site
    ON entity_role_assignment (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_role_assignment TO ${appDbUser};

ALTER TABLE entity_role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_role_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_role_assignment_isolation ON entity_role_assignment;
CREATE POLICY entity_role_assignment_isolation ON entity_role_assignment
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

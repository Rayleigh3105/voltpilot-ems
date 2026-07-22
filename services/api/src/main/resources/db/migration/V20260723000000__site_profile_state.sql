-- =============================================================================
-- V20260723000000 - per-Anlage Modus-Profil state (Portal v3 M3), ADDITIVE.
-- -----------------------------------------------------------------------------
-- Portal v3 turns a plant's feature set into a visible SHELF with switches
-- (docs/portal-v3/M3-profile.md): Eigenverbrauch, Marktoptimierung, Gewerbe
-- (Lastspitzenkappung), ... - customer-switchable, several active at once.
--
-- This table stores ONLY the customer's INTENT, never the derived profile: the
-- derivation (`activeModes` in the portal / `UsageProfileDeriver` signals here)
-- stays the single truth (the AE7 rule). A row is an explicit customer
-- decision; NO ROW means "derived default", which is exactly why every existing
-- plant is untouched by this migration.
--
-- There are exactly TWO states - `an` and `aus`. There is deliberately NO
-- "angefragt": the owner decided every profile is a direct customer toggle,
-- with no VoltPilot-request wall (M3-profile.md). `aus` is load-bearing: it
-- SUPPRESSES a mode that the derivation would otherwise re-activate, so
-- switching a profile off cannot be silently undone by a re-derived signal.
--
-- Tenant-scoped + RLS exactly like flow_definition / flow_gated_node_enablement
-- (the customer writes it through the RLS-scoped app datasource; an admin
-- reaches it via the X-Tenant-Id switcher - no BYPASSRLS). Date-based version
-- per the AGENTS.md coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_profile_state (
    site_id    UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    -- The profile id (the M0 mode kind): 'eigenverbrauch', 'marktvermarktung',
    -- 'lastspitzenkappung', 'atypische-netznutzung', ... - an OPEN vocabulary,
    -- like the v2 entity types: adding a profile is catalog data, not DDL.
    profile    TEXT        NOT NULL,
    state      TEXT        NOT NULL CHECK (state IN ('an', 'aus')),
    tenant_id  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, profile)
);

CREATE INDEX IF NOT EXISTS idx_site_profile_state_site ON site_profile_state (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_profile_state TO ${appDbUser};

ALTER TABLE site_profile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_profile_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_profile_state_isolation ON site_profile_state;
CREATE POLICY site_profile_state_isolation ON site_profile_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

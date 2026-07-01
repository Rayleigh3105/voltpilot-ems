-- =============================================================================
-- V2 - Row-Level-Security (architecture sections 9 & 14.1).
-- -----------------------------------------------------------------------------
-- Every request runs a `set_config('app.tenant_id', <jwt tenant_id>, ...)` on
-- its connection (see TenantAwareDataSource). The policies below turn that one
-- session variable into transparent per-tenant scoping on every table, so no
-- query can read or write another tenant's rows regardless of application bugs.
--
-- Predicate helper: NULLIF(current_setting('app.tenant_id', true), '')::uuid
--   - current_setting(..., true) -> NULL when the GUC was never set (missing_ok)
--   - NULLIF(..., '') guards against an empty string ever reaching ::uuid
--   - NULL compared to tenant_id yields no rows => secure default-deny.
-- =============================================================================

-- Grant the app role table access; RLS then narrows what it can see/write.
GRANT USAGE ON SCHEMA public TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, site, device, asset, telemetry TO ${appDbUser};
-- New tables created later inherit these grants for the app role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appDbUser};

-- tenant: scoped by its own primary key.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant;
CREATE POLICY tenant_isolation ON tenant
    USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- site / device / asset / telemetry: scoped by their tenant_id column.
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
ALTER TABLE site FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_isolation ON site;
CREATE POLICY site_isolation ON site
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device ENABLE ROW LEVEL SECURITY;
ALTER TABLE device FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_isolation ON device;
CREATE POLICY device_isolation ON device
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_isolation ON asset;
CREATE POLICY asset_isolation ON asset
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Telemetry is a TimescaleDB hypertable; enabling RLS on the parent applies the
-- policy transparently to every chunk.
ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_isolation ON telemetry;
CREATE POLICY telemetry_isolation ON telemetry
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

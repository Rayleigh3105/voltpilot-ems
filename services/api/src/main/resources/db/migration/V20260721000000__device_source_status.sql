-- =============================================================================
-- V20260721000000 - Per-measurement-point Ist (device_source_status).
-- -----------------------------------------------------------------------------
-- A multi-inverter site's portal PV is ONE composite number ("39,0 kW"), so the
-- customer could not see it is the sum of several devices - the parts existed
-- only on the edge's own :8484 page (PV incident 2026-07-21). The edge now
-- folds a per-measurement-point block into its status heartbeat
-- (ems/{t}/{s}/{d}/status, additive `sources` block): the primary inverter plus
-- every configured source with its OWN latest reading and freshness. The api's
-- source-status listener replaces the reporting device's whole set here (the
-- heartbeat carries the COMPLETE Ist, so a partial merge would keep ghosts),
-- and the portal renders the calm PV breakdown under the live PV figure.
--
-- Display-only: nothing here feeds telemetry, rollups, earnings or the
-- optimizer - the composite telemetry path is untouched.
--
-- Tenant-scoped + RLS exactly like device_control_status (the listener runs as
-- the app role with the topic's tenant in app.tenant_id; WITH CHECK guarantees
-- the row lands in that tenant).
--
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_source_status (
    device_id   UUID          NOT NULL,
    source_id   TEXT          NOT NULL,
    tenant_id   UUID          NOT NULL,
    site_id     UUID          NOT NULL,
    kind        TEXT          NOT NULL,   -- primary | source
    role        TEXT,                     -- pv-generation | grid-meter | consumer
    label       TEXT,                     -- customer-facing name (brand/model)
    brand       TEXT,
    model       TEXT,
    pv_kw       DOUBLE PRECISION,         -- NULL = the point does not measure it
    power_kw    DOUBLE PRECISION,         -- signed, +import / -export
    load_kw     DOUBLE PRECISION,
    health      TEXT          NOT NULL,   -- ok | stale | never
    read_at     TIMESTAMPTZ,
    reported_at TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (device_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_device_source_status_site
    ON device_source_status (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_source_status TO ${appDbUser};

ALTER TABLE device_source_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_source_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_source_status_isolation ON device_source_status;
CREATE POLICY device_source_status_isolation ON device_source_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

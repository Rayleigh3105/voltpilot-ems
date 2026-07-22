-- =============================================================================
-- V20260723020000 - Live flow state from the device (Portal v3 M5 Part B + C).
-- -----------------------------------------------------------------------------
-- Two ADDITIVE, display-only tables fed by the FOURTH sibling listener on
-- ems/+/+/+/status (next to the control / entity / source listeners), each
-- REPLACING the reporting device's whole set (the heartbeat carries the
-- complete Ist, so a partial merge would keep ghosts):
--
--  * flow_device_ack  - the device's acknowledgement of the deployed artifacts
--    (the heartbeat's EXISTING `flows` block: flow_id, flow_version,
--    content_hash, state active|error|unsupported). This is what makes the
--    editor open the version that is REALLY running ("Läuft auf dem Gerät ·
--    v4") instead of the one the cloud last activated.
--  * flow_node_status - the per-node live state ("erfüllt", "EIN seit 14:02")
--    from the NEW, feature-flagged `flow_node_status` block. Old edges simply
--    do not send it and the editor falls back to channel values only - it never
--    guesses a node state.
--
-- Nothing here feeds telemetry, rollups, earnings or the optimizer.
--
-- Tenant-scoped + RLS exactly like device_control_status / device_source_status.
-- =============================================================================

CREATE TABLE IF NOT EXISTS flow_device_ack (
    device_id    UUID        NOT NULL,
    flow_id      UUID        NOT NULL,
    tenant_id    UUID        NOT NULL,
    site_id      UUID        NOT NULL,
    flow_version INTEGER     NOT NULL,
    content_hash TEXT,
    state        TEXT        NOT NULL,   -- active | error | unsupported
    detail       TEXT,
    reported_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, flow_id)
);

CREATE INDEX IF NOT EXISTS idx_flow_device_ack_site ON flow_device_ack (site_id);

CREATE TABLE IF NOT EXISTS flow_node_status (
    device_id   UUID        NOT NULL,
    flow_id     UUID        NOT NULL,
    node_id     TEXT        NOT NULL,
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    state       TEXT        NOT NULL,   -- active | idle | error
    text        TEXT,
    since       TIMESTAMPTZ,
    reported_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, flow_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_flow_node_status_site ON flow_node_status (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_device_ack  TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_node_status TO ${appDbUser};

ALTER TABLE flow_device_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_device_ack FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_device_ack_isolation ON flow_device_ack;
CREATE POLICY flow_device_ack_isolation ON flow_device_ack
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE flow_node_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_node_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_node_status_isolation ON flow_node_status;
CREATE POLICY flow_node_status_isolation ON flow_node_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

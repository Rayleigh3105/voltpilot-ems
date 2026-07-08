-- =============================================================================
-- V20260708000000 - Inverter control confirmation (device_control_status).
-- -----------------------------------------------------------------------------
-- The edge folds a compact control readback into its status heartbeat
-- (ems/{t}/{s}/{d}/status, additive `control` block - report §5.3): what the
-- schedule commanded vs. what the inverter read back, with an all-match verdict.
-- The api's status listener upserts the latest such block here, one row per
-- device, so the portal can render a calm "Steuerung" strip ("Fahrplan-Sollwert
-- X -> Wechselrichter bestätigt Y", healthy | mismatch | stale).
--
-- Tenant-scoped + RLS exactly like every device-owned write (the listener runs
-- as the app role with the topic's tenant in app.tenant_id, and the WITH CHECK
-- guarantees the row lands in that tenant). Liveness ("geprüft vor X") derives
-- from checked_at, mirroring telemetry freshness.
--
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_control_status (
    device_id       UUID          PRIMARY KEY,
    tenant_id       UUID          NOT NULL,
    site_id         UUID          NOT NULL,
    commanded_kw    DOUBLE PRECISION,
    confirmed_kw    DOUBLE PRECISION,
    all_match       BOOLEAN       NOT NULL,
    control_enabled BOOLEAN       NOT NULL,
    certified       BOOLEAN       NOT NULL,
    mismatch_roles  TEXT,
    slot_start      TIMESTAMPTZ,
    checked_at      TIMESTAMPTZ   NOT NULL,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_control_status_site
    ON device_control_status (site_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_control_status TO ${appDbUser};

ALTER TABLE device_control_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_control_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_control_status_isolation ON device_control_status;
CREATE POLICY device_control_status_isolation ON device_control_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

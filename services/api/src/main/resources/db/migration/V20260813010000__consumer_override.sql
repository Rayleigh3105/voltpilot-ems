-- =============================================================================
-- V20260813010000 - consumer_override: the record of a TTL-bound MANUAL
-- intervention (Inkrement 5 / §11 override + §14.13 Sofortaktionen). ADDITIVE.
-- -----------------------------------------------------------------------------
-- "Jetzt starten" / "Jetzt stoppen" from the consumer detail head place a
-- time-limited manual wish; "Automatik fortsetzen" clears it. The record is the
-- cloud-side truth the portal reads ("Eingriff aktiv bis HH:MM") and the audit
-- anchor; the physical override rides the existing edge desired-override path
-- (Source local-ui, class flow, override, bounded TTL - never retained as an
-- immortal wish, §16). One row per consumer, replaced on a new override.
--
--   kind             start | stop  (start = run at value, stop = force off)
--   target_command   on_off | setpoint_kw
--   target_value     the setpoint kW (setpoint_kw), else NULL
--   ends_at          the TTL horizon - a manual override is never open-ended.
--
-- Also WIDENS the consumer_audit_event event_type CHECK (V20260812010000) to
-- carry the manual-override actions - an applied migration is immutable, so the
-- constraint is dropped + re-added here.
--
-- Tenant-scoped + ENABLE/FORCE RLS + default-deny like consumer_runtime_status.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consumer_override (
    entity_id       UUID          PRIMARY KEY,
    tenant_id       UUID          NOT NULL,
    site_id         UUID          NOT NULL,
    kind            TEXT          NOT NULL CHECK (kind IN ('start', 'stop')),
    target_command  TEXT          NOT NULL CHECK (target_command IN ('on_off', 'setpoint_kw')),
    target_value    NUMERIC(10,3),
    ends_at         TIMESTAMPTZ   NOT NULL,
    created_by      TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumer_override_site
    ON consumer_override (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_override TO ${appDbUser};

ALTER TABLE consumer_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_override FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_override_isolation ON consumer_override;
CREATE POLICY consumer_override_isolation ON consumer_override
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Widen the audit event vocabulary to include the manual-override actions.
ALTER TABLE consumer_audit_event DROP CONSTRAINT IF EXISTS consumer_audit_event_event_type_check;
ALTER TABLE consumer_audit_event ADD CONSTRAINT consumer_audit_event_event_type_check
    CHECK (event_type IN ('policy_saved', 'policy_activated', 'policy_deactivated',
                          'paused', 'resumed', 'override_started', 'override_stopped',
                          'override_cleared'));

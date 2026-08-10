-- Verbrauchssteuerung Inkrement 4 (§16): the append-only audit trail of every
-- consumer-policy lifecycle action - save, activate, deactivate, pause, resume.
-- One row per action, never updated, never deleted by the app role. The policy
-- VERSIONS themselves live in consumer_policy (lifecycle draft|active|retired);
-- this table answers WHO did WHAT WHEN, which the version rows alone cannot
-- (a pause touches no policy row at all).
--
-- Tenant-scoped + ENABLE/FORCE ROW LEVEL SECURITY + default-deny exactly like
-- consumer_profile/consumer_policy (V20260810000000). The app role gets
-- SELECT + INSERT only - an audit trail is append-only by construction.
--
-- Footgun (the rollout_event lesson, root AGENTS.md "OTA Stufe 2"): the
-- BIGSERIAL needs its OWN GRANT USAGE ON SEQUENCE - default table privileges
-- do not cover sequences, and without it the INSERT dies with "permission
-- denied for sequence" on exactly the write that carries the paper trail.

CREATE TABLE IF NOT EXISTS consumer_audit_event (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    site_id         UUID        NOT NULL,
    entity_id       UUID        NOT NULL,
    event_type      TEXT        NOT NULL CHECK (event_type IN
                        ('policy_saved', 'policy_activated', 'policy_deactivated',
                         'paused', 'resumed')),
    policy_id       UUID,
    policy_version  INTEGER,
    actor           TEXT,
    detail          TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumer_audit_site_time
    ON consumer_audit_event (site_id, occurred_at DESC);

GRANT SELECT, INSERT ON consumer_audit_event TO ${appDbUser};
GRANT USAGE ON SEQUENCE consumer_audit_event_id_seq TO ${appDbUser};

ALTER TABLE consumer_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_audit_event FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_audit_event_isolation ON consumer_audit_event;
CREATE POLICY consumer_audit_event_isolation ON consumer_audit_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

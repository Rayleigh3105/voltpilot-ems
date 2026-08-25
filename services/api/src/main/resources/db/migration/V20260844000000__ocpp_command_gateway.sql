-- Slice 11/12: durable OCPP 1.6 command choreography.
-- A command is a customer intent, not a claim that the station acted.
CREATE TABLE ocpp_action_intent (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL,
    device_id UUID,
    charge_point_id TEXT NOT NULL,
    action TEXT NOT NULL,
    phrase TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ocpp_action (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL,
    device_id UUID NOT NULL,
    charge_point_id TEXT NOT NULL,
    action TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'prepared','sent','accepted_waiting_effect','effect_observed','completed',
        'rejected','call_error','not_sendable','transport_failed','timed_out','cancelled')),
    correlation_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL,
    actor TEXT NOT NULL,
    connector_id INTEGER,
    transaction_id INTEGER,
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_status TEXT,
    effect_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason TEXT,
    prepared_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    response_at TIMESTAMPTZ,
    effect_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_ocpp_action_site_time ON ocpp_action (site_id, prepared_at DESC);
CREATE INDEX idx_ocpp_action_station_active ON ocpp_action (device_id, charge_point_id, action)
    WHERE state IN ('prepared','sent','accepted_waiting_effect');
CREATE UNIQUE INDEX uq_ocpp_action_station_running ON ocpp_action (device_id, charge_point_id, action)
    WHERE state IN ('prepared','sent','accepted_waiting_effect');

CREATE TABLE ocpp_action_audit (
    id BIGSERIAL PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES ocpp_action(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL,
    device_id UUID NOT NULL,
    charge_point_id TEXT NOT NULL,
    connector_id INTEGER,
    transaction_id INTEGER,
    actor TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ocpp_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpp_action FORCE ROW LEVEL SECURITY;
CREATE POLICY ocpp_action_isolation ON ocpp_action
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE ocpp_action_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpp_action_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY ocpp_action_audit_isolation ON ocpp_action_audit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE ocpp_action_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpp_action_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY ocpp_action_intent_isolation ON ocpp_action_intent
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ocpp_action, ocpp_action_audit, ocpp_action_intent TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE ocpp_action_audit_id_seq TO ${appDbUser};

ALTER TABLE ocpp_action
  ADD CONSTRAINT ocpp_action_device_scope_fk FOREIGN KEY (device_id, site_id, tenant_id)
  REFERENCES device (id, site_id, tenant_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE ocpp_action VALIDATE CONSTRAINT ocpp_action_device_scope_fk;

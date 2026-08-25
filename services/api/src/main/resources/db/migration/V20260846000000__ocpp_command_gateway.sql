-- V20260846000000 - Slice 11/12: durable OCPP 1.6 command choreography.
-- A command is a customer intent, not a claim that the station acted.
ALTER TABLE ocpp_protocol_event ADD COLUMN wire_id TEXT;

CREATE TABLE ocpp_action_intent (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL,
    device_id UUID NOT NULL,
    charge_point_id TEXT NOT NULL,
    action TEXT NOT NULL,
    phrase TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    connector_id INTEGER,
    transaction_id INTEGER,
    four_eyes BOOLEAN NOT NULL DEFAULT FALSE,
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
        'rejected','call_error','edge_rejected','effect_failed','not_sendable',
        'transport_failed','timed_out','cancelled')),
    correlation_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    conflict_key TEXT NOT NULL,
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
CREATE INDEX idx_ocpp_action_station_active ON ocpp_action (device_id, charge_point_id, conflict_key)
    WHERE state IN ('prepared','sent','accepted_waiting_effect');
CREATE UNIQUE INDEX uq_ocpp_action_station_running ON ocpp_action (device_id, charge_point_id, conflict_key)
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

-- Registry entries are admitted only after the platform has verified the
-- detached signature. Command execution must match all three immutable
-- artifact facts byte-for-byte; a caller cannot turn a plausible-looking
-- hash/signature string into an allowlisted firmware image.
CREATE TABLE ocpp_firmware_artifact (
    id UUID PRIMARY KEY,
    location TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    signature TEXT NOT NULL,
    signing_key_id TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    UNIQUE (location, sha256, signature)
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

-- Scheduler maintenance has no request-scoped tenant. Keep the application
-- role default-deny under RLS and expose only these narrowly-scoped,
-- owner-executed operations. The expiry function also writes the immutable
-- audit transition in the same statement as the state change.
CREATE FUNCTION expire_ocpp_actions(p_now TIMESTAMPTZ) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed INTEGER;
BEGIN
  WITH expired AS (
    UPDATE public.ocpp_action
       SET state = CASE WHEN state = 'prepared' THEN 'transport_failed' ELSE 'timed_out' END,
           reason = CASE
             WHEN state = 'prepared' THEN 'Befehl wurde vor Fristablauf nicht an die Edge übergeben.'
             WHEN state = 'sent' THEN 'Keine OCPP-Antwort innerhalb der aktionsspezifischen Frist.'
             ELSE 'Angenommen, aber kein passender Wirkungsbeleg innerhalb der aktionsspezifischen Frist.'
           END,
           updated_at = p_now
     WHERE state IN ('prepared','sent','accepted_waiting_effect') AND deadline_at <= p_now
     RETURNING *
  ), audited AS (
    INSERT INTO public.ocpp_action_audit(action_id, tenant_id, site_id, device_id,
      charge_point_id, connector_id, transaction_id, actor, state, reason, occurred_at)
    SELECT id, tenant_id, site_id, device_id, charge_point_id, connector_id,
      transaction_id, 'system', state, reason, p_now FROM expired
    RETURNING 1
  )
  SELECT count(*) INTO changed FROM audited;
  RETURN changed;
END $$;

CREATE FUNCTION purge_ocpp_action_history(p_action_cutoff TIMESTAMPTZ, p_intent_cutoff TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed INTEGER;
BEGIN
  DELETE FROM public.ocpp_action_intent
    WHERE created_at < p_intent_cutoff AND (consumed_at IS NOT NULL OR expires_at < p_intent_cutoff);
  DELETE FROM public.ocpp_action
    WHERE updated_at < p_action_cutoff
      AND state NOT IN ('prepared','sent','accepted_waiting_effect');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;

-- Explicit customer data erasure is the only non-retention path that may
-- remove an audit chain before its normal cutoff. Keep that privilege behind
-- a tenant-bound function instead of granting DELETE on any lifecycle table.
-- Exactly one scope is accepted so a programming error cannot widen a device
-- purge into a tenant-wide delete.
CREATE FUNCTION purge_ocpp_action_scope(p_site UUID, p_device UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_scope UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  changed INTEGER;
BEGIN
  IF tenant_scope IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  IF (p_site IS NULL) = (p_device IS NULL) THEN
    RAISE EXCEPTION 'exactly one purge scope is required' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.ocpp_action_intent
    WHERE tenant_id = tenant_scope
      AND ((p_site IS NOT NULL AND site_id = p_site)
        OR (p_device IS NOT NULL AND device_id = p_device));
  DELETE FROM public.ocpp_action
    WHERE tenant_id = tenant_scope
      AND ((p_site IS NOT NULL AND site_id = p_site)
        OR (p_device IS NOT NULL AND device_id = p_device));
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION expire_ocpp_actions(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_ocpp_action_history(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_ocpp_action_scope(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_ocpp_actions(TIMESTAMPTZ) TO ${appDbUser};
GRANT EXECUTE ON FUNCTION purge_ocpp_action_history(TIMESTAMPTZ, TIMESTAMPTZ) TO ${appDbUser};
GRANT EXECUTE ON FUNCTION purge_ocpp_action_scope(UUID, UUID) TO ${appDbUser};

GRANT SELECT, INSERT, UPDATE ON ocpp_action, ocpp_action_intent TO ${appDbUser};
GRANT SELECT, INSERT ON ocpp_action_audit TO ${appDbUser};
GRANT SELECT ON ocpp_firmware_artifact TO ${appDbUser};
REVOKE DELETE ON ocpp_action, ocpp_action_intent FROM ${appDbUser};
REVOKE UPDATE, DELETE ON ocpp_action_audit FROM ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE ocpp_action_audit_id_seq TO ${appDbUser};

ALTER TABLE ocpp_action
  ADD CONSTRAINT ocpp_action_device_scope_fk FOREIGN KEY (device_id, site_id, tenant_id)
  REFERENCES device (id, site_id, tenant_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE ocpp_action_intent
  ADD CONSTRAINT ocpp_action_intent_device_scope_fk FOREIGN KEY (device_id, site_id, tenant_id)
  REFERENCES device (id, site_id, tenant_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE ocpp_action VALIDATE CONSTRAINT ocpp_action_device_scope_fk;

-- Geräte-Erlebnis, Slices 2-4: auditierbarer Bearbeitungsvertrag.
--
-- component_definition bleibt die append-only Wahrheit jeder vollständigen
-- Fassung. Diese kleine Ereignisspur ergänzt die SEMANTIK eines Wechsels
-- (insbesondere der Gerätefamilie), ohne alte Messwerte oder alte Fassungen
-- umzuschreiben. Ein family_changed-Marker ist daher ein Zeitpunkt, niemals
-- ein Auftrag zur rückwirkenden Neudekodierung.
CREATE TABLE IF NOT EXISTS component_change_event (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id         UUID NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    entity_id       UUID NOT NULL REFERENCES measurement_point(id) ON DELETE CASCADE,
    revision        INTEGER NOT NULL CHECK (revision >= 1),
    event_type      TEXT NOT NULL CHECK (event_type IN ('edited', 'family_changed', 'rolled_back')),
    effective_at    TIMESTAMPTZ NOT NULL,
    from_value      TEXT,
    to_value        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    note            TEXT
);
-- Audit history survives site/device offboarding; a cascading FK would
-- otherwise invoke the append-only DELETE guard during legitimate cleanup.
ALTER TABLE component_change_event DROP CONSTRAINT IF EXISTS component_change_event_tenant_id_fkey;
ALTER TABLE component_change_event DROP CONSTRAINT IF EXISTS component_change_event_site_id_fkey;
ALTER TABLE component_change_event DROP CONSTRAINT IF EXISTS component_change_event_entity_id_fkey;

-- Full semantic snapshot for a rollback (not only transport metadata).
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS capacity_kwp NUMERIC;
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS control BOOLEAN;
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS capabilities JSONB;
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS guard_config JSONB;
ALTER TABLE component_definition ADD COLUMN IF NOT EXISTS registry_unit_id TEXT;

CREATE INDEX IF NOT EXISTS idx_component_change_event_entity
    ON component_change_event (site_id, entity_id, effective_at DESC, id DESC);

GRANT SELECT, INSERT ON component_change_event TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE component_change_event_id_seq TO ${appDbUser};

ALTER TABLE component_change_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_change_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS component_change_event_isolation ON component_change_event;
CREATE POLICY component_change_event_isolation ON component_change_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Der Standort ist ausdrücklich KEIN Feld des allgemeinen Assistenten. Dieser
-- Revisionszähler und die eigene Historie tragen den separaten Verschiebeweg.
ALTER TABLE device ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS device_site_assignment (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    revision        INTEGER NOT NULL CHECK (revision >= 1),
    -- Bewusst nur UUID-Snapshots: ein späteres Löschen/Offboarding eines
    -- Standorts darf weder blockiert werden noch den damaligen Umzug fälschen.
    from_site_id    UUID NOT NULL,
    to_site_id      UUID NOT NULL,
    effective_at    TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CHECK (from_site_id <> to_site_id)
);
ALTER TABLE device_site_assignment DROP CONSTRAINT IF EXISTS device_site_assignment_tenant_id_fkey;
ALTER TABLE device_site_assignment DROP CONSTRAINT IF EXISTS device_site_assignment_device_id_fkey;

CREATE INDEX IF NOT EXISTS idx_device_site_assignment_device
    ON device_site_assignment (device_id, revision DESC);
GRANT SELECT, INSERT ON device_site_assignment TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE device_site_assignment_id_seq TO ${appDbUser};
ALTER TABLE device_site_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_site_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_site_assignment_isolation ON device_site_assignment;
CREATE POLICY device_site_assignment_isolation ON device_site_assignment
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Durable external activation.  DB state is committed first; workers may
-- retry broker delivery and the API can report the honest state.
CREATE TABLE IF NOT EXISTS component_activation_outbox (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    site_id         UUID NOT NULL,
    operation       TEXT NOT NULL CHECK (operation IN ('component_edit', 'component_rollback')),
    entity_id       UUID NOT NULL,
    revision        INTEGER NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'refused')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at      TIMESTAMPTZ,
    UNIQUE (entity_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_component_activation_outbox_pending
    ON component_activation_outbox (status, created_at);
GRANT SELECT, INSERT, UPDATE ON component_activation_outbox TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE component_activation_outbox_id_seq TO ${appDbUser};
ALTER TABLE component_activation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_activation_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY component_activation_outbox_isolation ON component_activation_outbox
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS move_provisioning_operation (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    device_id       UUID NOT NULL,
    from_site_id    UUID NOT NULL,
    to_site_id      UUID NOT NULL,
    revision        INTEGER NOT NULL,
    external_ref    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'refused')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at      TIMESTAMPTZ,
    UNIQUE (device_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_move_provisioning_pending
    ON move_provisioning_operation (status, created_at);
GRANT SELECT, INSERT, UPDATE ON move_provisioning_operation TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE move_provisioning_operation_id_seq TO ${appDbUser};
ALTER TABLE move_provisioning_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE move_provisioning_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY move_provisioning_operation_isolation ON move_provisioning_operation
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Audit rows are append-only at the database boundary, not merely by API
-- convention.  The application role can insert and read, never rewrite.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are append-only';
END $$;
DROP TRIGGER IF EXISTS component_change_event_append_only ON component_change_event;
CREATE TRIGGER component_change_event_append_only BEFORE UPDATE OR DELETE ON component_change_event
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS device_site_assignment_append_only ON device_site_assignment;
CREATE TRIGGER device_site_assignment_append_only BEFORE UPDATE OR DELETE ON device_site_assignment
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Eine Verbraucher-Konfiguration folgt beim Verschieben atomisch ihrer stabilen
-- Entität. Ohne ON UPDATE CASCADE wäre dieselbe Identität technisch
-- unverrückbar, obwohl gerade sie erhalten bleiben soll.
ALTER TABLE consumer_profile DROP CONSTRAINT IF EXISTS consumer_profile_entity_consistency;
ALTER TABLE consumer_profile ADD CONSTRAINT consumer_profile_entity_consistency
    FOREIGN KEY (entity_id, tenant_id, site_id)
    REFERENCES measurement_point (id, tenant_id, site_id) ON UPDATE CASCADE;

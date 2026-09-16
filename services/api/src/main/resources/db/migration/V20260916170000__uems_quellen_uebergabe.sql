-- AP-06 IP-7: Ausführung getrennt von der geplanten Zuständigkeit.
-- Keine Bestandszeile ändern. Keine FK auf löschbare Objekte: kein Löschweg wird enger.
-- nextval ist auch nach einem Rollback verbraucht: eine versandte Fassung nie wiederverwenden.
CREATE SEQUENCE data_source_registry_revision_seq;
GRANT USAGE ON SEQUENCE data_source_registry_revision_seq TO ${appDbUser};

CREATE TABLE data_source_handover (
    tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    data_source_id uuid NOT NULL,
    site_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    reader_id uuid NOT NULL,
    target_id uuid NOT NULL,
    phase text NOT NULL CHECK (phase IN ('active', 'pending', 'reconciling', 'removing', 'receiving')),
    due_at timestamptz NOT NULL,
    started_at timestamptz,
    sent_revision text,
    event_id uuid NOT NULL,
    -- Kein Freigeben aus einem Entzug derselben noch offenen Fachtransaktion.
    written_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (tenant_id, data_source_id)
);
CREATE INDEX data_source_handover_site ON data_source_handover (site_id);
ALTER TABLE data_source_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source_handover FORCE ROW LEVEL SECURITY;
CREATE POLICY data_source_handover_isolation ON data_source_handover
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON data_source_handover TO ${appDbUser};

-- Auch ein leerer Registry-Herzschlag ist eine Rückmeldung. entity_observed_state
-- hat dafür keine Zeile; fehlende Rückmeldung ist niemals eine Quittung.
CREATE TABLE data_source_box_receipt (
    tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    revision text,
    received_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, device_id)
);
ALTER TABLE data_source_box_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source_box_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY data_source_box_receipt_isolation ON data_source_box_receipt
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON data_source_box_receipt TO ${appDbUser};

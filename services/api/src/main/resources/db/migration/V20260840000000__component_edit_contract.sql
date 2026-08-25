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

CREATE INDEX IF NOT EXISTS idx_component_change_event_entity
    ON component_change_event (site_id, entity_id, effective_at DESC, id DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON component_change_event TO ${appDbUser};
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

CREATE INDEX IF NOT EXISTS idx_device_site_assignment_device
    ON device_site_assignment (device_id, revision DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON device_site_assignment TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE device_site_assignment_id_seq TO ${appDbUser};
ALTER TABLE device_site_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_site_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_site_assignment_isolation ON device_site_assignment;
CREATE POLICY device_site_assignment_isolation ON device_site_assignment
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Eine Verbraucher-Konfiguration folgt beim Verschieben atomisch ihrer stabilen
-- Entität. Ohne ON UPDATE CASCADE wäre dieselbe Identität technisch
-- unverrückbar, obwohl gerade sie erhalten bleiben soll.
ALTER TABLE consumer_profile DROP CONSTRAINT IF EXISTS consumer_profile_entity_consistency;
ALTER TABLE consumer_profile ADD CONSTRAINT consumer_profile_entity_consistency
    FOREIGN KEY (entity_id, tenant_id, site_id)
    REFERENCES measurement_point (id, tenant_id, site_id) ON UPDATE CASCADE;

-- Nur bestätigte Entscheidungen; Lesen erzeugt keine Zeilen und keine Anschlüsse.
-- Keine Übernahme von Preis-/Grenzwerten und keine Änderung bestehender site-Zeilen.
CREATE TABLE netzanschluss_vorschlag_entscheidung (
    tenant_id UUID NOT NULL REFERENCES tenant(id),
    site_id UUID NOT NULL,
    entscheidung TEXT NOT NULL CHECK (entscheidung IN ('uebernommen', 'verworfen')),
    entschieden_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    entschieden_von TEXT NOT NULL,
    PRIMARY KEY (tenant_id, site_id),
    FOREIGN KEY (site_id, tenant_id) REFERENCES site(id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE netzanschluss_vorschlag_entscheidung ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss_vorschlag_entscheidung FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON netzanschluss_vorschlag_entscheidung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON netzanschluss_vorschlag_entscheidung FROM voltpilot_app;
GRANT SELECT, INSERT ON netzanschluss_vorschlag_entscheidung TO voltpilot_app;

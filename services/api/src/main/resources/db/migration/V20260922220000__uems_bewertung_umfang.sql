-- AP-16 IP-5, U1/U2/N4: leere, additive Fassungen am Unternehmen.
CREATE TABLE bewertung_umfang (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    unternehmen_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    gueltig_ab DATE NOT NULL,
    traeger TEXT[] NOT NULL CHECK (cardinality(traeger) > 0
        AND array_position(traeger, NULL) IS NULL
        AND traeger <@ ARRAY['Strom','Gas','Wärme','Kälte','Wasser','Druckluft']::text[]),
    begruendung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aufgehoben_am TIMESTAMPTZ,
    UNIQUE (id, tenant_id),
    UNIQUE (tenant_id, unternehmen_id, fassung),
    FOREIGN KEY (unternehmen_id, tenant_id) REFERENCES unternehmen(id, tenant_id) ON DELETE RESTRICT,
    CHECK (actor_art IN ('kunde','unterstuetzung','voltpilot','notfall')),
    CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator','energiemanager','bearbeiter','bedienberechtigt','leser','unterstuetzer','voltpilot_betrieb')),
    CHECK ((actor_sub IS NOT NULL AND btrim(actor_sub) <> '') OR actor_art = 'voltpilot')
);
CREATE UNIQUE INDEX bewertung_umfang_laufend ON bewertung_umfang(tenant_id, unternehmen_id)
    WHERE aufgehoben_am IS NULL;

CREATE TABLE bewertung_umfang_standort (
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    umfang_id UUID NOT NULL,
    standort_id UUID NOT NULL,
    PRIMARY KEY (tenant_id, umfang_id, standort_id),
    FOREIGN KEY (umfang_id, tenant_id) REFERENCES bewertung_umfang(id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (standort_id, tenant_id) REFERENCES standort(id, tenant_id) ON DELETE RESTRICT
);
CREATE TABLE bewertung_umfang_ausschluss (
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    umfang_id UUID NOT NULL,
    art TEXT NOT NULL CHECK (art IN ('standort','anlage','prozess')),
    verweis UUID NOT NULL,
    begruendung TEXT NOT NULL CHECK (btrim(begruendung) <> ''),
    PRIMARY KEY (tenant_id, umfang_id, art, verweis),
    FOREIGN KEY (umfang_id, tenant_id) REFERENCES bewertung_umfang(id, tenant_id) ON DELETE RESTRICT
);
-- Nur beim Anlegen prüfen: der Anlagen-Löschweg bleibt wie bei anlage_standort offen,
-- der historische Ausschluss bleibt erhalten. Kein CASCADE, kein neuer Bestands-Schreibweg.
CREATE FUNCTION bewertung_umfang_verweis_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM bewertung_umfang u WHERE u.id = NEW.umfang_id AND u.tenant_id = NEW.tenant_id
        AND CASE NEW.art
            WHEN 'standort' THEN EXISTS (SELECT 1 FROM standort s WHERE s.id = NEW.verweis
                AND s.tenant_id = NEW.tenant_id AND s.unternehmen_id = u.unternehmen_id)
            WHEN 'anlage' THEN EXISTS (SELECT 1 FROM site s WHERE s.id = NEW.verweis AND s.tenant_id = NEW.tenant_id)
            WHEN 'prozess' THEN EXISTS (SELECT 1 FROM prozess p WHERE p.id = NEW.verweis
                AND p.tenant_id = NEW.tenant_id AND p.unternehmen_id = u.unternehmen_id)
            ELSE false END) THEN
        RAISE EXCEPTION 'Unbekannter Ausschlussverweis' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bewertung_umfang_verweis_pruefen BEFORE INSERT ON bewertung_umfang_ausschluss
    FOR EACH ROW EXECUTE FUNCTION bewertung_umfang_verweis_pruefen();

CREATE TABLE bewertung_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    art TEXT NOT NULL CHECK (art IN ('umfang_angelegt','umfang_geaendert')),
    alt JSONB,
    neu JSONB,
    actor_sub TEXT,
    actor_name TEXT NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (actor_art IN ('kunde','unterstuetzung','voltpilot','notfall')),
    CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator','energiemanager','bearbeiter','bedienberechtigt','leser','unterstuetzer','voltpilot_betrieb')),
    CHECK ((actor_sub IS NOT NULL AND btrim(actor_sub) <> '') OR actor_art = 'voltpilot')
);

ALTER TABLE bewertung_umfang ENABLE ROW LEVEL SECURITY;
ALTER TABLE bewertung_umfang FORCE ROW LEVEL SECURITY;
CREATE POLICY bewertung_umfang_tenant_isolation ON bewertung_umfang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON bewertung_umfang FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bewertung_umfang TO ${appDbUser};
GRANT SELECT, DELETE ON bewertung_umfang TO ${adminDbUser};

ALTER TABLE bewertung_umfang_standort ENABLE ROW LEVEL SECURITY;
ALTER TABLE bewertung_umfang_standort FORCE ROW LEVEL SECURITY;
CREATE POLICY bewertung_umfang_standort_tenant_isolation ON bewertung_umfang_standort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON bewertung_umfang_standort FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bewertung_umfang_standort TO ${appDbUser};
GRANT SELECT, DELETE ON bewertung_umfang_standort TO ${adminDbUser};

ALTER TABLE bewertung_umfang_ausschluss ENABLE ROW LEVEL SECURITY;
ALTER TABLE bewertung_umfang_ausschluss FORCE ROW LEVEL SECURITY;
CREATE POLICY bewertung_umfang_ausschluss_tenant_isolation ON bewertung_umfang_ausschluss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON bewertung_umfang_ausschluss FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bewertung_umfang_ausschluss TO ${appDbUser};
GRANT SELECT, DELETE ON bewertung_umfang_ausschluss TO ${adminDbUser};

ALTER TABLE bewertung_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bewertung_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY bewertung_aenderung_tenant_isolation ON bewertung_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON bewertung_aenderung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bewertung_aenderung TO ${appDbUser};
GRANT SELECT, DELETE ON bewertung_aenderung TO ${adminDbUser};

GRANT UPDATE (aufgehoben_am) ON bewertung_umfang TO ${appDbUser};
REVOKE ALL ON SEQUENCE bewertung_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE bewertung_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};

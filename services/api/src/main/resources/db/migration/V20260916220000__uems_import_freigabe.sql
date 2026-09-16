-- AP-09 IP-13: Import-Berichtigungen und Rücknahmen verwenden die bestehende
-- Korrektur-Freigabe. Der Auftrag enthält ausschließlich normalisierte Werte,
-- keine Kopie der Datei. Jede Entscheidung ist eine neue, unveränderliche Fassung.
CREATE TABLE bezugsdaten_import_freigabe (
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennung TEXT NOT NULL CHECK (kennung ~ '^I-[0-9]{4}-[0-9]{4,}$'),
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    import_fassung INTEGER GENERATED ALWAYS AS (1) STORED,
    status TEXT NOT NULL CHECK (status IN ('vorschlag', 'freigegeben')),
    grund TEXT NOT NULL CHECK (bezugsdaten_begruendung_gueltig(grund)),
    ruecknahme BOOLEAN NOT NULL,
    auftrag JSONB NOT NULL CHECK (jsonb_typeof(auftrag) = 'array' AND jsonb_array_length(auftrag) > 0),
    actor_sub TEXT NOT NULL CHECK (btrim(actor_sub) <> ''),
    actor_name TEXT NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle TEXT CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
        'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    actor_art TEXT NOT NULL CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, kennung, fassung),
    FOREIGN KEY (tenant_id, kennung, import_fassung)
        REFERENCES bezugsdaten_import(tenant_id, kennung, fassung) ON DELETE RESTRICT
);
CREATE TRIGGER bezugsdaten_import_freigabe_append_only BEFORE UPDATE ON bezugsdaten_import_freigabe
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
ALTER TABLE bezugsdaten_import_freigabe ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsdaten_import_freigabe FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsdaten_import_freigabe_tenant ON bezugsdaten_import_freigabe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON bezugsdaten_import_freigabe TO ${appDbUser};
GRANT INSERT (tenant_id, kennung, fassung, status, grund, ruecknahme, auftrag,
    actor_sub, actor_name, actor_rolle, actor_art) ON bezugsdaten_import_freigabe TO ${appDbUser};
GRANT SELECT, DELETE ON bezugsdaten_import_freigabe TO ${adminDbUser};

-- Jede Zeile eines Imports ist ein eigener Kaskaden-Anlass. Sonst würde die
-- erste Fassung 2 den Anlass der zweiten Zeile mit derselben Fassung verbrauchen.
ALTER TABLE messreihe_kaskade_wirkung DROP CONSTRAINT messreihe_kaskade_wirkung_kennung_chk;
ALTER TABLE messreihe_kaskade_wirkung ADD CONSTRAINT messreihe_kaskade_wirkung_kennung_chk CHECK (
    anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^BK-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^I-[0-9]{4}-[0-9]{4,}/Zeile-[1-9][0-9]*/Fassung-[1-9][0-9]*$'
    OR anlass_kennung ~ '^kennzahl_fassung:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR anlass_kennung ~ '^bezugsgroesse_stammdatum:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR anlass_kennung ~ '^ort_flaeche:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

CREATE FUNCTION bezugsdaten_import_freigabe_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alt bezugsdaten_import_freigabe%ROWTYPE;
BEGIN
    SELECT * INTO alt FROM bezugsdaten_import_freigabe
      WHERE tenant_id=NEW.tenant_id AND kennung=NEW.kennung ORDER BY fassung DESC LIMIT 1;
    IF NEW.fassung <> coalesce(alt.fassung,0)+1
       OR (alt.status IS NULL AND NEW.status <> 'vorschlag')
       OR (alt.status = 'vorschlag' AND (NEW.status <> 'freigegeben'
           OR NEW.auftrag <> alt.auftrag OR NEW.ruecknahme <> alt.ruecknahme))
       OR (alt.status = 'freigegeben' AND (NEW.status <> 'vorschlag' OR NOT NEW.ruecknahme OR alt.ruecknahme)) THEN
        RAISE EXCEPTION 'Import-Freigabe: unzulässige Folgefassung' USING ERRCODE='check_violation';
    END IF;
    IF NEW.status='freigegeben' AND NEW.actor_sub=alt.actor_sub
       AND EXISTS (SELECT 1 FROM unternehmen WHERE tenant_id=NEW.tenant_id AND vieraugen_freigabe) THEN
        RAISE EXCEPTION 'Import-Freigabe: zweite Person erforderlich' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugsdaten_import_freigabe_folgt BEFORE INSERT ON bezugsdaten_import_freigabe
    FOR EACH ROW EXECUTE FUNCTION bezugsdaten_import_freigabe_folgt();

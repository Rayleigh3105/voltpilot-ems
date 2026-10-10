-- UEMS AP-19 IP-23 (MG4–MG7): Sitzung, Beschlüsse und Folgen der Managementbewertung — die
-- Entscheidungen der Leitung, die keine Vorlage erzeugen kann. Drei neue, leere Tabellen am
-- Bericht der Vorlage `managementbewertung` (IP-22); keine Spalte, kein CHECK und keine
-- Bestandszeile einer anderen Tabelle ändert sich.
--
--   managementbewertung_sitzung    MG4: je Managementbewertung eine Sitzung — Tag, Leitung
--                                  (eine Person, PA3), Teilnehmende (Personen), wahlfrei Ort;
--                                  bis zur Freigabe änderbar (der Dienst sperrt danach).
--   managementbewertung_beschluss  MG5: Nr. n, Art aus `beschluss_art`, Wortlaut, entschieden
--                                  von (die Leitung), wahlfrei zuständig und Termin; bis zur
--                                  Freigabe änderbar, danach Teil des Stands (die Kopie steht im
--                                  Abzug des Berichtsstands, AP-12 F2).
--   managementbewertung_folge      MG6: nur anhängen — die Hand-Verknüpfung Beschluss × Objekt
--                                  (Energieziel, Dokument-Fassung, Aufgabe, internes Audit), genau
--                                  ein Objekt je Zeile. Maßnahmen verknüpfen sich selbst über ihre
--                                  Herkunft `managementbewertung` (BR-…/Bn); Aufgabe, Fassung und
--                                  „geprüft, bleibt“ über ihre `beschluss_kennung` — gelesen, nie
--                                  kopiert. Eine Folge ändert den Stand nicht.
--
-- `bericht_id` ohne Fremdschlüssel: kein Weg zu den Berichts-Tabellen wird enger (UemsBerichtMigrationTest
-- „kein bestehender Weg wird enger“, Muster der Kennungen als Wert); Berichte werden nie gelöscht, nur das
-- Offboarding entfernt sie — und löscht diese drei Tabellen vorher (TenantRepository). Geschrieben wird nur unter der
-- Sperre des Berichts (BerichtService#managementbewertungEingabe).
--
-- Rechte: die App-Rolle liest und legt an; Sitzung und Beschluss ändern nur benannte Spalten,
-- eine Folge nie; gelöscht wird nie — nur das administrative Offboarding (TenantRepository).
-- RLS mit FORCE; die Managementbewertung gilt für das Unternehmen: im engen Zaun (Teilansicht)
-- keine Zeile — wie ein Audit ohne Standort (IP-16).

CREATE TABLE managementbewertung_sitzung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    bericht_id UUID NOT NULL,
    tag DATE NOT NULL,
    leitung_person_id UUID NOT NULL,
    teilnehmende UUID[] NOT NULL DEFAULT '{}',
    ort TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT managementbewertung_sitzung_bericht_uq UNIQUE (tenant_id, bericht_id),
    CONSTRAINT managementbewertung_sitzung_leitung_fk FOREIGN KEY (leitung_person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_sitzung_teilnehmende_chk CHECK (
        array_position(teilnehmende, NULL) IS NULL AND cardinality(teilnehmende) <= 50),
    CONSTRAINT managementbewertung_sitzung_ort_chk CHECK (
        ort IS NULL OR (btrim(ort) <> '' AND char_length(ort) <= 200)),
    CONSTRAINT managementbewertung_sitzung_actor_art_chk CHECK (
        actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT managementbewertung_sitzung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

CREATE TABLE managementbewertung_beschluss (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    bericht_id UUID NOT NULL,
    nr INTEGER NOT NULL CHECK (nr BETWEEN 1 AND 999),
    art TEXT NOT NULL,
    wortlaut TEXT NOT NULL,
    entschieden_von UUID NOT NULL,
    zustaendig UUID,
    termin DATE,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT managementbewertung_beschluss_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT managementbewertung_beschluss_nr_uq UNIQUE (tenant_id, bericht_id, nr),
    CONSTRAINT managementbewertung_beschluss_entschieden_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_beschluss_zustaendig_fk FOREIGN KEY (zustaendig, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_beschluss_art_chk CHECK (
        coalesce(energiemanagement_wort('beschluss_art', art), false)),
    CONSTRAINT managementbewertung_beschluss_wortlaut_chk CHECK (
        btrim(wortlaut) <> '' AND char_length(wortlaut) <= 2000),
    CONSTRAINT managementbewertung_beschluss_actor_art_chk CHECK (
        actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT managementbewertung_beschluss_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

CREATE TABLE managementbewertung_folge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    beschluss_id UUID NOT NULL,
    art TEXT NOT NULL,
    energieziel_id UUID,
    fassung_id UUID,
    aufgabe_id UUID,
    audit_id UUID,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT managementbewertung_folge_beschluss_fk FOREIGN KEY (beschluss_id, tenant_id)
        REFERENCES managementbewertung_beschluss(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_folge_energieziel_fk FOREIGN KEY (energieziel_id, tenant_id)
        REFERENCES energieziel(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_folge_fassung_fk FOREIGN KEY (fassung_id, tenant_id)
        REFERENCES energiemanagement_dokument_fassung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_folge_aufgabe_fk FOREIGN KEY (aufgabe_id, tenant_id)
        REFERENCES energiemanagement_aufgabe(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT managementbewertung_folge_audit_fk FOREIGN KEY (audit_id, tenant_id)
        REFERENCES internes_audit(id, tenant_id) ON DELETE RESTRICT,
    -- Die Maßnahme verknüpft sich selbst (Herkunft), darum hat die Hand-Verknüpfung vier Arten.
    CONSTRAINT managementbewertung_folge_art_chk CHECK (
        coalesce(energiemanagement_wort('folge_art', art), false) AND art <> 'massnahme'),
    CONSTRAINT managementbewertung_folge_objekt_chk CHECK (num_nonnulls(energieziel_id, fassung_id, aufgabe_id, audit_id) = 1
        AND (art <> 'energieziel' OR energieziel_id IS NOT NULL)
        AND (art <> 'dokument' OR fassung_id IS NOT NULL)
        AND (art <> 'aufgabe' OR aufgabe_id IS NOT NULL)
        AND (art <> 'audit' OR audit_id IS NOT NULL)),
    CONSTRAINT managementbewertung_folge_actor_art_chk CHECK (
        actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT managementbewertung_folge_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- Dasselbe Objekt hängt an einem Beschluss höchstens einmal.
CREATE UNIQUE INDEX managementbewertung_folge_objekt_uq ON managementbewertung_folge
    (tenant_id, beschluss_id, art, coalesce(energieziel_id, fassung_id, aufgabe_id, audit_id));
CREATE INDEX managementbewertung_beschluss_bericht_idx ON managementbewertung_beschluss (tenant_id, bericht_id);

-- -----------------------------------------------------------------------------
-- RLS: Mandant, und nur unternehmensweit — die Managementbewertung hat keinen Standort.
-- -----------------------------------------------------------------------------
ALTER TABLE managementbewertung_sitzung ENABLE ROW LEVEL SECURITY;
ALTER TABLE managementbewertung_sitzung FORCE ROW LEVEL SECURITY;
CREATE POLICY managementbewertung_sitzung_tenant_isolation ON managementbewertung_sitzung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON managementbewertung_sitzung AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());
ALTER TABLE managementbewertung_beschluss ENABLE ROW LEVEL SECURITY;
ALTER TABLE managementbewertung_beschluss FORCE ROW LEVEL SECURITY;
CREATE POLICY managementbewertung_beschluss_tenant_isolation ON managementbewertung_beschluss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON managementbewertung_beschluss AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());
ALTER TABLE managementbewertung_folge ENABLE ROW LEVEL SECURITY;
ALTER TABLE managementbewertung_folge FORCE ROW LEVEL SECURITY;
CREATE POLICY managementbewertung_folge_tenant_isolation ON managementbewertung_folge
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON managementbewertung_folge AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

REVOKE ALL ON managementbewertung_sitzung, managementbewertung_beschluss, managementbewertung_folge
    FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON managementbewertung_sitzung, managementbewertung_beschluss, managementbewertung_folge
    TO ${appDbUser};
GRANT UPDATE (tag, leitung_person_id, teilnehmende, ort, actor_sub, actor_name, actor_rolle, actor_art, geaendert_am)
    ON managementbewertung_sitzung TO ${appDbUser};
GRANT UPDATE (art, wortlaut, entschieden_von, zustaendig, termin, actor_sub, actor_name, actor_rolle, actor_art,
    geaendert_am) ON managementbewertung_beschluss TO ${appDbUser};
GRANT SELECT, DELETE ON managementbewertung_sitzung, managementbewertung_beschluss, managementbewertung_folge
    TO ${adminDbUser};

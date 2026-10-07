-- =============================================================================
-- Konzept Nachweisen n1, Runde 2, PR 6 (Entscheid 7): „Unterlagen zusammenstellen“ - die Mappe für eine Prüfung
-- von außen (Vertrag energiemanagement 1.6, Vokabular `mappe_anlass`).
--
-- 1. Neu und leer: energiemanagement_mappe. Eine Mappe hält fest, wer wann wofür (Anlass) welche Gruppen des
--    Verzeichnisses für welchen Zeitraum zusammengestellt hat, mit den Teilen, die dabei offen waren, und die beiden
--    Dateien, die daraus entstanden: das PDF mit Inhaltsverzeichnis und die Verzeichnis-CSV, je mit Prüfsumme.
--    Abrufbar sind die Dateien 30 Tage (`abrufbar_bis`, echte Zeit); danach leert die App-Rolle die beiden
--    Datei-Spalten, die Angaben bleiben als Nachweis, dass es die Mappe gab. Sonst ändert sich nie etwas.
-- 2. Neu und leer: energiemanagement_mappe_abruf. Jeder Abruf einer Datei (PDF oder CSV) wird protokolliert: welche
--    Mappe, welches Format, wer und wann. Nur anhängen.
--
-- 3. Geweitet (Vereinigung, nie enger): energiemanagement_vokabular() trägt alle Wörter von V20261007004500 Zeile für
--    Zeile mit derselben Nummer und dazu den Block `mappe_anlass` (zeilengleich zu `energiemanagement-vectors.json` 1.6,
--    nach `teil` wie im Vertrag); der Anlass einer Mappe prüft über energiemanagement_wort() wie jedes Vokabular.
--
-- Keine bestehende Tabelle, kein CHECK und keine Zeile ändert sich (Invariante 1). Wer keine Mappe anlegt, merkt nichts.
-- Späte Ankunft: die Funktion wird als Ganzes ersetzt; die Migrationstests, die V20261007004500 mitreisen lassen,
-- lassen auch diese mitreisen. Die Tabellen brauchen `tenant`, `uems_zugriff_unternehmensweit()` und
-- energiemanagement_wort() (V20260925013500).
-- =============================================================================

CREATE OR REPLACE FUNCTION energiemanagement_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('dokument_art', 1, 'energiepolitik'),
    ('dokument_art', 2, 'anwendungsbereich'),
    ('dokument_art', 3, 'kontext'),
    ('dokument_art', 4, 'rechtliche_anforderungen'),
    ('dokument_art', 5, 'risiken_chancen'),
    ('dokument_art', 6, 'bestellung'),
    ('dokument_art', 7, 'verfahren'),
    ('dokument_art', 8, 'betrieb'),
    ('dokument_art', 9, 'beschaffung'),
    ('dokument_art', 10, 'kommunikation'),
    ('dokument_art', 11, 'auslegung'),
    ('dokument_art', 12, 'kompetenz'),
    ('dokument_klasse', 1, 'vorgabe'),
    ('dokument_klasse', 2, 'nachweis'),
    ('dokument_zustand', 1, 'entwurf'),
    ('dokument_zustand', 2, 'gueltig'),
    ('dokument_zustand', 3, 'aufgehoben'),
    ('dokument_bezug', 1, 'unternehmen'),
    ('dokument_bezug', 2, 'standort'),
    ('dokument_bezug', 3, 'energieeinsatz'),
    ('dokument_bezug', 4, 'person'),
    ('dokument_bezug', 5, 'aufgabe'),
    ('fassung_form', 1, 'wortlaut'),
    ('fassung_form', 2, 'verweis'),
    ('fassung_status', 1, 'entwurf'),
    ('fassung_status', 2, 'beantragt'),
    ('fassung_status', 3, 'freigegeben'),
    ('fassung_status', 4, 'abgelehnt'),
    ('fassung_status', 5, 'abgeloest'),
    ('dokument_eintrag', 1, 'bekannt_gemacht'),
    ('dokument_eintrag', 2, 'geprueft_bleibt'),
    ('dokument_eintrag', 3, 'aufgehoben'),
    ('dokument_eintrag', 4, 'kommentar'),
    ('bekanntmachung_weg', 1, 'aushang'),
    ('bekanntmachung_weg', 2, 'intranet'),
    ('bekanntmachung_weg', 3, 'unterweisung'),
    ('bekanntmachung_weg', 4, 'besprechung'),
    ('bekanntmachung_weg', 5, 'e_mail'),
    ('bekanntmachung_weg', 6, 'weiterer'),
    ('aufgabe', 1, 'unternehmensleitung'),
    ('aufgabe', 2, 'energiemanagement_leiten'),
    ('aufgabe', 3, 'energieteam'),
    ('aufgabe', 4, 'bezugsbasen'),
    ('aufgabe', 5, 'energieziele_massnahmen'),
    ('aufgabe', 6, 'bewertung_messplanung'),
    ('aufgabe', 7, 'interne_audits'),
    ('aufgabe', 8, 'managementbewertung'),
    ('aufgabe', 9, 'dokumente'),
    ('aufgabe', 10, 'weitere'),
    ('person_zustand', 1, 'aktiv'),
    ('person_zustand', 2, 'beendet'),
    ('aufgabe_zustand', 1, 'laufend'),
    ('aufgabe_zustand', 2, 'beendet'),
    ('audit_zustand', 1, 'geplant'),
    ('audit_zustand', 2, 'durchgefuehrt'),
    ('audit_zustand', 3, 'abgeschlossen'),
    ('audit_zustand', 4, 'abgesagt'),
    ('audit_eintrag', 1, 'hinweis'),
    ('audit_eintrag', 2, 'kommentar'),
    ('feststellung_quelle', 1, 'internes_audit'),
    ('feststellung_quelle', 2, 'eigene'),
    ('feststellung_quelle', 3, 'extern'),
    ('feststellung_quelle', 4, 'managementbewertung'),
    ('feststellung_zustand', 1, 'offen'),
    ('feststellung_zustand', 2, 'abgeschlossen'),
    ('feststellung_eintrag', 1, 'kommentar'),
    ('feststellung_eintrag', 2, 'behebung'),
    ('feststellung_eintrag', 3, 'ursache_aussage'),
    ('feststellung_eintrag', 4, 'aehnliche_faelle'),
    ('wirksamkeit_ergebnis', 1, 'wirksam'),
    ('wirksamkeit_ergebnis', 2, 'nicht_wirksam'),
    ('wirksamkeit_ergebnis', 3, 'ohne_massnahme'),
    ('wirksamkeit_ergebnis', 4, 'zurueckgenommen'),
    ('managementbewertung_zustand', 1, 'entwurf'),
    ('managementbewertung_zustand', 2, 'freigegeben'),
    ('beschluss_art', 1, 'energieziel'),
    ('beschluss_art', 2, 'massnahme'),
    ('beschluss_art', 3, 'dokument'),
    ('beschluss_art', 4, 'aufgabe'),
    ('beschluss_art', 5, 'ressourcen'),
    ('beschluss_art', 6, 'audit'),
    ('beschluss_art', 7, 'keine_aenderung'),
    ('beschluss_art', 8, 'weitere'),
    ('folge_art', 1, 'energieziel'),
    ('folge_art', 2, 'massnahme'),
    ('folge_art', 3, 'dokument'),
    ('folge_art', 4, 'aufgabe'),
    ('folge_art', 5, 'audit'),
    ('wiedervorlage_art', 1, 'dokument_ueberpruefung'),
    ('wiedervorlage_art', 2, 'internes_audit'),
    ('wiedervorlage_art', 3, 'managementbewertung'),
    ('wiedervorlage_art', 4, 'feststellung'),
    ('wiedervorlage_art', 5, 'bewertung_ueberpruefung'),
    ('wiedervorlage_art', 6, 'bezugsbasis_ueberpruefung'),
    ('wiedervorlage_art', 7, 'energieziel_bewertung'),
    ('wiedervorlage_art', 8, 'massnahme_termin'),
    ('wiedervorlage_art', 9, 'abweichung_frist'),
    ('wiedervorlage_art', 10, 'messbedarf_frist'),
    ('wiedervorlage_art', 11, 'bericht_anstoss'),
    ('wiedervorlage_art', 12, 'zaehlerablesung'),
    ('verzeichnis_ort', 1, 'in_voltpilot'),
    ('verzeichnis_ort', 2, 'wortlaut_original_beim_kunden'),
    ('verzeichnis_ort', 3, 'verweis'),
    ('verzeichnis_gruppe', 1, 'grundlagen'),
    ('verzeichnis_gruppe', 2, 'verantwortung'),
    ('verzeichnis_gruppe', 3, 'risiken_chancen'),
    ('verzeichnis_gruppe', 4, 'kompetenz_kommunikation'),
    ('verzeichnis_gruppe', 5, 'betrieb_auslegung_beschaffung'),
    ('verzeichnis_gruppe', 6, 'bewertung_messplanung'),
    ('verzeichnis_gruppe', 7, 'kennzahlen_bezugsbasen'),
    ('verzeichnis_gruppe', 8, 'ziele_massnahmen_abweichungen'),
    ('verzeichnis_gruppe', 9, 'audits_feststellungen'),
    ('verzeichnis_gruppe', 10, 'managementbewertung'),
    ('verzeichnis_gruppe', 11, 'berichte'),
    ('ueberpruefung_art', 1, 'dokument'),
    ('ueberpruefung_art', 2, 'internes_audit'),
    ('ueberpruefung_art', 3, 'managementbewertung'),
    ('ueberpruefung_art', 4, 'feststellung'),
    ('ueberpruefung_grund', 1, 'nachweis'),
    ('ueberpruefung_grund', 2, 'keine_fassung'),
    ('ueberpruefung_grund', 3, 'kein_audit'),
    ('ueberpruefung_grund', 4, 'keine_managementbewertung'),
    ('ueberpruefung_grund', 5, 'abgeschlossen'),
    ('teil', 1, 'energiepolitik'),
    ('teil', 2, 'anwendungsbereich'),
    ('teil', 3, 'rechtliche_anforderungen'),
    ('teil', 4, 'kontext'),
    ('teil', 5, 'risiken_chancen'),
    ('teil', 6, 'aufgaben'),
    ('teil', 7, 'kompetenz'),
    ('teil', 8, 'kommunikation'),
    ('teil', 9, 'betrieb'),
    ('teil', 10, 'auslegung'),
    ('teil', 11, 'beschaffung'),
    ('teil', 12, 'energetische_bewertung'),
    ('teil', 13, 'bezugsbasen'),
    ('teil', 14, 'massnahmen'),
    ('teil', 15, 'interne_audits'),
    ('teil', 16, 'feststellungen'),
    ('teil', 17, 'managementbewertung'),
    ('teil', 18, 'berichte'),
    ('mappe_anlass', 1, 'audit_von_aussen'),
    ('mappe_anlass', 2, 'anfrage_behoerde'),
    ('mappe_anlass', 3, 'eigene_ablage'),
    ('leitungs_pflicht', 1, 'energiepolitik'),
    ('leitungs_pflicht', 2, 'anwendungsbereich'),
    ('leitungs_pflicht', 3, 'bestellung'),
    ('kennung_art', 1, 'D'),
    ('kennung_art', 2, 'AU'),
    ('kennung_art', 3, 'F'),
    ('anwendungsbereich_ausschluss', 1, 'standort'),
    ('anwendungsbereich_ausschluss', 2, 'anlage'),
    ('anwendungsbereich_ausschluss', 3, 'prozess'),
    ('energiemanagement_protokoll', 1, 'person_erfasst'),
    ('energiemanagement_protokoll', 2, 'person_geaendert'),
    ('energiemanagement_protokoll', 3, 'person_beendet'),
    ('energiemanagement_protokoll', 4, 'aufgabe_zugeordnet'),
    ('energiemanagement_protokoll', 5, 'aufgabe_beendet'),
    ('energiemanagement_protokoll', 6, 'dokument_angelegt'),
    ('energiemanagement_protokoll', 7, 'fassung_entworfen'),
    ('energiemanagement_protokoll', 8, 'fassung_beantragt'),
    ('energiemanagement_protokoll', 9, 'fassung_freigegeben'),
    ('energiemanagement_protokoll', 10, 'fassung_abgelehnt'),
    ('energiemanagement_protokoll', 11, 'dokument_gueltig'),
    ('energiemanagement_protokoll', 12, 'fassung_abgeloest'),
    ('energiemanagement_protokoll', 13, 'geprueft_bleibt'),
    ('energiemanagement_protokoll', 14, 'bekannt_gemacht'),
    ('energiemanagement_protokoll', 15, 'dokument_aufgehoben'),
    ('energiemanagement_protokoll', 16, 'einstellung_geaendert'),
    ('energiemanagement_protokoll', 17, 'audit_geplant'),
    ('energiemanagement_protokoll', 18, 'audit_geaendert'),
    ('energiemanagement_protokoll', 19, 'audit_durchgefuehrt'),
    ('energiemanagement_protokoll', 20, 'hinweis'),
    ('energiemanagement_protokoll', 21, 'audit_abgesagt'),
    ('energiemanagement_protokoll', 22, 'audit_abgeschlossen'),
    ('energiemanagement_protokoll', 23, 'feststellung_erfasst'),
    ('energiemanagement_protokoll', 24, 'eintrag'),
    ('energiemanagement_protokoll', 25, 'feststellung_geaendert'),
    ('energiemanagement_protokoll', 26, 'wirksamkeit_beantragt'),
    ('energiemanagement_protokoll', 27, 'wirksamkeit_geprueft'),
    ('energiemanagement_protokoll', 28, 'wirksamkeit_abgelehnt'),
    ('energiemanagement_protokoll', 29, 'feststellung_abgeschlossen')
$$;

CREATE TABLE energiemanagement_mappe (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    anlass TEXT NOT NULL,
    von DATE,
    bis DATE NOT NULL,
    gruppen TEXT[] NOT NULL,
    offen TEXT[] NOT NULL DEFAULT '{}',
    stichtag TIMESTAMPTZ NOT NULL,
    eintraege INTEGER NOT NULL,
    gilt INTEGER NOT NULL,
    pdf BYTEA,
    pdf_sha256 TEXT NOT NULL,
    csv BYTEA,
    csv_sha256 TEXT NOT NULL,
    abrufbar_bis TIMESTAMPTZ NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_mappe_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_mappe_anlass_chk CHECK (coalesce(energiemanagement_wort('mappe_anlass', anlass), false)),
    CONSTRAINT energiemanagement_mappe_zeitraum_chk CHECK (von IS NULL OR von <= bis),
    -- Die Gruppen des Verzeichnisses (Vokabular `verzeichnis_gruppe`), mindestens eine.
    CONSTRAINT energiemanagement_mappe_gruppen_chk CHECK (cardinality(gruppen) >= 1 AND gruppen <@ ARRAY['grundlagen',
        'verantwortung', 'risiken_chancen', 'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung',
        'bewertung_messplanung', 'kennzahlen_bezugsbasen', 'ziele_massnahmen_abweichungen', 'audits_feststellungen',
        'managementbewertung', 'berichte']::TEXT[]),
    -- Die Teile des Überblicks (Vokabular `teil`), die beim Zusammenstellen offen waren.
    CONSTRAINT energiemanagement_mappe_offen_chk CHECK (offen <@ ARRAY['energiepolitik', 'anwendungsbereich',
        'rechtliche_anforderungen', 'kontext', 'risiken_chancen', 'aufgaben', 'kompetenz', 'kommunikation', 'betrieb',
        'auslegung', 'beschaffung', 'energetische_bewertung', 'bezugsbasen', 'massnahmen', 'interne_audits',
        'feststellungen', 'managementbewertung', 'berichte']::TEXT[]),
    CONSTRAINT energiemanagement_mappe_zahlen_chk CHECK (eintraege >= 0 AND gilt >= 0),
    CONSTRAINT energiemanagement_mappe_sha_chk CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$' AND csv_sha256 ~ '^[0-9a-f]{64}$'),
    -- Die Dateien gehen nur gemeinsam (nach der Frist), nie eine allein.
    CONSTRAINT energiemanagement_mappe_dateien_chk CHECK ((pdf IS NULL) = (csv IS NULL)),
    CONSTRAINT energiemanagement_mappe_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_mappe_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb',
         'einsicht')),
    CONSTRAINT energiemanagement_mappe_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_mappe_tenant_idx ON energiemanagement_mappe (tenant_id, created_at DESC);

-- Eine Mappe ändert sich nie; nach der Frist werden nur ihre beiden Dateien geleert, einmal.
CREATE FUNCTION energiemanagement_mappe_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['pdf', 'csv']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['pdf', 'csv'])
        OR NEW.pdf IS NOT NULL OR NEW.csv IS NOT NULL OR OLD.pdf IS NULL THEN
        RAISE EXCEPTION 'Eine Mappe ändert sich nie; nach der Frist werden nur ihre Dateien geleert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_mappe_nur_leeren';
    END IF;
    IF OLD.abrufbar_bis > now() THEN
        RAISE EXCEPTION 'Die Mappe ist noch abrufbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_mappe_frist';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_mappe_eingefroren BEFORE UPDATE ON energiemanagement_mappe
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_mappe_eingefroren();

CREATE TABLE energiemanagement_mappe_abruf (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    mappe_id UUID NOT NULL,
    format TEXT NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_mappe_abruf_mappe_fk FOREIGN KEY (mappe_id, tenant_id)
        REFERENCES energiemanagement_mappe(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_mappe_abruf_format_chk CHECK (format IN ('pdf', 'csv')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb',
         'einsicht')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_mappe_abruf_mappe_idx ON energiemanagement_mappe_abruf (tenant_id, mappe_id, created_at);

-- RLS + FORCE und der Zaun wie bei den Vermerken (V20261007004500): die Mappe gehört dem ganzen Unternehmen, im
-- engen Standort-Zaun ist sie nicht sichtbar.
ALTER TABLE energiemanagement_mappe ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_mappe FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_mappe_tenant_isolation ON energiemanagement_mappe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_mappe AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

ALTER TABLE energiemanagement_mappe_abruf ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_mappe_abruf FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_mappe_abruf_tenant_isolation ON energiemanagement_mappe_abruf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_mappe_abruf AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

-- Grants: die App-Rolle liest und legt an, leert nach der Frist nur die Dateien und löscht nie; nur das
-- administrative Offboarding löscht (TenantRepository.offboard, das Protokoll vor der Mappe).
REVOKE ALL ON energiemanagement_mappe, energiemanagement_mappe_abruf FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energiemanagement_mappe TO ${appDbUser};
GRANT UPDATE (pdf, csv) ON energiemanagement_mappe TO ${appDbUser};
GRANT SELECT, INSERT ON energiemanagement_mappe_abruf TO ${appDbUser};
GRANT SELECT, DELETE ON energiemanagement_mappe, energiemanagement_mappe_abruf TO ${adminDbUser};

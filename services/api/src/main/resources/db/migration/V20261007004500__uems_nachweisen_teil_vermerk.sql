-- =============================================================================
-- Konzept Nachweisen n1, Runde 2, PR 1 (Captain-Freigabe 07.10.2026, Entscheide 5 und 23):
-- „Trifft bei uns zurzeit nicht zu“ je Teil des Überblicks (Vertrag energiemanagement 1.3).
--
-- 1. Geweitet (Vereinigung, nie enger): energiemanagement_vokabular() trägt alle Wörter von
--    V20261005220000 Zeile für Zeile mit derselben Nummer und dazu den Block `teil` (die 18 Teile,
--    zeilengleich zu `energiemanagement-vectors.json` 1.3, nach `ueberpruefung_grund` wie im Vertrag).
-- 2. Neu und leer: energiemanagement_teil_vermerk. Ein Vermerk sagt, dass ein Teil bei diesem
--    Unternehmen zurzeit nicht zutrifft: mit Satz (10–500 Zeichen, die Begründung des Vertrags) und
--    der Person, die es entschieden hat („entschieden von“, eine Person im Energiemanagement, auch ohne
--    Konto), dazu wer es eingetragen hat. Nur anhängen: außer dem einmaligen Aufheben ändert sich nie
--    etwas; höchstens ein geltender Vermerk je Teil. Ein Urteil fällt die Datenbank nicht: welcher Teil
--    zutrifft, entscheidet der Kunde.
--
-- Keine bestehende Tabelle, kein CHECK und keine Zeile ändert sich (Invariante 1). Wer nichts
-- vermerkt, merkt nichts.
--
-- Späte Ankunft: die Funktion wird als Ganzes ersetzt; auf einer Datenbank, die diese Version erst
-- nach jüngeren Migrationen erreicht, gilt dasselbe Ergebnis, solange keine jüngere Migration die
-- Funktion selbst ersetzt (die Migrationstests von IP-5, IP-16, AP-12 und IP-12 spielen sie darum mit).
-- Die Tabelle braucht nur `energiemanagement_person` (V20260925013500) und `uems_zugriff_unternehmensweit()`.
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

-- -----------------------------------------------------------------------------
-- energiemanagement_teil_vermerk: „Trifft bei uns zurzeit nicht zu“ je Teil.
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_teil_vermerk (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    teil TEXT NOT NULL,
    satz TEXT NOT NULL,
    entschieden_von UUID NOT NULL,
    entschieden_am DATE NOT NULL,
    aufgehoben_am TIMESTAMPTZ,
    aufgehoben_sub TEXT,
    aufgehoben_name TEXT,
    aufgehoben_rolle TEXT,
    aufgehoben_art TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_teil_vermerk_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_teil_vermerk_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_teil_vermerk_teil_chk CHECK (coalesce(energiemanagement_wort('teil', teil), false)),
    CONSTRAINT energiemanagement_teil_vermerk_satz_chk CHECK (char_length(btrim(satz)) BETWEEN 10 AND 500),
    -- Aufgehoben: Zeitpunkt und wer es eingetragen hat, ganz oder gar nicht.
    CONSTRAINT energiemanagement_teil_vermerk_aufgehoben_chk CHECK (
        (aufgehoben_am IS NULL) = (aufgehoben_name IS NULL)
        AND (aufgehoben_am IS NULL) = (aufgehoben_art IS NULL)
        AND (aufgehoben_am IS NOT NULL OR (aufgehoben_sub IS NULL AND aufgehoben_rolle IS NULL))
        AND (aufgehoben_name IS NULL OR btrim(aufgehoben_name) <> '')
        AND (aufgehoben_art IS NULL OR aufgehoben_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'))
        AND (aufgehoben_rolle IS NULL OR aufgehoben_rolle IN ('kundenadministrator', 'energiemanager', 'bearbeiter',
            'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb', 'einsicht'))),
    CONSTRAINT energiemanagement_teil_vermerk_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_teil_vermerk_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb',
         'einsicht')),
    CONSTRAINT energiemanagement_teil_vermerk_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- Höchstens ein geltender Vermerk je Teil; ein aufgehobener bleibt daneben stehen.
CREATE UNIQUE INDEX energiemanagement_teil_vermerk_geltend_uq ON energiemanagement_teil_vermerk (tenant_id, teil)
    WHERE aufgehoben_am IS NULL;

-- Nur anhängen: außer dem einmaligen Aufheben ändert sich nichts; ein aufgehobener Vermerk ist endgültig.
CREATE FUNCTION energiemanagement_teil_vermerk_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.aufgehoben_am IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Der Vermerk ist aufgehoben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_teil_vermerk_endgueltig';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['aufgehoben_am', 'aufgehoben_sub', 'aufgehoben_name', 'aufgehoben_rolle', 'aufgehoben_art'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['aufgehoben_am', 'aufgehoben_sub', 'aufgehoben_name', 'aufgehoben_rolle',
            'aufgehoben_art']) THEN
        RAISE EXCEPTION 'Ein Vermerk ändert sich nie; ein neuer Stand ist ein neuer Vermerk'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_teil_vermerk_nur_anhaengen';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_teil_vermerk_eingefroren BEFORE UPDATE ON energiemanagement_teil_vermerk
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_teil_vermerk_eingefroren();

-- RLS + FORCE und der Zaun wie bei den Aufgaben (V20260925013500): ein Teil gehört dem ganzen
-- Unternehmen, im engen Standort-Zaun ist der Vermerk nicht sichtbar.
ALTER TABLE energiemanagement_teil_vermerk ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_teil_vermerk FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_teil_vermerk_tenant_isolation ON energiemanagement_teil_vermerk
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_teil_vermerk AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

-- Grants: die App-Rolle liest und legt an, ändert nur das Aufheben und löscht nie; nur das
-- administrative Offboarding löscht (TenantRepository.offboard, vor energiemanagement_person).
REVOKE ALL ON energiemanagement_teil_vermerk FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energiemanagement_teil_vermerk TO ${appDbUser};
GRANT UPDATE (aufgehoben_am, aufgehoben_sub, aufgehoben_name, aufgehoben_rolle, aufgehoben_art)
    ON energiemanagement_teil_vermerk TO ${appDbUser};
GRANT SELECT, DELETE ON energiemanagement_teil_vermerk TO ${adminDbUser};

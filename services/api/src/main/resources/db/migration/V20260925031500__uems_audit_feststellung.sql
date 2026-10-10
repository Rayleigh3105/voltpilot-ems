-- =============================================================================
-- AP-19 IP-16: Energiemanagement — Datenhaltung von internem Audit und Feststellung
-- (IA1–IA5, FS1, FS2, FS4–FS7; §4.2, §4.6, §4.7, §4.14, §5.6 des Konzepts).
--
-- Neue, leere Tabellen neben denen von IP-5 (V20260925013500); KEINE bestehende
-- Zeile ändert sich (Invariante 1). Wer nichts anlegt, merkt nichts (Invariante 7).
--
--   internes_audit             AU-JJJJ-nnnn (Zähler von IP-5, Jahr des Anlegens):
--                              Titel, Termin, Auditorinnen/Auditoren (Personen),
--                              Unabhängigkeit, was und woran geprüft wird, Verantwortlich
--                              (Konto), wahlfrei Standorte; Abschluss mit Bericht-Verweis
--                              oder Zusammenfassung, Kopie und Prüfsumme (IA1, IA3)
--   internes_audit_eintrag     Hinweis (Nr. n, festgestellt von einer Person) und
--                              Kommentar — nur anhängen (IA2, IA5)
--   feststellung               F-JJJJ-nnnn: Quelle, Wortlaut, Vorgabe, Bezug,
--                              festgestellt von/am, Verantwortlich (Konto), Frist (FS1)
--   feststellung_eintrag       Kommentar · Behebung · Ursache (Aussage von) · ähnliche
--                              Fälle — nur anhängen, immer mit Person und Tag (FS2)
--   feststellung_wirksamkeit   Stand Nr. n: Ergebnis, Begründung, Kopie mit Prüfsumme,
--                              entschieden von, Vier-Augen (FS4–FS7)
--
-- Übergänge sind einmalig (Trigger). Ein abgeschlossenes oder abgesagtes Audit und eine
-- abgeschlossene Feststellung sind endgültig; ein Stand ändert sich nie, nur über einen
-- Antrag entscheidet die zweite Person einmal. `wirksam`, `ohne_massnahme` und
-- `zurueckgenommen` schließen die Feststellung (der Stand schließt sie selbst),
-- `nicht_wirksam` hält sie offen; höchstens ein Abschluss je Feststellung.
--
-- Geweitet (Vereinigung, nie enger): `energiemanagement_vokabular()` um die Wörter des
-- Protokolls von Audit und Feststellung (§5.6), das Protokoll `energiemanagement_aenderung`
-- um die Objekte `internes_audit` und `feststellung` (CHECK und `site_scope`).
--
-- Nicht dieses Paket: Routen (IP-18 Audit, IP-19 Feststellung und Wirksamkeit), die
-- Herkunft der Maßnahme (IP-17: die Maßnahme nennt F-…/AU-… als Kennung ihrer Herkunft —
-- die Feststellung trägt keine Spalte dafür), die Wiedervorlage (IP-21).
-- =============================================================================

-- Die Vokabulare von IP-5 unverändert, dazu im Block `energiemanagement_protokoll` (nur
-- Tabellen, kein Vertragsblock) die Übergänge von Audit und Feststellung aus §5.6 und die
-- Vier-Augen-Wörter des Stands (Muster fassung_beantragt/_abgelehnt).
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

-- Personen im Energiemanagement bzw. Standorte des Kundenbereichs, jede einmal (Muster
-- energiemanagement_anwendungsbereich_pruefen): ein Array trägt keinen Fremdschlüssel.
CREATE FUNCTION energiemanagement_personen_ok(p_tenant UUID, p_ids UUID[]) RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
  SELECT cardinality(p_ids) = (SELECT count(DISTINCT s) FROM unnest(p_ids) s)
     AND NOT EXISTS (SELECT 1 FROM unnest(p_ids) s(id)
                      WHERE NOT EXISTS (SELECT 1 FROM energiemanagement_person p
                                         WHERE p.id = s.id AND p.tenant_id = p_tenant))
$$;
CREATE FUNCTION energiemanagement_standorte_ok(p_tenant UUID, p_ids UUID[]) RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
  SELECT cardinality(p_ids) = (SELECT count(DISTINCT s) FROM unnest(p_ids) s)
     AND NOT EXISTS (SELECT 1 FROM unnest(p_ids) s(id)
                      WHERE NOT EXISTS (SELECT 1 FROM standort st WHERE st.id = s.id AND st.tenant_id = p_tenant))
$$;

-- Objekt-Kennzeichen im Bezug einer Feststellung (BB-0001, M-2029-0001, …): ohne Leerraum
-- am Rand, nicht leer, höchstens 60 Zeichen, jedes einmal.
CREATE FUNCTION feststellung_objekte_ok(p_objekte TEXT[]) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(bool_and(o IS NOT NULL AND o = pg_catalog.btrim(o) AND o <> '' AND pg_catalog.char_length(o) <= 60),
                  true)
     AND count(DISTINCT o) = count(*)
    FROM pg_catalog.unnest(p_objekte) o
$$;

-- Der Tag des Anlegens in der Zeitzone des Unternehmens: sein Jahr steht im Kennzeichen
-- (Muster massnahme_anlegen, abweichung_eroeffnen).
CREATE FUNCTION energiemanagement_anlegetag(p_tenant UUID, p_am TIMESTAMPTZ) RETURNS DATE
    LANGUAGE sql STABLE AS $$
  SELECT (p_am AT TIME ZONE coalesce((SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = p_tenant),
                                     'Europe/Berlin'))::date
$$;

-- -----------------------------------------------------------------------------
-- internes_audit (IA1, IA3, IA4): das Unternehmen, wahlfrei Standorte. `standort_ids` ist der
-- Zaun (RE1): ohne Standort nur unternehmensweit sichtbar, mit Standorten nur wer alle sieht.
-- Auditorinnen und Auditoren sind Personen im Energiemanagement (auch ohne Konto, IA5),
-- „Verantwortlich“ ist ein Konto (`benutzer` + Schnappschuss, Muster massnahme W4).
--   geplant        ändern: Titel, Termin, Personen, Umfang (die Begründung steht im Protokoll)
--   durchgefuehrt  Tag der Durchführung; Hinweise und Feststellungen entstehen nur jetzt
--   abgeschlossen  entschieden von (Person), Tag, Bericht als Verweis ODER Zusammenfassung
--                  (oder beides), `kopie` {kennzeichen, hinweise, feststellungen, bericht}
--                  (Vertrag energiemanagement.md §6) und `pruefsumme = bericht_pruefsumme(kopie)`
--   abgesagt       Begründung (10–500)
-- Abgeschlossen und abgesagt sind endgültig — ein zweiter Abschluss scheitert. Das nächste
-- interne Audit ist nie gespeichert: letzter Durchführungstag + Rhythmus, beim Abruf (IA4).
-- -----------------------------------------------------------------------------
CREATE TABLE internes_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    titel TEXT NOT NULL,
    termin DATE NOT NULL,
    auditor_ids UUID[] NOT NULL,
    unabhaengigkeit TEXT NOT NULL,
    was TEXT NOT NULL,
    woran TEXT NOT NULL,
    verantwortlich_sub TEXT NOT NULL,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT NOT NULL,
    standort_ids UUID[] NOT NULL DEFAULT '{}',
    zustand TEXT NOT NULL DEFAULT 'geplant',
    durchgefuehrt_am DATE,
    abgesagt_begruendung TEXT,
    zusammenfassung TEXT,
    bericht_bezeichnung TEXT,
    bericht_ablage TEXT,
    bericht_kennung TEXT,
    bericht_adresse TEXT,
    bericht_sha256 CHAR(64),
    kopie TEXT,
    pruefsumme TEXT,
    entschieden_von UUID,
    abgeschlossen_am DATE,
    abschluss_sub TEXT,
    abschluss_name TEXT,
    abschluss_rolle TEXT,
    abschluss_art TEXT,
    abschluss_eingetragen_am TIMESTAMPTZ,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT internes_audit_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT internes_audit_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- Vertrag `kennzeichen_muster.internes_audit`; das Jahr prüft der Anlege-Trigger.
    CONSTRAINT internes_audit_kennzeichen_chk CHECK (kennzeichen ~ '^AU-[0-9]{4}-[0-9]{4,9}$'
        AND substring(kennzeichen FROM 9) !~ '^0+$'),
    CONSTRAINT internes_audit_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT internes_audit_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT internes_audit_titel_chk CHECK (btrim(titel) <> '' AND char_length(titel) <= 200),
    -- IA1: Unabhängigkeit, was und woran als Wortlaut, Pflicht.
    CONSTRAINT internes_audit_wortlaut_chk CHECK (btrim(unabhaengigkeit) <> '' AND char_length(unabhaengigkeit) <= 2000
        AND btrim(was) <> '' AND char_length(was) <= 2000 AND btrim(woran) <> '' AND char_length(woran) <= 2000),
    CONSTRAINT internes_audit_personen_chk CHECK (cardinality(auditor_ids) > 0 AND array_position(auditor_ids, NULL) IS NULL
        AND array_position(standort_ids, NULL) IS NULL),
    CONSTRAINT internes_audit_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND btrim(verantwortlich_sub) <> '' AND btrim(verantwortlich_konto) <> ''),
    CONSTRAINT internes_audit_zustand_chk CHECK (coalesce(energiemanagement_wort('audit_zustand', zustand), false)),
    CONSTRAINT internes_audit_durchgefuehrt_chk CHECK (
        (durchgefuehrt_am IS NOT NULL) = (zustand IN ('durchgefuehrt', 'abgeschlossen'))),
    CONSTRAINT internes_audit_abgesagt_chk CHECK ((zustand = 'abgesagt') = (abgesagt_begruendung IS NOT NULL)
        AND (abgesagt_begruendung IS NULL OR char_length(btrim(abgesagt_begruendung)) BETWEEN 10 AND 500)),
    CONSTRAINT internes_audit_bericht_chk CHECK (energiemanagement_verweis_ok(bericht_bezeichnung, bericht_ablage,
        bericht_kennung, bericht_adresse, NULL, NULL, bericht_sha256)
        AND (zusammenfassung IS NULL OR (btrim(zusammenfassung) <> '' AND char_length(zusammenfassung) <= 2000))),
    -- IA3/G2: der Abschluss — und nur er — trägt entschieden von, Tag, Bericht oder Zusammenfassung,
    -- Kopie mit Prüfsumme und das eintragende Konto (Recht energiemanagement.freigeben: KA, EM).
    CONSTRAINT internes_audit_abschluss_chk CHECK (coalesce(CASE WHEN zustand = 'abgeschlossen' THEN
            entschieden_von IS NOT NULL AND abgeschlossen_am >= durchgefuehrt_am
            AND (bericht_ablage IS NOT NULL OR zusammenfassung IS NOT NULL)
            AND kopie IS NOT NULL AND pruefsumme = bericht_pruefsumme(kopie)
            AND btrim(abschluss_name) <> '' AND abschluss_eingetragen_am IS NOT NULL
            AND abschluss_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (abschluss_rolle IS NULL OR abschluss_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
            AND (btrim(abschluss_sub) <> '' OR (abschluss_sub IS NULL AND abschluss_art = 'voltpilot'))
        ELSE num_nonnulls(entschieden_von, abgeschlossen_am, zusammenfassung, bericht_bezeichnung, bericht_ablage,
                bericht_kennung, bericht_adresse, bericht_sha256, kopie, pruefsumme, abschluss_sub, abschluss_name,
                abschluss_rolle, abschluss_art, abschluss_eingetragen_am) = 0 END, false)),
    CONSTRAINT internes_audit_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT internes_audit_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT internes_audit_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX internes_audit_termin_idx ON internes_audit (tenant_id, termin);

-- AU-<Jahr des Anlegens>-<Nr.>: fehlt es, vergibt der Zähler von IP-5; ein gesetztes rückt
-- ihn dahinter. Ein Audit entsteht geplant, mit Personen und Standorten des Kundenbereichs.
CREATE FUNCTION internes_audit_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tag DATE := energiemanagement_anlegetag(NEW.tenant_id, NEW.angelegt_am);
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'geplant' THEN
        RAISE EXCEPTION 'Ein internes Audit entsteht geplant'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_uebergang_einmalig';
    END IF;
    IF NOT energiemanagement_personen_ok(NEW.tenant_id, NEW.auditor_ids)
        OR NOT energiemanagement_standorte_ok(NEW.tenant_id, NEW.standort_ids) THEN
        RAISE EXCEPTION 'Auditorinnen und Auditoren sind Personen, Standorte die des Kundenbereichs, jede einmal'
            USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'internes_audit_personen_fk';
    END IF;
    IF NEW.kennzeichen IS NULL THEN
        NEW.kennzeichen := uems_energiemanagement_kennung(NEW.tenant_id, 'AU', extract(YEAR FROM tag)::integer);
    ELSE
        IF NEW.kennzeichen ~ '^AU-[0-9]{4}-' AND substring(NEW.kennzeichen FROM 4 FOR 4) <> to_char(tag, 'YYYY') THEN
            RAISE EXCEPTION 'Das Jahr im Kennzeichen % ist das Jahr des Anlegens (%)', NEW.kennzeichen, tag
                USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_kennzeichen_jahr_chk';
        END IF;
        PERFORM uems_energiemanagement_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER internes_audit_anlegen BEFORE INSERT ON internes_audit
    FOR EACH ROW EXECUTE FUNCTION internes_audit_anlegen();

-- Übergänge einmalig (§5.6): geplant → durchgefuehrt · abgesagt, durchgefuehrt → abgeschlossen,
-- nie zurück. Geplant ändern sich Titel, Termin, Personen, Umfang und Verantwortlich;
-- durchgeführt nur der Abschluss; abgeschlossen und abgesagt nichts mehr. Beim Abschluss nennt
-- die Kopie genau die Feststellungen dieses Audits und seine Hinweise mit ihren Nummern.
CREATE FUNCTION internes_audit_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    abschluss CONSTANT TEXT[] := ARRAY['zustand', 'zusammenfassung', 'bericht_bezeichnung', 'bericht_ablage',
        'bericht_kennung', 'bericht_adresse', 'bericht_sha256', 'kopie', 'pruefsumme', 'entschieden_von',
        'abgeschlossen_am', 'abschluss_sub', 'abschluss_name', 'abschluss_rolle', 'abschluss_art',
        'abschluss_eingetragen_am'];
    k JSONB;
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kennzeichen <> OLD.kennzeichen
        OR NEW.angelegt_am <> OLD.angelegt_am OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Kennzeichen und Anlage eines internen Audits sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_identitaet_bleibt';
    END IF;
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.zustand IN ('abgeschlossen', 'abgesagt') THEN
        RAISE EXCEPTION 'Das interne Audit % ist % und endgültig', OLD.kennzeichen, OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_endgueltig';
    END IF;
    IF OLD.zustand = 'geplant' THEN
        IF NEW.zustand NOT IN ('geplant', 'durchgefuehrt', 'abgesagt') THEN
            RAISE EXCEPTION 'Das interne Audit % geht nicht von geplant nach %', OLD.kennzeichen, NEW.zustand
                USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_uebergang_einmalig';
        END IF;
        IF NOT energiemanagement_personen_ok(NEW.tenant_id, NEW.auditor_ids)
            OR NOT energiemanagement_standorte_ok(NEW.tenant_id, NEW.standort_ids) THEN
            RAISE EXCEPTION 'Auditorinnen und Auditoren sind Personen, Standorte die des Kundenbereichs, jede einmal'
                USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'internes_audit_personen_fk';
        END IF;
        RETURN NEW;
    END IF;
    -- OLD.zustand = 'durchgefuehrt'
    IF NEW.zustand <> 'abgeschlossen' OR (to_jsonb(NEW) - abschluss) IS DISTINCT FROM (to_jsonb(OLD) - abschluss) THEN
        RAISE EXCEPTION 'Das durchgeführte Audit % wird nur noch abgeschlossen', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_uebergang_einmalig';
    END IF;
    k := NEW.kopie::jsonb;
    IF jsonb_typeof(k) IS DISTINCT FROM 'object'
        OR (SELECT array_agg(s ORDER BY s) FROM jsonb_object_keys(k) s)
            IS DISTINCT FROM ARRAY['bericht', 'feststellungen', 'hinweise', 'kennzeichen']
        OR k ->> 'kennzeichen' IS DISTINCT FROM NEW.kennzeichen
        OR (CASE WHEN NEW.bericht_ablage IS NULL THEN k -> 'bericht' <> 'null'::jsonb
                 ELSE jsonb_typeof(k -> 'bericht') IS DISTINCT FROM 'object'
                      OR k -> 'bericht' ->> 'ablage' IS DISTINCT FROM NEW.bericht_ablage END)
        OR jsonb_typeof(k -> 'feststellungen') IS DISTINCT FROM 'array'
        OR (SELECT coalesce(array_agg(f ORDER BY f), '{}') FROM jsonb_array_elements_text(k -> 'feststellungen') f)
            IS DISTINCT FROM (SELECT coalesce(array_agg(x.kennzeichen ORDER BY x.kennzeichen), '{}') FROM feststellung x
                               WHERE x.tenant_id = NEW.tenant_id AND x.audit_id = NEW.id)
        OR jsonb_typeof(k -> 'hinweise') IS DISTINCT FROM 'array'
        OR (SELECT coalesce(array_agg((h ->> 'nr')::text ORDER BY (h ->> 'nr')::text), '{}')
              FROM jsonb_array_elements(k -> 'hinweise') h)
            IS DISTINCT FROM (SELECT coalesce(array_agg(e.nr::text ORDER BY e.nr::text), '{}') FROM internes_audit_eintrag e
                               WHERE e.tenant_id = NEW.tenant_id AND e.audit_id = NEW.id AND e.art = 'hinweis') THEN
        RAISE EXCEPTION 'Die Kopie des Abschlusses nennt das Audit %, seine Hinweise, seine Feststellungen und den Bericht',
            OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_kopie';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER internes_audit_eingefroren BEFORE UPDATE ON internes_audit
    FOR EACH ROW EXECUTE FUNCTION internes_audit_eingefroren();

-- -----------------------------------------------------------------------------
-- internes_audit_eintrag (IA2, IA5): nur anhängen.
--   hinweis    Nr. n je Audit (lückenlos, der Trigger vergibt), am, festgestellt von (die Person,
--              die prüft — sie braucht kein Konto), Wortlaut; nur am durchgeführten Audit. Aus
--              einem Hinweis kann eine Maßnahme mit Herkunft `audit` werden (IP-17) — die
--              Maßnahme nennt das Audit, der Hinweis bleibt byte-gleich.
--   kommentar  Wortlaut, jederzeit.
-- „Eingetragen von“ ist das Konto (`actor_*`, G2).
-- -----------------------------------------------------------------------------
CREATE TABLE internes_audit_eintrag (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    audit_id UUID NOT NULL,
    art TEXT NOT NULL,
    nr INTEGER,
    am DATE,
    festgestellt_von UUID,
    wortlaut TEXT NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT internes_audit_eintrag_audit_fk FOREIGN KEY (audit_id, tenant_id)
        REFERENCES internes_audit(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT internes_audit_eintrag_person_fk FOREIGN KEY (festgestellt_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT internes_audit_eintrag_nr_uq UNIQUE (tenant_id, audit_id, nr),
    CONSTRAINT internes_audit_eintrag_art_chk CHECK (coalesce(energiemanagement_wort('audit_eintrag', art), false)),
    CONSTRAINT internes_audit_eintrag_inhalt_chk CHECK (coalesce(btrim(wortlaut) <> '' AND char_length(wortlaut) <= 2000
        AND CASE art WHEN 'hinweis' THEN nr > 0 AND am IS NOT NULL AND festgestellt_von IS NOT NULL
                     WHEN 'kommentar' THEN num_nonnulls(nr, am, festgestellt_von) = 0 END, false)),
    CONSTRAINT internes_audit_eintrag_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT internes_audit_eintrag_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT internes_audit_eintrag_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX internes_audit_eintrag_audit_idx ON internes_audit_eintrag (tenant_id, audit_id, created_at, id);

CREATE FUNCTION internes_audit_eintrag_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    zustand TEXT;
    naechste INTEGER;
BEGIN
    IF NEW.art <> 'hinweis' THEN
        RETURN NEW;
    END IF;
    SELECT a.zustand INTO zustand FROM internes_audit a
     WHERE a.id = NEW.audit_id AND a.tenant_id = NEW.tenant_id FOR UPDATE;
    IF zustand IS DISTINCT FROM 'durchgefuehrt' THEN
        RAISE EXCEPTION 'Ein Hinweis entsteht am durchgeführten Audit (es ist %)', coalesce(zustand, 'unbekannt')
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_eintrag_durchgefuehrt';
    END IF;
    SELECT coalesce(max(e.nr), 0) + 1 INTO naechste FROM internes_audit_eintrag e
     WHERE e.tenant_id = NEW.tenant_id AND e.audit_id = NEW.audit_id AND e.art = 'hinweis';
    IF NEW.nr IS NULL THEN
        NEW.nr := naechste;
    ELSIF NEW.nr <> naechste THEN
        RAISE EXCEPTION 'Der nächste Hinweis ist Nr. %, nicht Nr. %', naechste, NEW.nr
            USING ERRCODE = 'check_violation', CONSTRAINT = 'internes_audit_eintrag_lueckenlos';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER internes_audit_eintrag_anlegen BEFORE INSERT ON internes_audit_eintrag
    FOR EACH ROW EXECUTE FUNCTION internes_audit_eintrag_anlegen();

-- -----------------------------------------------------------------------------
-- feststellung (FS1, FS7): F-JJJJ-nnnn (Zähler von IP-5, Jahr des Anlegens).
--   Quelle     internes_audit (`audit_id`, nur solange das Audit durchgeführt ist) · eigene ·
--              extern (`quelle_wortlaut`: von wem, was) · managementbewertung (`quelle_kennung`
--              BR-JJJJ-nnnn/Bn, Vertrag `kennzeichen_muster.beschluss`)
--   Wortlaut   was nicht erfüllt ist — nie geändert; eine neue Nichterfüllung ist eine neue
--              Feststellung, die die alte im Wortlaut nennen kann (FS7)
--   Vorgabe    eine Dokument-Fassung D-…/n und/oder ein Wortlaut
--   Bezug      `standort_id` (NULL = das Unternehmen; der Zaun, RE1), wahlfrei eine Aufgabe
--              (Wort des Vokabulars `aufgabe`), ein Dokument und Objekt-Kennzeichen
--   Frist      fehlt sie, festgestellt am + `feststellung_frist_tage` der Einstellung
--              (Startwert 90); „überfällig seit n Tagen“ ist ein Wort des Abrufs
-- Offen ändern sich nur Frist und Verantwortlich (die Begründung steht im Protokoll);
-- abgeschlossen wird sie von einem schließenden Stand der Wirksamkeit und ist endgültig.
-- Die Korrekturmaßnahmen sind AP-18-Maßnahmen mit Herkunft `nichtkonformitaet` (IP-17).
-- -----------------------------------------------------------------------------
CREATE TABLE feststellung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    quelle_art TEXT NOT NULL,
    audit_id UUID,
    quelle_kennung TEXT,
    quelle_wortlaut TEXT,
    wortlaut TEXT NOT NULL,
    vorgabe_dokument_id UUID,
    vorgabe_fassung INTEGER,
    vorgabe_wortlaut TEXT,
    standort_id UUID,
    bezug_aufgabe TEXT,
    bezug_dokument_id UUID,
    bezug_objekte TEXT[] NOT NULL DEFAULT '{}',
    festgestellt_von UUID NOT NULL,
    festgestellt_am DATE NOT NULL,
    verantwortlich_sub TEXT NOT NULL,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT NOT NULL,
    frist DATE NOT NULL,
    zustand TEXT NOT NULL DEFAULT 'offen',
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feststellung_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT feststellung_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- Vertrag `kennzeichen_muster.feststellung`; das Jahr prüft der Anlege-Trigger.
    CONSTRAINT feststellung_kennzeichen_chk CHECK (kennzeichen ~ '^F-[0-9]{4}-[0-9]{4,9}$'
        AND substring(kennzeichen FROM 8) !~ '^0+$'),
    CONSTRAINT feststellung_audit_fk FOREIGN KEY (audit_id, tenant_id)
        REFERENCES internes_audit(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_vorgabe_fk FOREIGN KEY (tenant_id, vorgabe_dokument_id, vorgabe_fassung)
        REFERENCES energiemanagement_dokument_fassung(tenant_id, dokument_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT feststellung_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_bezug_dokument_fk FOREIGN KEY (bezug_dokument_id, tenant_id)
        REFERENCES energiemanagement_dokument(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_festgestellt_von_fk FOREIGN KEY (festgestellt_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    -- FS1: die Quelle mit genau ihrem Verweis.
    CONSTRAINT feststellung_quelle_chk CHECK (coalesce(energiemanagement_wort('feststellung_quelle', quelle_art)
        AND CASE quelle_art
            WHEN 'internes_audit' THEN audit_id IS NOT NULL AND num_nonnulls(quelle_kennung, quelle_wortlaut) = 0
            WHEN 'eigene' THEN num_nonnulls(audit_id, quelle_kennung, quelle_wortlaut) = 0
            WHEN 'extern' THEN btrim(quelle_wortlaut) <> '' AND char_length(quelle_wortlaut) <= 500
                AND num_nonnulls(audit_id, quelle_kennung) = 0
            WHEN 'managementbewertung' THEN quelle_kennung ~ '^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$'
                AND num_nonnulls(audit_id, quelle_wortlaut) = 0
        END, false)),
    CONSTRAINT feststellung_wortlaut_chk CHECK (btrim(wortlaut) <> '' AND char_length(wortlaut) <= 2000),
    -- FS1: die Vorgabe als Dokument-Fassung (ganz) und/oder als Wortlaut.
    CONSTRAINT feststellung_vorgabe_chk CHECK ((vorgabe_dokument_id IS NULL) = (vorgabe_fassung IS NULL)
        AND (vorgabe_dokument_id IS NOT NULL OR vorgabe_wortlaut IS NOT NULL)
        AND (vorgabe_wortlaut IS NULL OR (btrim(vorgabe_wortlaut) <> '' AND char_length(vorgabe_wortlaut) <= 2000))),
    CONSTRAINT feststellung_bezug_chk CHECK ((bezug_aufgabe IS NULL OR coalesce(energiemanagement_wort('aufgabe', bezug_aufgabe), false))
        AND feststellung_objekte_ok(bezug_objekte)),
    CONSTRAINT feststellung_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND btrim(verantwortlich_sub) <> '' AND btrim(verantwortlich_konto) <> ''),
    CONSTRAINT feststellung_frist_chk CHECK (frist >= festgestellt_am),
    CONSTRAINT feststellung_zustand_chk CHECK (coalesce(energiemanagement_wort('feststellung_zustand', zustand), false)),
    CONSTRAINT feststellung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT feststellung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT feststellung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX feststellung_audit_idx ON feststellung (tenant_id, audit_id) WHERE audit_id IS NOT NULL;
CREATE INDEX feststellung_standort_idx ON feststellung (tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX feststellung_offen_idx ON feststellung (tenant_id, frist) WHERE zustand = 'offen';

-- F-<Jahr des Anlegens>-<Nr.>, die Frist-Vorgabe aus der Einstellung (Startwert 90 Tage); eine
-- Feststellung entsteht offen, aus einem Audit nur, solange es durchgeführt ist (§5.6).
CREATE FUNCTION feststellung_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tag DATE := energiemanagement_anlegetag(NEW.tenant_id, NEW.angelegt_am);
    audit_zustand TEXT;
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'offen' THEN
        RAISE EXCEPTION 'Eine Feststellung entsteht offen'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_uebergang_einmalig';
    END IF;
    IF NEW.audit_id IS NOT NULL THEN
        SELECT a.zustand INTO audit_zustand FROM internes_audit a
         WHERE a.id = NEW.audit_id AND a.tenant_id = NEW.tenant_id FOR UPDATE;
        IF audit_zustand IS DISTINCT FROM 'durchgefuehrt' THEN
            RAISE EXCEPTION 'Eine Feststellung aus einem Audit entsteht am durchgeführten Audit (es ist %)',
                coalesce(audit_zustand, 'unbekannt')
                USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_audit_durchgefuehrt';
        END IF;
    END IF;
    NEW.frist := coalesce(NEW.frist, NEW.festgestellt_am + coalesce((SELECT e.feststellung_frist_tage
        FROM energiemanagement_einstellung e WHERE e.tenant_id = NEW.tenant_id), 90));
    IF NEW.kennzeichen IS NULL THEN
        NEW.kennzeichen := uems_energiemanagement_kennung(NEW.tenant_id, 'F', extract(YEAR FROM tag)::integer);
    ELSE
        IF NEW.kennzeichen ~ '^F-[0-9]{4}-' AND substring(NEW.kennzeichen FROM 3 FOR 4) <> to_char(tag, 'YYYY') THEN
            RAISE EXCEPTION 'Das Jahr im Kennzeichen % ist das Jahr des Anlegens (%)', NEW.kennzeichen, tag
                USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_kennzeichen_jahr_chk';
        END IF;
        PERFORM uems_energiemanagement_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER feststellung_anlegen BEFORE INSERT ON feststellung
    FOR EACH ROW EXECUTE FUNCTION feststellung_anlegen();

-- Übergänge einmalig (§5.6, FS7): offen ändern sich nur Frist und Verantwortlich; nach
-- abgeschlossen nur mit einem schließenden, festgehaltenen Stand; abgeschlossen ist endgültig.
CREATE FUNCTION feststellung_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    offen CONSTANT TEXT[] := ARRAY['frist', 'verantwortlich_sub', 'verantwortlich_name', 'verantwortlich_konto',
        'zustand'];
BEGIN
    IF (to_jsonb(NEW) - offen) IS DISTINCT FROM (to_jsonb(OLD) - offen) THEN
        RAISE EXCEPTION 'Kennzeichen, Quelle, Wortlaut, Vorgabe, Bezug und Anlage einer Feststellung sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_identitaet_bleibt';
    END IF;
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.zustand = 'abgeschlossen' THEN
        RAISE EXCEPTION 'Die Feststellung % ist abgeschlossen und endgültig', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_endgueltig';
    END IF;
    IF NEW.zustand = 'abgeschlossen' AND NOT EXISTS (SELECT 1 FROM feststellung_wirksamkeit w
            WHERE w.tenant_id = NEW.tenant_id AND w.feststellung_id = NEW.id AND w.status = 'freigegeben'
              AND w.ergebnis IN ('wirksam', 'ohne_massnahme', 'zurueckgenommen')) THEN
        RAISE EXCEPTION 'Die Feststellung % schließt nur ein Stand wirksam, ohne Maßnahme oder zurückgenommen',
            OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_uebergang_einmalig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER feststellung_eingefroren BEFORE UPDATE ON feststellung
    FOR EACH ROW EXECUTE FUNCTION feststellung_eingefroren();

-- -----------------------------------------------------------------------------
-- feststellung_eintrag (FS2): nur anhängen, jeder mit Person und Tag und Wortlaut
-- (1–2 000 Zeichen) — nie ein Satz des Systems. `ursache_aussage` ist die Aussage der Person
-- („Ursache — Aussage von <Person>, <Tag>“). Kommentare jederzeit, die übrigen solange offen.
-- -----------------------------------------------------------------------------
CREATE TABLE feststellung_eintrag (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    feststellung_id UUID NOT NULL,
    art TEXT NOT NULL,
    am DATE NOT NULL,
    person_id UUID NOT NULL,
    wortlaut TEXT NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feststellung_eintrag_feststellung_fk FOREIGN KEY (feststellung_id, tenant_id)
        REFERENCES feststellung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_eintrag_person_fk FOREIGN KEY (person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_eintrag_art_chk CHECK (coalesce(energiemanagement_wort('feststellung_eintrag', art), false)),
    CONSTRAINT feststellung_eintrag_wortlaut_chk CHECK (btrim(wortlaut) <> '' AND char_length(wortlaut) <= 2000),
    CONSTRAINT feststellung_eintrag_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT feststellung_eintrag_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT feststellung_eintrag_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX feststellung_eintrag_feststellung_idx ON feststellung_eintrag (tenant_id, feststellung_id, created_at, id);

CREATE FUNCTION feststellung_eintrag_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.art <> 'kommentar' AND EXISTS (SELECT 1 FROM feststellung f
            WHERE f.id = NEW.feststellung_id AND f.tenant_id = NEW.tenant_id AND f.zustand = 'abgeschlossen') THEN
        RAISE EXCEPTION 'Die Feststellung ist abgeschlossen — nur noch ein Kommentar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_endgueltig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER feststellung_eintrag_anlegen BEFORE INSERT ON feststellung_eintrag
    FOR EACH ROW EXECUTE FUNCTION feststellung_eintrag_anlegen();

-- -----------------------------------------------------------------------------
-- feststellung_wirksamkeit (FS4–FS7): Stand Nr. n je Feststellung (lückenlos, der Trigger
-- vergibt sie), Ergebnis `wirksam · nicht_wirksam · ohne_massnahme · zurueckgenommen`,
-- Begründung (10–500, immer), entschieden von (Person) am Tag, `kopie` (Feststellung,
-- Einträge, Maßnahmen mit Zustand, Aufgabe, Tag — Vertrag §6; ihr `feststellung` ist das
-- Kennzeichen, ihr `am` der Tag) und `pruefsumme = bericht_pruefsumme(kopie)`. Das Konto,
-- das festhält, steht in `freigabe_*` (G2).
--
-- Vier-Augen nach Einstellung (`unternehmen.vieraugen_freigabe`, Muster massnahme_bewertung):
-- `status` beantragt · freigegeben · abgelehnt (Wörter von `fassung_status`); ohne Vier-Augen
-- entsteht der Stand freigegeben. Die zweite Person ist nie die Urheberin (CHECK) und nie der
-- Verantwortliche der Feststellung (Trigger), Rolle KA oder EM. Eine Ablehnung behält die Nr.
--
-- Ein freigegebener Stand `wirksam`, `ohne_massnahme` oder `zurueckgenommen` schließt die
-- Feststellung (der Trigger setzt ihren Zustand), `nicht_wirksam` hält sie offen. Höchstens
-- ein schließender Stand je Feststellung, und an einer abgeschlossenen entsteht keiner mehr:
-- ein zweiter Abschluss scheitert. Ein Stand wird nie zurückgenommen (FS7).
-- -----------------------------------------------------------------------------
CREATE TABLE feststellung_wirksamkeit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    feststellung_id UUID NOT NULL,
    stand_nr INTEGER NOT NULL,
    ergebnis TEXT NOT NULL,
    begruendung TEXT NOT NULL,
    entschieden_von UUID NOT NULL,
    entschieden_tag DATE NOT NULL,
    kopie TEXT NOT NULL,
    pruefsumme TEXT NOT NULL,
    vieraugen BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL,
    freigabe_sub TEXT,
    freigabe_name TEXT NOT NULL,
    freigabe_rolle TEXT,
    freigabe_art TEXT NOT NULL,
    freigabe_am TIMESTAMPTZ NOT NULL,
    entscheidung_sub TEXT,
    entscheidung_name TEXT,
    entscheidung_rolle TEXT,
    entscheidung_art TEXT,
    entschieden_am TIMESTAMPTZ,
    entscheidungs_begruendung TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feststellung_wirksamkeit_feststellung_fk FOREIGN KEY (feststellung_id, tenant_id)
        REFERENCES feststellung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_wirksamkeit_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT feststellung_wirksamkeit_stand_uq UNIQUE (tenant_id, feststellung_id, stand_nr),
    CONSTRAINT feststellung_wirksamkeit_stand_nr_chk CHECK (stand_nr > 0),
    CONSTRAINT feststellung_wirksamkeit_ergebnis_chk CHECK (
        coalesce(energiemanagement_wort('wirksamkeit_ergebnis', ergebnis), false)),
    -- FS4/FS5: die Begründung ist Pflicht, bei jedem Ergebnis.
    CONSTRAINT feststellung_wirksamkeit_begruendung_chk CHECK (char_length(btrim(begruendung)) BETWEEN 10 AND 500),
    CONSTRAINT feststellung_wirksamkeit_kopie_chk CHECK (
        jsonb_typeof(kopie::jsonb) = 'object' AND pruefsumme = bericht_pruefsumme(kopie)),
    CONSTRAINT feststellung_wirksamkeit_status_chk CHECK (coalesce(energiemanagement_wort('fassung_status', status), false)
        AND status IN ('beantragt', 'freigegeben', 'abgelehnt')),
    CONSTRAINT feststellung_wirksamkeit_person_chk CHECK (coalesce(btrim(freigabe_name) <> ''
        AND freigabe_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
        AND (freigabe_rolle IS NULL OR freigabe_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
        AND (btrim(freigabe_sub) <> '' OR (freigabe_sub IS NULL AND freigabe_art = 'voltpilot')), false)),
    -- Ohne Vier-Augen weder beantragt noch abgelehnt; die zweite Person ist nie die erste
    -- (die Urheberin) und hat Rolle KA oder EM.
    CONSTRAINT feststellung_wirksamkeit_vieraugen_chk CHECK (vieraugen OR status = 'freigegeben'),
    CONSTRAINT feststellung_wirksamkeit_entscheidung_chk CHECK (coalesce(
        CASE WHEN vieraugen AND status IN ('freigegeben', 'abgelehnt') THEN
            entscheidung_sub <> freigabe_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager') AND entschieden_am IS NOT NULL
        ELSE num_nonnulls(entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am) = 0
        END, false)),
    CONSTRAINT feststellung_wirksamkeit_ablehnung_chk CHECK (
        (status = 'abgelehnt') = coalesce(btrim(entscheidungs_begruendung) <> '', false))
);
-- Höchstens ein offener Antrag und höchstens ein Abschluss (nicht abgelehnt) je Feststellung.
CREATE UNIQUE INDEX feststellung_wirksamkeit_ein_antrag_uq ON feststellung_wirksamkeit (tenant_id, feststellung_id)
    WHERE status = 'beantragt';
CREATE UNIQUE INDEX feststellung_wirksamkeit_ein_abschluss_uq ON feststellung_wirksamkeit (tenant_id, feststellung_id)
    WHERE ergebnis IN ('wirksam', 'ohne_massnahme', 'zurueckgenommen') AND status <> 'abgelehnt';

-- Ein Stand entsteht an einer offenen Feststellung ohne offenen Antrag, freigegeben bzw. bei
-- Vier-Augen als Antrag, mit der nächsten Nr.; seine Kopie nennt die Feststellung und den Tag.
CREATE FUNCTION feststellung_wirksamkeit_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    f RECORD;
    naechste INTEGER;
BEGIN
    IF NEW.status IS DISTINCT FROM (CASE WHEN NEW.vieraugen THEN 'beantragt' ELSE 'freigegeben' END) THEN
        RAISE EXCEPTION 'Ein Stand entsteht freigegeben, bei Vier-Augen als Antrag'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_entsteht_als_antrag';
    END IF;
    SELECT x.zustand, x.kennzeichen INTO f FROM feststellung x
     WHERE x.id = NEW.feststellung_id AND x.tenant_id = NEW.tenant_id FOR UPDATE;
    IF f.zustand IS DISTINCT FROM 'offen' THEN
        RAISE EXCEPTION 'Die Feststellung % ist % — kein weiterer Stand', f.kennzeichen, coalesce(f.zustand, 'unbekannt')
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_endgueltig';
    END IF;
    IF EXISTS (SELECT 1 FROM feststellung_wirksamkeit w WHERE w.tenant_id = NEW.tenant_id
                  AND w.feststellung_id = NEW.feststellung_id AND w.status = 'beantragt') THEN
        RAISE EXCEPTION 'An der Feststellung % wartet ein Antrag auf die zweite Person', f.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_antrag_offen';
    END IF;
    IF NEW.kopie::jsonb ->> 'feststellung' IS DISTINCT FROM f.kennzeichen
        OR NEW.kopie::jsonb ->> 'am' IS DISTINCT FROM to_char(NEW.entschieden_tag, 'YYYY-MM-DD') THEN
        RAISE EXCEPTION 'Die Kopie des Stands nennt die Feststellung % und den Tag %', f.kennzeichen, NEW.entschieden_tag
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_kopie';
    END IF;
    SELECT coalesce(max(w.stand_nr), 0) + 1 INTO naechste FROM feststellung_wirksamkeit w
     WHERE w.tenant_id = NEW.tenant_id AND w.feststellung_id = NEW.feststellung_id;
    IF NEW.stand_nr IS NULL THEN
        NEW.stand_nr := naechste;
    ELSIF NEW.stand_nr <> naechste THEN
        RAISE EXCEPTION 'Der nächste Stand ist Nr. % (nicht %)', naechste, NEW.stand_nr
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_stand_nr_lueckenlos';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER feststellung_wirksamkeit_anlegen BEFORE INSERT ON feststellung_wirksamkeit
    FOR EACH ROW EXECUTE FUNCTION feststellung_wirksamkeit_anlegen();

-- Ein Stand ändert sich nie; nur über einen Antrag entscheidet die zweite Person einmal —
-- nie der Verantwortliche der Feststellung, und freigegeben nur an einer offenen (FS6).
CREATE FUNCTION feststellung_wirksamkeit_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    entscheid CONSTANT TEXT[] := ARRAY['status', 'entscheidung_sub', 'entscheidung_name', 'entscheidung_rolle',
        'entscheidung_art', 'entschieden_am', 'entscheidungs_begruendung'];
    f RECORD;
BEGIN
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.status <> 'beantragt' OR NEW.status NOT IN ('freigegeben', 'abgelehnt')
        OR (to_jsonb(NEW) - entscheid) IS DISTINCT FROM (to_jsonb(OLD) - entscheid) THEN
        RAISE EXCEPTION 'Stand Nr. % ist %: ein Stand wird nie zurückgenommen oder geändert', OLD.stand_nr, OLD.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_einmalig';
    END IF;
    SELECT x.zustand, x.kennzeichen, x.verantwortlich_sub INTO f FROM feststellung x
     WHERE x.id = NEW.feststellung_id AND x.tenant_id = NEW.tenant_id FOR UPDATE;
    IF NEW.entscheidung_sub IS NOT DISTINCT FROM f.verantwortlich_sub THEN
        RAISE EXCEPTION 'Über die Wirksamkeit von % entscheidet nie der Verantwortliche', f.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_wirksamkeit_vieraugen_verantwortlich';
    END IF;
    IF NEW.status = 'freigegeben' AND f.zustand IS DISTINCT FROM 'offen' THEN
        RAISE EXCEPTION 'Die Feststellung % ist % — kein weiterer Stand', f.kennzeichen, coalesce(f.zustand, 'unbekannt')
            USING ERRCODE = 'check_violation', CONSTRAINT = 'feststellung_endgueltig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER feststellung_wirksamkeit_eingefroren BEFORE UPDATE ON feststellung_wirksamkeit
    FOR EACH ROW EXECUTE FUNCTION feststellung_wirksamkeit_eingefroren();

-- Der schließende Stand schließt die Feststellung — in derselben Anweisung, nie später.
CREATE FUNCTION feststellung_wirksamkeit_schliesst() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'freigegeben' AND NEW.ergebnis IN ('wirksam', 'ohne_massnahme', 'zurueckgenommen') THEN
        UPDATE feststellung SET zustand = 'abgeschlossen'
         WHERE id = NEW.feststellung_id AND tenant_id = NEW.tenant_id AND zustand = 'offen';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER feststellung_wirksamkeit_schliesst AFTER INSERT OR UPDATE OF status ON feststellung_wirksamkeit
    FOR EACH ROW EXECUTE FUNCTION feststellung_wirksamkeit_schliesst();

-- -----------------------------------------------------------------------------
-- Das Protokoll von IP-5 kennt Audit und Feststellung (§5.6): Vereinigung der Objekte, die
-- bestehenden Zweige wörtlich.
-- -----------------------------------------------------------------------------
ALTER TABLE energiemanagement_aenderung DROP CONSTRAINT energiemanagement_aenderung_objekt_chk;
ALTER TABLE energiemanagement_aenderung ADD CONSTRAINT energiemanagement_aenderung_objekt_chk CHECK (
    CASE objekt WHEN 'einstellung' THEN objekt_id IS NULL
                WHEN 'person' THEN objekt_id IS NOT NULL
                WHEN 'aufgabe' THEN objekt_id IS NOT NULL
                WHEN 'dokument' THEN objekt_id IS NOT NULL
                WHEN 'internes_audit' THEN objekt_id IS NOT NULL
                WHEN 'feststellung' THEN objekt_id IS NOT NULL
                ELSE false END);

-- -----------------------------------------------------------------------------
-- RLS + FORCE und der Standort-Zaun (RE1, RE2, Muster IP-5): RESTRICTIVE `site_scope` wird
-- mit der Mandanten-Policy UND-verknüpft; unternehmensweit gilt allein der Mandanten-Zaun.
-- Im engen Zaun: ein Audit nur mit Standorten, die alle zur Anfrage gehören (ohne Standort
-- = das Unternehmen, nie); eine Feststellung nur an einem Standort der Anfrage; Einträge und
-- Stände folgen ihrem Objekt, das Protokoll ebenso.
-- -----------------------------------------------------------------------------
ALTER TABLE internes_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE internes_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY internes_audit_tenant_isolation ON internes_audit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON internes_audit AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE cardinality(standort_ids) > 0 AND coalesce(standort_ids <@ uems_zugriff_standort_ids(), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE cardinality(standort_ids) > 0 AND coalesce(standort_ids <@ uems_zugriff_standort_ids(), false) END);
ALTER TABLE internes_audit_eintrag ENABLE ROW LEVEL SECURITY;
ALTER TABLE internes_audit_eintrag FORCE ROW LEVEL SECURITY;
CREATE POLICY internes_audit_eintrag_tenant_isolation ON internes_audit_eintrag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON internes_audit_eintrag AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM internes_audit a
                             WHERE a.id = internes_audit_eintrag.audit_id
                               AND a.tenant_id = internes_audit_eintrag.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM internes_audit a
                                  WHERE a.id = internes_audit_eintrag.audit_id
                                    AND a.tenant_id = internes_audit_eintrag.tenant_id) END);
ALTER TABLE feststellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE feststellung FORCE ROW LEVEL SECURITY;
CREATE POLICY feststellung_tenant_isolation ON feststellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON feststellung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);
ALTER TABLE feststellung_eintrag ENABLE ROW LEVEL SECURITY;
ALTER TABLE feststellung_eintrag FORCE ROW LEVEL SECURITY;
CREATE POLICY feststellung_eintrag_tenant_isolation ON feststellung_eintrag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON feststellung_eintrag AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM feststellung f
                             WHERE f.id = feststellung_eintrag.feststellung_id
                               AND f.tenant_id = feststellung_eintrag.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM feststellung f
                                  WHERE f.id = feststellung_eintrag.feststellung_id
                                    AND f.tenant_id = feststellung_eintrag.tenant_id) END);
ALTER TABLE feststellung_wirksamkeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE feststellung_wirksamkeit FORCE ROW LEVEL SECURITY;
CREATE POLICY feststellung_wirksamkeit_tenant_isolation ON feststellung_wirksamkeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON feststellung_wirksamkeit AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM feststellung f
                             WHERE f.id = feststellung_wirksamkeit.feststellung_id
                               AND f.tenant_id = feststellung_wirksamkeit.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM feststellung f
                                  WHERE f.id = feststellung_wirksamkeit.feststellung_id
                                    AND f.tenant_id = feststellung_wirksamkeit.tenant_id) END);

-- Das Protokoll folgt nun auch Audit und Feststellung (die Zweige von IP-5 wörtlich).
DROP POLICY site_scope ON energiemanagement_aenderung;
CREATE POLICY site_scope ON energiemanagement_aenderung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                WHEN objekt = 'dokument' THEN EXISTS (SELECT 1 FROM energiemanagement_dokument d
                             WHERE d.id = energiemanagement_aenderung.objekt_id
                               AND d.tenant_id = energiemanagement_aenderung.tenant_id)
                WHEN objekt = 'internes_audit' THEN EXISTS (SELECT 1 FROM internes_audit a
                             WHERE a.id = energiemanagement_aenderung.objekt_id
                               AND a.tenant_id = energiemanagement_aenderung.tenant_id)
                WHEN objekt = 'feststellung' THEN EXISTS (SELECT 1 FROM feststellung f
                             WHERE f.id = energiemanagement_aenderung.objekt_id
                               AND f.tenant_id = energiemanagement_aenderung.tenant_id)
                ELSE false END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     WHEN objekt = 'dokument' THEN EXISTS (SELECT 1 FROM energiemanagement_dokument d
                                  WHERE d.id = energiemanagement_aenderung.objekt_id
                                    AND d.tenant_id = energiemanagement_aenderung.tenant_id)
                     WHEN objekt = 'internes_audit' THEN EXISTS (SELECT 1 FROM internes_audit a
                                  WHERE a.id = energiemanagement_aenderung.objekt_id
                                    AND a.tenant_id = energiemanagement_aenderung.tenant_id)
                     WHEN objekt = 'feststellung' THEN EXISTS (SELECT 1 FROM feststellung f
                                  WHERE f.id = energiemanagement_aenderung.objekt_id
                                    AND f.tenant_id = energiemanagement_aenderung.tenant_id)
                     ELSE false END);

-- Grants: die App-Rolle liest und legt an, ändert nur benannte Spalten und löscht nie;
-- Einträge werden nur angehängt, ein Stand ändert nur seine Entscheid-Spalten. Nur das
-- administrative Offboarding löscht (TenantRepository.offboard): Stände, Einträge,
-- Feststellungen, Hinweise und Audits vor den Tabellen von IP-5.
REVOKE ALL ON internes_audit, internes_audit_eintrag, feststellung, feststellung_eintrag, feststellung_wirksamkeit
    FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON internes_audit, internes_audit_eintrag, feststellung, feststellung_eintrag,
    feststellung_wirksamkeit TO ${appDbUser};
GRANT UPDATE (titel, termin, auditor_ids, unabhaengigkeit, was, woran, verantwortlich_sub, verantwortlich_name,
    verantwortlich_konto, standort_ids, zustand, durchgefuehrt_am, abgesagt_begruendung, zusammenfassung,
    bericht_bezeichnung, bericht_ablage, bericht_kennung, bericht_adresse, bericht_sha256, kopie, pruefsumme,
    entschieden_von, abgeschlossen_am, abschluss_sub, abschluss_name, abschluss_rolle, abschluss_art,
    abschluss_eingetragen_am) ON internes_audit TO ${appDbUser};
GRANT UPDATE (frist, verantwortlich_sub, verantwortlich_name, verantwortlich_konto, zustand)
    ON feststellung TO ${appDbUser};
GRANT UPDATE (status, entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am,
    entscheidungs_begruendung) ON feststellung_wirksamkeit TO ${appDbUser};
GRANT SELECT, DELETE ON internes_audit, internes_audit_eintrag, feststellung, feststellung_eintrag,
    feststellung_wirksamkeit TO ${adminDbUser};
REVOKE ALL ON SEQUENCE internes_audit_eintrag_id_seq, feststellung_eintrag_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE internes_audit_eintrag_id_seq, feststellung_eintrag_id_seq
    TO ${appDbUser}, ${adminDbUser};

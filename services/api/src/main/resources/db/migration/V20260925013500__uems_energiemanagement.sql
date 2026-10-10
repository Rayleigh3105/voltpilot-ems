-- =============================================================================
-- AP-19 IP-5: Energiemanagement — Datenhaltung der Grundlage und des Dokuments
-- (G3, G5, DK1–DK8, PA1, PA2, RE1, RE2; §4.2, §5.6, §6.1 des Konzepts).
--
-- Neue, leere Tabellen; KEINE bestehende Zeile, Spalte, kein CHECK und kein
-- Fremdschlüssel einer bestehenden Tabelle ändert sich (Invariante 1). Wer
-- nichts anlegt, merkt nichts (Invariante 7).
--
--   energiemanagement_kennung_seq   Zähler D-nnnn (ohne Jahr, Muster BB-/KZ-) und
--                                   AU-/F-JJJJ-nnnn (je Jahr, IP-16) je Kundenbereich
--   energiemanagement_einstellung   eine Zeile je Unternehmen: Überprüfung, Audit-
--                                   und Managementbewertungs-Rhythmus, Frist einer
--                                   Feststellung, Vorschau (Startwerte des Vertrags)
--   energiemanagement_person        Person im Energiemanagement, auch ohne Konto (PA1)
--   energiemanagement_aufgabe       Aufgabe × Person × gilt ab/bis, zeitgültig und
--                                   nur anhängen (PA2)
--   energiemanagement_dokument      D-nnnn: Art (zwölf, geschlossen) × Bezug (G5, DK1)
--   energiemanagement_dokument_fassung   Fassung Nr. n: Wortlaut ≤ 20 000 Zeichen
--                                   ODER Verweis mit Ablage (G3), ab dem Antrag die
--                                   Kopie mit Prüfsumme (Vertrag §6), Freigabe mit
--                                   Vier-Augen und „entschieden von“ (DK2–DK4)
--   energiemanagement_dokument_eintrag   bekannt gemacht · geprüft, bleibt ·
--                                   aufgehoben · Kommentar — nur anhängen (DK5, DK6, DK8)
--   energiemanagement_anwendungsbereich  Standorte, Energieträger und Ausschlüsse
--                                   einer Fassung des Anwendungsbereichs (DK7)
--   energiemanagement_aenderung     Protokoll der Übergänge von Person, Aufgabe und
--                                   Dokument (§5.6), nur anhängen, ohne Fremdschlüssel
--
-- Übergänge sind einmalig (Trigger): eine Fassung ist ab der Freigabe (und nach
-- einer Ablehnung) unveränderlich; ein Antrag ändert sich nicht; „abgelöst“ wird
-- beim Lesen abgeleitet (DK4: die jüngste freigegebene Fassung gilt), die Zeile
-- bleibt byte-gleich (Invariante 6). Kein DELETE für die App-Rolle; nur das
-- Mandanten-Offboarding löscht.
--
-- Die Vokabulare stehen EINMAL in energiemanagement_vokabular(), zeilengleich zu
-- `energiemanagement-vectors.json` (IP-2, Muster verbesserung_vokabular()); die
-- Zuordnung `dokument_art_klasse` in energiemanagement_dokument_klasse(); die Muster
-- der Kennzeichen sind `kennzeichen_muster`. Weiten = CREATE OR REPLACE mit der GANZEN Liste
-- (Vereinigung, nie enger). Ein CHECK, der ein Wort prüft, fragt die Funktion.
--
-- Nicht dieses Paket: Routen (IP-6, IP-7), Verzeichnis (IP-8), Rolle „Einsicht“
-- (IP-12), internes Audit und Feststellung (IP-16), Herkunft der Maßnahme (IP-17).
-- =============================================================================

-- Die Vokabulare von `energiemanagement-vectors.json` (IP-2) zeilengleich und in der
-- Reihenfolge des Vertrags (`vokabulare`, dann `leitungs_pflicht`); `nr` ist die Stelle.
-- Wörter der Tabellen, die der Vertrag nicht als Block führt: `kennung_art` (Zähler),
-- `anwendungsbereich_ausschluss` (Arten wie bewertung_umfang_ausschluss),
-- `energiemanagement_protokoll` (§5.6: Person, Aufgabe, Dokument, Einstellung).
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
    ('energiemanagement_protokoll', 16, 'einstellung_geaendert')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION energiemanagement_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.energiemanagement_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- `dokument_art_klasse` des Vertrags: `vorgabe` (mit Überprüfung) oder `nachweis`
-- (Auslegung, Kompetenz — ohne, DK5); NULL für ein Wort außerhalb der Liste.
CREATE OR REPLACE FUNCTION energiemanagement_dokument_klasse(p_art TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_art IN ('auslegung', 'kompetenz') THEN 'nachweis'
              WHEN public.energiemanagement_wort('dokument_art', p_art) THEN 'vorgabe' END
$$;

-- Passt die Kopie einer Fassung zu ihren Spalten (DK2, Vertrag §6)? Die Kopie ist die
-- kanonische Form (bericht.md A1, `BerichtRegeln.kanonisch`) mit genau den Feldern
-- `nr`, `form`, `wortlaut`, `verweis`, `anwendungsbereich`; beim Wortlaut ist `verweis`
-- null, beim Verweis ein Objekt mit derselben Ablage. Die Kopie bildet der Schreibweg,
-- die Datenbank prüft sie und hält die Prüfsumme (`bericht_pruefsumme`).
CREATE OR REPLACE FUNCTION energiemanagement_fassung_kopie_passt(p_kopie TEXT, p_nr INTEGER, p_form TEXT,
    p_wortlaut TEXT, p_ablage TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT pg_catalog.jsonb_typeof(x.k) = 'object'
     AND (SELECT pg_catalog.array_agg(s ORDER BY s) FROM pg_catalog.jsonb_object_keys(x.k) s)
         = ARRAY['anwendungsbereich', 'form', 'nr', 'verweis', 'wortlaut']
     AND x.k ->> 'nr' = p_nr::text
     AND x.k ->> 'form' = p_form
     AND (x.k ->> 'wortlaut') IS NOT DISTINCT FROM p_wortlaut
     AND CASE p_form
           WHEN 'wortlaut' THEN x.k -> 'verweis' = 'null'::jsonb
           ELSE pg_catalog.jsonb_typeof(x.k -> 'verweis') = 'object' AND x.k -> 'verweis' ->> 'ablage' = p_ablage
         END
    FROM (SELECT p_kopie::jsonb AS k) x
$$;

-- Ein Verweis (G3) — an der Fassung, am Dokument (das unterschriebene Original) und
-- an der Aufgabe (Beleg): ohne Ablage keiner seiner Teile; mit ihr sind Bezeichnung,
-- Kennung, Adresse, Fassungsangabe, Datum und die im Browser gebildete Prüfsumme wahlfrei.
CREATE OR REPLACE FUNCTION energiemanagement_verweis_ok(p_bezeichnung TEXT, p_ablage TEXT, p_kennung TEXT,
    p_adresse TEXT, p_fassungsangabe TEXT, p_datum DATE, p_sha256 TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_ablage IS NULL
              THEN pg_catalog.num_nonnulls(p_bezeichnung, p_kennung, p_adresse, p_fassungsangabe, p_datum, p_sha256) = 0
              ELSE pg_catalog.btrim(p_ablage) <> '' AND pg_catalog.char_length(p_ablage) <= 200
                   AND coalesce(pg_catalog.btrim(p_bezeichnung) <> '' AND pg_catalog.char_length(p_bezeichnung) <= 200, true)
                   AND coalesce(pg_catalog.btrim(p_kennung) <> '' AND pg_catalog.char_length(p_kennung) <= 200, true)
                   AND coalesce(pg_catalog.btrim(p_adresse) <> '' AND pg_catalog.char_length(p_adresse) <= 2000, true)
                   AND coalesce(pg_catalog.btrim(p_fassungsangabe) <> ''
                                AND pg_catalog.char_length(p_fassungsangabe) <= 200, true)
                   AND coalesce(p_sha256 ~ '^[0-9a-f]{64}$', true)
         END
$$;

-- -----------------------------------------------------------------------------
-- energiemanagement_kennung_seq: D-<Nr.> (Jahr 0 = ohne Jahr) und AU-/F-<Jahr>-<Nr.>
-- je Kundenbereich — eine Tabelle, nie ein BIGSERIAL (Muster verbesserung_kennung_seq).
-- `naechste_nummer` ist die nächste Nummer; der Zähler rückt nur mit einer
-- vergebenen Kennung vor (dieselbe Transaktion) und nie zurück.
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_kennung_seq (
    tenant_id        UUID    NOT NULL,
    art              TEXT    NOT NULL,
    jahr             INTEGER NOT NULL,
    naechste_nummer  BIGINT  NOT NULL DEFAULT 1,
    CONSTRAINT energiemanagement_kennung_seq_pk PRIMARY KEY (tenant_id, art, jahr),
    CONSTRAINT energiemanagement_kennung_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_kennung_seq_art_chk CHECK (coalesce(energiemanagement_wort('kennung_art', art), false)),
    -- D ohne Jahr (0), AU und F je Jahr.
    CONSTRAINT energiemanagement_kennung_seq_jahr_chk CHECK (
        CASE WHEN art = 'D' THEN jahr = 0 ELSE jahr BETWEEN 1000 AND 9999 END),
    CONSTRAINT energiemanagement_kennung_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

CREATE FUNCTION energiemanagement_kennung_seq_rueckt_vor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.art <> OLD.art OR NEW.jahr <> OLD.jahr
        OR NEW.naechste_nummer < OLD.naechste_nummer THEN
        RAISE EXCEPTION 'Der Kennzeichen-Zähler rückt nur vor (% auf %)', OLD.naechste_nummer, NEW.naechste_nummer
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_kennung_seq_rueckt_nur_vor';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_kennung_seq_rueckt_vor BEFORE UPDATE ON energiemanagement_kennung_seq
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_kennung_seq_rueckt_vor();

-- Die nächste Kennung des Kundenbereichs — D-<Nr.> (p_jahr NULL) bzw.
-- AU-/F-<Jahr>-<Nr.> — und der Zähler rückt dahinter. Die Zeile wird gesperrt
-- oder angelegt: parallele Vergaben warten aufeinander, eine zurückgerollte Anlage
-- gibt ihre Nummer zurück. Läuft als Aufrufer (unter RLS nur der eigene Mandant).
CREATE FUNCTION uems_energiemanagement_kennung(p_tenant UUID, p_art TEXT, p_jahr INTEGER) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
    j INTEGER := CASE WHEN p_art = 'D' THEN 0 ELSE p_jahr END;
    n BIGINT;
BEGIN
    IF p_tenant IS NULL OR p_art IS NULL OR j IS NULL OR (p_art = 'D' AND p_jahr IS NOT NULL) THEN
        RAISE EXCEPTION 'a tenant scope and a kind are required, a year only for AU and F' USING ERRCODE = '22023';
    END IF;
    INSERT INTO energiemanagement_kennung_seq AS z (tenant_id, art, jahr, naechste_nummer)
    VALUES (p_tenant, p_art, j, 1)
    ON CONFLICT (tenant_id, art, jahr) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    UPDATE energiemanagement_kennung_seq SET naechste_nummer = n + 1
     WHERE tenant_id = p_tenant AND art = p_art AND jahr = j;
    RETURN p_art || CASE WHEN p_art = 'D' THEN '' ELSE '-' || j END
        || '-' || lpad(n::text, greatest(4, length(n::text)), '0');
END
$$;

-- Ein ausdrücklich gesetztes Kennzeichen (Übernahme, Referenzdatei) rückt den
-- Zähler dahinter; ein unförmiges lässt ihn stehen — den Fehler meldet der CHECK.
CREATE FUNCTION uems_energiemanagement_kennung_vorruecken(p_tenant UUID, p_kennung TEXT) RETURNS VOID
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
    d TEXT[] := regexp_match(p_kennung, '^D-([0-9]{4,13})$');
    t TEXT[] := regexp_match(p_kennung, '^(AU|F)-([0-9]{4})-([0-9]{4,9})$');
    v_art TEXT;
    v_jahr INTEGER;
    v_nr BIGINT;
BEGIN
    IF d IS NOT NULL THEN
        v_art := 'D'; v_jahr := 0; v_nr := d[1]::bigint;
    ELSIF t IS NOT NULL THEN
        v_art := t[1]; v_jahr := t[2]::integer; v_nr := t[3]::bigint;
    END IF;
    IF p_tenant IS NULL OR v_art IS NULL OR v_nr = 0 THEN
        RETURN;
    END IF;
    INSERT INTO energiemanagement_kennung_seq AS z (tenant_id, art, jahr, naechste_nummer)
    VALUES (p_tenant, v_art, v_jahr, v_nr + 1)
    ON CONFLICT (tenant_id, art, jahr) DO UPDATE
        SET naechste_nummer = greatest(z.naechste_nummer, EXCLUDED.naechste_nummer);
END
$$;

-- -----------------------------------------------------------------------------
-- energiemanagement_einstellung: eine Zeile je Unternehmen (= Kundenbereich).
-- Fehlt sie, gelten die Startwerte des Vertrags — dieselben wie die Vorgaben hier
-- (ohne Norm-Herleitung, Muster AP-16/AP-18 §8.5).
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_einstellung (
    tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
    ueberpruefung_monate INTEGER NOT NULL DEFAULT 12,
    audit_rhythmus_monate INTEGER NOT NULL DEFAULT 12,
    managementbewertung_rhythmus_monate INTEGER NOT NULL DEFAULT 12,
    feststellung_frist_tage INTEGER NOT NULL DEFAULT 90,
    vorschau_tage INTEGER NOT NULL DEFAULT 30,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_einstellung_monate_chk CHECK (ueberpruefung_monate BETWEEN 1 AND 60
        AND audit_rhythmus_monate BETWEEN 1 AND 60 AND managementbewertung_rhythmus_monate BETWEEN 1 AND 60),
    CONSTRAINT energiemanagement_einstellung_tage_chk CHECK (feststellung_frist_tage > 0 AND vorschau_tage > 0),
    CONSTRAINT energiemanagement_einstellung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_einstellung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_einstellung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

-- -----------------------------------------------------------------------------
-- energiemanagement_person (PA1, PA5): wer außerhalb des Systems entscheidet,
-- prüft oder teilnimmt — Name und Funktion, wahlfrei Kürzel (so nennen die Kopien
-- sie: „entschieden_von“: „RF“), Organisation, Konto (`benutzer`), seit, bis. Nie gelöscht, solange eine Zeile sie nennt (RESTRICT);
-- „bis“ beendet sie, endgültig. Ein Konto gehört höchstens einer Person.
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_person (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    funktion TEXT NOT NULL,
    kuerzel TEXT,
    organisation TEXT,
    konto_sub TEXT,
    seit DATE,
    bis DATE,
    zustand TEXT NOT NULL DEFAULT 'aktiv',
    beendet_begruendung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_person_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_person_konto_fk FOREIGN KEY (tenant_id, konto_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_person_text_chk CHECK (btrim(name) <> '' AND char_length(name) <= 200
        AND btrim(funktion) <> '' AND char_length(funktion) <= 200
        AND (kuerzel IS NULL OR (btrim(kuerzel) = kuerzel AND kuerzel <> '' AND char_length(kuerzel) <= 10))
        AND (organisation IS NULL OR (btrim(organisation) <> '' AND char_length(organisation) <= 200))
        AND (konto_sub IS NULL OR btrim(konto_sub) <> '')),
    CONSTRAINT energiemanagement_person_zeitraum_chk CHECK (seit IS NULL OR bis IS NULL OR bis >= seit),
    CONSTRAINT energiemanagement_person_zustand_chk CHECK (coalesce(energiemanagement_wort('person_zustand', zustand), false)),
    -- „bis“ beendet: Tag und Begründung (10–500) genau dann, wenn beendet.
    CONSTRAINT energiemanagement_person_beendet_chk CHECK (
        (zustand = 'beendet') = (bis IS NOT NULL)
        AND (bis IS NULL) = (beendet_begruendung IS NULL)
        AND (beendet_begruendung IS NULL OR char_length(btrim(beendet_begruendung)) BETWEEN 10 AND 500)),
    CONSTRAINT energiemanagement_person_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_person_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_person_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE UNIQUE INDEX energiemanagement_person_konto_uq ON energiemanagement_person (tenant_id, konto_sub)
    WHERE konto_sub IS NOT NULL;
CREATE UNIQUE INDEX energiemanagement_person_kuerzel_uq ON energiemanagement_person (tenant_id, kuerzel)
    WHERE kuerzel IS NOT NULL;

-- Übergänge einmalig: Identität und Anlage nie; eine beendete Person ist endgültig.
CREATE FUNCTION energiemanagement_person_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Identität und Anlage einer Person im Energiemanagement sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_person_identitaet_bleibt';
    END IF;
    IF OLD.zustand = 'beendet' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Die Person % ist beendet', OLD.name
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_person_endgueltig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_person_eingefroren BEFORE UPDATE ON energiemanagement_person
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_person_eingefroren();

-- -----------------------------------------------------------------------------
-- energiemanagement_aufgabe (PA2): Aufgabe (zehn Wörter, „weitere“ mit Wortlaut)
-- × Person × gilt ab/bis (Tage, der letzte eingeschlossen), wahlfrei Vertretung,
-- Beleg als Verweis und Beschluss (BR-JJJJ-nnnn/Bn, IP-23). „Entschieden von“ ist
-- Pflicht außer bei der Leitung des Unternehmens. Zeitgültig und nur anhängen:
-- eine Zuordnung ändert sich nie — außer dem einmaligen Ende (gilt bis +
-- Begründung); eine Übergabe ist eine neue Zuordnung ab dem Folgetag.
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_aufgabe (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    aufgabe TEXT NOT NULL,
    aufgabe_wortlaut TEXT,
    person_id UUID NOT NULL,
    gilt_ab DATE NOT NULL,
    gilt_bis DATE,
    vertretung_person_id UUID,
    entschieden_von UUID,
    begruendung TEXT NOT NULL,
    beleg_bezeichnung TEXT,
    beleg_ablage TEXT,
    beleg_kennung TEXT,
    beleg_adresse TEXT,
    beleg_sha256 CHAR(64),
    beschluss_kennung TEXT,
    zustand TEXT NOT NULL DEFAULT 'laufend',
    beendet_begruendung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_aufgabe_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_aufgabe_person_fk FOREIGN KEY (person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_aufgabe_vertretung_fk FOREIGN KEY (vertretung_person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_aufgabe_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_aufgabe_aufgabe_chk CHECK (coalesce(energiemanagement_wort('aufgabe', aufgabe), false)),
    CONSTRAINT energiemanagement_aufgabe_wortlaut_chk CHECK (CASE WHEN aufgabe = 'weitere'
        THEN coalesce(btrim(aufgabe_wortlaut) <> '' AND char_length(aufgabe_wortlaut) <= 200, false)
        ELSE aufgabe_wortlaut IS NULL END),
    CONSTRAINT energiemanagement_aufgabe_entschieden_chk CHECK (aufgabe = 'unternehmensleitung' OR entschieden_von IS NOT NULL),
    CONSTRAINT energiemanagement_aufgabe_vertretung_chk CHECK (vertretung_person_id IS DISTINCT FROM person_id),
    CONSTRAINT energiemanagement_aufgabe_begruendung_chk CHECK (char_length(btrim(begruendung)) BETWEEN 10 AND 500),
    -- Der Beleg ist ein Verweis (G3): ohne Ablage keiner seiner Teile.
    CONSTRAINT energiemanagement_aufgabe_beleg_chk CHECK (energiemanagement_verweis_ok(beleg_bezeichnung, beleg_ablage,
        beleg_kennung, beleg_adresse, NULL, NULL, beleg_sha256)),
    -- Vertrag `kennzeichen_muster.beschluss`.
    CONSTRAINT energiemanagement_aufgabe_beschluss_chk CHECK (
        beschluss_kennung IS NULL OR beschluss_kennung ~ '^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$'),
    CONSTRAINT energiemanagement_aufgabe_zustand_chk CHECK (coalesce(energiemanagement_wort('aufgabe_zustand', zustand), false)),
    CONSTRAINT energiemanagement_aufgabe_beendet_chk CHECK (
        (zustand = 'beendet') = (gilt_bis IS NOT NULL)
        AND (gilt_bis IS NULL) = (beendet_begruendung IS NULL)
        AND (gilt_bis IS NULL OR gilt_bis >= gilt_ab)
        AND (beendet_begruendung IS NULL OR char_length(btrim(beendet_begruendung)) BETWEEN 10 AND 500)),
    CONSTRAINT energiemanagement_aufgabe_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_aufgabe_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_aufgabe_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_aufgabe_aufgabe_idx ON energiemanagement_aufgabe (tenant_id, aufgabe, gilt_ab);
CREATE INDEX energiemanagement_aufgabe_person_idx ON energiemanagement_aufgabe (tenant_id, person_id);

-- Nur anhängen: außer dem einmaligen Ende (gilt bis, Zustand, Begründung) ändert
-- sich nichts; eine beendete Zuordnung ist endgültig.
CREATE FUNCTION energiemanagement_aufgabe_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.zustand = 'beendet' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Die Zuordnung ist beendet'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_aufgabe_endgueltig';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['gilt_bis', 'zustand', 'beendet_begruendung'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['gilt_bis', 'zustand', 'beendet_begruendung']) THEN
        RAISE EXCEPTION 'Eine Zuordnung ändert sich nie — eine Übergabe ist eine neue Zuordnung'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_aufgabe_nur_anhaengen';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_aufgabe_eingefroren BEFORE UPDATE ON energiemanagement_aufgabe
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_aufgabe_eingefroren();

-- -----------------------------------------------------------------------------
-- energiemanagement_dokument (G5, DK1, DK8): D-nnnn, Art aus der geschlossenen
-- Liste (keine Art „sonstiges“), Titel, Bezug. `standort_id` ist der Zaun (RE1):
-- der Standort des Bezugs, ohne Standort das Unternehmen (NULL — dann nur
-- unternehmensweit sichtbar). Beim Bezug Standort ist er der Bezug selbst; beim
-- Energieeinsatz leitet ihn der Schreibweg ab (IP-14); Unternehmen, Person und
-- Aufgabe haben keinen. `ueberpruefung_monate` nur bei Vorgabe-Arten (DK5; fehlt er,
-- setzt der Anlege-Trigger den Wert der Einstellung bzw. den Startwert 12), Nachweise
-- (Auslegung, Kompetenz) haben keine Überprüfung. `beleg_*` ist der Verweis auf das
-- unterschriebene Original beim Kunden (G1: „Wortlaut in VoltPilot, Original bei
-- Ihnen“). Nie gelöscht; aufgehoben bleibt es mit allen Fassungen.
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_dokument (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    art TEXT NOT NULL,
    titel TEXT NOT NULL,
    bezug TEXT NOT NULL,
    standort_id UUID,
    energieeinsatz_id UUID,
    person_id UUID,
    aufgabe_id UUID,
    zustand TEXT NOT NULL DEFAULT 'entwurf',
    ueberpruefung_monate INTEGER,
    beleg_bezeichnung TEXT,
    beleg_ablage TEXT,
    beleg_kennung TEXT,
    beleg_adresse TEXT,
    beleg_sha256 CHAR(64),
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_dokument_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_dokument_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- Vertrag `kennzeichen_muster.dokument` (Muster BB-).
    CONSTRAINT energiemanagement_dokument_kennzeichen_chk CHECK (kennzeichen ~ '^D-[0-9]{4,13}$'
        AND substring(kennzeichen FROM 3) !~ '^0+$'),
    CONSTRAINT energiemanagement_dokument_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_dokument_energieeinsatz_fk FOREIGN KEY (energieeinsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_dokument_person_fk FOREIGN KEY (person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_dokument_aufgabe_fk FOREIGN KEY (aufgabe_id, tenant_id)
        REFERENCES energiemanagement_aufgabe(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_dokument_art_chk CHECK (coalesce(energiemanagement_wort('dokument_art', art), false)),
    CONSTRAINT energiemanagement_dokument_titel_chk CHECK (btrim(titel) <> '' AND char_length(titel) <= 200),
    CONSTRAINT energiemanagement_dokument_zustand_chk CHECK (coalesce(energiemanagement_wort('dokument_zustand', zustand), false)),
    CONSTRAINT energiemanagement_dokument_ueberpruefung_chk CHECK (
        CASE energiemanagement_dokument_klasse(art) WHEN 'nachweis' THEN ueberpruefung_monate IS NULL
             ELSE coalesce(ueberpruefung_monate BETWEEN 1 AND 60, false) END),
    CONSTRAINT energiemanagement_dokument_beleg_chk CHECK (energiemanagement_verweis_ok(beleg_bezeichnung, beleg_ablage,
        beleg_kennung, beleg_adresse, NULL, NULL, beleg_sha256)),
    -- Genau der Verweis des Bezugs ist gesetzt (G5).
    CONSTRAINT energiemanagement_dokument_bezug_chk CHECK (coalesce(energiemanagement_wort('dokument_bezug', bezug)
        AND CASE bezug
            WHEN 'unternehmen' THEN num_nonnulls(standort_id, energieeinsatz_id, person_id, aufgabe_id) = 0
            WHEN 'standort' THEN standort_id IS NOT NULL AND num_nonnulls(energieeinsatz_id, person_id, aufgabe_id) = 0
            WHEN 'energieeinsatz' THEN energieeinsatz_id IS NOT NULL AND num_nonnulls(person_id, aufgabe_id) = 0
            WHEN 'person' THEN person_id IS NOT NULL AND num_nonnulls(standort_id, energieeinsatz_id, aufgabe_id) = 0
            WHEN 'aufgabe' THEN aufgabe_id IS NOT NULL AND num_nonnulls(standort_id, energieeinsatz_id, person_id) = 0
        END, false)),
    CONSTRAINT energiemanagement_dokument_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_dokument_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_dokument_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_dokument_standort_idx ON energiemanagement_dokument (tenant_id, standort_id)
    WHERE standort_id IS NOT NULL;
CREATE INDEX energiemanagement_dokument_art_idx ON energiemanagement_dokument (tenant_id, art);

-- D-<Nr.> (Muster bezugsbasis_kennzeichen_setzen): fehlt es, vergibt der Zähler;
-- ein gesetztes rückt ihn dahinter. Ein Dokument entsteht im Entwurf; eine Vorgabe
-- ohne Überprüfungs-Monate bekommt die der Einstellung (Startwert 12).
CREATE FUNCTION energiemanagement_dokument_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'entwurf' THEN
        RAISE EXCEPTION 'Ein Dokument entsteht im Entwurf'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_uebergang_einmalig';
    END IF;
    IF NEW.ueberpruefung_monate IS NULL AND energiemanagement_dokument_klasse(NEW.art) = 'vorgabe' THEN
        NEW.ueberpruefung_monate := coalesce((SELECT e.ueberpruefung_monate FROM energiemanagement_einstellung e
                                               WHERE e.tenant_id = NEW.tenant_id), 12);
    END IF;
    IF NEW.kennzeichen IS NULL THEN
        NEW.kennzeichen := uems_energiemanagement_kennung(NEW.tenant_id, 'D', NULL);
    ELSE
        PERFORM uems_energiemanagement_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_dokument_anlegen BEFORE INSERT ON energiemanagement_dokument
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_dokument_anlegen();

-- Übergänge einmalig (§5.6): entwurf → gültig (nur mit einer freigegebenen
-- Fassung) · entwurf/gültig → aufgehoben (nur mit dem Eintrag „aufgehoben“: Tag,
-- Begründung, entschieden von — erst der Eintrag, dann der Zustand); aufgehoben
-- ist endgültig, zurück in den Entwurf nie. Identität, Art und Bezug nie; der
-- Titel ändert sich nur, solange das Dokument nicht aufgehoben ist.
CREATE FUNCTION energiemanagement_dokument_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kennzeichen <> OLD.kennzeichen
        OR NEW.art <> OLD.art OR NEW.bezug <> OLD.bezug
        OR NEW.standort_id IS DISTINCT FROM OLD.standort_id
        OR NEW.energieeinsatz_id IS DISTINCT FROM OLD.energieeinsatz_id
        OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.aufgabe_id IS DISTINCT FROM OLD.aufgabe_id
        OR NEW.angelegt_am <> OLD.angelegt_am OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Identität, Art und Bezug eines Dokuments sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_identitaet_bleibt';
    END IF;
    IF OLD.zustand = 'aufgehoben' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Das Dokument % ist aufgehoben', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_endgueltig';
    END IF;
    IF NEW.zustand <> OLD.zustand THEN
        IF NEW.zustand = 'entwurf'
            OR (NEW.zustand = 'gueltig' AND NOT EXISTS (SELECT 1 FROM energiemanagement_dokument_fassung f
                    WHERE f.tenant_id = NEW.tenant_id AND f.dokument_id = NEW.id AND f.freigabe_status = 'freigegeben'))
            OR (NEW.zustand = 'aufgehoben' AND NOT EXISTS (SELECT 1 FROM energiemanagement_dokument_eintrag e
                    WHERE e.tenant_id = NEW.tenant_id AND e.dokument_id = NEW.id AND e.art = 'aufgehoben')) THEN
            RAISE EXCEPTION 'Das Dokument % geht nicht von % nach %', OLD.kennzeichen, OLD.zustand, NEW.zustand
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_uebergang_einmalig';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_dokument_eingefroren BEFORE UPDATE ON energiemanagement_dokument
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_dokument_eingefroren();

-- -----------------------------------------------------------------------------
-- energiemanagement_dokument_fassung (G3, DK2–DK4): Fassung Nr. n (lückenlos, der
-- Trigger vergibt sie), Form Wortlaut (≤ 20 000 Zeichen) ODER Verweis (Ablage
-- Pflicht; Bezeichnung, Kennung, Adresse, Fassungsangabe, Datum und die im Browser
-- gebildete Prüfsumme wahlfrei) — ganz oder gar nicht, nie eine Datei; wahlfrei der
-- Beschluss (BR-…/Bn), aus dem die Fassung folgt. Ab dem Antrag trägt sie ihre
-- `kopie` (kanonische Form von bericht.md A1 mit `nr`, `form`, `wortlaut`,
-- `verweis`, `anwendungsbereich` — Vertrag energiemanagement.md §6) und die
-- `pruefsumme = bericht_pruefsumme(kopie)`, die die Datenbank hält.
--
-- Freigabe (Muster bezugsbasis_fassung): `freigabe_status` entwurf · beantragt
-- (Vier-Augen offen) · freigegeben · abgelehnt; „abgelöst“ ist ein Wort des
-- Lesens (DK4) und nie gespeichert. Ab dem Antrag tragen `entschieden_von` (die
-- Person im Energiemanagement, auch ohne Konto) und `entschieden_tag` die
-- Entscheidung, `freigabe_*` das eintragende Konto (G2); bei Energiepolitik,
-- Anwendungsbereich und Bestellung ist „entschieden von“ die Person mit der am
-- Tag laufenden Aufgabe „Leitung des Unternehmens“ (DK3/PA3). Bei Vier-Augen
-- entscheidet eine ZWEITE Person (KA/EM, nie der Urheber).
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_dokument_fassung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    dokument_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    form TEXT NOT NULL,
    wortlaut TEXT,
    verweis_bezeichnung TEXT,
    verweis_ablage TEXT,
    verweis_kennung TEXT,
    verweis_adresse TEXT,
    verweis_fassungsangabe TEXT,
    verweis_datum DATE,
    verweis_sha256 CHAR(64),
    kopie TEXT,
    pruefsumme TEXT,
    -- DK2: ab Fassung 2 Pflicht (10–500 Zeichen).
    begruendung TEXT,
    beschluss_kennung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    vieraugen BOOLEAN NOT NULL DEFAULT false,
    freigabe_status TEXT NOT NULL DEFAULT 'entwurf',
    entschieden_von UUID,
    entschieden_tag DATE,
    freigabe_begruendung TEXT,
    freigabe_sub TEXT,
    freigabe_name TEXT,
    freigabe_rolle TEXT,
    freigabe_art TEXT,
    freigabe_am TIMESTAMPTZ,
    entscheidung_sub TEXT,
    entscheidung_name TEXT,
    entscheidung_rolle TEXT,
    entscheidung_art TEXT,
    entschieden_am TIMESTAMPTZ,
    entscheidungs_begruendung TEXT,
    freigegeben_am TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_fassung_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_fassung_nummer_uq UNIQUE (tenant_id, dokument_id, fassung),
    CONSTRAINT energiemanagement_fassung_dokument_fk FOREIGN KEY (dokument_id, tenant_id)
        REFERENCES energiemanagement_dokument(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_fassung_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    -- G3: Wortlaut ODER Verweis mit Ablage — ganz oder gar nicht.
    CONSTRAINT energiemanagement_fassung_form_chk CHECK (coalesce(energiemanagement_wort('fassung_form', form)
        AND CASE form
            WHEN 'wortlaut' THEN btrim(wortlaut) <> '' AND char_length(wortlaut) <= 20000
                AND num_nonnulls(verweis_bezeichnung, verweis_ablage, verweis_kennung, verweis_adresse,
                    verweis_fassungsangabe, verweis_datum, verweis_sha256) = 0
            WHEN 'verweis' THEN wortlaut IS NULL AND verweis_ablage IS NOT NULL
                AND energiemanagement_verweis_ok(verweis_bezeichnung, verweis_ablage, verweis_kennung, verweis_adresse,
                    verweis_fassungsangabe, verweis_datum, verweis_sha256)
        END, false)),
    -- DK2: ab dem Antrag die Kopie, passend zu den Spalten; im Entwurf wahlfrei.
    CONSTRAINT energiemanagement_fassung_kopie_chk CHECK (
        (freigabe_status = 'entwurf' OR kopie IS NOT NULL)
        AND (kopie IS NULL OR coalesce(energiemanagement_fassung_kopie_passt(kopie, fassung, form, wortlaut,
            verweis_ablage), false))),
    CONSTRAINT energiemanagement_fassung_pruefsumme_chk CHECK ((kopie IS NULL) = (pruefsumme IS NULL)
        AND (kopie IS NULL OR pruefsumme = bericht_pruefsumme(kopie))),
    -- Vertrag `kennzeichen_muster.beschluss`.
    CONSTRAINT energiemanagement_fassung_beschluss_chk CHECK (
        beschluss_kennung IS NULL OR beschluss_kennung ~ '^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$'),
    CONSTRAINT energiemanagement_fassung_begruendung_chk CHECK (
        (begruendung IS NULL OR char_length(btrim(begruendung)) BETWEEN 10 AND 500)
        AND (fassung = 1 OR begruendung IS NOT NULL)),
    -- „abgelöst“ wird gelesen, nicht gespeichert (DK4, Invariante 6).
    CONSTRAINT energiemanagement_fassung_status_chk CHECK (
        coalesce(energiemanagement_wort('fassung_status', freigabe_status), false) AND freigabe_status <> 'abgeloest'),
    CONSTRAINT energiemanagement_fassung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_fassung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_fassung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    -- G2/DK3: außerhalb des Entwurfs „entschieden von“ (Person), Tag, Begründung
    -- (10–500) und das eintragende Konto; im Entwurf nichts davon.
    CONSTRAINT energiemanagement_fassung_freigabe_chk CHECK (coalesce(CASE WHEN freigabe_status = 'entwurf' THEN
            num_nonnulls(entschieden_von, entschieden_tag, freigabe_begruendung, freigabe_sub, freigabe_name,
                freigabe_rolle, freigabe_art, freigabe_am) = 0
        ELSE entschieden_von IS NOT NULL AND entschieden_tag IS NOT NULL
            AND char_length(btrim(freigabe_begruendung)) BETWEEN 10 AND 500
            AND btrim(freigabe_name) <> '' AND freigabe_am IS NOT NULL
            AND freigabe_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (freigabe_rolle IS NULL OR freigabe_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
            AND (btrim(freigabe_sub) <> '' OR (freigabe_sub IS NULL AND freigabe_art = 'voltpilot')) END, false)),
    CONSTRAINT energiemanagement_fassung_freigegeben_am_chk CHECK (
        (freigabe_status = 'freigegeben') = (freigegeben_am IS NOT NULL)),
    -- DK3 (Muster bezugsbasis_fassung): ohne Vier-Augen weder beantragt noch
    -- abgelehnt; die zweite Person ist nie die erste und hat Rolle KA oder EM.
    CONSTRAINT energiemanagement_fassung_vieraugen_chk CHECK (vieraugen OR freigabe_status IN ('entwurf', 'freigegeben')),
    CONSTRAINT energiemanagement_fassung_entscheidung_chk CHECK (coalesce(
        CASE WHEN vieraugen AND freigabe_status IN ('freigegeben', 'abgelehnt') THEN
            entscheidung_sub <> freigabe_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager') AND entschieden_am IS NOT NULL
        ELSE num_nonnulls(entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am) = 0
        END, false)),
    CONSTRAINT energiemanagement_fassung_ablehnung_chk CHECK (
        (freigabe_status = 'abgelehnt') = coalesce(btrim(entscheidungs_begruendung) <> '', false))
);
-- Höchstens ein offener Entwurf bzw. Antrag je Dokument.
CREATE UNIQUE INDEX energiemanagement_fassung_offen_uq ON energiemanagement_dokument_fassung (tenant_id, dokument_id)
    WHERE freigabe_status IN ('entwurf', 'beantragt');

-- Eine Fassung entsteht im Entwurf, mit der nächsten Nr. (lückenlos, auch eine
-- abgelehnte behält ihre), und nie an einem aufgehobenen Dokument.
CREATE FUNCTION energiemanagement_fassung_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    naechste INTEGER;
    zustand TEXT;
BEGIN
    SELECT d.zustand INTO zustand FROM energiemanagement_dokument d
     WHERE d.id = NEW.dokument_id AND d.tenant_id = NEW.tenant_id FOR UPDATE;
    IF zustand = 'aufgehoben' THEN
        RAISE EXCEPTION 'Das Dokument ist aufgehoben — keine neue Fassung'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_endgueltig';
    END IF;
    IF NEW.freigabe_status IS DISTINCT FROM 'entwurf' THEN
        RAISE EXCEPTION 'Eine Fassung entsteht im Entwurf'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_uebergang_einmalig';
    END IF;
    SELECT coalesce(max(f.fassung), 0) + 1 INTO naechste FROM energiemanagement_dokument_fassung f
     WHERE f.tenant_id = NEW.tenant_id AND f.dokument_id = NEW.dokument_id;
    IF NEW.fassung IS NULL THEN
        NEW.fassung := naechste;
    ELSIF NEW.fassung <> naechste THEN
        RAISE EXCEPTION 'Die nächste Fassung ist Nr. %, nicht Nr. %', naechste, NEW.fassung
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_lueckenlos';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_fassung_anlegen BEFORE INSERT ON energiemanagement_dokument_fassung
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_fassung_anlegen();

-- Übergänge einmalig (DK2–DK4): im Entwurf ist die Fassung änderbar; ab dem
-- Antrag bleibt ihr Inhalt, und eine zweite Person bestätigt oder lehnt ab;
-- freigegeben und abgelehnt sind unveränderlich — keine Spalte ändert sich mehr.
-- Bei Vier-Augen geht jede Freigabe über einen Antrag. Wer den Entwurf verlässt,
-- braucht bei den Leitungs-Arten die Leitung als „entschieden von“ am Tag und
-- beim Anwendungsbereich dessen Standorte und Träger (DK7).
CREATE FUNCTION energiemanagement_fassung_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    dok_art TEXT;
    entscheid CONSTANT TEXT[] := ARRAY['freigabe_status', 'entscheidung_sub', 'entscheidung_name',
        'entscheidung_rolle', 'entscheidung_art', 'entschieden_am', 'entscheidungs_begruendung', 'freigegeben_am'];
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.dokument_id <> OLD.dokument_id
        OR NEW.fassung <> OLD.fassung OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Die Identität einer Fassung ist nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_identitaet_bleibt';
    END IF;
    IF OLD.freigabe_status IN ('freigegeben', 'abgelehnt') THEN
        IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
            RAISE EXCEPTION 'Die Fassung % ist % und unveränderlich', OLD.fassung, OLD.freigabe_status
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_unveraenderlich';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.freigabe_status = 'beantragt' THEN
        IF NEW.freigabe_status NOT IN ('beantragt', 'freigegeben', 'abgelehnt')
            OR (to_jsonb(NEW) - entscheid) IS DISTINCT FROM (to_jsonb(OLD) - entscheid) THEN
            RAISE EXCEPTION 'Der Antrag auf Freigabe der Fassung % ändert sich nicht', OLD.fassung
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_antrag_bleibt';
        END IF;
        RETURN NEW;
    END IF;
    -- OLD.freigabe_status = 'entwurf'
    IF NEW.freigabe_status = 'abgelehnt' OR (NEW.freigabe_status = 'freigegeben' AND NEW.vieraugen) THEN
        RAISE EXCEPTION 'Über die Fassung % entscheidet bei Vier-Augen eine zweite Person auf Antrag', OLD.fassung
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_uebergang_einmalig';
    END IF;
    IF NEW.freigabe_status IN ('beantragt', 'freigegeben') THEN
        SELECT d.art INTO dok_art FROM energiemanagement_dokument d
         WHERE d.id = NEW.dokument_id AND d.tenant_id = NEW.tenant_id;
        -- Fehlt „entschieden von“ ganz, meldet es energiemanagement_fassung_freigabe_chk.
        IF energiemanagement_wort('leitungs_pflicht', dok_art) AND NEW.entschieden_von IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM energiemanagement_aufgabe a
                 WHERE a.tenant_id = NEW.tenant_id AND a.aufgabe = 'unternehmensleitung'
                   AND a.person_id = NEW.entschieden_von AND a.gilt_ab <= NEW.entschieden_tag
                   AND (a.gilt_bis IS NULL OR a.gilt_bis >= NEW.entschieden_tag)) THEN
            RAISE EXCEPTION 'Über % entscheidet die Leitung des Unternehmens', dok_art
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_leitung';
        END IF;
        -- DK7: der Anwendungsbereich trägt seine Standorte und Träger (Tabelle und Kopie),
        -- jede andere Art in der Kopie `anwendungsbereich: null`.
        IF (dok_art = 'anwendungsbereich' AND NOT EXISTS (SELECT 1 FROM energiemanagement_anwendungsbereich b
                WHERE b.tenant_id = NEW.tenant_id AND b.fassung_id = NEW.id))
            OR (NEW.kopie IS NOT NULL
                AND (NEW.kopie::jsonb -> 'anwendungsbereich' = 'null'::jsonb) = (dok_art = 'anwendungsbereich')) THEN
            RAISE EXCEPTION 'Der Anwendungsbereich nennt Standorte und Energieträger'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_anwendungsbereich';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_fassung_eingefroren BEFORE UPDATE ON energiemanagement_dokument_fassung
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_fassung_eingefroren();

-- -----------------------------------------------------------------------------
-- energiemanagement_anwendungsbereich (DK7): je Fassung eines Anwendungsbereichs
-- die Standorte (≥ 1), die Energieträger (Vokabular des Betrachtungsumfangs,
-- bewertung_umfang) und die Ausschlüsse [{art, verweis, begruendung}] (Arten wie
-- bewertung_umfang_ausschluss). Geschrieben nur, solange die Fassung ein Entwurf
-- ist; danach so unveränderlich wie sie.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION energiemanagement_ausschluesse_ok(p_ausschluesse JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT pg_catalog.jsonb_typeof(p_ausschluesse) = 'array'
     AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_ausschluesse) a
          WHERE pg_catalog.jsonb_typeof(a) <> 'object'
             OR NOT coalesce(public.energiemanagement_wort('anwendungsbereich_ausschluss', a ->> 'art'), false)
             OR NOT coalesce((a ->> 'verweis') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
             OR NOT coalesce(char_length(btrim(a ->> 'begruendung')) BETWEEN 10 AND 500, false)
             OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(a)) <> 3)
$$;

CREATE TABLE energiemanagement_anwendungsbereich (
    fassung_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    standort_ids UUID[] NOT NULL,
    traeger TEXT[] NOT NULL,
    ausschluesse JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_anwendungsbereich_fassung_fk FOREIGN KEY (fassung_id, tenant_id)
        REFERENCES energiemanagement_dokument_fassung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_anwendungsbereich_standorte_chk CHECK (cardinality(standort_ids) > 0
        AND array_position(standort_ids, NULL) IS NULL),
    CONSTRAINT energiemanagement_anwendungsbereich_traeger_chk CHECK (cardinality(traeger) > 0
        AND array_position(traeger, NULL) IS NULL
        AND traeger <@ ARRAY['Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft']::text[]),
    CONSTRAINT energiemanagement_anwendungsbereich_ausschluesse_chk CHECK (energiemanagement_ausschluesse_ok(ausschluesse))
);

CREATE FUNCTION energiemanagement_anwendungsbereich_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    status TEXT;
    dok_art TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.fassung_id <> OLD.fassung_id OR NEW.tenant_id <> OLD.tenant_id
        OR NEW.created_at <> OLD.created_at) THEN
        RAISE EXCEPTION 'Die Fassung eines Anwendungsbereichs ist nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_identitaet_bleibt';
    END IF;
    SELECT f.freigabe_status, d.art INTO status, dok_art
      FROM energiemanagement_dokument_fassung f
      JOIN energiemanagement_dokument d ON d.id = f.dokument_id AND d.tenant_id = f.tenant_id
     WHERE f.id = NEW.fassung_id AND f.tenant_id = NEW.tenant_id;
    IF dok_art IS DISTINCT FROM 'anwendungsbereich' THEN
        RAISE EXCEPTION 'Standorte und Energieträger trägt nur eine Fassung des Anwendungsbereichs'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_anwendungsbereich_art';
    END IF;
    IF status IS DISTINCT FROM 'entwurf' THEN
        RAISE EXCEPTION 'Die Fassung ist % und unveränderlich', status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_fassung_unveraenderlich';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.standort_ids) s(id)
                WHERE NOT EXISTS (SELECT 1 FROM standort st WHERE st.id = s.id AND st.tenant_id = NEW.tenant_id))
        OR cardinality(NEW.standort_ids) <> (SELECT count(DISTINCT s) FROM unnest(NEW.standort_ids) s) THEN
        RAISE EXCEPTION 'Jeder Standort des Anwendungsbereichs ist ein Standort des Kundenbereichs, einmal'
            USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'energiemanagement_anwendungsbereich_standort_fk';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_anwendungsbereich_pruefen BEFORE INSERT OR UPDATE ON energiemanagement_anwendungsbereich
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_anwendungsbereich_pruefen();

-- -----------------------------------------------------------------------------
-- energiemanagement_dokument_eintrag (DK5, DK6, DK8): nur anhängen.
--   bekannt_gemacht  an <kreis> am <am> über <weg> (bei „weiterer“ mit Wortlaut),
--                    durch <person_id> — an einer freigegebenen Fassung eines
--                    gültigen Dokuments; VoltPilot verschickt nichts
--   geprueft_bleibt  entschieden von <entschieden_von> am <am>, Begründung, wahlfrei
--                    Person und Beschluss — nur an Vorgabe-Arten, an einer
--                    freigegebenen Fassung eines gültigen Dokuments (DK5)
--   aufgehoben       entschieden von <entschieden_von> am <am>, Begründung, wahlfrei
--                    Person und Beschluss — einmal je Dokument, vor dem Zustand (DK8)
--   kommentar        Wortlaut 1–2 000 Zeichen
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_dokument_eintrag (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    dokument_id UUID NOT NULL,
    fassung INTEGER,
    art TEXT NOT NULL,
    am DATE,
    person_id UUID,
    entschieden_von UUID,
    kreis TEXT,
    weg TEXT,
    weg_wortlaut TEXT,
    begruendung TEXT,
    beschluss_kennung TEXT,
    kommentar TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_eintrag_dokument_fk FOREIGN KEY (dokument_id, tenant_id)
        REFERENCES energiemanagement_dokument(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_eintrag_fassung_fk FOREIGN KEY (tenant_id, dokument_id, fassung)
        REFERENCES energiemanagement_dokument_fassung(tenant_id, dokument_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_eintrag_person_fk FOREIGN KEY (person_id, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_eintrag_entschieden_von_fk FOREIGN KEY (entschieden_von, tenant_id)
        REFERENCES energiemanagement_person(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_eintrag_art_chk CHECK (coalesce(energiemanagement_wort('dokument_eintrag', art), false)),
    CONSTRAINT energiemanagement_eintrag_inhalt_chk CHECK (coalesce(CASE art
        WHEN 'bekannt_gemacht' THEN fassung IS NOT NULL AND am IS NOT NULL AND person_id IS NOT NULL
            AND btrim(kreis) <> '' AND char_length(kreis) <= 200
            AND energiemanagement_wort('bekanntmachung_weg', weg)
            AND CASE WHEN weg = 'weiterer' THEN btrim(weg_wortlaut) <> '' AND char_length(weg_wortlaut) <= 200
                     ELSE weg_wortlaut IS NULL END
            AND (begruendung IS NULL OR char_length(btrim(begruendung)) BETWEEN 10 AND 500)
            AND num_nonnulls(entschieden_von, beschluss_kennung, kommentar) = 0
        WHEN 'geprueft_bleibt' THEN fassung IS NOT NULL AND am IS NOT NULL AND entschieden_von IS NOT NULL
            AND char_length(btrim(begruendung)) BETWEEN 10 AND 500
            AND num_nonnulls(kreis, weg, weg_wortlaut, kommentar) = 0
        WHEN 'aufgehoben' THEN fassung IS NULL AND am IS NOT NULL AND entschieden_von IS NOT NULL
            AND char_length(btrim(begruendung)) BETWEEN 10 AND 500
            AND num_nonnulls(kreis, weg, weg_wortlaut, kommentar) = 0
        WHEN 'kommentar' THEN btrim(kommentar) <> '' AND char_length(kommentar) <= 2000
            AND num_nonnulls(fassung, am, person_id, entschieden_von, kreis, weg, weg_wortlaut, begruendung,
                beschluss_kennung) = 0
        END, false)),
    -- Vertrag `kennzeichen_muster.beschluss`.
    CONSTRAINT energiemanagement_eintrag_beschluss_chk CHECK (
        beschluss_kennung IS NULL OR beschluss_kennung ~ '^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$'),
    CONSTRAINT energiemanagement_eintrag_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_eintrag_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_eintrag_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_eintrag_dokument_idx ON energiemanagement_dokument_eintrag
    (tenant_id, dokument_id, created_at, id);
CREATE UNIQUE INDEX energiemanagement_eintrag_einmal_aufgehoben_uq ON energiemanagement_dokument_eintrag
    (tenant_id, dokument_id) WHERE art = 'aufgehoben';

CREATE FUNCTION energiemanagement_eintrag_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT dk.zustand, dk.art INTO d FROM energiemanagement_dokument dk
     WHERE dk.id = NEW.dokument_id AND dk.tenant_id = NEW.tenant_id;
    IF d.zustand = 'aufgehoben' AND NEW.art <> 'kommentar' THEN
        RAISE EXCEPTION 'Das Dokument ist aufgehoben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_dokument_endgueltig';
    END IF;
    IF NEW.art IN ('bekannt_gemacht', 'geprueft_bleibt') AND (d.zustand IS DISTINCT FROM 'gueltig'
        OR NOT EXISTS (SELECT 1 FROM energiemanagement_dokument_fassung f
                        WHERE f.tenant_id = NEW.tenant_id AND f.dokument_id = NEW.dokument_id
                          AND f.fassung = NEW.fassung AND f.freigabe_status = 'freigegeben')) THEN
        RAISE EXCEPTION 'Bekannt gemacht und geprüft wird eine freigegebene Fassung eines gültigen Dokuments'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_eintrag_fassung_freigegeben';
    END IF;
    IF NEW.art = 'geprueft_bleibt' AND energiemanagement_dokument_klasse(d.art) IS DISTINCT FROM 'vorgabe' THEN
        RAISE EXCEPTION 'Ein Nachweis (%) hat keine Überprüfung', d.art
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_eintrag_nur_vorgabe';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_eintrag_anlegen BEFORE INSERT ON energiemanagement_dokument_eintrag
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_eintrag_anlegen();

-- -----------------------------------------------------------------------------
-- energiemanagement_aenderung: Protokoll der Übergänge (§5.6) von Person, Aufgabe
-- und Dokument (samt Fassung, Eintrag) und der Einstellung — nur lesen und
-- anhängen, ohne Fremdschlüssel auf das Objekt (Muster energieziel_aenderung).
-- -----------------------------------------------------------------------------
CREATE TABLE energiemanagement_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    objekt TEXT NOT NULL,
    objekt_id UUID,
    art TEXT NOT NULL,
    alt JSONB,
    neu JSONB,
    begruendung TEXT CHECK (begruendung IS NULL OR btrim(begruendung) <> ''),
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_aenderung_objekt_chk CHECK (
        CASE objekt WHEN 'einstellung' THEN objekt_id IS NULL
                    WHEN 'person' THEN objekt_id IS NOT NULL
                    WHEN 'aufgabe' THEN objekt_id IS NOT NULL
                    WHEN 'dokument' THEN objekt_id IS NOT NULL
                    ELSE false END),
    CONSTRAINT energiemanagement_aenderung_art_chk CHECK (
        coalesce(energiemanagement_wort('energiemanagement_protokoll', art), false)),
    CONSTRAINT energiemanagement_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energiemanagement_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_aenderung_objekt_idx ON energiemanagement_aenderung
    (tenant_id, objekt, objekt_id, created_at, id);

-- -----------------------------------------------------------------------------
-- RLS + FORCE und der Standort-Zaun (RE1, RE2, Muster V20260924223000):
-- RESTRICTIVE `site_scope` wird mit der Mandanten-Policy UND-verknüpft.
-- Unternehmensweit (oder ohne Zugriff im Spiel) gilt allein der Mandanten-Zaun.
-- Im engen Zaun: Dokumente nur an einem Standort der Anfrage (am Unternehmen, an
-- Person oder Aufgabe nie), Fassung, Eintrag und Anwendungsbereich folgen ihrem
-- Dokument; Aufgaben haben keinen Standort und sind darum nur unternehmensweit
-- sichtbar; das Protokoll folgt seinem Dokument, sonst nur unternehmensweit.
-- Personen (Namen, wie `benutzer`), die Einstellung und der Zähler tragen nur den
-- Mandanten-Zaun: ein Standort-Leser braucht den Namen hinter „entschieden von“
-- und die Fristen seiner Dokumente.
-- -----------------------------------------------------------------------------
ALTER TABLE energiemanagement_kennung_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_kennung_seq FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_kennung_seq_tenant_isolation ON energiemanagement_kennung_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energiemanagement_einstellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_einstellung FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_einstellung_tenant_isolation ON energiemanagement_einstellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energiemanagement_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_person FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_person_tenant_isolation ON energiemanagement_person
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energiemanagement_aufgabe ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_aufgabe FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_aufgabe_tenant_isolation ON energiemanagement_aufgabe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_aufgabe AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());
ALTER TABLE energiemanagement_dokument ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_dokument FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_dokument_tenant_isolation ON energiemanagement_dokument
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_dokument AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);
ALTER TABLE energiemanagement_dokument_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_dokument_fassung FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_dokument_fassung_tenant_isolation ON energiemanagement_dokument_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_dokument_fassung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument d
                             WHERE d.id = energiemanagement_dokument_fassung.dokument_id
                               AND d.tenant_id = energiemanagement_dokument_fassung.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument d
                                  WHERE d.id = energiemanagement_dokument_fassung.dokument_id
                                    AND d.tenant_id = energiemanagement_dokument_fassung.tenant_id) END);
ALTER TABLE energiemanagement_anwendungsbereich ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_anwendungsbereich FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_anwendungsbereich_tenant_isolation ON energiemanagement_anwendungsbereich
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_anwendungsbereich AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument_fassung f
                             WHERE f.id = energiemanagement_anwendungsbereich.fassung_id
                               AND f.tenant_id = energiemanagement_anwendungsbereich.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument_fassung f
                                  WHERE f.id = energiemanagement_anwendungsbereich.fassung_id
                                    AND f.tenant_id = energiemanagement_anwendungsbereich.tenant_id) END);
ALTER TABLE energiemanagement_dokument_eintrag ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_dokument_eintrag FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_dokument_eintrag_tenant_isolation ON energiemanagement_dokument_eintrag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_dokument_eintrag AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument d
                             WHERE d.id = energiemanagement_dokument_eintrag.dokument_id
                               AND d.tenant_id = energiemanagement_dokument_eintrag.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM energiemanagement_dokument d
                                  WHERE d.id = energiemanagement_dokument_eintrag.dokument_id
                                    AND d.tenant_id = energiemanagement_dokument_eintrag.tenant_id) END);
ALTER TABLE energiemanagement_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_aenderung_tenant_isolation ON energiemanagement_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_aenderung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                WHEN objekt = 'dokument' THEN EXISTS (SELECT 1 FROM energiemanagement_dokument d
                             WHERE d.id = energiemanagement_aenderung.objekt_id
                               AND d.tenant_id = energiemanagement_aenderung.tenant_id)
                ELSE false END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     WHEN objekt = 'dokument' THEN EXISTS (SELECT 1 FROM energiemanagement_dokument d
                                  WHERE d.id = energiemanagement_aenderung.objekt_id
                                    AND d.tenant_id = energiemanagement_aenderung.tenant_id)
                     ELSE false END);

-- Grants: die App-Rolle liest und legt an, ändert nur benannte Spalten und löscht
-- nie; Einträge und Protokoll werden nur angehängt. Nur das administrative
-- Offboarding löscht (TenantRepository.offboard): Protokoll, Einträge,
-- Anwendungsbereich, Fassungen, Dokumente, Aufgaben, Personen, Einstellung und
-- Zähler vor Energieeinsatz, Standort und Benutzer.
REVOKE ALL ON energiemanagement_kennung_seq, energiemanagement_einstellung, energiemanagement_person,
    energiemanagement_aufgabe, energiemanagement_dokument, energiemanagement_dokument_fassung,
    energiemanagement_anwendungsbereich, energiemanagement_dokument_eintrag, energiemanagement_aenderung
    FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energiemanagement_kennung_seq, energiemanagement_einstellung, energiemanagement_person,
    energiemanagement_aufgabe, energiemanagement_dokument, energiemanagement_dokument_fassung,
    energiemanagement_anwendungsbereich, energiemanagement_dokument_eintrag, energiemanagement_aenderung
    TO ${appDbUser};
GRANT UPDATE (naechste_nummer) ON energiemanagement_kennung_seq TO ${appDbUser};
GRANT UPDATE (ueberpruefung_monate, audit_rhythmus_monate, managementbewertung_rhythmus_monate, feststellung_frist_tage,
    vorschau_tage, actor_sub, actor_name, actor_rolle, actor_art, geaendert_am)
    ON energiemanagement_einstellung TO ${appDbUser};
GRANT UPDATE (name, funktion, kuerzel, organisation, konto_sub, seit, bis, zustand, beendet_begruendung)
    ON energiemanagement_person TO ${appDbUser};
GRANT UPDATE (gilt_bis, zustand, beendet_begruendung) ON energiemanagement_aufgabe TO ${appDbUser};
GRANT UPDATE (titel, zustand, ueberpruefung_monate, beleg_bezeichnung, beleg_ablage, beleg_kennung, beleg_adresse,
    beleg_sha256) ON energiemanagement_dokument TO ${appDbUser};
GRANT UPDATE (form, wortlaut, verweis_bezeichnung, verweis_ablage, verweis_kennung, verweis_adresse,
    verweis_fassungsangabe, verweis_datum, verweis_sha256, kopie, pruefsumme, begruendung, beschluss_kennung, vieraugen, freigabe_status, entschieden_von, entschieden_tag,
    freigabe_begruendung, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am,
    entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am,
    entscheidungs_begruendung, freigegeben_am) ON energiemanagement_dokument_fassung TO ${appDbUser};
GRANT UPDATE (standort_ids, traeger, ausschluesse) ON energiemanagement_anwendungsbereich TO ${appDbUser};
GRANT SELECT, DELETE ON energiemanagement_kennung_seq, energiemanagement_einstellung, energiemanagement_person,
    energiemanagement_aufgabe, energiemanagement_dokument, energiemanagement_dokument_fassung,
    energiemanagement_anwendungsbereich, energiemanagement_dokument_eintrag, energiemanagement_aenderung
    TO ${adminDbUser};
REVOKE ALL ON SEQUENCE energiemanagement_dokument_eintrag_id_seq, energiemanagement_aenderung_id_seq
    FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE energiemanagement_dokument_eintrag_id_seq, energiemanagement_aenderung_id_seq
    TO ${appDbUser}, ${adminDbUser};
REVOKE ALL ON FUNCTION uems_energiemanagement_kennung(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_energiemanagement_kennung(UUID, TEXT, INTEGER) TO ${appDbUser};
REVOKE ALL ON FUNCTION uems_energiemanagement_kennung_vorruecken(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_energiemanagement_kennung_vorruecken(UUID, TEXT) TO ${appDbUser};

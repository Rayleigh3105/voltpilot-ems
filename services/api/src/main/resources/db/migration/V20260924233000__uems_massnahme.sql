-- =============================================================================
-- AP-18 IP-9: Maßnahme — Datenhaltung (M1, M2, M4, M5, M6, M7; §4.2, §4.4, §4.7,
-- §5.7, §6.1 des Konzepts).
--
-- Neue, leere Tabellen neben IP-5 (V20260924223000); KEINE bestehende Zeile,
-- Spalte, kein CHECK und kein Fremdschlüssel einer bestehenden Tabelle ändert
-- sich (Invariante 1: an `kennzahl*`, `bezugsbasis*`, `bericht*`,
-- `energieeinsatz*`, `energieziel*` nichts). Ohne Maßnahme schreibt nichts.
--
--   massnahme             M-JJJJ-nnnn (JJJJ = Jahr des Anlegens, LA6) mit Titel,
--                         Verantwortlichem (`benutzer` + Schnappschuss, W4),
--                         Termin, Zustand, Herkunft (`abweichung · energieziel ·
--                         einsatz · von_hand` mit Kennung), wahlfreier
--                         Messgrundlage = Kennzahl × FREIGEGEBENE Basis-Fassung ×
--                         Ausgangslage-Kopie mit Prüfsumme (M2, E2 = A), wahlfrei
--                         Einsatz × Einstufungs-Fassung und Energieziel,
--                         erwarteter Wirkung als Wortlaut (Pflicht) und als Zahl
--                         (nur mit Messgrundlage, M4), `standort_id` (RE2).
--   massnahme_aenderung   Protokoll und Verlauf, nur lesen und anhängen, ohne
--                         Fremdschlüssel auf die Maßnahme (M7); Kommentare sind
--                         Zeilen mit Text (1–2 000 Zeichen).
--   massnahme_bewertung   Stand Nr. n (WK6): Kopie der Wirkung als kanonischer TEXT
--                         mit Prüfsumme, Ergebnis `belegt · nicht_belegt ·
--                         nicht_messbar`, Person, Begründung, Vier-Augen wie das
--                         Energieziel; ohne Messgrundlage nur `nicht_messbar`
--                         (CHECK über die Messgrundlage des Stands). Nie
--                         zurückgenommen; ein neuer Stand ist Nr. n + 1.
--   vorgang_anstoss       Anstoß am Vorgang (M5): genau ein Bezug (Maßnahme ODER
--                         Energieziel), Art und Anlass-Kennung, eindeutig je
--                         Vorgang × Art × Anlass; die Antwort einer Person
--                         (`bleibt` mit Begründung · `neu_kopiert` ·
--                         `neu_bewertet`) ist einmalig. Kein Läufer antwortet.
--
-- Übergänge sind einmalig (Trigger massnahme_eingefroren, Muster
-- energieziel_eingefroren): geplant → umgesetzt · verworfen, umgesetzt →
-- bewertet; `umgesetzt` trägt einen Tag nie in der Zukunft (Zeitzone des
-- Unternehmens) und eine Begründung und wird nie wiederholt; `verworfen` ist
-- endgültig; Titel, Termin, Verantwortlicher, Messgrundlage und Verweise ändern
-- sich nur, solange die Maßnahme geplant ist. Die Ausgangslage-Kopie bleibt
-- byte-gleich; nur eine Antwort `neu_kopiert` ersetzt sie (die alte steht im
-- Protokoll). Kein DELETE für die App-Rolle; nur das Mandanten-Offboarding löscht.
--
-- Vokabulare: verbesserung_vokabular() aus IP-5 wird mit CREATE OR REPLACE
-- geweitet — alle Wörter von IP-5 unverändert, dazu nur die Tabellen-Wörter
-- `massnahme_bewertung_status` und `massnahme_protokoll` (die Vertragslisten
-- `massnahme_zustand`, `massnahme_herkunft`, `wirkung_ergebnis`, `anstoss_*`
-- stehen schon dort). Wer die Funktion später weitet, schreibt die VEREINIGUNG.
--
-- Nicht dieses Paket: Routen (IP-10), Wirkung-Leser (IP-11), Bewertungs-Routen
-- (IP-12), Portal (IP-13), Abweichung (IP-14), die Naht, die Anstöße setzt
-- (IP-17). Keine neue Rechte-Kennung: verbesserung.verwalten/abschliessen/ansehen
-- aus IP-5 decken alle Übergänge der Maßnahme (§4.9 RE1).
-- =============================================================================

-- Die Wörter von IP-5 in derselben Reihenfolge, dazu die Wörter der Tabellen
-- dieses Pakets (der Vertrag nennt sie nicht).
CREATE OR REPLACE FUNCTION verbesserung_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('energieziel_zustand', 1, 'offen'),
    ('energieziel_zustand', 2, 'bewertet'),
    ('energieziel_zustand', 3, 'beendet'),
    ('energieziel_ergebnis', 1, 'erreicht'),
    ('energieziel_ergebnis', 2, 'verfehlt'),
    ('energieziel_ergebnis', 3, 'nicht_bewertbar'),
    ('zielstand_vorschlag', 1, 'erreicht'),
    ('zielstand_vorschlag', 2, 'nicht_erreicht'),
    ('massnahme_zustand', 1, 'geplant'),
    ('massnahme_zustand', 2, 'umgesetzt'),
    ('massnahme_zustand', 3, 'bewertet'),
    ('massnahme_zustand', 4, 'verworfen'),
    ('massnahme_herkunft', 1, 'abweichung'),
    ('massnahme_herkunft', 2, 'energieziel'),
    ('massnahme_herkunft', 3, 'einsatz'),
    ('massnahme_herkunft', 4, 'von_hand'),
    ('abweichung_zustand', 1, 'offen'),
    ('abweichung_zustand', 2, 'abgeschlossen'),
    ('abweichung_ergebnis', 1, 'massnahme'),
    ('abweichung_ergebnis', 2, 'erklaert'),
    ('abweichung_ergebnis', 3, 'keine_abweichung'),
    ('abweichung_ergebnis', 4, 'nicht_bewertbar'),
    ('abweichung_eintrag_art', 1, 'kommentar'),
    ('abweichung_eintrag_art', 2, 'ursache_aussage'),
    ('auffaelligkeit_zustand', 1, 'offen'),
    ('auffaelligkeit_zustand', 2, 'beantwortet'),
    ('auffaelligkeit_antwort', 1, 'abweichung'),
    ('auffaelligkeit_antwort', 2, 'zur_kenntnis'),
    ('ursache_beleg', 1, 'keine_messung'),
    ('ursache_beleg', 2, 'mit_beleg'),
    ('wirkung_ergebnis', 1, 'belegt'),
    ('wirkung_ergebnis', 2, 'nicht_belegt'),
    ('wirkung_ergebnis', 3, 'nicht_messbar'),
    ('wirkung_grund', 1, 'umsetzungsmonat'),
    ('wirkung_grund', 2, 'basis_nach_umsetzung'),
    ('wirkung_grund', 3, 'unvollstaendig'),
    ('wirkung_grund', 4, 'basis_fehlt'),
    ('wirkung_grund', 5, 'basis_beendet'),
    ('wirkung_grund', 6, 'zu_wenig_perioden'),
    ('wirkung_grund', 7, 'variable_fehlt'),
    ('wirkung_grund', 8, 'variable_ausserhalb'),
    ('wirkung_grund', 9, 'periode_nicht_zu_ende'),
    ('wirkung_grund', 10, 'keine_werte'),
    ('anstoss_art', 1, 'ausgangslage_korrigiert'),
    ('anstoss_art', 2, 'bewertung_korrigiert'),
    ('anstoss_art', 3, 'messgrundlage_beendet'),
    ('anstoss_art', 4, 'messgrundlage_neu_gefasst'),
    ('anstoss_zustand', 1, 'offen'),
    ('anstoss_zustand', 2, 'beantwortet'),
    ('anstoss_antwort', 1, 'bleibt'),
    ('anstoss_antwort', 2, 'neu_kopiert'),
    ('anstoss_antwort', 3, 'neu_bewertet'),
    ('frist_art', 1, 'massnahme'),
    ('frist_art', 2, 'abweichung'),
    ('frist_art', 3, 'energieziel'),
    ('frist_faellig', 1, 'ueberfaellig'),
    ('frist_faellig', 2, 'bewertung_faellig'),
    ('kennung_art', 1, 'EZ'),
    ('kennung_art', 2, 'M'),
    ('kennung_art', 3, 'AW'),
    ('energieziel_bewertung_status', 1, 'beantragt'),
    ('energieziel_bewertung_status', 2, 'bewertet'),
    ('energieziel_bewertung_status', 3, 'abgelehnt'),
    ('energieziel_protokoll', 1, 'energieziel_angelegt'),
    ('energieziel_protokoll', 2, 'energieziel_geaendert'),
    ('energieziel_protokoll', 3, 'verantwortlicher_geaendert'),
    ('energieziel_protokoll', 4, 'bewertung_beantragt'),
    ('energieziel_protokoll', 5, 'bewertung_abgelehnt'),
    ('energieziel_protokoll', 6, 'energieziel_bewertet'),
    ('energieziel_protokoll', 7, 'energieziel_beendet'),
    ('energieziel_protokoll', 8, 'anstoss_gesetzt'),
    ('energieziel_protokoll', 9, 'anstoss_beantwortet'),
    ('massnahme_bewertung_status', 1, 'beantragt'),
    ('massnahme_bewertung_status', 2, 'bewertet'),
    ('massnahme_bewertung_status', 3, 'abgelehnt'),
    ('massnahme_protokoll', 1, 'massnahme_angelegt'),
    ('massnahme_protokoll', 2, 'massnahme_geaendert'),
    ('massnahme_protokoll', 3, 'verantwortlicher_geaendert'),
    ('massnahme_protokoll', 4, 'kommentar'),
    ('massnahme_protokoll', 5, 'massnahme_umgesetzt'),
    ('massnahme_protokoll', 6, 'massnahme_verworfen'),
    ('massnahme_protokoll', 7, 'bewertung_beantragt'),
    ('massnahme_protokoll', 8, 'bewertung_abgelehnt'),
    ('massnahme_protokoll', 9, 'massnahme_bewertet'),
    ('massnahme_protokoll', 10, 'anstoss_gesetzt'),
    ('massnahme_protokoll', 11, 'anstoss_beantwortet')
$$;

-- -----------------------------------------------------------------------------
-- massnahme (M1, M2, M4, M6, RE2, W4).
--
-- Die Messgrundlage (kennzahl_id, bezugsbasis_id, fassung) ist wahlfrei (E2 = A),
-- aber ganz oder gar nicht, und mit ihr steht immer die Ausgangslage: eine Kopie
-- eines Vergleichsergebnisses als kanonischer TEXT (kein JSONB), ihre Prüfsumme
-- hält die Datenbank selbst (bericht_pruefsumme). Die zitierte Fassung ist
-- FREIGEGEBEN, die Basis nicht beendet und die der Kennzahl, und sie gilt am Tag
-- des Anlegens noch (Muster energieziel_anlegen); eine zitierte Einstufung ist
-- freigegeben. Ohne Messgrundlage gibt es keine Zahl der erwarteten Wirkung (M4),
-- der Wortlaut ist immer Pflicht.
--
-- `standort_id` ist der Zaun (RE2; NULL = am Unternehmen, dann nur
-- unternehmensweit sichtbar). Bei einer Kennzahl am Standort bzw. am Unternehmen
-- prüft die Datenbank, dass er ihr folgt; die übrigen Anker (Einsatz, andere
-- Geltungen) leitet der Schreibweg ab (IP-10).
--
-- `umgesetzt_am` ist ein Tag, nie nach dem Tag der Meldung
-- (`umgesetzt_gemeldet_am` in der Zeitzone des Unternehmens; fehlt die Meldezeit,
-- setzt die Datenbank ihre Uhr ein, ein Schreibweg mit eigener Uhr gibt sie mit).
-- -----------------------------------------------------------------------------
CREATE TABLE massnahme (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    titel TEXT NOT NULL,
    -- W4: `benutzer` + Schnappschuss (Muster Einsatz/Basis/Energieziel).
    verantwortlich_sub TEXT NOT NULL,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT NOT NULL,
    termin DATE NOT NULL,
    standort_id UUID,
    zustand TEXT NOT NULL DEFAULT 'geplant',
    -- M1: woher die Maßnahme kommt, mit Kennung (AW-…, EZ-…, EE-…; von Hand ohne).
    herkunft_art TEXT NOT NULL,
    herkunft_kennung TEXT,
    -- M2: die Messgrundlage und ihre Ausgangslage-Kopie.
    kennzahl_id UUID,
    bezugsbasis_id UUID,
    fassung INTEGER CHECK (fassung > 0),
    ausgangslage TEXT,
    ausgangslage_pruefsumme TEXT,
    -- Wahlfreie Verweise: Einsatz × Einstufungs-Fassung, Energieziel.
    einsatz_id UUID,
    einstufung_fassung INTEGER CHECK (einstufung_fassung > 0),
    energieziel_id UUID,
    -- M4: Prozent gegenüber dem Erwarteten, weniger Energie negativ, eine Stelle.
    erwartete_wirkung_prozent NUMERIC,
    erwartete_wirkung_wortlaut TEXT NOT NULL,
    -- M6: umgesetzt (Tag, Begründung, wann gemeldet) und verworfen (wann, warum).
    umgesetzt_am DATE,
    umgesetzt_begruendung TEXT,
    umgesetzt_gemeldet_am TIMESTAMPTZ,
    verworfen_am TIMESTAMPTZ,
    verworfen_grund TEXT,
    -- Wer angelegt hat.
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT massnahme_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT massnahme_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- LA6: M-<Jahr des Anlegens>-<Nr.>; das Jahr prüft der Anlege-Trigger.
    CONSTRAINT massnahme_kennzeichen_chk CHECK (kennzeichen ~ '^M-[0-9]{4}-[0-9]{4,9}$'
        AND substring(kennzeichen FROM 8) !~ '^0+$'),
    CONSTRAINT massnahme_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT massnahme_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_fassung_fk FOREIGN KEY (tenant_id, bezugsbasis_id, fassung)
        REFERENCES bezugsbasis_fassung(tenant_id, bezugsbasis_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT massnahme_einsatz_fk FOREIGN KEY (einsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_einstufung_fk FOREIGN KEY (tenant_id, einsatz_id, einstufung_fassung)
        REFERENCES energieeinsatz_einstufung(tenant_id, einsatz_id, nummer) ON DELETE RESTRICT,
    CONSTRAINT massnahme_energieziel_fk FOREIGN KEY (energieziel_id, tenant_id)
        REFERENCES energieziel(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_titel_chk CHECK (btrim(titel) <> ''),
    CONSTRAINT massnahme_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND btrim(verantwortlich_sub) <> '' AND btrim(verantwortlich_konto) <> ''),
    CONSTRAINT massnahme_zustand_chk CHECK (coalesce(verbesserung_wort('massnahme_zustand', zustand), false)),
    -- M1: die Herkunft mit ihrer Kennung; aus einem Energieziel bzw. am Einsatz mit dem Verweis.
    CONSTRAINT massnahme_herkunft_chk CHECK (coalesce(verbesserung_wort('massnahme_herkunft', herkunft_art)
        AND CASE herkunft_art
            WHEN 'von_hand' THEN herkunft_kennung IS NULL
            WHEN 'abweichung' THEN herkunft_kennung ~ '^AW-[0-9]{4}-[0-9]{4,9}$'
            WHEN 'energieziel' THEN herkunft_kennung ~ '^EZ-[0-9]{4}-[0-9]{4,9}$' AND energieziel_id IS NOT NULL
            WHEN 'einsatz' THEN herkunft_kennung ~ '^EE-[1-9][0-9]{0,12}$' AND einsatz_id IS NOT NULL
            ELSE false END, false)),
    -- M2/M4: die Messgrundlage ganz oder gar nicht; mit ihr immer die Ausgangslage, ohne sie weder
    -- Ausgangslage noch eine Zahl der erwarteten Wirkung.
    CONSTRAINT massnahme_messgrundlage_chk CHECK (
        (kennzahl_id IS NULL) = (bezugsbasis_id IS NULL) AND (bezugsbasis_id IS NULL) = (fassung IS NULL)
        AND (ausgangslage IS NULL) = (fassung IS NULL)
        AND (erwartete_wirkung_prozent IS NULL OR fassung IS NOT NULL)),
    -- Die Prüfsumme hält die Datenbank gegen den kanonischen Text (Muster Energieziel-Bewertung).
    CONSTRAINT massnahme_ausgangslage_pruefsumme_chk CHECK (
        (ausgangslage IS NULL) = (ausgangslage_pruefsumme IS NULL)
        AND (ausgangslage IS NULL OR (jsonb_typeof(ausgangslage::jsonb) = 'object'
             AND ausgangslage_pruefsumme = bericht_pruefsumme(ausgangslage)))),
    CONSTRAINT massnahme_wirkung_chk CHECK (btrim(erwartete_wirkung_wortlaut) <> ''
        AND (erwartete_wirkung_prozent IS NULL OR (erwartete_wirkung_prozent = round(erwartete_wirkung_prozent, 1)
             AND erwartete_wirkung_prozent > -100 AND erwartete_wirkung_prozent < 100))),
    CONSTRAINT massnahme_einstufung_chk CHECK (einstufung_fassung IS NULL OR einsatz_id IS NOT NULL),
    -- M6: ab `umgesetzt` für immer Tag, Begründung (10–500) und Meldezeit; `verworfen` mit Zeit und Begründung.
    CONSTRAINT massnahme_umgesetzt_chk CHECK (
        (zustand IN ('umgesetzt', 'bewertet')) = (umgesetzt_am IS NOT NULL)
        AND (umgesetzt_am IS NULL) = (umgesetzt_begruendung IS NULL)
        AND (umgesetzt_am IS NULL) = (umgesetzt_gemeldet_am IS NULL)
        AND (umgesetzt_begruendung IS NULL OR char_length(btrim(umgesetzt_begruendung)) BETWEEN 10 AND 500)),
    CONSTRAINT massnahme_verworfen_chk CHECK (
        (zustand = 'verworfen') = (verworfen_am IS NOT NULL)
        AND (verworfen_am IS NULL) = (verworfen_grund IS NULL)
        AND (verworfen_grund IS NULL OR char_length(btrim(verworfen_grund)) BETWEEN 10 AND 500)),
    CONSTRAINT massnahme_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT massnahme_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT massnahme_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX massnahme_standort_idx ON massnahme (tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX massnahme_kennzahl_idx ON massnahme (tenant_id, kennzahl_id) WHERE kennzahl_id IS NOT NULL;
CREATE INDEX massnahme_fassung_idx ON massnahme (tenant_id, bezugsbasis_id, fassung) WHERE bezugsbasis_id IS NOT NULL;
CREATE INDEX massnahme_einsatz_idx ON massnahme (tenant_id, einsatz_id) WHERE einsatz_id IS NOT NULL;
CREATE INDEX massnahme_energieziel_idx ON massnahme (tenant_id, energieziel_id) WHERE energieziel_id IS NOT NULL;

-- Die Anker einer Maßnahme — beim Anlegen alle, danach nur, was sich ändert (`o` ist die
-- alte Zeile, beim Anlegen NULL): die zitierte Fassung ist freigegeben, ihre Basis nicht
-- beendet und die der Kennzahl, und sie gilt am Tag des Anlegens noch; eine zitierte
-- Einstufung ist freigegeben; der Standort folgt einer Kennzahl am Standort bzw. am
-- Unternehmen.
CREATE FUNCTION massnahme_anker_pruefen(n massnahme, o massnahme) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    f RECORD;
    k RECORD;
    tag DATE;
BEGIN
    tag := (n.angelegt_am AT TIME ZONE coalesce(
        (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = n.tenant_id), 'Europe/Berlin'))::date;
    IF n.fassung IS NOT NULL AND (n.kennzahl_id, n.bezugsbasis_id, n.fassung)
            IS DISTINCT FROM (o.kennzahl_id, o.bezugsbasis_id, o.fassung) THEN
        SELECT bf.freigabe_status, bf.gilt_bis, b.kennzahl_id, b.beendet_am AS basis_beendet_am INTO f
          FROM bezugsbasis_fassung bf
          JOIN bezugsbasis b ON b.id = bf.bezugsbasis_id AND b.tenant_id = bf.tenant_id
         WHERE bf.tenant_id = n.tenant_id AND bf.bezugsbasis_id = n.bezugsbasis_id AND bf.fassung = n.fassung;
        IF FOUND AND f.kennzahl_id <> n.kennzahl_id THEN
            RAISE EXCEPTION 'Die Bezugsbasis gehört zu einer anderen Kennzahl'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_basis_der_kennzahl_chk';
        END IF;
        IF FOUND AND (f.freigabe_status <> 'freigegeben' OR f.basis_beendet_am IS NOT NULL
                      OR (f.gilt_bis IS NOT NULL AND f.gilt_bis < tag)) THEN
            RAISE EXCEPTION 'Eine Messgrundlage zitiert eine freigegebene, geltende Bezugsbasis-Fassung (Fassung %: %)',
                n.fassung, f.freigabe_status
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_fassung_freigegeben_chk';
        END IF;
    END IF;
    IF n.einstufung_fassung IS NOT NULL
            AND (n.einsatz_id, n.einstufung_fassung) IS DISTINCT FROM (o.einsatz_id, o.einstufung_fassung)
            AND EXISTS (SELECT 1 FROM energieeinsatz_einstufung s
                         WHERE s.tenant_id = n.tenant_id AND s.einsatz_id = n.einsatz_id
                           AND s.nummer = n.einstufung_fassung AND s.freigabe_status <> 'freigegeben') THEN
        RAISE EXCEPTION 'Eine Maßnahme zitiert eine freigegebene Einstufungs-Fassung (Fassung %)', n.einstufung_fassung
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_einstufung_freigegeben_chk';
    END IF;
    IF n.kennzahl_id IS NOT NULL AND (n.kennzahl_id, n.standort_id) IS DISTINCT FROM (o.kennzahl_id, o.standort_id) THEN
        SELECT kz.geltung_art, kz.standort_id INTO k FROM kennzahl kz
         WHERE kz.id = n.kennzahl_id AND kz.tenant_id = n.tenant_id;
        IF FOUND AND ((k.geltung_art = 'standort' AND n.standort_id IS DISTINCT FROM k.standort_id)
                      OR (k.geltung_art = 'unternehmen' AND n.standort_id IS NOT NULL)) THEN
            RAISE EXCEPTION 'Der Standort der Maßnahme ist der Standort ihrer Kennzahl'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_standort_der_kennzahl_chk';
        END IF;
    END IF;
END $$;

-- M1/M2 beim Anlegen: die Maßnahme entsteht geplant, die Anker gelten; dann das Kennzeichen
-- M-<Jahr des Anlegens in der Zeitzone des Unternehmens>-<Nr.> (LA6).
CREATE FUNCTION massnahme_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tag DATE;
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'geplant' THEN
        RAISE EXCEPTION 'Eine Maßnahme entsteht geplant'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_entsteht_geplant';
    END IF;
    PERFORM massnahme_anker_pruefen(NEW, NULL::massnahme);
    tag := (NEW.angelegt_am AT TIME ZONE coalesce(
        (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = NEW.tenant_id), 'Europe/Berlin'))::date;
    IF NEW.kennzeichen IS NULL THEN
        IF tag IS NOT NULL THEN
            NEW.kennzeichen := uems_verbesserung_kennung(NEW.tenant_id, 'M', extract(YEAR FROM tag)::integer);
        END IF;
    ELSE
        IF NEW.kennzeichen ~ '^M-[0-9]{4}-' AND substring(NEW.kennzeichen FROM 3 FOR 4) <> to_char(tag, 'YYYY') THEN
            RAISE EXCEPTION 'Das Jahr im Kennzeichen % ist das Jahr des Anlegens (%)', NEW.kennzeichen, tag
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_kennzeichen_jahr_chk';
        END IF;
        PERFORM uems_verbesserung_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_anlegen BEFORE INSERT ON massnahme
    FOR EACH ROW EXECUTE FUNCTION massnahme_anlegen();

-- Übergänge einmalig (§5.7, M6): geplant → umgesetzt · verworfen, umgesetzt → bewertet, nie
-- zurück; `umgesetzt` wird nie wiederholt (Tag, Begründung und Meldezeit bleiben) und sein Tag
-- liegt nie nach dem Tag der Meldung; `verworfen` ist endgültig; Titel, Termin,
-- Verantwortlicher, Messgrundlage, Verweise und erwartete Wirkung ändern sich nur, solange
-- die Maßnahme geplant ist; `bewertet` nur mit einem bewerteten Stand.
CREATE FUNCTION massnahme_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tag DATE;
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kennzeichen <> OLD.kennzeichen
        OR NEW.herkunft_art <> OLD.herkunft_art OR NEW.herkunft_kennung IS DISTINCT FROM OLD.herkunft_kennung
        OR NEW.angelegt_am <> OLD.angelegt_am OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Kennzeichen, Herkunft und Anlage einer Maßnahme sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_identitaet_bleibt';
    END IF;
    IF OLD.zustand = 'verworfen' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Die Maßnahme % ist verworfen', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_endgueltig';
    END IF;
    IF NEW.zustand <> OLD.zustand AND (OLD.zustand, NEW.zustand) NOT IN
            (('geplant', 'umgesetzt'), ('geplant', 'verworfen'), ('umgesetzt', 'bewertet')) THEN
        RAISE EXCEPTION 'Die Maßnahme % geht nicht von % nach %', OLD.kennzeichen, OLD.zustand, NEW.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_uebergang_einmalig';
    END IF;
    IF OLD.umgesetzt_am IS NOT NULL AND (NEW.umgesetzt_am, NEW.umgesetzt_begruendung, NEW.umgesetzt_gemeldet_am)
            IS DISTINCT FROM (OLD.umgesetzt_am, OLD.umgesetzt_begruendung, OLD.umgesetzt_gemeldet_am) THEN
        RAISE EXCEPTION 'Die Maßnahme % ist schon umgesetzt (am %)', OLD.kennzeichen, OLD.umgesetzt_am
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_uebergang_einmalig';
    END IF;
    IF OLD.zustand <> 'geplant' AND (NEW.titel, NEW.termin, NEW.verantwortlich_sub, NEW.verantwortlich_name,
            NEW.verantwortlich_konto, NEW.standort_id, NEW.kennzahl_id, NEW.bezugsbasis_id, NEW.fassung,
            NEW.einsatz_id, NEW.einstufung_fassung, NEW.energieziel_id, NEW.erwartete_wirkung_prozent,
            NEW.erwartete_wirkung_wortlaut)
        IS DISTINCT FROM (OLD.titel, OLD.termin, OLD.verantwortlich_sub, OLD.verantwortlich_name,
            OLD.verantwortlich_konto, OLD.standort_id, OLD.kennzahl_id, OLD.bezugsbasis_id, OLD.fassung,
            OLD.einsatz_id, OLD.einstufung_fassung, OLD.energieziel_id, OLD.erwartete_wirkung_prozent,
            OLD.erwartete_wirkung_wortlaut) THEN
        RAISE EXCEPTION 'Die Maßnahme % ist %: nur solange geplant änderbar', OLD.kennzeichen, OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_nur_geplant_aenderbar';
    END IF;
    IF NEW.zustand = 'bewertet' AND OLD.zustand <> 'bewertet' AND NOT EXISTS (
            SELECT 1 FROM massnahme_bewertung b
             WHERE b.tenant_id = NEW.tenant_id AND b.massnahme_id = NEW.id AND b.status = 'bewertet') THEN
        RAISE EXCEPTION 'Die Maßnahme % ist erst mit einem bewerteten Stand bewertet', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertet_mit_stand';
    END IF;
    IF OLD.umgesetzt_am IS NULL AND NEW.umgesetzt_am IS NOT NULL THEN
        NEW.umgesetzt_gemeldet_am := coalesce(NEW.umgesetzt_gemeldet_am, now());
        tag := (NEW.umgesetzt_gemeldet_am AT TIME ZONE coalesce(
            (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = NEW.tenant_id), 'Europe/Berlin'))::date;
        IF NEW.umgesetzt_am > tag THEN
            RAISE EXCEPTION 'Umgesetzt am % liegt nach dem Tag der Meldung (%)', NEW.umgesetzt_am, tag
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_umgesetzt_nicht_in_der_zukunft';
        END IF;
    END IF;
    PERFORM massnahme_anker_pruefen(NEW, OLD);
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_eingefroren BEFORE UPDATE ON massnahme
    FOR EACH ROW EXECUTE FUNCTION massnahme_eingefroren();

-- -----------------------------------------------------------------------------
-- massnahme_aenderung: Protokoll und Verlauf, nur lesen und anhängen, ohne
-- Fremdschlüssel auf die Maßnahme (M7, §8.1 Nr. 12: „ein Protokoll überlebt sein
-- Objekt“). Ein Kommentar ist eine Zeile mit Text; `neu_kopiert` trägt die alte
-- Ausgangslage-Prüfsumme in `alt`.
-- -----------------------------------------------------------------------------
CREATE TABLE massnahme_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    massnahme_id UUID NOT NULL,
    art TEXT NOT NULL,
    alt JSONB,
    neu JSONB,
    begruendung TEXT CHECK (begruendung IS NULL OR btrim(begruendung) <> ''),
    kommentar TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT massnahme_aenderung_art_chk CHECK (coalesce(verbesserung_wort('massnahme_protokoll', art), false)),
    -- M7: ein Kommentar hat Text (1–2 000 Zeichen), keine andere Zeile hat einen.
    CONSTRAINT massnahme_aenderung_kommentar_chk CHECK (coalesce(CASE WHEN art = 'kommentar'
        THEN btrim(kommentar) <> '' AND char_length(kommentar) <= 2000 ELSE kommentar IS NULL END, false)),
    CONSTRAINT massnahme_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT massnahme_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT massnahme_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX massnahme_aenderung_massnahme_idx ON massnahme_aenderung (tenant_id, massnahme_id, created_at, id);

-- -----------------------------------------------------------------------------
-- massnahme_bewertung: Stand Nr. n (WK6, E6 = A).
--
-- Jede Zeile ist ein Stand bzw. bei Vier-Augen ein Antrag darauf: die Person in
-- freigabe_*, bei Vier-Augen entscheidet eine ZWEITE Person (entscheidung_*, Rolle
-- KA oder EM, nie der Urheber) — Muster energieziel. Nr. n ist lückenlos je
-- Maßnahme (ein abgelehnter Antrag behält seine Nr.), höchstens ein offener Antrag
-- je Maßnahme; ein Stand wird nie zurückgenommen, ein neuer ist Nr. n + 1.
-- Die Messgrundlage des Stands ist die der Maßnahme (Trigger): ohne sie nur
-- `nicht_messbar` (M4, CHECK), mit ihr ist die Kopie der Wirkung Pflicht.
-- Ein Stand entsteht nur an einer umgesetzten oder bewerteten Maßnahme.
-- -----------------------------------------------------------------------------
CREATE TABLE massnahme_bewertung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    massnahme_id UUID NOT NULL,
    stand_nr INTEGER NOT NULL,
    kennzahl_id UUID,
    bezugsbasis_id UUID,
    fassung INTEGER,
    wirkung TEXT,
    pruefsumme TEXT,
    ergebnis TEXT NOT NULL,
    begruendung TEXT NOT NULL,
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
    CONSTRAINT massnahme_bewertung_massnahme_fk FOREIGN KEY (massnahme_id, tenant_id)
        REFERENCES massnahme(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT massnahme_bewertung_stand_uq UNIQUE (tenant_id, massnahme_id, stand_nr),
    CONSTRAINT massnahme_bewertung_stand_nr_chk CHECK (stand_nr > 0),
    CONSTRAINT massnahme_bewertung_messgrundlage_chk CHECK (fassung IS NULL OR fassung > 0),
    CONSTRAINT massnahme_bewertung_messgrundlage_ganz_chk CHECK (
        (kennzahl_id IS NULL) = (bezugsbasis_id IS NULL) AND (bezugsbasis_id IS NULL) = (fassung IS NULL)),
    CONSTRAINT massnahme_bewertung_ergebnis_chk CHECK (coalesce(verbesserung_wort('wirkung_ergebnis', ergebnis), false)),
    -- M4/E2 = A: ohne Messgrundlage ist `nicht_messbar` das einzige Ergebnis.
    CONSTRAINT massnahme_bewertung_nicht_messbar_chk CHECK (fassung IS NOT NULL OR ergebnis = 'nicht_messbar'),
    -- WK6: mit Messgrundlage die Kopie der Wirkung (kanonischer Text), ihre Prüfsumme hält die Datenbank.
    CONSTRAINT massnahme_bewertung_wirkung_chk CHECK (
        (wirkung IS NULL) = (pruefsumme IS NULL) AND (fassung IS NULL OR wirkung IS NOT NULL)
        AND (wirkung IS NULL OR (jsonb_typeof(wirkung::jsonb) = 'object' AND pruefsumme = bericht_pruefsumme(wirkung)))),
    CONSTRAINT massnahme_bewertung_begruendung_chk CHECK (char_length(btrim(begruendung)) BETWEEN 10 AND 500),
    CONSTRAINT massnahme_bewertung_status_chk CHECK (coalesce(verbesserung_wort('massnahme_bewertung_status', status), false)),
    CONSTRAINT massnahme_bewertung_person_chk CHECK (coalesce(btrim(freigabe_name) <> ''
        AND freigabe_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
        AND (freigabe_rolle IS NULL OR freigabe_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
        AND (btrim(freigabe_sub) <> '' OR (freigabe_sub IS NULL AND freigabe_art = 'voltpilot')), false)),
    -- Ohne Vier-Augen weder beantragt noch abgelehnt; die zweite Person ist nie die erste und hat
    -- Rolle KA oder EM.
    CONSTRAINT massnahme_bewertung_vieraugen_chk CHECK (vieraugen OR status = 'bewertet'),
    CONSTRAINT massnahme_bewertung_entscheidung_chk CHECK (coalesce(
        CASE WHEN vieraugen AND status IN ('bewertet', 'abgelehnt') THEN
            entscheidung_sub <> freigabe_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager') AND entschieden_am IS NOT NULL
        ELSE entscheidung_sub IS NULL AND entscheidung_name IS NULL AND entscheidung_rolle IS NULL
            AND entscheidung_art IS NULL AND entschieden_am IS NULL END, false)),
    CONSTRAINT massnahme_bewertung_ablehnung_chk CHECK (
        (status = 'abgelehnt') = coalesce(btrim(entscheidungs_begruendung) <> '', false))
);
CREATE UNIQUE INDEX massnahme_bewertung_ein_antrag_uq ON massnahme_bewertung (tenant_id, massnahme_id)
    WHERE status = 'beantragt';
CREATE INDEX massnahme_bewertung_fassung_idx ON massnahme_bewertung (tenant_id, bezugsbasis_id, fassung)
    WHERE bezugsbasis_id IS NOT NULL;

-- Ein Stand entsteht an einer umgesetzten oder bewerteten Maßnahme, mit ihrer Messgrundlage,
-- als Antrag (Vier-Augen) oder gleich bewertet, mit der nächsten Nr.
CREATE FUNCTION massnahme_bewertung_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    m RECORD;
    naechste INTEGER;
BEGIN
    IF NEW.status IS DISTINCT FROM (CASE WHEN NEW.vieraugen THEN 'beantragt' ELSE 'bewertet' END) THEN
        RAISE EXCEPTION 'Ein Stand entsteht bewertet, bei Vier-Augen als Antrag'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertung_entsteht_als_antrag';
    END IF;
    SELECT x.zustand, x.kennzeichen, x.kennzahl_id, x.bezugsbasis_id, x.fassung INTO m FROM massnahme x
     WHERE x.id = NEW.massnahme_id AND x.tenant_id = NEW.tenant_id;
    IF FOUND THEN
        IF m.zustand NOT IN ('umgesetzt', 'bewertet') THEN
            RAISE EXCEPTION 'Die Maßnahme % ist %: bewertet wird erst nach der Umsetzung', m.kennzeichen, m.zustand
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertung_nach_umsetzung';
        END IF;
        IF (NEW.kennzahl_id, NEW.bezugsbasis_id, NEW.fassung) IS DISTINCT FROM (m.kennzahl_id, m.bezugsbasis_id, m.fassung) THEN
            RAISE EXCEPTION 'Der Stand trägt die Messgrundlage der Maßnahme %', m.kennzeichen
                USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertung_messgrundlage_der_massnahme';
        END IF;
    END IF;
    SELECT coalesce(max(b.stand_nr), 0) + 1 INTO naechste FROM massnahme_bewertung b
     WHERE b.tenant_id = NEW.tenant_id AND b.massnahme_id = NEW.massnahme_id;
    IF NEW.stand_nr IS NULL THEN
        NEW.stand_nr := naechste;
    ELSIF NEW.stand_nr <> naechste THEN
        RAISE EXCEPTION 'Der nächste Stand ist Nr. % (nicht %)', naechste, NEW.stand_nr
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertung_stand_nr_lueckenlos';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_bewertung_anlegen BEFORE INSERT ON massnahme_bewertung
    FOR EACH ROW EXECUTE FUNCTION massnahme_bewertung_anlegen();

-- Ein Stand ändert sich nie; nur über einen Antrag entscheidet die zweite Person einmal.
CREATE FUNCTION massnahme_bewertung_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    entscheid CONSTANT TEXT[] := ARRAY['status', 'entscheidung_sub', 'entscheidung_name', 'entscheidung_rolle',
        'entscheidung_art', 'entschieden_am', 'entscheidungs_begruendung'];
BEGIN
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.status <> 'beantragt' OR NEW.status NOT IN ('bewertet', 'abgelehnt')
        OR (to_jsonb(NEW) - entscheid) IS DISTINCT FROM (to_jsonb(OLD) - entscheid) THEN
        RAISE EXCEPTION 'Stand Nr. % ist %: ein Stand wird nie zurückgenommen oder geändert', OLD.stand_nr, OLD.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_bewertung_einmalig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_bewertung_eingefroren BEFORE UPDATE ON massnahme_bewertung
    FOR EACH ROW EXECUTE FUNCTION massnahme_bewertung_eingefroren();

-- -----------------------------------------------------------------------------
-- vorgang_anstoss: der Anstoß am Vorgang (M5, Z5).
--
-- Genau ein Bezug — eine Maßnahme ODER ein Energieziel (Muster
-- unterstuetzung_hinweis) —, Art und Anlass-Kennung (K-…, BK-…, BB-…/Fassung),
-- eindeutig je Vorgang × Art × Anlass (zwei partielle Indizes; die Naht setzt ihn
-- idempotent, IP-17). Eine Ausgangslage hat nur die Maßnahme. Der Anstoß entsteht
-- offen; die Antwort einer Person (`bleibt` mit Begründung 10–500 · `neu_kopiert`
-- · `neu_bewertet`) ist einmalig. Ob ein beendeter Vorgang angestoßen wird,
-- entscheidet die Naht (sie stößt ihn nicht an), nicht ein Fehler hier.
-- -----------------------------------------------------------------------------
CREATE TABLE vorgang_anstoss (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    massnahme_id UUID,
    energieziel_id UUID,
    art TEXT NOT NULL,
    anlass_kennung TEXT NOT NULL,
    angestossen_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    zustand TEXT NOT NULL DEFAULT 'offen',
    antwort TEXT,
    antwort_begruendung TEXT,
    beantwortet_am TIMESTAMPTZ,
    beantwortet_sub TEXT,
    beantwortet_name TEXT,
    beantwortet_rolle TEXT,
    beantwortet_art TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vorgang_anstoss_massnahme_fk FOREIGN KEY (massnahme_id, tenant_id)
        REFERENCES massnahme(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT vorgang_anstoss_energieziel_fk FOREIGN KEY (energieziel_id, tenant_id)
        REFERENCES energieziel(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT vorgang_anstoss_bezug_chk CHECK (num_nonnulls(massnahme_id, energieziel_id) = 1),
    CONSTRAINT vorgang_anstoss_art_chk CHECK (coalesce(verbesserung_wort('anstoss_art', art), false)),
    CONSTRAINT vorgang_anstoss_ausgangslage_chk CHECK (massnahme_id IS NOT NULL
        OR (art <> 'ausgangslage_korrigiert' AND antwort IS DISTINCT FROM 'neu_kopiert')),
    CONSTRAINT vorgang_anstoss_anlass_chk CHECK (btrim(anlass_kennung) <> ''),
    CONSTRAINT vorgang_anstoss_zustand_chk CHECK (coalesce(verbesserung_wort('anstoss_zustand', zustand), false)),
    CONSTRAINT vorgang_anstoss_antwort_chk CHECK (coalesce(CASE WHEN zustand = 'offen' THEN
            antwort IS NULL AND antwort_begruendung IS NULL AND beantwortet_am IS NULL AND beantwortet_sub IS NULL
            AND beantwortet_name IS NULL AND beantwortet_rolle IS NULL AND beantwortet_art IS NULL
        ELSE verbesserung_wort('anstoss_antwort', antwort) AND beantwortet_am IS NOT NULL
            AND btrim(beantwortet_name) <> ''
            AND beantwortet_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (beantwortet_rolle IS NULL OR beantwortet_rolle IN ('kundenadministrator', 'energiemanager',
                 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
            AND (btrim(beantwortet_sub) <> '' OR (beantwortet_sub IS NULL AND beantwortet_art = 'voltpilot'))
            AND (antwort_begruendung IS NULL OR char_length(btrim(antwort_begruendung)) BETWEEN 10 AND 500)
            AND (antwort <> 'bleibt' OR antwort_begruendung IS NOT NULL) END, false))
);
CREATE UNIQUE INDEX vorgang_anstoss_massnahme_uq ON vorgang_anstoss (tenant_id, massnahme_id, art, anlass_kennung)
    WHERE massnahme_id IS NOT NULL;
CREATE UNIQUE INDEX vorgang_anstoss_energieziel_uq ON vorgang_anstoss (tenant_id, energieziel_id, art, anlass_kennung)
    WHERE energieziel_id IS NOT NULL;
CREATE INDEX vorgang_anstoss_offen_idx ON vorgang_anstoss (tenant_id) WHERE zustand = 'offen';

-- Der Anstoß entsteht offen; danach beantwortet ihn eine Person genau einmal.
CREATE FUNCTION vorgang_anstoss_einmalig() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    antwort_spalten CONSTANT TEXT[] := ARRAY['zustand', 'antwort', 'antwort_begruendung', 'beantwortet_am',
        'beantwortet_sub', 'beantwortet_name', 'beantwortet_rolle', 'beantwortet_art'];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.zustand IS DISTINCT FROM 'offen' THEN
            RAISE EXCEPTION 'Ein Anstoß entsteht offen'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'vorgang_anstoss_entsteht_offen';
        END IF;
        RETURN NEW;
    END IF;
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.zustand <> 'offen' OR NEW.zustand <> 'beantwortet'
        OR (to_jsonb(NEW) - antwort_spalten) IS DISTINCT FROM (to_jsonb(OLD) - antwort_spalten) THEN
        RAISE EXCEPTION 'Der Anstoß % (%) ist %: die Antwort ist einmalig', OLD.anlass_kennung, OLD.art, OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'vorgang_anstoss_antwort_einmalig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER vorgang_anstoss_einmalig BEFORE INSERT OR UPDATE ON vorgang_anstoss
    FOR EACH ROW EXECUTE FUNCTION vorgang_anstoss_einmalig();

-- -----------------------------------------------------------------------------
-- RLS + FORCE und der Standort-Zaun (RE2, Muster energieziel): RESTRICTIVE
-- `site_scope` wird mit der Mandanten-Policy UND-verknüpft. Die Maßnahme über
-- `standort_id` (eine am Unternehmen im engen Zaun nie); Protokoll und Stände
-- folgen ihrer Maßnahme, der Anstoß seinem Vorgang (liest massnahme bzw.
-- energieziel unter derselben Rolle, also unter deren Zaun; kein Zyklus).
-- -----------------------------------------------------------------------------
ALTER TABLE massnahme ENABLE ROW LEVEL SECURITY;
ALTER TABLE massnahme FORCE ROW LEVEL SECURITY;
CREATE POLICY massnahme_tenant_isolation ON massnahme
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON massnahme AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);
ALTER TABLE massnahme_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE massnahme_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY massnahme_aenderung_tenant_isolation ON massnahme_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON massnahme_aenderung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM massnahme m
                             WHERE m.id = massnahme_aenderung.massnahme_id
                               AND m.tenant_id = massnahme_aenderung.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM massnahme m
                                  WHERE m.id = massnahme_aenderung.massnahme_id
                                    AND m.tenant_id = massnahme_aenderung.tenant_id) END);
ALTER TABLE massnahme_bewertung ENABLE ROW LEVEL SECURITY;
ALTER TABLE massnahme_bewertung FORCE ROW LEVEL SECURITY;
CREATE POLICY massnahme_bewertung_tenant_isolation ON massnahme_bewertung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON massnahme_bewertung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM massnahme m
                             WHERE m.id = massnahme_bewertung.massnahme_id
                               AND m.tenant_id = massnahme_bewertung.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM massnahme m
                                  WHERE m.id = massnahme_bewertung.massnahme_id
                                    AND m.tenant_id = massnahme_bewertung.tenant_id) END);
ALTER TABLE vorgang_anstoss ENABLE ROW LEVEL SECURITY;
ALTER TABLE vorgang_anstoss FORCE ROW LEVEL SECURITY;
CREATE POLICY vorgang_anstoss_tenant_isolation ON vorgang_anstoss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON vorgang_anstoss AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM massnahme m
                             WHERE m.id = vorgang_anstoss.massnahme_id AND m.tenant_id = vorgang_anstoss.tenant_id)
                  OR EXISTS (SELECT 1 FROM energieziel e
                             WHERE e.id = vorgang_anstoss.energieziel_id AND e.tenant_id = vorgang_anstoss.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM massnahme m
                                  WHERE m.id = vorgang_anstoss.massnahme_id AND m.tenant_id = vorgang_anstoss.tenant_id)
                       OR EXISTS (SELECT 1 FROM energieziel e
                                  WHERE e.id = vorgang_anstoss.energieziel_id
                                    AND e.tenant_id = vorgang_anstoss.tenant_id) END);

-- Grants: die App-Rolle liest und legt an, ändert nur benannte Spalten und löscht nie;
-- das Protokoll wird nur angehängt. Nur das administrative Offboarding löscht: Anstoß,
-- Stände, Protokoll und Maßnahme vor dem Energieziel, der Fassung, dem Einsatz, der
-- Kennzahl, dem Standort und dem Benutzer (TenantRepository.offboard).
REVOKE ALL ON massnahme, massnahme_aenderung, massnahme_bewertung, vorgang_anstoss FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON massnahme, massnahme_aenderung, massnahme_bewertung, vorgang_anstoss TO ${appDbUser};
GRANT UPDATE (titel, verantwortlich_sub, verantwortlich_name, verantwortlich_konto, termin, standort_id, zustand,
    kennzahl_id, bezugsbasis_id, fassung, ausgangslage, ausgangslage_pruefsumme, einsatz_id, einstufung_fassung,
    energieziel_id, erwartete_wirkung_prozent, erwartete_wirkung_wortlaut, umgesetzt_am, umgesetzt_begruendung,
    umgesetzt_gemeldet_am, verworfen_am, verworfen_grund) ON massnahme TO ${appDbUser};
GRANT UPDATE (status, entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am,
    entscheidungs_begruendung) ON massnahme_bewertung TO ${appDbUser};
GRANT UPDATE (zustand, antwort, antwort_begruendung, beantwortet_am, beantwortet_sub, beantwortet_name,
    beantwortet_rolle, beantwortet_art) ON vorgang_anstoss TO ${appDbUser};
GRANT SELECT, DELETE ON massnahme, massnahme_aenderung, massnahme_bewertung, vorgang_anstoss TO ${adminDbUser};
REVOKE ALL ON SEQUENCE massnahme_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE massnahme_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};

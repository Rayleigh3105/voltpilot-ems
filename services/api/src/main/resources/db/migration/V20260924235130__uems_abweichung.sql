-- =============================================================================
-- AP-18 IP-14: Abweichung und Auffälligkeit — Datenhaltung (A1, A2, A3, A4, A6,
-- U1, U2; §4.2, §4.5, §4.6, §5.2, §5.3, §5.7 des Konzepts).
--
-- Neue, leere Tabellen neben IP-5 (V20260924223000) und IP-9 (V20260924233000);
-- KEINE bestehende Zeile, Spalte, kein CHECK und kein Fremdschlüssel einer
-- bestehenden Tabelle ändert sich (Invariante 1: an `kennzahl*`, `bezugsbasis*`,
-- `bericht*`, `energieeinsatz*`, `energieziel*`, `massnahme*` nichts). Ohne
-- Vermerk und ohne Abweichung schreibt nichts.
--
--   auffaelligkeit        Vermerk an einer Kennzahl (A1, kein Vorgang, kein
--                         Kennzeichen): eindeutig je Kennzahl × Bezugsbasis-Fassung
--                         × Monat, mit der Kopie des Vergleichsergebnisses als
--                         kanonischem TEXT und Prüfsumme (`anlass`), `vermerkt_am`
--                         und `standort_id` (Zaun, RE2). Die Antwort einer Person
--                         (A2: `abweichung` mit Verweis · `zur_kenntnis` mit
--                         Begründung 10–500) ist einmalig (Trigger).
--   abweichung            AW-JJJJ-nnnn (JJJJ = Jahr des Eröffnens, LA6) an genau
--                         einer Kennzahl × Fassung × Monaten (A3), Herkunft
--                         `auffaelligkeit · von_hand` (von Hand mit Wortlaut, warum),
--                         Anlass-Kopie mit Prüfsumme, Verantwortlicher (`benutzer` +
--                         Schnappschuss, RE3), Frist (Vorgabe Eröffnungstag + 30
--                         Tage, Vertrag §1), `standort_id`, Zustand `offen ·
--                         abgeschlossen`; der Abschluss (A6) trägt Ergebnis,
--                         Begründung, Person, Zeit und bei `massnahme` den Verweis
--                         (CHECK) — einmalig, danach nie geändert, nie gelöscht.
--   abweichung_aenderung  Protokoll und Verlauf (A4), nur lesen und anhängen, ohne
--                         Fremdschlüssel auf die Abweichung: Kommentar (1–2 000
--                         Zeichen), Ursache-Aussage (U1/U2: Wortlaut 10–500, Person,
--                         Tag, wahlfrei `beleg_kennung`), Frist- und
--                         Verantwortlicher-Änderung mit Begründung 10–500.
--
-- Eine Antwort, ein Eintrag oder ein Abschluss ändert nie eine Zahl (A5): kein
-- Trigger schreibt an Kennzahl, Vergleich oder Basis. Kein Läufer legt eine
-- Abweichung an oder schließt sie (Invariante 4); die Naht, die Vermerke schreibt,
-- ist IP-15, die Routen IP-16, das Portal IP-18.
--
-- Vokabulare: verbesserung_vokabular() wird mit CREATE OR REPLACE geweitet — alle
-- Wörter von IP-5 und IP-9 unverändert in derselben Reihenfolge, dazu nur die
-- Tabellen-Wörter `abweichung_herkunft` und `abweichung_protokoll` (die
-- Vertragslisten `abweichung_zustand`, `abweichung_ergebnis`,
-- `abweichung_eintrag_art`, `auffaelligkeit_zustand`, `auffaelligkeit_antwort`
-- stehen schon dort). Wer die Funktion später weitet, schreibt die VEREINIGUNG.
--
-- Keine neue Rechte-Kennung: verbesserung.verwalten/abschliessen/ansehen aus IP-5
-- decken Eröffnen, Einträge, Antwort und Abschluss (§4.9 RE1).
-- =============================================================================

-- Die Wörter von IP-5 und IP-9 in derselben Reihenfolge, dazu die Wörter der
-- Tabellen dieses Pakets (der Vertrag nennt sie nicht).
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
    ('massnahme_protokoll', 11, 'anstoss_beantwortet'),
    ('abweichung_herkunft', 1, 'auffaelligkeit'),
    ('abweichung_herkunft', 2, 'von_hand'),
    ('abweichung_protokoll', 1, 'abweichung_eroeffnet'),
    ('abweichung_protokoll', 2, 'kommentar'),
    ('abweichung_protokoll', 3, 'ursache_aussage'),
    ('abweichung_protokoll', 4, 'abweichung_geaendert'),
    ('abweichung_protokoll', 5, 'verantwortlicher_geaendert'),
    ('abweichung_protokoll', 6, 'abweichung_abgeschlossen')
$$;

-- Monate einer Abweichung: `JJJJ-MM`, aufsteigend, ohne Doppel, mindestens einer.
CREATE FUNCTION uems_abweichung_monate_gueltig(m TEXT[]) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(m) >= 1 AND array_ndims(m) = 1 AND array_position(m, NULL) IS NULL
     AND NOT EXISTS (SELECT 1 FROM unnest(m) x WHERE x !~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
     AND m = ARRAY(SELECT DISTINCT x FROM unnest(m) x ORDER BY x)
$$;

-- Die Anker eines Vermerks bzw. einer Abweichung (A1, A3): die zitierte Fassung ist
-- FREIGEGEBEN und die Basis die der Kennzahl; jeder Monat liegt in der Geltung der Fassung
-- (gilt_ab … gilt_bis, monatsgenau — auch eine beendete Fassung zitiert ihre Monate); der
-- Standort folgt einer Kennzahl am Standort bzw. am Unternehmen (die übrigen Geltungen
-- leitet der Schreibweg ab, IP-15/IP-16). Eine fehlende Fassung meldet der Fremdschlüssel.
CREATE FUNCTION uems_abweichung_anker_pruefen(p_tabelle TEXT, p_tenant UUID, p_kennzahl UUID, p_basis UUID,
        p_fassung INTEGER, p_monate TEXT[], p_standort UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    f RECORD;
    k RECORD;
    ausserhalb TEXT;
BEGIN
    SELECT bf.freigabe_status, bf.gilt_ab, bf.gilt_bis, b.kennzahl_id INTO f
      FROM bezugsbasis_fassung bf
      JOIN bezugsbasis b ON b.id = bf.bezugsbasis_id AND b.tenant_id = bf.tenant_id
     WHERE bf.tenant_id = p_tenant AND bf.bezugsbasis_id = p_basis AND bf.fassung = p_fassung;
    IF FOUND THEN
        IF f.kennzahl_id <> p_kennzahl THEN
            RAISE EXCEPTION 'Die Bezugsbasis gehört zu einer anderen Kennzahl'
                USING ERRCODE = 'check_violation', CONSTRAINT = p_tabelle || '_basis_der_kennzahl_chk';
        END IF;
        IF f.freigabe_status <> 'freigegeben' THEN
            RAISE EXCEPTION 'Zitiert wird eine freigegebene Bezugsbasis-Fassung (Fassung %: %)', p_fassung,
                f.freigabe_status
                USING ERRCODE = 'check_violation', CONSTRAINT = p_tabelle || '_fassung_freigegeben_chk';
        END IF;
        SELECT min(m) INTO ausserhalb FROM unnest(p_monate) m
         WHERE m < to_char(f.gilt_ab, 'YYYY-MM') OR (f.gilt_bis IS NOT NULL AND m > to_char(f.gilt_bis, 'YYYY-MM'));
        IF ausserhalb IS NOT NULL THEN
            RAISE EXCEPTION 'Der Monat % liegt außerhalb der Geltung der Fassung % (ab %, bis %)', ausserhalb,
                p_fassung, f.gilt_ab, coalesce(f.gilt_bis::text, 'offen')
                USING ERRCODE = 'check_violation', CONSTRAINT = p_tabelle || '_monat_in_der_fassung_chk';
        END IF;
    END IF;
    SELECT kz.geltung_art, kz.standort_id INTO k FROM kennzahl kz WHERE kz.id = p_kennzahl AND kz.tenant_id = p_tenant;
    IF FOUND AND ((k.geltung_art = 'standort' AND p_standort IS DISTINCT FROM k.standort_id)
                  OR (k.geltung_art = 'unternehmen' AND p_standort IS NOT NULL)) THEN
        RAISE EXCEPTION 'Der Standort ist der Standort der Kennzahl'
            USING ERRCODE = 'check_violation', CONSTRAINT = p_tabelle || '_standort_der_kennzahl_chk';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- abweichung (A3, A4, A6, RE2, RE3).
--
-- Genau eine Kennzahl × Fassung × Monate; der Anlass ist die Kopie der
-- Vergleichsergebnisse beim Eröffnen als kanonischer TEXT (kein JSONB), ihre
-- Prüfsumme hält die Datenbank selbst (bericht_pruefsumme). Aus einer
-- Auffälligkeit tragen deren Vermerke den Verweis (auffaelligkeit.abweichung_id);
-- von Hand steht ein Wortlaut, warum (auch an `im_rahmen`, A3).
--
-- `standort_id` ist der Zaun (RE2; NULL = am Unternehmen, dann nur
-- unternehmensweit sichtbar). Die Frist ist ein Tag; fehlt sie beim Eröffnen,
-- setzt die Datenbank die Vorgabe des Vertrags (Tag des Eröffnens + 30).
-- -----------------------------------------------------------------------------
CREATE TABLE abweichung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    -- A3: der Anker.
    kennzahl_id UUID NOT NULL,
    bezugsbasis_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    monate TEXT[] NOT NULL,
    herkunft_art TEXT NOT NULL,
    herkunft_wortlaut TEXT,
    anlass TEXT NOT NULL,
    anlass_pruefsumme TEXT NOT NULL,
    -- RE3: `benutzer` + Schnappschuss (Muster Energieziel/Maßnahme).
    verantwortlich_sub TEXT NOT NULL,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT NOT NULL,
    frist DATE NOT NULL,
    standort_id UUID,
    zustand TEXT NOT NULL DEFAULT 'offen',
    -- A6: der Abschluss — Ergebnis, Verweis bei `massnahme`, Begründung, wer, wann.
    ergebnis TEXT,
    massnahme_id UUID,
    abschluss_begruendung TEXT,
    abgeschlossen_am TIMESTAMPTZ,
    abgeschlossen_sub TEXT,
    abgeschlossen_name TEXT,
    abgeschlossen_rolle TEXT,
    abgeschlossen_art TEXT,
    -- Wer eröffnet hat.
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    eroeffnet_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT abweichung_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT abweichung_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- LA6: AW-<Jahr des Eröffnens>-<Nr.>; das Jahr prüft der Eröffnungs-Trigger.
    CONSTRAINT abweichung_kennzeichen_chk CHECK (kennzeichen ~ '^AW-[0-9]{4}-[0-9]{4,9}$'
        AND substring(kennzeichen FROM 9) !~ '^0+$'),
    CONSTRAINT abweichung_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT abweichung_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT abweichung_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT abweichung_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT abweichung_fassung_fk FOREIGN KEY (tenant_id, bezugsbasis_id, fassung)
        REFERENCES bezugsbasis_fassung(tenant_id, bezugsbasis_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT abweichung_massnahme_fk FOREIGN KEY (massnahme_id, tenant_id)
        REFERENCES massnahme(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT abweichung_monate_chk CHECK (coalesce(uems_abweichung_monate_gueltig(monate), false)),
    CONSTRAINT abweichung_herkunft_chk CHECK (coalesce(verbesserung_wort('abweichung_herkunft', herkunft_art)
        AND (herkunft_art <> 'von_hand' OR herkunft_wortlaut IS NOT NULL)
        AND (herkunft_wortlaut IS NULL OR char_length(btrim(herkunft_wortlaut)) BETWEEN 10 AND 500), false)),
    -- Die Prüfsumme hält die Datenbank gegen den kanonischen Text (Muster Ausgangslage der Maßnahme).
    CONSTRAINT abweichung_anlass_pruefsumme_chk CHECK (jsonb_typeof(anlass::jsonb) = 'object'
        AND anlass_pruefsumme = bericht_pruefsumme(anlass)),
    CONSTRAINT abweichung_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND btrim(verantwortlich_sub) <> '' AND btrim(verantwortlich_konto) <> ''),
    CONSTRAINT abweichung_zustand_chk CHECK (coalesce(verbesserung_wort('abweichung_zustand', zustand), false)),
    -- A6: offen ohne jede Abschluss-Spalte; abgeschlossen mit Ergebnis, Begründung (10–500), Person und Zeit.
    CONSTRAINT abweichung_abschluss_chk CHECK (coalesce(CASE WHEN zustand = 'offen' THEN
            ergebnis IS NULL AND abschluss_begruendung IS NULL AND abgeschlossen_am IS NULL
            AND abgeschlossen_sub IS NULL AND abgeschlossen_name IS NULL AND abgeschlossen_rolle IS NULL
            AND abgeschlossen_art IS NULL
        ELSE verbesserung_wort('abweichung_ergebnis', ergebnis) AND abgeschlossen_am IS NOT NULL
            AND char_length(btrim(abschluss_begruendung)) BETWEEN 10 AND 500
            AND btrim(abgeschlossen_name) <> ''
            AND abgeschlossen_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (abgeschlossen_rolle IS NULL OR abgeschlossen_rolle IN ('kundenadministrator', 'energiemanager',
                 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
            AND (btrim(abgeschlossen_sub) <> '' OR (abgeschlossen_sub IS NULL AND abgeschlossen_art = 'voltpilot')) END,
        false)),
    -- A6: das Ergebnis `massnahme` nur mit dem Verweis auf M-…, und der Verweis nur bei diesem Ergebnis.
    CONSTRAINT abweichung_massnahme_verweis_chk CHECK (
        (ergebnis IS NOT DISTINCT FROM 'massnahme') = (massnahme_id IS NOT NULL)),
    CONSTRAINT abweichung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT abweichung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT abweichung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX abweichung_kennzahl_idx ON abweichung (tenant_id, kennzahl_id);
CREATE INDEX abweichung_standort_idx ON abweichung (tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX abweichung_fassung_idx ON abweichung (tenant_id, bezugsbasis_id, fassung);
CREATE INDEX abweichung_offen_idx ON abweichung (tenant_id, frist) WHERE zustand = 'offen';
CREATE INDEX abweichung_massnahme_idx ON abweichung (tenant_id, massnahme_id) WHERE massnahme_id IS NOT NULL;

-- A3 beim Eröffnen: die Abweichung entsteht offen, die Anker gelten; die Frist hat die
-- Vorgabe des Vertrags; dann das Kennzeichen AW-<Jahr des Eröffnens in der Zeitzone des
-- Unternehmens>-<Nr.> (LA6).
CREATE FUNCTION abweichung_eroeffnen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tag DATE;
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'offen' THEN
        RAISE EXCEPTION 'Eine Abweichung entsteht offen'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'abweichung_entsteht_offen';
    END IF;
    PERFORM uems_abweichung_anker_pruefen('abweichung', NEW.tenant_id, NEW.kennzahl_id, NEW.bezugsbasis_id,
        NEW.fassung, NEW.monate, NEW.standort_id);
    tag := (NEW.eroeffnet_am AT TIME ZONE coalesce(
        (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = NEW.tenant_id), 'Europe/Berlin'))::date;
    NEW.frist := coalesce(NEW.frist, tag + 30);
    IF NEW.kennzeichen IS NULL THEN
        IF tag IS NOT NULL THEN
            NEW.kennzeichen := uems_verbesserung_kennung(NEW.tenant_id, 'AW', extract(YEAR FROM tag)::integer);
        END IF;
    ELSE
        IF NEW.kennzeichen ~ '^AW-[0-9]{4}-' AND substring(NEW.kennzeichen FROM 4 FOR 4) <> to_char(tag, 'YYYY') THEN
            RAISE EXCEPTION 'Das Jahr im Kennzeichen % ist das Jahr des Eröffnens (%)', NEW.kennzeichen, tag
                USING ERRCODE = 'check_violation', CONSTRAINT = 'abweichung_kennzeichen_jahr_chk';
        END IF;
        PERFORM uems_verbesserung_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER abweichung_eroeffnen BEFORE INSERT ON abweichung
    FOR EACH ROW EXECUTE FUNCTION abweichung_eroeffnen();

-- Einmalig (§5.7, A4, A6): Anker, Anlass, Herkunft, Standort und Eröffnung ändern sich nie;
-- solange offen, ändern sich nur Frist und Verantwortlicher (die Begründung steht im
-- Protokoll); offen → abgeschlossen genau einmal, danach ist die Zeile endgültig.
CREATE FUNCTION abweichung_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kennzeichen <> OLD.kennzeichen
        OR NEW.kennzahl_id <> OLD.kennzahl_id OR NEW.bezugsbasis_id <> OLD.bezugsbasis_id
        OR NEW.fassung <> OLD.fassung OR NEW.monate <> OLD.monate OR NEW.herkunft_art <> OLD.herkunft_art
        OR NEW.herkunft_wortlaut IS DISTINCT FROM OLD.herkunft_wortlaut OR NEW.anlass <> OLD.anlass
        OR NEW.anlass_pruefsumme <> OLD.anlass_pruefsumme OR NEW.standort_id IS DISTINCT FROM OLD.standort_id
        OR NEW.eroeffnet_am <> OLD.eroeffnet_am OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Kennzeichen, Anker, Anlass und Eröffnung einer Abweichung sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'abweichung_identitaet_bleibt';
    END IF;
    IF OLD.zustand = 'abgeschlossen' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Die Abweichung % ist abgeschlossen (%): der Abschluss ist einmalig', OLD.kennzeichen,
            OLD.ergebnis
            USING ERRCODE = 'check_violation', CONSTRAINT = 'abweichung_abschluss_einmalig';
    END IF;
    IF OLD.zustand = 'offen' AND NEW.zustand = 'abgeschlossen' THEN
        NEW.abgeschlossen_am := coalesce(NEW.abgeschlossen_am, now());
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER abweichung_eingefroren BEFORE UPDATE ON abweichung
    FOR EACH ROW EXECUTE FUNCTION abweichung_eingefroren();

-- -----------------------------------------------------------------------------
-- abweichung_aenderung: Protokoll und Verlauf (A4), nur lesen und anhängen, ohne
-- Fremdschlüssel auf die Abweichung (§8.1 Nr. 12: „ein Protokoll überlebt sein
-- Objekt“). Ein Kommentar ist eine Zeile mit Text; eine Ursache-Aussage ist die
-- Aussage einer Person (U1): Wortlaut, wer (`aussage_name`, wahlfrei ihr Konto),
-- an welchem Tag, wahlfrei eine Beleg-Kennung (U2: Ereignis, Korrektur K-…,
-- Messbedarf MB-…, statischer Faktor, Befund) — eingetragen von `actor_*`, der
-- nicht dieselbe Person sein muss (R2: Ines trägt die Aussage von Murat ein).
-- Frist und Verantwortlicher ändern sich nur mit Begründung (alt/neu).
-- -----------------------------------------------------------------------------
CREATE TABLE abweichung_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    abweichung_id UUID NOT NULL,
    art TEXT NOT NULL,
    alt JSONB,
    neu JSONB,
    begruendung TEXT,
    kommentar TEXT,
    aussage_wortlaut TEXT,
    aussage_sub TEXT,
    aussage_name TEXT,
    aussage_am DATE,
    beleg_kennung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT abweichung_aenderung_art_chk CHECK (coalesce(verbesserung_wort('abweichung_protokoll', art), false)),
    -- A4: ein Kommentar hat Text (1–2 000 Zeichen), keine andere Zeile hat einen.
    CONSTRAINT abweichung_aenderung_kommentar_chk CHECK (coalesce(CASE WHEN art = 'kommentar'
        THEN btrim(kommentar) <> '' AND char_length(kommentar) <= 2000 ELSE kommentar IS NULL END, false)),
    -- U1/U2: nur eine Ursache-Aussage trägt Wortlaut (10–500), Person, Tag und wahlfrei einen Beleg.
    CONSTRAINT abweichung_aenderung_ursache_chk CHECK (coalesce(CASE WHEN art = 'ursache_aussage'
        THEN char_length(btrim(aussage_wortlaut)) BETWEEN 10 AND 500 AND btrim(aussage_name) <> ''
            AND aussage_am IS NOT NULL AND (aussage_sub IS NULL OR btrim(aussage_sub) <> '')
            AND (beleg_kennung IS NULL OR (btrim(beleg_kennung) <> '' AND char_length(beleg_kennung) <= 200))
        ELSE aussage_wortlaut IS NULL AND aussage_sub IS NULL AND aussage_name IS NULL AND aussage_am IS NULL
            AND beleg_kennung IS NULL END, false)),
    -- A4: Frist und Verantwortlicher ändern sich mit Begründung (10–500, Muster Bezugsbasis-Anstoß).
    CONSTRAINT abweichung_aenderung_begruendung_chk CHECK (
        (begruendung IS NULL OR char_length(btrim(begruendung)) BETWEEN 10 AND 500)
        AND (art NOT IN ('abweichung_geaendert', 'verantwortlicher_geaendert') OR begruendung IS NOT NULL)),
    CONSTRAINT abweichung_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT abweichung_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT abweichung_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX abweichung_aenderung_abweichung_idx ON abweichung_aenderung (tenant_id, abweichung_id, created_at, id);

-- -----------------------------------------------------------------------------
-- auffaelligkeit: der Vermerk an der Kennzahl (A1, A2).
--
-- Eindeutig je Kennzahl × Bezugsbasis-Fassung × Monat (die Naht setzt ihn
-- idempotent: ON CONFLICT ON CONSTRAINT auffaelligkeit_eindeutig_uq DO NOTHING,
-- IP-15); der Anlass ist die Kopie des Vergleichsergebnisses (Urteil, Δ, Band,
-- Kennzeichen) als kanonischer TEXT mit Prüfsumme. `standort_id` ist der Zaun wie
-- bei der Abweichung. Der Vermerk entsteht offen; die Antwort einer Person ist
-- einmalig: `abweichung` mit dem Verweis auf eine Abweichung derselben Kennzahl
-- und Fassung, die den Monat enthält · `zur_kenntnis` mit Begründung 10–500.
-- Der Vermerk bleibt lesbar; er wird nie gelöscht.
-- -----------------------------------------------------------------------------
CREATE TABLE auffaelligkeit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzahl_id UUID NOT NULL,
    bezugsbasis_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    periode TEXT NOT NULL,
    standort_id UUID,
    anlass TEXT NOT NULL,
    anlass_pruefsumme TEXT NOT NULL,
    vermerkt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    zustand TEXT NOT NULL DEFAULT 'offen',
    antwort TEXT,
    antwort_begruendung TEXT,
    abweichung_id UUID,
    beantwortet_am TIMESTAMPTZ,
    beantwortet_sub TEXT,
    beantwortet_name TEXT,
    beantwortet_rolle TEXT,
    beantwortet_art TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A1: je Kennzahl × Fassung × Monat genau ein Vermerk.
    CONSTRAINT auffaelligkeit_eindeutig_uq UNIQUE (tenant_id, kennzahl_id, bezugsbasis_id, fassung, periode),
    CONSTRAINT auffaelligkeit_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT auffaelligkeit_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT auffaelligkeit_fassung_fk FOREIGN KEY (tenant_id, bezugsbasis_id, fassung)
        REFERENCES bezugsbasis_fassung(tenant_id, bezugsbasis_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT auffaelligkeit_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT auffaelligkeit_abweichung_fk FOREIGN KEY (abweichung_id, tenant_id)
        REFERENCES abweichung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT auffaelligkeit_periode_chk CHECK (periode ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT auffaelligkeit_anlass_pruefsumme_chk CHECK (jsonb_typeof(anlass::jsonb) = 'object'
        AND anlass_pruefsumme = bericht_pruefsumme(anlass)),
    CONSTRAINT auffaelligkeit_zustand_chk CHECK (coalesce(verbesserung_wort('auffaelligkeit_zustand', zustand), false)),
    -- A2: offen ohne Antwort; beantwortet mit Wort, Person und Zeit — `abweichung` mit Verweis,
    -- `zur_kenntnis` mit Begründung (10–500) und ohne Verweis.
    CONSTRAINT auffaelligkeit_antwort_chk CHECK (coalesce(CASE WHEN zustand = 'offen' THEN
            antwort IS NULL AND antwort_begruendung IS NULL AND abweichung_id IS NULL AND beantwortet_am IS NULL
            AND beantwortet_sub IS NULL AND beantwortet_name IS NULL AND beantwortet_rolle IS NULL
            AND beantwortet_art IS NULL
        ELSE verbesserung_wort('auffaelligkeit_antwort', antwort) AND beantwortet_am IS NOT NULL
            AND btrim(beantwortet_name) <> ''
            AND beantwortet_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (beantwortet_rolle IS NULL OR beantwortet_rolle IN ('kundenadministrator', 'energiemanager',
                 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
            AND (btrim(beantwortet_sub) <> '' OR (beantwortet_sub IS NULL AND beantwortet_art = 'voltpilot'))
            AND (antwort_begruendung IS NULL OR char_length(btrim(antwort_begruendung)) BETWEEN 10 AND 500)
            AND (antwort <> 'zur_kenntnis' OR antwort_begruendung IS NOT NULL)
            AND (antwort = 'abweichung') = (abweichung_id IS NOT NULL) END, false))
);
CREATE INDEX auffaelligkeit_offen_idx ON auffaelligkeit (tenant_id, kennzahl_id) WHERE zustand = 'offen';
CREATE INDEX auffaelligkeit_standort_idx ON auffaelligkeit (tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX auffaelligkeit_abweichung_idx ON auffaelligkeit (tenant_id, abweichung_id) WHERE abweichung_id IS NOT NULL;

-- Der Vermerk entsteht offen an einer freigegebenen Fassung seiner Kennzahl, deren Geltung
-- den Monat trifft; danach beantwortet ihn eine Person genau einmal — mit `abweichung` nur
-- an einer Abweichung derselben Kennzahl und Fassung, die den Monat enthält.
CREATE FUNCTION auffaelligkeit_einmalig() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    antwort_spalten CONSTANT TEXT[] := ARRAY['zustand', 'antwort', 'antwort_begruendung', 'abweichung_id',
        'beantwortet_am', 'beantwortet_sub', 'beantwortet_name', 'beantwortet_rolle', 'beantwortet_art'];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.zustand IS DISTINCT FROM 'offen' THEN
            RAISE EXCEPTION 'Eine Auffälligkeit entsteht offen'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'auffaelligkeit_entsteht_offen';
        END IF;
        PERFORM uems_abweichung_anker_pruefen('auffaelligkeit', NEW.tenant_id, NEW.kennzahl_id, NEW.bezugsbasis_id,
            NEW.fassung, ARRAY[NEW.periode], NEW.standort_id);
        RETURN NEW;
    END IF;
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
        RETURN NEW;
    END IF;
    IF OLD.zustand <> 'offen' OR NEW.zustand <> 'beantwortet'
        OR (to_jsonb(NEW) - antwort_spalten) IS DISTINCT FROM (to_jsonb(OLD) - antwort_spalten) THEN
        RAISE EXCEPTION 'Die Auffälligkeit % (Fassung %) ist %: die Antwort ist einmalig', OLD.periode, OLD.fassung,
            OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'auffaelligkeit_antwort_einmalig';
    END IF;
    IF NEW.antwort = 'abweichung' AND NEW.abweichung_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM abweichung a
             WHERE a.id = NEW.abweichung_id AND a.tenant_id = NEW.tenant_id AND a.kennzahl_id = NEW.kennzahl_id
               AND a.bezugsbasis_id = NEW.bezugsbasis_id AND a.fassung = NEW.fassung
               AND NEW.periode = ANY (a.monate)) THEN
        RAISE EXCEPTION 'Die Abweichung zitiert die Kennzahl, die Fassung % und den Monat % des Vermerks', NEW.fassung,
            NEW.periode
            USING ERRCODE = 'check_violation', CONSTRAINT = 'auffaelligkeit_abweichung_passt_chk';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER auffaelligkeit_einmalig BEFORE INSERT OR UPDATE ON auffaelligkeit
    FOR EACH ROW EXECUTE FUNCTION auffaelligkeit_einmalig();

-- -----------------------------------------------------------------------------
-- RLS + FORCE und der Standort-Zaun (RE2, Muster Maßnahme): RESTRICTIVE
-- `site_scope` wird mit der Mandanten-Policy UND-verknüpft. Abweichung und
-- Vermerk über `standort_id` (einer am Unternehmen im engen Zaun nie); das
-- Protokoll folgt seiner Abweichung (liest abweichung unter derselben Rolle,
-- also unter deren Zaun; kein Zyklus).
-- -----------------------------------------------------------------------------
ALTER TABLE abweichung ENABLE ROW LEVEL SECURITY;
ALTER TABLE abweichung FORCE ROW LEVEL SECURITY;
CREATE POLICY abweichung_tenant_isolation ON abweichung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON abweichung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);
ALTER TABLE abweichung_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE abweichung_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY abweichung_aenderung_tenant_isolation ON abweichung_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON abweichung_aenderung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM abweichung a
                             WHERE a.id = abweichung_aenderung.abweichung_id
                               AND a.tenant_id = abweichung_aenderung.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM abweichung a
                                  WHERE a.id = abweichung_aenderung.abweichung_id
                                    AND a.tenant_id = abweichung_aenderung.tenant_id) END);
ALTER TABLE auffaelligkeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE auffaelligkeit FORCE ROW LEVEL SECURITY;
CREATE POLICY auffaelligkeit_tenant_isolation ON auffaelligkeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON auffaelligkeit AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);

-- Grants: die App-Rolle liest und legt an, ändert nur benannte Spalten und löscht nie;
-- das Protokoll wird nur angehängt. Nur das administrative Offboarding löscht: Vermerk,
-- Protokoll und Abweichung vor der Maßnahme, der Fassung, der Kennzahl, dem Standort und
-- dem Benutzer (TenantRepository.offboard).
REVOKE ALL ON abweichung, abweichung_aenderung, auffaelligkeit FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON abweichung, abweichung_aenderung, auffaelligkeit TO ${appDbUser};
GRANT UPDATE (verantwortlich_sub, verantwortlich_name, verantwortlich_konto, frist, zustand, ergebnis, massnahme_id,
    abschluss_begruendung, abgeschlossen_am, abgeschlossen_sub, abgeschlossen_name, abgeschlossen_rolle,
    abgeschlossen_art) ON abweichung TO ${appDbUser};
GRANT UPDATE (zustand, antwort, antwort_begruendung, abweichung_id, beantwortet_am, beantwortet_sub, beantwortet_name,
    beantwortet_rolle, beantwortet_art) ON auffaelligkeit TO ${appDbUser};
GRANT SELECT, DELETE ON abweichung, abweichung_aenderung, auffaelligkeit TO ${adminDbUser};
REVOKE ALL ON SEQUENCE abweichung_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE abweichung_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};

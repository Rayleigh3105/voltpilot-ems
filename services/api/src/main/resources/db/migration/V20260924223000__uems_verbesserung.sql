-- =============================================================================
-- AP-18 IP-5: Vorgänge — gemeinsame Datenhaltung und Energieziel (Z1, Z2, RE1,
-- RE2; §4.2, §5.7, §6.1 des Konzepts).
--
-- Neue, leere Tabellen; KEINE bestehende Zeile, Spalte, kein CHECK und kein
-- Fremdschlüssel einer bestehenden Tabelle ändert sich (Invariante 1: an
-- `kennzahl*`, `bezugsbasis*`, `bericht*`, `energieeinsatz*` nichts). Ohne
-- Energieziel schreibt nichts.
--
--   verbesserung_kennung_seq  der Kennzeichen-Zähler EZ-/M-/AW-JJJJ-nnnn je
--                             Kundenbereich, Art und Jahr (Muster
--                             bericht_kennung_seq); lückenlos, weil er in der
--                             Transaktion der Anlage vorrückt. M und AW ziehen
--                             erst IP-9 und IP-14.
--   energieziel               EZ-… an genau einer Kennzahl mit der zitierten,
--                             FREIGEGEBENEN Bezugsbasis-Fassung (Z1), Zielwert
--                             in Prozent gegenüber dem Erwarteten (eine Stelle,
--                             weniger negativ), Zielperiode JJJJ-MM/JJJJ-MM aus
--                             ganzen Monaten ab dem Monat nach dem Anlegen (Z2),
--                             Verantwortlicher (`benutzer` + Schnappschuss, W4),
--                             `standort_id` (RE2), Zustand, Bewertung als Kopie
--                             mit Prüfsumme und Vier-Augen (Z5). Je Kennzahl und
--                             Zielperiode höchstens EIN laufendes Ziel.
--   energieziel_aenderung     Protokoll, nur lesen und anhängen (§8.1 Nr. 12:
--                             alt/neu/Begründung und Akteur, ohne Fremdschlüssel
--                             auf das Objekt).
--
-- Das Jahr im Kennzeichen ist beim Energieziel das ERSTE Jahr der Zielperiode
-- (Z1/LA6: EZ-2028-0001 wird am 20.12.2027 angelegt), bei Maßnahme und
-- Abweichung das Jahr des Anlegens (IP-9, IP-14).
--
-- Übergänge sind einmalig (Trigger energieziel_eingefroren, Muster
-- bezugsbasis_fassung_eingefroren): `bewertet` und `beendet` sind endgültig; die
-- Zielperiode verschiebt nur ihr Ende nach hinten; ein Antrag auf Bewertung
-- (Vier-Augen) ändert sich nicht, eine zweite Person bestätigt oder lehnt ab.
-- Kein DELETE für die App-Rolle; nur das Mandanten-Offboarding löscht.
--
-- Die Vokabulare stehen EINMAL in verbesserung_vokabular(), zeilengleich zu
-- `verbesserung-vectors.json` (IP-2); ein späteres Paket weitet sie mit CREATE
-- OR REPLACE, ohne einen CHECK anzufassen (nie enger).
--
-- Nicht dieses Paket: Routen, Ziel-Stand-Leser (IP-6), Bewertung (IP-7),
-- Portal (IP-8), Maßnahme (IP-9), Abweichung (IP-14), Auffälligkeit und Anstoß
-- (IP-15 ff.).
-- =============================================================================

-- Die Vokabulare von `verbesserung-vectors.json` (IP-2) in der Reihenfolge des
-- Vertrags; `nr` ist die Stelle. `kennung_art`, `energieziel_bewertung_status` und
-- `energieziel_protokoll` sind Wörter der Tabellen, die der Vertrag nicht nennt.
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
    ('energieziel_protokoll', 9, 'anstoss_beantwortet')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION verbesserung_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.verbesserung_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- -----------------------------------------------------------------------------
-- verbesserung_kennung_seq: der Zähler EZ-/M-/AW-<Jahr>-<Nr.> je Kundenbereich,
-- Art und Jahr — eine Tabelle, nie ein BIGSERIAL (Muster bericht_kennung_seq).
-- `naechste_nummer` ist die nächste Nummer (fehlt die Zeile: 1); der Zähler rückt
-- nur mit einer vergebenen Kennung vor (dieselbe Transaktion) und nie zurück.
-- -----------------------------------------------------------------------------
CREATE TABLE verbesserung_kennung_seq (
    tenant_id        UUID    NOT NULL,
    art              TEXT    NOT NULL,
    jahr             INTEGER NOT NULL,
    naechste_nummer  INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT verbesserung_kennung_seq_pk PRIMARY KEY (tenant_id, art, jahr),
    CONSTRAINT verbesserung_kennung_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT verbesserung_kennung_seq_art_chk CHECK (coalesce(verbesserung_wort('kennung_art', art), false)),
    CONSTRAINT verbesserung_kennung_seq_jahr_chk CHECK (jahr BETWEEN 1000 AND 9999),
    CONSTRAINT verbesserung_kennung_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

CREATE FUNCTION verbesserung_kennung_seq_rueckt_vor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.art <> OLD.art OR NEW.jahr <> OLD.jahr
        OR NEW.naechste_nummer < OLD.naechste_nummer THEN
        RAISE EXCEPTION 'Der Kennzeichen-Zähler rückt nur vor (% auf %)', OLD.naechste_nummer, NEW.naechste_nummer
            USING ERRCODE = 'check_violation', CONSTRAINT = 'verbesserung_kennung_seq_rueckt_nur_vor';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER verbesserung_kennung_seq_rueckt_vor BEFORE UPDATE ON verbesserung_kennung_seq
    FOR EACH ROW EXECUTE FUNCTION verbesserung_kennung_seq_rueckt_vor();

-- Die nächste Kennung <Art>-<Jahr>-<Nr.> des Kundenbereichs — und der Zähler rückt
-- dahinter. Die Zeile (Mandant, Art, Jahr) wird gesperrt oder angelegt: parallele
-- Vergaben warten aufeinander, eine zurückgerollte Anlage gibt ihre Nummer zurück.
-- Läuft als Aufrufer: unter RLS vergibt die App-Rolle nur für ihren Mandanten.
-- Welches Jahr, sagt der Aufrufer (Z1).
CREATE FUNCTION uems_verbesserung_kennung(p_tenant UUID, p_art TEXT, p_jahr INTEGER) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
    n INTEGER;
BEGIN
    IF p_tenant IS NULL OR p_art IS NULL OR p_jahr IS NULL THEN
        RAISE EXCEPTION 'a tenant scope, a kind and a year are required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO verbesserung_kennung_seq AS z (tenant_id, art, jahr, naechste_nummer)
    VALUES (p_tenant, p_art, p_jahr, 1)
    ON CONFLICT (tenant_id, art, jahr) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    UPDATE verbesserung_kennung_seq SET naechste_nummer = n + 1
     WHERE tenant_id = p_tenant AND art = p_art AND jahr = p_jahr;
    RETURN p_art || '-' || p_jahr || '-' || lpad(n::text, greatest(4, length(n::text)), '0');
END
$$;

-- Ein ausdrücklich gesetztes Kennzeichen (Übernahme, Referenzdatei) rückt den
-- Zähler dahinter; ein unförmiges lässt ihn stehen — den Fehler meldet der CHECK.
CREATE FUNCTION uems_verbesserung_kennung_vorruecken(p_tenant UUID, p_kennung TEXT) RETURNS VOID
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
    teile TEXT[] := regexp_match(p_kennung, '^(EZ|M|AW)-([0-9]{4})-([0-9]{4,9})$');
BEGIN
    IF p_tenant IS NULL OR teile IS NULL OR teile[3]::integer = 0 THEN
        RETURN;
    END IF;
    INSERT INTO verbesserung_kennung_seq AS z (tenant_id, art, jahr, naechste_nummer)
    VALUES (p_tenant, teile[1], teile[2]::integer, teile[3]::integer + 1)
    ON CONFLICT (tenant_id, art, jahr) DO UPDATE
        SET naechste_nummer = greatest(z.naechste_nummer, EXCLUDED.naechste_nummer);
END
$$;

-- -----------------------------------------------------------------------------
-- energieziel (Z1, Z2, Z5, RE2, W4).
--
-- Die zitierte Fassung (bezugsbasis_id, fassung) ist beim Anlegen FREIGEGEBEN,
-- nicht beendet und gehört zur Basis der Kennzahl (Trigger energieziel_anlegen;
-- ein Fremdschlüssel allein kennt den Freigabe-Zustand nicht). Die Zielperiode
-- beginnt frühestens im Monat nach dem Anlegen (Tag in der Zeitzone des
-- Unternehmens) und nie vor der Geltung der Fassung.
--
-- `standort_id` ist der Standort der Geltung der Kennzahl (NULL = am
-- Unternehmen, RE2: dann nur unternehmensweit sichtbar); bei einer Kennzahl am
-- Standort bzw. am Unternehmen prüft das der Anlege-Trigger, die übrigen
-- Geltungen leitet der Schreibweg ab (IP-6).
--
-- Bewertung (Z5, Muster bezugsbasis_fassung): `bewertung_status` NULL (keine) ·
-- `beantragt` (Vier-Augen offen) · `bewertet` · `abgelehnt` (Vier-Augen; danach
-- darf ein neuer Antrag kommen). Die Person der Bewertung bzw. des Antrags steht
-- in freigabe_*, bei Vier-Augen entscheidet eine ZWEITE Person (entscheidung_*)
-- mit Rolle KA oder EM. Die Kopie des Ziel-Stands ist kanonischer TEXT (kein
-- JSONB), ihre Prüfsumme hält die Datenbank selbst (bericht_pruefsumme).
-- -----------------------------------------------------------------------------
CREATE TABLE energieziel (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    kennzahl_id UUID NOT NULL,
    bezugsbasis_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    -- Z2: Prozent gegenüber dem Erwarteten der Basis, weniger Energie negativ, eine Stelle.
    zielwert_prozent NUMERIC NOT NULL,
    zielperiode TEXT NOT NULL,
    wortlaut TEXT NOT NULL,
    begruendung TEXT NOT NULL,
    -- W4: `benutzer` + Schnappschuss (Muster Einsatz/Basis).
    verantwortlich_sub TEXT NOT NULL,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT NOT NULL,
    standort_id UUID,
    zustand TEXT NOT NULL DEFAULT 'offen',
    -- Vorzeitig beendet (Tag, wann, warum), nie gelöscht.
    beendet_zum DATE,
    beendet_am TIMESTAMPTZ,
    beendet_grund TEXT,
    -- Z4/Z5: Ergebnis einer Person mit Begründung, Kopie des Ziel-Stands mit Prüfsumme.
    ergebnis TEXT,
    bewertung_begruendung TEXT,
    bewertung_kopie TEXT,
    bewertung_pruefsumme TEXT,
    vieraugen BOOLEAN NOT NULL DEFAULT false,
    bewertung_status TEXT,
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
    -- Wer angelegt hat.
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    angelegt_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energieziel_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energieziel_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    -- Z1/LA6: EZ-<erstes Jahr der Zielperiode>-<Nr.>.
    CONSTRAINT energieziel_kennzeichen_chk CHECK (kennzeichen ~ '^EZ-[0-9]{4}-[0-9]{4,9}$'
        AND substring(kennzeichen FROM 9) !~ '^0+$'
        AND substring(kennzeichen FROM 4 FOR 4) = substring(zielperiode FROM 1 FOR 4)),
    CONSTRAINT energieziel_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieziel_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieziel_fassung_fk FOREIGN KEY (tenant_id, bezugsbasis_id, fassung)
        REFERENCES bezugsbasis_fassung(tenant_id, bezugsbasis_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT energieziel_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT energieziel_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieziel_zielwert_chk CHECK (zielwert_prozent = round(zielwert_prozent, 1)
        AND zielwert_prozent > -100 AND zielwert_prozent < 100),
    -- Z2: ganze Kalendermonate JJJJ-MM/JJJJ-MM (Format der Datengrundlage), Anfang ≤ Ende.
    CONSTRAINT energieziel_zielperiode_chk CHECK (
        zielperiode ~ '^[0-9]{4}-(0[1-9]|1[0-2])/[0-9]{4}-(0[1-9]|1[0-2])$'
        AND substring(zielperiode FROM 1 FOR 7) <= substring(zielperiode FROM 9 FOR 7)),
    CONSTRAINT energieziel_wortlaut_chk CHECK (btrim(wortlaut) <> ''),
    CONSTRAINT energieziel_begruendung_chk CHECK (char_length(btrim(begruendung)) BETWEEN 10 AND 500),
    CONSTRAINT energieziel_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND btrim(verantwortlich_sub) <> '' AND btrim(verantwortlich_konto) <> ''),
    CONSTRAINT energieziel_zustand_chk CHECK (coalesce(verbesserung_wort('energieziel_zustand', zustand), false)),
    CONSTRAINT energieziel_beendet_chk CHECK (
        (zustand = 'beendet') = (beendet_zum IS NOT NULL)
        AND (beendet_zum IS NULL) = (beendet_am IS NULL)
        AND (beendet_am IS NULL) = (beendet_grund IS NULL)
        AND (beendet_grund IS NULL OR char_length(btrim(beendet_grund)) BETWEEN 10 AND 500)),
    -- Z5: ohne Bewertung keine Spur davon; mit ihr Ergebnis, Begründung (10–500), Kopie und Person.
    CONSTRAINT energieziel_bewertung_chk CHECK (coalesce(CASE WHEN bewertung_status IS NULL THEN
            ergebnis IS NULL AND bewertung_begruendung IS NULL AND bewertung_kopie IS NULL
            AND NOT vieraugen AND freigabe_sub IS NULL AND freigabe_name IS NULL AND freigabe_rolle IS NULL
            AND freigabe_art IS NULL AND freigabe_am IS NULL
        ELSE verbesserung_wort('energieziel_bewertung_status', bewertung_status)
            AND verbesserung_wort('energieziel_ergebnis', ergebnis)
            AND char_length(btrim(bewertung_begruendung)) BETWEEN 10 AND 500
            AND bewertung_kopie IS NOT NULL
            AND btrim(freigabe_name) <> '' AND freigabe_am IS NOT NULL
            AND freigabe_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (freigabe_rolle IS NULL OR freigabe_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
            AND (btrim(freigabe_sub) <> '' OR (freigabe_sub IS NULL AND freigabe_art = 'voltpilot')) END, false)),
    -- Die Prüfsumme hält die Datenbank gegen den kanonischen Text (Muster Bezugsbasis-Grundlage).
    CONSTRAINT energieziel_bewertung_pruefsumme_chk CHECK (
        (bewertung_kopie IS NULL) = (bewertung_pruefsumme IS NULL)
        AND (bewertung_kopie IS NULL OR (jsonb_typeof(bewertung_kopie::jsonb) = 'object'
             AND bewertung_pruefsumme = bericht_pruefsumme(bewertung_kopie)))),
    CONSTRAINT energieziel_bewertet_chk CHECK ((zustand = 'bewertet') = coalesce(bewertung_status = 'bewertet', false)),
    -- Ohne Vier-Augen weder beantragt noch abgelehnt; die zweite Person ist nie die erste
    -- und hat Rolle KA oder EM.
    CONSTRAINT energieziel_vieraugen_chk CHECK (vieraugen OR bewertung_status IS NULL OR bewertung_status = 'bewertet'),
    CONSTRAINT energieziel_entscheidung_chk CHECK (coalesce(
        CASE WHEN vieraugen AND bewertung_status IN ('bewertet', 'abgelehnt') THEN
            entscheidung_sub <> freigabe_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager') AND entschieden_am IS NOT NULL
        ELSE entscheidung_sub IS NULL AND entscheidung_name IS NULL AND entscheidung_rolle IS NULL
            AND entscheidung_art IS NULL AND entschieden_am IS NULL END, false)),
    CONSTRAINT energieziel_ablehnung_chk CHECK (
        coalesce(bewertung_status = 'abgelehnt', false) = coalesce(btrim(entscheidungs_begruendung) <> '', false)),
    CONSTRAINT energieziel_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energieziel_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energieziel_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- Z1: je Kennzahl und Zielperiode höchstens EIN laufendes Ziel.
CREATE UNIQUE INDEX energieziel_ein_laufendes_uq ON energieziel (tenant_id, kennzahl_id, zielperiode)
    WHERE zustand = 'offen';
CREATE INDEX energieziel_standort_idx ON energieziel (tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX energieziel_fassung_idx ON energieziel (tenant_id, bezugsbasis_id, fassung);

-- Z1/Z2 beim Anlegen: die Fassung gilt (freigegeben, nicht beendet, Basis der Kennzahl),
-- die Zielperiode beginnt nach dem Anlegen und nicht vor der Fassung; dann das Kennzeichen.
CREATE FUNCTION energieziel_anlegen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    f RECORD;
    k RECORD;
    tag DATE;
BEGIN
    IF NEW.zustand IS DISTINCT FROM 'offen' OR NEW.bewertung_status IS NOT NULL THEN
        RAISE EXCEPTION 'Ein Energieziel entsteht offen und unbewertet'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_entsteht_offen';
    END IF;
    tag := (NEW.angelegt_am AT TIME ZONE coalesce(
        (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = NEW.tenant_id), 'Europe/Berlin'))::date;
    SELECT bf.freigabe_status, bf.gilt_ab, bf.gilt_bis, b.kennzahl_id, b.beendet_am AS basis_beendet_am INTO f
      FROM bezugsbasis_fassung bf
      JOIN bezugsbasis b ON b.id = bf.bezugsbasis_id AND b.tenant_id = bf.tenant_id
     WHERE bf.tenant_id = NEW.tenant_id AND bf.bezugsbasis_id = NEW.bezugsbasis_id AND bf.fassung = NEW.fassung;
    IF FOUND THEN
        IF f.kennzahl_id <> NEW.kennzahl_id THEN
            RAISE EXCEPTION 'Die Bezugsbasis gehört zu einer anderen Kennzahl'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_basis_der_kennzahl_chk';
        END IF;
        IF f.freigabe_status <> 'freigegeben' OR f.basis_beendet_am IS NOT NULL
            OR (f.gilt_bis IS NOT NULL AND f.gilt_bis < tag) THEN
            RAISE EXCEPTION 'Ein Energieziel zitiert eine freigegebene, geltende Bezugsbasis-Fassung (Fassung %: %)',
                NEW.fassung, f.freigabe_status
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_fassung_freigegeben_chk';
        END IF;
        IF substring(NEW.zielperiode FROM 1 FOR 7) < to_char(f.gilt_ab, 'YYYY-MM') THEN
            RAISE EXCEPTION 'Die Zielperiode beginnt nicht vor der Geltung der Fassung (%)', f.gilt_ab
                USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_zielperiode_ab_fassung_chk';
        END IF;
    END IF;
    IF substring(NEW.zielperiode FROM 1 FOR 7) <= to_char(tag, 'YYYY-MM') THEN
        RAISE EXCEPTION 'Die Zielperiode beginnt frühestens im Monat nach dem Anlegen (%)', tag
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_zielperiode_nach_anlegen_chk';
    END IF;
    SELECT kz.geltung_art, kz.standort_id INTO k FROM kennzahl kz
     WHERE kz.id = NEW.kennzahl_id AND kz.tenant_id = NEW.tenant_id;
    IF FOUND AND ((k.geltung_art = 'standort' AND NEW.standort_id IS DISTINCT FROM k.standort_id)
                  OR (k.geltung_art = 'unternehmen' AND NEW.standort_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'Der Standort des Energieziels ist der Standort der Kennzahl'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_standort_der_kennzahl_chk';
    END IF;
    IF NEW.kennzeichen IS NULL THEN
        IF NEW.zielperiode ~ '^[0-9]{4}-' THEN
            NEW.kennzeichen := uems_verbesserung_kennung(NEW.tenant_id, 'EZ',
                substring(NEW.zielperiode FROM 1 FOR 4)::integer);
        END IF;
    ELSE
        PERFORM uems_verbesserung_kennung_vorruecken(NEW.tenant_id, NEW.kennzeichen);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energieziel_anlegen BEFORE INSERT ON energieziel
    FOR EACH ROW EXECUTE FUNCTION energieziel_anlegen();

-- Übergänge einmalig (§5.7): Identität, Anker und Zielwert bleiben; `bewertet` und
-- `beendet` sind endgültig; die Zielperiode verschiebt nur ihr Ende nach hinten; ein
-- Antrag auf Bewertung bleibt, bis die zweite Person bestätigt oder ablehnt.
CREATE FUNCTION energieziel_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kennzeichen <> OLD.kennzeichen
        OR NEW.kennzahl_id <> OLD.kennzahl_id OR NEW.bezugsbasis_id <> OLD.bezugsbasis_id
        OR NEW.fassung <> OLD.fassung OR NEW.zielwert_prozent <> OLD.zielwert_prozent
        OR NEW.begruendung <> OLD.begruendung OR NEW.standort_id IS DISTINCT FROM OLD.standort_id
        OR NEW.angelegt_am <> OLD.angelegt_am OR NEW.created_at <> OLD.created_at
        OR NEW.actor_sub IS DISTINCT FROM OLD.actor_sub OR NEW.actor_name <> OLD.actor_name
        OR NEW.actor_rolle IS DISTINCT FROM OLD.actor_rolle OR NEW.actor_art <> OLD.actor_art THEN
        RAISE EXCEPTION 'Identität, Anker und Zielwert eines Energieziels sind nie änderbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_identitaet_bleibt';
    END IF;
    IF OLD.zustand <> 'offen' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Das Energieziel % ist %', OLD.kennzeichen, OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_endgueltig';
    END IF;
    IF substring(NEW.zielperiode FROM 1 FOR 7) <> substring(OLD.zielperiode FROM 1 FOR 7)
        OR substring(NEW.zielperiode FROM 9 FOR 7) < substring(OLD.zielperiode FROM 9 FOR 7) THEN
        RAISE EXCEPTION 'Die Zielperiode verschiebt nur ihr Ende nach hinten (% auf %)', OLD.zielperiode, NEW.zielperiode
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_zielperiode_nur_nach_hinten';
    END IF;
    IF OLD.bewertung_status IS NOT NULL AND NEW.bewertung_status IS NULL THEN
        RAISE EXCEPTION 'Eine Bewertung des Energieziels % wird nie zurückgenommen', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_bewertung_einmalig';
    END IF;
    -- Solange der Zustand der Bewertung gleich bleibt oder die zweite Person über einen
    -- Antrag entscheidet, bleibt der Inhalt (Ergebnis, Begründung, Kopie, erste Person).
    IF (NEW.bewertung_status IS NOT DISTINCT FROM OLD.bewertung_status OR OLD.bewertung_status = 'beantragt')
        AND (NEW.ergebnis, NEW.bewertung_begruendung, NEW.bewertung_kopie, NEW.bewertung_pruefsumme, NEW.vieraugen,
             NEW.freigabe_sub, NEW.freigabe_name, NEW.freigabe_rolle, NEW.freigabe_art, NEW.freigabe_am)
            IS DISTINCT FROM (OLD.ergebnis, OLD.bewertung_begruendung, OLD.bewertung_kopie, OLD.bewertung_pruefsumme,
             OLD.vieraugen, OLD.freigabe_sub, OLD.freigabe_name, OLD.freigabe_rolle, OLD.freigabe_art, OLD.freigabe_am)
    THEN
        RAISE EXCEPTION 'Die Bewertung des Energieziels % ist gestellt', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_bewertung_einmalig';
    END IF;
    -- Bei Vier-Augen geht jede Bewertung über einen Antrag; abgelehnt wird nur ein Antrag.
    IF NEW.bewertung_status IS DISTINCT FROM OLD.bewertung_status AND OLD.bewertung_status IS DISTINCT FROM 'beantragt'
        AND (NEW.bewertung_status = 'abgelehnt' OR (NEW.bewertung_status = 'bewertet' AND NEW.vieraugen)) THEN
        RAISE EXCEPTION 'Über die Bewertung des Energieziels % entscheidet bei Vier-Augen eine zweite Person',
            OLD.kennzeichen USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_bewertung_einmalig';
    END IF;
    IF NEW.bewertung_status IS NOT DISTINCT FROM OLD.bewertung_status
        AND (NEW.entscheidung_sub, NEW.entscheidung_name, NEW.entscheidung_rolle, NEW.entscheidung_art,
             NEW.entschieden_am, NEW.entscheidungs_begruendung)
            IS DISTINCT FROM (OLD.entscheidung_sub, OLD.entscheidung_name, OLD.entscheidung_rolle,
             OLD.entscheidung_art, OLD.entschieden_am, OLD.entscheidungs_begruendung) THEN
        RAISE EXCEPTION 'Der Entscheid über die Bewertung des Energieziels % ist gefallen', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energieziel_bewertung_einmalig';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energieziel_eingefroren BEFORE UPDATE ON energieziel
    FOR EACH ROW EXECUTE FUNCTION energieziel_eingefroren();

-- -----------------------------------------------------------------------------
-- energieziel_aenderung: Protokoll, nur lesen und anhängen (§5.7, §8.1 Nr. 12).
-- -----------------------------------------------------------------------------
CREATE TABLE energieziel_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    energieziel_id UUID NOT NULL,
    art TEXT NOT NULL,
    alt JSONB,
    neu JSONB,
    begruendung TEXT CHECK (begruendung IS NULL OR btrim(begruendung) <> ''),
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energieziel_aenderung_art_chk CHECK (coalesce(verbesserung_wort('energieziel_protokoll', art), false)),
    CONSTRAINT energieziel_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energieziel_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energieziel_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energieziel_aenderung_ziel_idx ON energieziel_aenderung (tenant_id, energieziel_id, created_at, id);

-- -----------------------------------------------------------------------------
-- RLS + FORCE und der Standort-Zaun (RE2, Muster V20260915190000): RESTRICTIVE
-- `site_scope` wird mit der Mandanten-Policy UND-verknüpft. Unternehmensweit (oder
-- ohne Zugriff im Spiel: Jobs, Offboarding) gilt allein der Mandanten-Zaun; im
-- engen Zaun nur Ziele an einem Standort der Anfrage — ein Ziel am Unternehmen
-- (standort_id NULL) nie. Das Protokoll folgt seinem Ziel (liest energieziel
-- unter derselben Rolle, also unter dessen Zaun; kein Zyklus).
-- -----------------------------------------------------------------------------
ALTER TABLE verbesserung_kennung_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE verbesserung_kennung_seq FORCE ROW LEVEL SECURITY;
CREATE POLICY verbesserung_kennung_seq_tenant_isolation ON verbesserung_kennung_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energieziel ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieziel FORCE ROW LEVEL SECURITY;
CREATE POLICY energieziel_tenant_isolation ON energieziel
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energieziel AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);
ALTER TABLE energieziel_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieziel_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY energieziel_aenderung_tenant_isolation ON energieziel_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energieziel_aenderung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM energieziel e
                             WHERE e.id = energieziel_aenderung.energieziel_id
                               AND e.tenant_id = energieziel_aenderung.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM energieziel e
                                  WHERE e.id = energieziel_aenderung.energieziel_id
                                    AND e.tenant_id = energieziel_aenderung.tenant_id) END);

-- Grants: die App-Rolle liest und legt an, ändert nur benannte Spalten und löscht
-- nie; das Protokoll wird nur angehängt. Nur das administrative Offboarding löscht:
-- Protokoll und Ziel vor Fassung, Basis, Kennzahl, Standort und Benutzer, der
-- Zähler mit ihnen (TenantRepository.offboard).
REVOKE ALL ON verbesserung_kennung_seq, energieziel, energieziel_aenderung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON verbesserung_kennung_seq, energieziel, energieziel_aenderung TO ${appDbUser};
GRANT UPDATE (naechste_nummer) ON verbesserung_kennung_seq TO ${appDbUser};
GRANT UPDATE (wortlaut, zielperiode, verantwortlich_sub, verantwortlich_name, verantwortlich_konto, zustand,
    beendet_zum, beendet_am, beendet_grund, ergebnis, bewertung_begruendung, bewertung_kopie, bewertung_pruefsumme,
    vieraugen, bewertung_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am,
    entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am,
    entscheidungs_begruendung) ON energieziel TO ${appDbUser};
GRANT SELECT, DELETE ON verbesserung_kennung_seq, energieziel, energieziel_aenderung TO ${adminDbUser};
REVOKE ALL ON SEQUENCE energieziel_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE energieziel_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};
REVOKE ALL ON FUNCTION uems_verbesserung_kennung(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_verbesserung_kennung(UUID, TEXT, INTEGER) TO ${appDbUser};
REVOKE ALL ON FUNCTION uems_verbesserung_kennung_vorruecken(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_verbesserung_kennung_vorruecken(UUID, TEXT) TO ${appDbUser};

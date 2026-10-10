-- =============================================================================
-- AP-17 IP-6: Bezugsbasis — Datenhaltung (B1, B4, V3, F1; §6.1 des Konzepts).
--
-- Neue, leere Tabellen; KEINE bestehende Zeile, Spalte, kein CHECK und kein
-- Fremdschlüssel einer bestehenden Tabelle ändert sich (Invariante 1: an
-- `kennzahl*`, `bezugsgroesse*` nichts). Ohne Bezugsbasis schreibt nichts.
--
--   bezugsbasis              BB-… an genau einer Kennzahl (B1): Zweck,
--                            Verantwortlicher (`benutzer` + Schnappschuss, B4),
--                            beendet, nie gelöscht. Je Kennzahl höchstens EINE
--                            laufende Bezugsbasis (partieller Unique-Index).
--   bezugsbasis_fassung      Nummer, Referenzperiode JJJJ-MM/JJJJ-MM, Methode,
--                            gilt_ab/gilt_bis, Datenlage, Toleranz, Wiedervorlage,
--                            Anpassungsgründe (A1), Freigabe nach dem Muster
--                            `bewertung_kriterien_fassung` (F1/F2), eingefrorene
--                            Grundlage mit Prüfsumme (F3), Basiswert,
--                            Koeffizienten, Güte (M4).
--   bezugsbasis_variable     Position 1/2 (V2: 1 = der Nenner), Bezugsgröße mit
--                            Fassung zum Freigabetag, Spannweite (M2, G3).
--   bezugsbasis_faktor       statischer Faktor (V3): Verweis oder Wortlaut, Wert
--                            zum Freigabetag als Kopie.
--   bezugsbasis_anstoss      „Anstoß liegt vor“ (A2–A4): Art, Anlass-Kennung,
--                            Zeitpunkt, Antwort einer Person.
--   bezugsbasis_aenderung    Protokoll, nur lesen und anhängen (A4, F5).
--
-- Die Grundlage ist wie der Berichtsstand ein kanonischer TEXT (kein JSONB: das
-- würde Schlüssel umsortieren und die Prüfsumme brechen); die Prüfsumme hält die
-- Datenbank selbst gegen den Text (bericht_pruefsumme, V20260915050000).
--
-- Eine Fassung außerhalb des Entwurfs ist eingefroren (Invariante 3): der
-- Trigger bezugsbasis_fassung_eingefroren lässt nur Freigabe-Entscheid und Ende
-- zu. Kein DELETE für die App-Rolle; nur das Mandanten-Offboarding löscht.
--
-- Die Vokabulare stehen EINMAL in bezugsbasis_vokabular(); ein späteres Paket
-- weitet sie mit CREATE OR REPLACE, ohne einen CHECK anzufassen (nie enger).
--
-- Nicht dieses Paket: Leser, Grundlage bilden (IP-7), Routen/Rechte-Prüfung
-- (IP-8), Modelle (IP-10), Anstoß-Schreiber (IP-15), Faktor-Vorschlag (IP-16).
-- =============================================================================

-- Die Vokabulare von `bezugsbasis-vectors.json` (IP-2); `nr` ist die Stelle im Vertrag.
-- `freigabe_status` ist die Vereinigung: der Vertrag nennt beantragt · freigegeben ·
-- abgelehnt, die Tabelle hält zusätzlich den Entwurf (F1 „entsteht als Entwurf“,
-- `basis_zustand` entwurf). `anstoss_art`, `anstoss_antwort`, `protokoll` sind Wörter
-- der Tabellen, die der Vertrag (noch) nicht nennt (A2–A4, IP-15).
CREATE OR REPLACE FUNCTION bezugsbasis_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('methode', 1, 'verhaeltnis'),
    ('methode', 2, 'regression_eine_variable'),
    ('methode', 3, 'regression_zwei_variablen'),
    ('methode', 4, 'gradtage'),
    ('freigabe_status', 1, 'entwurf'),
    ('freigabe_status', 2, 'beantragt'),
    ('freigabe_status', 3, 'freigegeben'),
    ('freigabe_status', 4, 'abgelehnt'),
    ('datenlage', 1, 'vollstaendig'),
    ('datenlage', 2, 'vorlaeufig'),
    ('anpassungsgrund', 1, 'referenzperiode_vervollstaendigt'),
    ('anpassungsgrund', 2, 'grundlage_korrigiert'),
    ('anpassungsgrund', 3, 'struktur_geaendert'),
    ('anpassungsgrund', 4, 'variable_geaendert'),
    ('anpassungsgrund', 5, 'methode_geaendert'),
    ('anpassungsgrund', 6, 'nicht_mehr_anwendbar'),
    ('anpassungsgrund', 7, 'sonstiger'),
    ('urteil', 1, 'besser'),
    ('urteil', 2, 'schlechter'),
    ('urteil', 3, 'im_rahmen'),
    ('urteil', 4, 'ohne_urteil'),
    ('urteil', 5, 'nicht_anwendbar'),
    ('grund', 1, 'basis_fehlt'),
    ('grund', 2, 'basis_beendet'),
    ('grund', 3, 'zu_wenig_perioden'),
    ('grund', 4, 'variable_fehlt'),
    ('grund', 5, 'variable_ausserhalb'),
    ('grund', 6, 'variablen_abhaengig'),
    ('grund', 7, 'keine_werte'),
    ('grund', 8, 'periode_nicht_zu_ende'),
    ('faktor_art', 1, 'flaeche'),
    ('faktor_art', 2, 'standort'),
    ('faktor_art', 3, 'anlage'),
    ('faktor_art', 4, 'prozess'),
    ('faktor_art', 5, 'kostenstelle'),
    ('faktor_art', 6, 'wortlaut'),
    ('anstoss_art', 1, 'grundlage_korrigiert'),
    ('anstoss_art', 2, 'struktur_geaendert'),
    ('anstoss_art', 3, 'variable_geaendert'),
    ('anstoss_art', 4, 'nicht_mehr_anwendbar'),
    ('anstoss_antwort', 1, 'neue_fassung'),
    ('anstoss_antwort', 2, 'beendet'),
    ('anstoss_antwort', 3, 'bleibt'),
    ('protokoll', 1, 'bezugsbasis_angelegt'),
    ('protokoll', 2, 'bezugsbasis_geaendert'),
    ('protokoll', 3, 'verantwortlicher_geaendert'),
    ('protokoll', 4, 'fassung_entworfen'),
    ('protokoll', 5, 'fassung_beantragt'),
    ('protokoll', 6, 'fassung_freigegeben'),
    ('protokoll', 7, 'fassung_abgelehnt'),
    ('protokoll', 8, 'fassung_beendet'),
    ('protokoll', 9, 'variable_abgelehnt'),
    ('protokoll', 10, 'anstoss_beantwortet'),
    ('protokoll', 11, 'gueltig_bleibt'),
    ('protokoll', 12, 'bezugsbasis_beendet')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION bezugsbasis_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.bezugsbasis_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- Die vier Vokabular-Funktionen, die §6.1 beim Namen nennt.
CREATE OR REPLACE FUNCTION bezugsbasis_methode() RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT wort FROM public.bezugsbasis_vokabular() WHERE vokabular = 'methode' ORDER BY nr
$$;
CREATE OR REPLACE FUNCTION bezugsbasis_anpassungsgrund() RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT wort FROM public.bezugsbasis_vokabular() WHERE vokabular = 'anpassungsgrund' ORDER BY nr
$$;
CREATE OR REPLACE FUNCTION bezugsbasis_urteil() RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT wort FROM public.bezugsbasis_vokabular() WHERE vokabular = 'urteil' ORDER BY nr
$$;
CREATE OR REPLACE FUNCTION bezugsbasis_grund() RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT wort FROM public.bezugsbasis_vokabular() WHERE vokabular = 'grund' ORDER BY nr
$$;

-- Liegt jedes Wort der Liste im Vokabular? Leere Liste ja, NULL-Eintrag nie.
CREATE OR REPLACE FUNCTION bezugsbasis_worte(p_vokabular TEXT, p_worte TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_worte IS NOT NULL AND pg_catalog.array_position(p_worte, NULL) IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p_worte) w
                     WHERE NOT public.bezugsbasis_wort(p_vokabular, w))
$$;

-- -----------------------------------------------------------------------------
-- Kennzeichen BB-0001 … je Kundenbereich (Format wie KZ-0001), atomarer Zähler
-- nach dem Muster energieeinsatz_kennzeichen_seq; ein explizites Kennzeichen
-- rückt ihn vor.
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_kennzeichen_seq (
    tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
    zaehler BIGINT NOT NULL CHECK (zaehler > 0)
);

CREATE TABLE bezugsbasis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    kennzahl_id UUID NOT NULL,
    zweck TEXT,
    -- B4: Vorgabe ist der Verantwortliche der Kennzahl; `benutzer` + Schnappschuss.
    verantwortlich_sub TEXT,
    verantwortlich_name TEXT NOT NULL,
    verantwortlich_konto TEXT,
    -- F4: beendet (letzter Tag, wann, warum), nie gelöscht.
    beendet_zum DATE,
    beendet_am TIMESTAMPTZ,
    beendet_grund TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsbasis_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT bezugsbasis_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    CONSTRAINT bezugsbasis_kennzeichen_chk CHECK (kennzeichen ~ '^BB-[0-9]{4,13}$' AND kennzeichen <> 'BB-0000'),
    CONSTRAINT bezugsbasis_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_zweck_chk CHECK (zweck IS NULL OR btrim(zweck) <> ''),
    CONSTRAINT bezugsbasis_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND (verantwortlich_sub IS NULL OR (btrim(verantwortlich_sub) <> '' AND verantwortlich_konto IS NOT NULL))
        AND (verantwortlich_konto IS NULL OR btrim(verantwortlich_konto) <> '')),
    CONSTRAINT bezugsbasis_beendet_chk CHECK (
        (beendet_zum IS NULL) = (beendet_am IS NULL)
        AND (beendet_am IS NULL) = (beendet_grund IS NULL)
        AND (beendet_grund IS NULL OR btrim(beendet_grund) <> '')),
    CONSTRAINT bezugsbasis_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsbasis_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsbasis_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- B1: je Kennzahl höchstens EINE laufende Bezugsbasis.
CREATE UNIQUE INDEX bezugsbasis_eine_laufende_uq ON bezugsbasis (tenant_id, kennzahl_id) WHERE beendet_am IS NULL;

CREATE FUNCTION bezugsbasis_kennzeichen_setzen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nummer BIGINT;
BEGIN
    IF NEW.kennzeichen IS NULL THEN
        INSERT INTO bezugsbasis_kennzeichen_seq (tenant_id, zaehler) VALUES (NEW.tenant_id, 1)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = bezugsbasis_kennzeichen_seq.zaehler + 1
            RETURNING zaehler INTO nummer;
        NEW.kennzeichen := 'BB-' || lpad(nummer::text, 4, '0');
    ELSIF NEW.kennzeichen ~ '^BB-[0-9]{4,13}$' AND NEW.kennzeichen <> 'BB-0000' THEN
        INSERT INTO bezugsbasis_kennzeichen_seq (tenant_id, zaehler)
            VALUES (NEW.tenant_id, substring(NEW.kennzeichen FROM 4)::bigint)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = greatest(
                bezugsbasis_kennzeichen_seq.zaehler, EXCLUDED.zaehler);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugsbasis_kennzeichen_setzen BEFORE INSERT ON bezugsbasis
    FOR EACH ROW EXECUTE FUNCTION bezugsbasis_kennzeichen_setzen();
CREATE TRIGGER bezugsbasis_kennzeichen_seq_rueckt_vor BEFORE UPDATE ON bezugsbasis_kennzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION messstelle_kennzeichen_seq_rueckt_vor();

-- -----------------------------------------------------------------------------
-- bezugsbasis_fassung (B4, P1–P4, F1–F5, A1, M4).
--
-- freigabe_status: `entwurf` (F1 „entsteht als Entwurf mit Vorschau“) ·
-- `beantragt` (F2, Vier-Augen offen) · `freigegeben` · `abgelehnt` (Vier-Augen).
-- Die Freigabe-Person (freigabe_*) gibt frei bzw. beantragt; bei Vier-Augen
-- entscheidet eine ZWEITE Person (entscheidung_*) mit Rolle KA oder EM.
-- Jede Fassung außerhalb des Entwurfs trägt eine Begründung von 10–500 Zeichen
-- (F1, auch Fassung 1); Fassung n + 1 nennt einen oder mehrere
-- Anpassungsgründe, `sonstiger` mit Wortlaut (A1, F4).
-- gilt_bis ist der letzte eingeschlossene Tag; eine Nachfolgerin mit demselben
-- gilt_ab ersetzt die Fassung ganz (gilt_bis = gilt_ab − 1).
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_fassung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    bezugsbasis_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    referenzperiode TEXT NOT NULL,
    methode TEXT NOT NULL,
    datenlage TEXT NOT NULL,
    gilt_ab DATE NOT NULL,
    gilt_bis DATE,
    beendet_am TIMESTAMPTZ,
    beendet_grund TEXT,
    toleranz_prozent NUMERIC NOT NULL DEFAULT 2.0,
    wiedervorlage_monate INTEGER NOT NULL DEFAULT 12,
    anpassungsgruende TEXT[] NOT NULL DEFAULT '{}',
    anpassung_wortlaut TEXT,
    begruendung TEXT,
    -- F3/M4: eingefroren, kanonischer Text + SHA-256 (Muster Berichtsstand).
    grundlage TEXT,
    pruefsumme TEXT,
    basiswert NUMERIC,
    koeffizienten JSONB,
    r2 NUMERIC,
    streuung_prozent NUMERIC,
    -- Wer die Fassung gebildet hat (Entwurf).
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    -- F1/F2: Freigabe bzw. Antrag.
    vieraugen BOOLEAN NOT NULL DEFAULT false,
    freigabe_status TEXT NOT NULL DEFAULT 'entwurf',
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
    -- F5: Beginn der Wiedervorlage (freigegeben_am + wiedervorlage_monate).
    freigegeben_am TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsbasis_fassung_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT bezugsbasis_fassung_nummer_uq UNIQUE (tenant_id, bezugsbasis_id, fassung),
    CONSTRAINT bezugsbasis_fassung_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    -- P1: ganze Kalendermonate JJJJ-MM/JJJJ-MM (Format der Datengrundlage), Anfang ≤ Ende.
    CONSTRAINT bezugsbasis_fassung_referenzperiode_chk CHECK (
        referenzperiode ~ '^[0-9]{4}-(0[1-9]|1[0-2])/[0-9]{4}-(0[1-9]|1[0-2])$'
        AND substring(referenzperiode FROM 1 FOR 7) <= substring(referenzperiode FROM 9 FOR 7)),
    CONSTRAINT bezugsbasis_fassung_methode_chk CHECK (coalesce(bezugsbasis_wort('methode', methode), false)),
    CONSTRAINT bezugsbasis_fassung_datenlage_chk CHECK (coalesce(bezugsbasis_wort('datenlage', datenlage), false)),
    CONSTRAINT bezugsbasis_fassung_status_chk CHECK (coalesce(bezugsbasis_wort('freigabe_status', freigabe_status), false)),
    CONSTRAINT bezugsbasis_fassung_toleranz_chk CHECK (toleranz_prozent > 0 AND toleranz_prozent < 100),
    CONSTRAINT bezugsbasis_fassung_wiedervorlage_chk CHECK (wiedervorlage_monate > 0),
    CONSTRAINT bezugsbasis_fassung_ende_chk CHECK (
        (gilt_bis IS NULL) = (beendet_am IS NULL)
        AND (beendet_am IS NULL) = (beendet_grund IS NULL)
        AND (beendet_grund IS NULL OR btrim(beendet_grund) <> '')
        AND (gilt_bis IS NULL OR (gilt_bis >= gilt_ab - 1 AND freigabe_status = 'freigegeben'))),
    -- A1/F4: geschlossene Liste; Fassung 1 ohne, Fassung n + 1 außerhalb des Entwurfs mit mindestens einem Grund.
    CONSTRAINT bezugsbasis_fassung_anpassungsgruende_chk CHECK (
        coalesce(bezugsbasis_worte('anpassungsgrund', anpassungsgruende), false)
        AND (fassung > 1 OR cardinality(anpassungsgruende) = 0)
        AND (fassung = 1 OR freigabe_status = 'entwurf' OR cardinality(anpassungsgruende) > 0)),
    CONSTRAINT bezugsbasis_fassung_anpassung_wortlaut_chk CHECK (
        CASE WHEN 'sonstiger' = ANY (anpassungsgruende)
             THEN coalesce(btrim(anpassung_wortlaut) <> '', false)
             ELSE anpassung_wortlaut IS NULL END),
    -- F1: ohne Begründung (10–500 Zeichen) keine Fassung außerhalb des Entwurfs.
    CONSTRAINT bezugsbasis_fassung_begruendung_chk CHECK (
        (begruendung IS NULL OR char_length(btrim(begruendung)) BETWEEN 10 AND 500)
        AND (freigabe_status = 'entwurf' OR begruendung IS NOT NULL)),
    CONSTRAINT bezugsbasis_fassung_grundlage_chk CHECK (
        (grundlage IS NULL) = (pruefsumme IS NULL)
        AND (grundlage IS NULL OR (jsonb_typeof(grundlage::jsonb) IN ('object', 'array')
             AND pruefsumme = bericht_pruefsumme(grundlage)))),
    CONSTRAINT bezugsbasis_fassung_koeffizienten_chk CHECK (koeffizienten IS NULL OR jsonb_typeof(koeffizienten) = 'object'),
    CONSTRAINT bezugsbasis_fassung_guete_chk CHECK ((r2 IS NULL OR (r2 >= 0 AND r2 <= 1))
        AND (streuung_prozent IS NULL OR streuung_prozent >= 0)),
    CONSTRAINT bezugsbasis_fassung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsbasis_fassung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsbasis_fassung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    -- F1: Freigabe-Person genau außerhalb des Entwurfs.
    CONSTRAINT bezugsbasis_fassung_freigabe_chk CHECK (coalesce(CASE WHEN freigabe_status = 'entwurf' THEN
            freigabe_sub IS NULL AND freigabe_name IS NULL AND freigabe_rolle IS NULL
            AND freigabe_art IS NULL AND freigabe_am IS NULL
        ELSE btrim(freigabe_name) <> '' AND freigabe_am IS NOT NULL
            AND freigabe_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (freigabe_rolle IS NULL OR freigabe_rolle IN ('kundenadministrator', 'energiemanager', 'voltpilot_betrieb'))
            AND (btrim(freigabe_sub) <> '' OR (freigabe_sub IS NULL AND freigabe_art = 'voltpilot')) END, false)),
    CONSTRAINT bezugsbasis_fassung_freigegeben_am_chk CHECK ((freigabe_status = 'freigegeben') = (freigegeben_am IS NOT NULL)),
    -- F2 (Muster bewertung_kriterien_fassung): ohne Vier-Augen weder beantragt noch abgelehnt;
    -- die zweite Person ist nie die Freigabe-Person und hat Rolle KA oder EM.
    CONSTRAINT bezugsbasis_fassung_vieraugen_chk CHECK (vieraugen OR freigabe_status IN ('entwurf', 'freigegeben')),
    CONSTRAINT bezugsbasis_fassung_entscheidung_chk CHECK (coalesce(
        CASE WHEN vieraugen AND freigabe_status IN ('freigegeben', 'abgelehnt') THEN
            entscheidung_sub <> freigabe_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager') AND entschieden_am IS NOT NULL
        ELSE entscheidung_sub IS NULL AND entscheidung_name IS NULL AND entscheidung_rolle IS NULL
            AND entscheidung_art IS NULL AND entschieden_am IS NULL END, false)),
    CONSTRAINT bezugsbasis_fassung_ablehnung_chk CHECK (
        (freigabe_status = 'abgelehnt') = coalesce(btrim(entscheidungs_begruendung) <> '', false))
);
-- Höchstens ein offener Entwurf bzw. Antrag je Bezugsbasis.
CREATE UNIQUE INDEX bezugsbasis_fassung_offen_uq ON bezugsbasis_fassung (tenant_id, bezugsbasis_id)
    WHERE freigabe_status IN ('entwurf', 'beantragt');

-- Invariante 3: außerhalb des Entwurfs ändern sich nur Freigabe-Entscheid und Ende;
-- freigegeben und abgelehnt kehren nie zurück, das Ende wird nie zurückgenommen.
CREATE FUNCTION bezugsbasis_fassung_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.bezugsbasis_id <> OLD.bezugsbasis_id
        OR NEW.fassung <> OLD.fassung THEN
        RAISE EXCEPTION 'Die Identität einer Bezugsbasis-Fassung ist nie änderbar' USING ERRCODE = '23514';
    END IF;
    IF OLD.freigabe_status = 'entwurf' THEN
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['freigabe_status', 'entscheidung_sub', 'entscheidung_name', 'entscheidung_rolle',
            'entscheidung_art', 'entschieden_am', 'entscheidungs_begruendung', 'freigegeben_am',
            'gilt_bis', 'beendet_am', 'beendet_grund'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['freigabe_status', 'entscheidung_sub', 'entscheidung_name',
            'entscheidung_rolle', 'entscheidung_art', 'entschieden_am', 'entscheidungs_begruendung',
            'freigegeben_am', 'gilt_bis', 'beendet_am', 'beendet_grund']) THEN
        RAISE EXCEPTION 'Die Bezugsbasis-Fassung % ist eingefroren', OLD.fassung USING ERRCODE = '23514';
    END IF;
    IF OLD.freigabe_status IN ('freigegeben', 'abgelehnt') AND (NEW.freigabe_status <> OLD.freigabe_status
        OR NEW.entscheidung_sub IS DISTINCT FROM OLD.entscheidung_sub
        OR NEW.entschieden_am IS DISTINCT FROM OLD.entschieden_am
        OR NEW.entscheidungs_begruendung IS DISTINCT FROM OLD.entscheidungs_begruendung
        OR NEW.freigegeben_am IS DISTINCT FROM OLD.freigegeben_am) THEN
        RAISE EXCEPTION 'Die Freigabe der Bezugsbasis-Fassung % ist entschieden', OLD.fassung USING ERRCODE = '23514';
    END IF;
    IF OLD.gilt_bis IS NOT NULL AND (NEW.gilt_bis IS DISTINCT FROM OLD.gilt_bis
        OR NEW.beendet_am IS DISTINCT FROM OLD.beendet_am OR NEW.beendet_grund IS DISTINCT FROM OLD.beendet_grund) THEN
        RAISE EXCEPTION 'Die Bezugsbasis-Fassung % ist beendet', OLD.fassung USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugsbasis_fassung_eingefroren BEFORE UPDATE ON bezugsbasis_fassung
    FOR EACH ROW EXECUTE FUNCTION bezugsbasis_fassung_eingefroren();

-- -----------------------------------------------------------------------------
-- bezugsbasis_variable (V1, V2, V5): Position 1 = der Nenner der Kennzahl,
-- höchstens zwei; die Bezugsgröße mit ihrer Fassung zum Freigabetag, die
-- Spannweite der Referenzperiode (M2, G3). Ein Entwurf hebt eine Zeile auf,
-- eine Fassung außerhalb des Entwurfs nie.
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_variable (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    fassung_id UUID NOT NULL,
    position INTEGER NOT NULL CHECK (position IN (1, 2)),
    bezugsgroesse_id UUID NOT NULL,
    bezugsgroesse_fassung INTEGER CHECK (bezugsgroesse_fassung IS NULL OR bezugsgroesse_fassung > 0),
    spannweite_von NUMERIC,
    spannweite_bis NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aufgehoben_am TIMESTAMPTZ,
    CONSTRAINT bezugsbasis_variable_fassung_fk FOREIGN KEY (fassung_id, tenant_id)
        REFERENCES bezugsbasis_fassung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_variable_bezug_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_variable_spannweite_chk CHECK (
        (spannweite_von IS NULL) = (spannweite_bis IS NULL)
        AND (spannweite_von IS NULL OR spannweite_von <= spannweite_bis))
);
CREATE UNIQUE INDEX bezugsbasis_variable_position_uq
    ON bezugsbasis_variable (tenant_id, fassung_id, position) WHERE aufgehoben_am IS NULL;
CREATE UNIQUE INDEX bezugsbasis_variable_bezug_uq
    ON bezugsbasis_variable (tenant_id, fassung_id, bezugsgroesse_id) WHERE aufgehoben_am IS NULL;

-- -----------------------------------------------------------------------------
-- bezugsbasis_faktor (V3, E6): Verweis auf ein zeitgültiges Objekt (flaeche →
-- Ort mit Flächen-Gültigkeit, standort, anlage, prozess, kostenstelle) ODER
-- Wortlaut; der Wert zum Freigabetag als Kopie. Der Verweis wird nur beim
-- Anlegen geprüft (Muster bewertung_umfang_ausschluss): kein Fremdschlüssel,
-- darum hält ein Faktor keinen bestehenden Löschweg auf.
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_faktor (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    fassung_id UUID NOT NULL,
    position INTEGER NOT NULL CHECK (position > 0),
    art TEXT NOT NULL,
    verweis UUID,
    wortlaut TEXT,
    wert NUMERIC,
    einheit TEXT,
    wert_gueltig_ab DATE,
    kopie_am DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aufgehoben_am TIMESTAMPTZ,
    CONSTRAINT bezugsbasis_faktor_fassung_fk FOREIGN KEY (fassung_id, tenant_id)
        REFERENCES bezugsbasis_fassung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_faktor_art_chk CHECK (coalesce(bezugsbasis_wort('faktor_art', art), false)),
    CONSTRAINT bezugsbasis_faktor_genau_eins_chk CHECK (CASE WHEN art = 'wortlaut'
        THEN verweis IS NULL AND coalesce(btrim(wortlaut) <> '', false)
        ELSE verweis IS NOT NULL AND wortlaut IS NULL END),
    CONSTRAINT bezugsbasis_faktor_einheit_chk CHECK (einheit IS NULL OR (wert IS NOT NULL AND btrim(einheit) <> ''))
);
CREATE UNIQUE INDEX bezugsbasis_faktor_position_uq
    ON bezugsbasis_faktor (tenant_id, fassung_id, position) WHERE aufgehoben_am IS NULL;

-- Unbekannte Arten und die Form (Verweis oder Wortlaut) prüfen die CHECKs.
CREATE FUNCTION bezugsbasis_faktor_verweis_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.verweis IS NOT NULL AND NEW.art IN ('flaeche', 'standort', 'anlage', 'prozess', 'kostenstelle') AND NOT (CASE NEW.art
            WHEN 'flaeche' THEN EXISTS (SELECT 1 FROM ort o WHERE o.id = NEW.verweis AND o.tenant_id = NEW.tenant_id)
            WHEN 'standort' THEN EXISTS (SELECT 1 FROM standort s WHERE s.id = NEW.verweis AND s.tenant_id = NEW.tenant_id)
            WHEN 'anlage' THEN EXISTS (SELECT 1 FROM site s WHERE s.id = NEW.verweis AND s.tenant_id = NEW.tenant_id)
            WHEN 'prozess' THEN EXISTS (SELECT 1 FROM prozess p WHERE p.id = NEW.verweis AND p.tenant_id = NEW.tenant_id)
            WHEN 'kostenstelle' THEN EXISTS (SELECT 1 FROM kostenstelle k
                WHERE k.id = NEW.verweis AND k.tenant_id = NEW.tenant_id)
            ELSE false END) THEN
        RAISE EXCEPTION 'Unbekannter Faktor-Verweis' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugsbasis_faktor_verweis_pruefen BEFORE INSERT ON bezugsbasis_faktor
    FOR EACH ROW EXECUTE FUNCTION bezugsbasis_faktor_verweis_pruefen();

-- Variablen und Faktoren einer Fassung außerhalb des Entwurfs bleiben stehen.
CREATE FUNCTION bezugsbasis_teil_nur_im_entwurf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - 'aufgehoben_am') IS DISTINCT FROM (to_jsonb(OLD) - 'aufgehoben_am')
        OR OLD.aufgehoben_am IS NOT NULL
        OR EXISTS (SELECT 1 FROM bezugsbasis_fassung f WHERE f.id = OLD.fassung_id AND f.tenant_id = OLD.tenant_id
                   AND f.freigabe_status <> 'entwurf') THEN
        RAISE EXCEPTION 'Variablen und Faktoren einer Bezugsbasis-Fassung ändern sich nur im Entwurf'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugsbasis_variable_nur_im_entwurf BEFORE UPDATE ON bezugsbasis_variable
    FOR EACH ROW EXECUTE FUNCTION bezugsbasis_teil_nur_im_entwurf();
CREATE TRIGGER bezugsbasis_faktor_nur_im_entwurf BEFORE UPDATE ON bezugsbasis_faktor
    FOR EACH ROW EXECUTE FUNCTION bezugsbasis_teil_nur_im_entwurf();

-- -----------------------------------------------------------------------------
-- bezugsbasis_anstoss (A2–A4): ein Zustand an einer Fassung, kein Umbau. Pfad 1
-- = Kaskade (neue Version eines Werts der Grundlage), Pfad 2 = Struktur-Läufer.
-- Je Fassung, Art und Anlass-Kennung genau einmal (ein Läufer schreibt
-- wiederholbar); eine Person antwortet mit neuer Fassung, Ende oder „bleibt“.
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_anstoss (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    fassung_id UUID NOT NULL,
    pfad SMALLINT NOT NULL CHECK (pfad IN (1, 2)),
    art TEXT NOT NULL,
    anlass_kennung TEXT NOT NULL CHECK (btrim(anlass_kennung) <> ''),
    anlass TEXT CHECK (anlass IS NULL OR btrim(anlass) <> ''),
    angestossen_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    antwort TEXT,
    antwort_begruendung TEXT,
    beantwortet_am TIMESTAMPTZ,
    beantwortet_sub TEXT,
    beantwortet_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsbasis_anstoss_fassung_fk FOREIGN KEY (fassung_id, tenant_id)
        REFERENCES bezugsbasis_fassung(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_anstoss_einmal_uq UNIQUE (tenant_id, fassung_id, art, anlass_kennung),
    CONSTRAINT bezugsbasis_anstoss_art_chk CHECK (coalesce(bezugsbasis_wort('anstoss_art', art), false)),
    CONSTRAINT bezugsbasis_anstoss_antwort_chk CHECK (coalesce(CASE WHEN antwort IS NULL THEN
            antwort_begruendung IS NULL AND beantwortet_am IS NULL AND beantwortet_sub IS NULL AND beantwortet_name IS NULL
        ELSE bezugsbasis_wort('anstoss_antwort', antwort) AND beantwortet_am IS NOT NULL
            AND btrim(beantwortet_name) <> '' AND (beantwortet_sub IS NULL OR btrim(beantwortet_sub) <> '')
            AND (antwort <> 'bleibt' OR char_length(btrim(antwort_begruendung)) BETWEEN 10 AND 500) END, false))
);
CREATE INDEX bezugsbasis_anstoss_offen_idx ON bezugsbasis_anstoss (tenant_id, fassung_id) WHERE antwort IS NULL;

-- -----------------------------------------------------------------------------
-- bezugsbasis_aenderung: Protokoll, nur lesen und anhängen (A4, F5, G4).
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsbasis_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    bezugsbasis_id UUID NOT NULL,
    fassung INTEGER CHECK (fassung IS NULL OR fassung > 0),
    art TEXT NOT NULL,
    alt JSONB,
    neu JSONB,
    begruendung TEXT CHECK (begruendung IS NULL OR btrim(begruendung) <> ''),
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsbasis_aenderung_basis_fk FOREIGN KEY (bezugsbasis_id, tenant_id)
        REFERENCES bezugsbasis(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsbasis_aenderung_art_chk CHECK (coalesce(bezugsbasis_wort('protokoll', art), false)),
    CONSTRAINT bezugsbasis_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsbasis_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsbasis_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX bezugsbasis_aenderung_basis_idx ON bezugsbasis_aenderung (tenant_id, bezugsbasis_id, created_at, id);

-- -----------------------------------------------------------------------------
-- RLS + FORCE, Grants: die App-Rolle liest und legt an, ändert nur benannte
-- Spalten und löscht nie; nur das administrative Offboarding löscht.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsbasis_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_kennzeichen_seq FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_kennzeichen_seq_tenant_isolation ON bezugsbasis_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_tenant_isolation ON bezugsbasis
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_fassung FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_fassung_tenant_isolation ON bezugsbasis_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis_variable ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_variable FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_variable_tenant_isolation ON bezugsbasis_variable
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis_faktor ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_faktor FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_faktor_tenant_isolation ON bezugsbasis_faktor
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis_anstoss ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_anstoss FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_anstoss_tenant_isolation ON bezugsbasis_anstoss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE bezugsbasis_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsbasis_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsbasis_aenderung_tenant_isolation ON bezugsbasis_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON bezugsbasis_kennzeichen_seq, bezugsbasis, bezugsbasis_fassung, bezugsbasis_variable,
    bezugsbasis_faktor, bezugsbasis_anstoss, bezugsbasis_aenderung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bezugsbasis_kennzeichen_seq, bezugsbasis, bezugsbasis_fassung, bezugsbasis_variable,
    bezugsbasis_faktor, bezugsbasis_anstoss, bezugsbasis_aenderung TO ${appDbUser};
GRANT UPDATE (zaehler) ON bezugsbasis_kennzeichen_seq TO ${appDbUser};
GRANT UPDATE (zweck, verantwortlich_sub, verantwortlich_name, verantwortlich_konto,
    beendet_zum, beendet_am, beendet_grund) ON bezugsbasis TO ${appDbUser};
GRANT UPDATE (referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund,
    toleranz_prozent, wiedervorlage_monate, anpassungsgruende, anpassung_wortlaut, begruendung,
    grundlage, pruefsumme, basiswert, koeffizienten, r2, streuung_prozent, vieraugen, freigabe_status,
    freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, entscheidung_sub,
    entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am, entscheidungs_begruendung,
    freigegeben_am) ON bezugsbasis_fassung TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON bezugsbasis_variable, bezugsbasis_faktor TO ${appDbUser};
GRANT UPDATE (antwort, antwort_begruendung, beantwortet_am, beantwortet_sub, beantwortet_name)
    ON bezugsbasis_anstoss TO ${appDbUser};
-- Nur das administrative Mandanten-Offboarding löscht: Teile vor Fassung, Fassung vor Basis,
-- Basis vor Kennzahl und Benutzer (TenantRepository.offboard).
GRANT SELECT, DELETE ON bezugsbasis_kennzeichen_seq, bezugsbasis, bezugsbasis_fassung, bezugsbasis_variable,
    bezugsbasis_faktor, bezugsbasis_anstoss, bezugsbasis_aenderung TO ${adminDbUser};
REVOKE ALL ON SEQUENCE bezugsbasis_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE bezugsbasis_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};

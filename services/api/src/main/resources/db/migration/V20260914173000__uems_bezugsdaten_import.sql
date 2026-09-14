-- =============================================================================
-- UEMS AP-09 IP-12: die Tabellen eines Imports — `bezugsdaten_import` und
-- `bezugsdaten_import_zeile` (append-only) und `bezugsdaten_vorlage` (Fassungen).
--
-- ⚠ DIE VORSCHAU SCHREIBT KEINE ZEILE. `POST /api/v1/bezugsdaten/importe/vorschau`
-- LIEST aus diesen Tabellen (ist die Datei schon bekannt? — `datei_bekannt`) und
-- aus `bezugsgroesse_wert` (ist der Schlüssel belegt?), in einer Nur-Lese-
-- Transaktion. Geschrieben wird hier erst mit der Übernahme (IP-13) und den
-- Vorlagen (IP-14). Darum ist `vorschau` zwar ein Wort des Vokabulars
-- `import_status` (so heißt der Stand, den die Vorschau ANZEIGT), aber
-- `bezugsdaten_import_status_chk` lehnt es für jede gespeicherte Zeile ab: ein
-- gespeicherter Import ist nie eine Vorschau.
--
-- ⚠ DIE DATEI SELBST WIRD NIE GESPEICHERT (E14). Es gibt keine Spalte für ihren
-- Inhalt: aufbewahrt werden der Fingerabdruck (SHA-256 der Bytes, C2/E8), die
-- Metadaten (Name, Größe, Kodierung, Trennzeichen, Kopfzeile) und je Zeile ihr
-- Urteil mit Befunden, ihr FACHLICHER Schlüssel (Bezugsgröße + Periode bzw.
-- Zeitpunkt) samt Betrag und Zeilen-Fingerabdruck — und der Zeilentext, der nach
-- zwei Jahren entfernt wird (`bezugsdaten_zeilentext_frist()`). Urteil, Schlüssel
-- und Fingerabdruck bleiben: ein späterer Import erkennt seine Dublette weiter.
--
-- Die Tabellen:
--   * `bezugsdaten_vorlage` — eine Zuordnung (C3/C9) als FASSUNGEN: `vorlage_id`
--     ist die Vorlage, `fassung` 1, 2, … lückenlos; eine Änderung ist die nächste
--     Fassung, nie ein UPDATE (ein Import nennt die benutzte Fassung).
--   * `bezugsdaten_import` — ein Import als FASSUNGEN (Muster
--     `messreihe_korrektur`, V20260913190000): Fassung 1 legt ihn an und trägt
--     alles (Datei-Metadaten, Vorlage, Zähler, Urheber); jede weitere trägt NUR
--     Status, Begründung und Urheber (C7 Rücknahme: `zurueckgenommen`). Der
--     heutige Status ist der der höchsten Fassung.
--   * `bezugsdaten_import_zeile` — je Datenzeile der Datei EINE Zeile an Fassung 1
--     des Imports: `nr` (Zeile der Datei), Urteil (C5), Befunde (C8), Schlüssel,
--     Betrag in der Einheit der Bezugsgröße, geliefert Wert/Einheit, Fingerabdruck.
--
-- Die Vokabulare kommen aus bezugsdaten_vokabular() — der EINEN Stelle. Diese
-- Migration ersetzt die Funktion (der aktuelle Stand aus V20260913104500
-- abgeschrieben) und ergänzt die Listen, die diese Tabellen speichern:
-- `vokabulare.import_status|zeilen_urteil|befunde` und aus dem Block `csv` die
-- `kodierungen` und `trennzeichen` der Vektor-Datei, in ihrer Reihenfolge.
-- UemsBezugsgroesseMigrationTest vergleicht die Funktion Zeile für Zeile.
--
-- ⚠ ZWEI JAHRE ZEILENTEXT (E14). Der Append-only-Trigger der Zeilen lässt GENAU
-- zwei Übergänge durch, beide ein Vergessen: den Zeilentext entfernen, sobald die
-- Zeile älter als die Frist ist (`text` → NULL, `text_entfernt_am` gesetzt; nur die
-- Verwaltungsrolle hat das Spaltenrecht, der tägliche Lauf
-- `ZeilentextAufbewahrung` benutzt es), und den Grabstein einer gelöschten
-- Bezugsgröße (`ON DELETE SET NULL (bezugsgroesse_id)`, Muster des
-- Kennzeichen-Verlaufs, V20260913120000). Alles andere scheitert — auch für die
-- Rolle mit Recht.
--
-- Nicht dieses Paket: Übernahme, Konflikt-Entscheidung, Kennungsvergabe
-- I-JJJJ-NNNN, Rücknahme (IP-13); Vorlagen-Routen (IP-14); Portal (IP-15/16);
-- Rechte-Durchsetzung (AP-03).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags — neue Fassung der Funktion (siehe Kopf).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bezugsdaten_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT, groesse TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('wertart', 1, 'periodenwert', NULL),
    ('wertart', 2, 'stand', NULL),
    ('wertart', 3, 'stammdatum', NULL),
    ('geltung_art', 1, 'unternehmen', NULL),
    ('geltung_art', 2, 'standort', NULL),
    ('geltung_art', 3, 'gebaeude', NULL),
    ('geltung_art', 4, 'bereich', NULL),
    ('geltung_art', 5, 'prozess', NULL),
    ('geltung_art', 6, 'kostenstelle', NULL),
    ('geltung_art', 7, 'messstelle', NULL),
    ('periode_art', 1, 'tag', NULL),
    ('periode_art', 2, 'woche', NULL),
    ('periode_art', 3, 'monat', NULL),
    ('periode_art', 4, 'jahr', NULL),
    ('herkunft_art', 1, 'eingabe', NULL),
    ('herkunft_art', 2, 'import', NULL),
    ('herkunft_art', 3, 'messkanal', NULL),
    ('herkunft_art', 4, 'stammdatum_ap02', NULL),
    ('vorgang', 1, 'erstwert', NULL),
    ('vorgang', 2, 'berichtigung', NULL),
    ('vorgang', 3, 'ruecknahme', NULL),
    ('status', 1, 'wirksam', NULL),
    ('status', 2, 'vorschlag', NULL),
    ('status', 3, 'zurueckgenommen', NULL),
    ('status', 4, 'abgelehnt', NULL),
    ('import_status', 1, 'vorschau', NULL),
    ('import_status', 2, 'uebernommen', NULL),
    ('import_status', 3, 'teilweise_uebernommen', NULL),
    ('import_status', 4, 'wiederholt', NULL),
    ('import_status', 5, 'zurueckgenommen', NULL),
    ('import_status', 6, 'verworfen', NULL),
    ('zeilen_urteil', 1, 'neu', NULL),
    ('zeilen_urteil', 2, 'wiederholung', NULL),
    ('zeilen_urteil', 3, 'konflikt', NULL),
    ('zeilen_urteil', 4, 'berichtigung', NULL),
    ('zeilen_urteil', 5, 'uebersprungen', NULL),
    ('zeilen_urteil', 6, 'abgelehnt', NULL),
    ('befunde', 1, 'datei_bekannt', NULL),
    ('befunde', 2, 'zeile_bekannt', NULL),
    ('befunde', 3, 'konflikt_anderer_wert', NULL),
    ('befunde', 4, 'einheit_unbekannt', NULL),
    ('befunde', 5, 'einheit_umgerechnet', NULL),
    ('befunde', 6, 'periode_passt_nicht', NULL),
    ('befunde', 7, 'periode_nicht_zu_ende', NULL),
    ('befunde', 8, 'zeit_mehrdeutig', NULL),
    ('befunde', 9, 'zeit_nicht_vorhanden', NULL),
    ('befunde', 10, 'zahl_unlesbar', NULL),
    ('befunde', 11, 'datum_unlesbar', NULL),
    ('befunde', 12, 'bezug_unbekannt', NULL),
    ('befunde', 13, 'wert_negativ', NULL),
    ('befunde', 14, 'wert_unplausibel', NULL),
    ('befunde', 15, 'keine_datenzeilen', NULL),
    ('befunde', 16, 'datei_zu_gross', NULL),
    ('befunde', 17, 'kodierung_unlesbar', NULL),
    ('kodierung', 1, 'utf-8', NULL),
    ('kodierung', 2, 'windows-1252', NULL),
    ('trennzeichen', 1, ';', NULL),
    ('trennzeichen', 2, ',', NULL),
    ('trennzeichen', 3, E'\t', NULL),
    ('einheiten', 1, 'kg', 'masse'),
    ('einheiten', 2, 't', 'masse'),
    ('einheiten', 3, 'Stück', 'stueckzahl'),
    ('einheiten', 4, 'h', 'zeit'),
    ('einheiten', 5, 'min', 'zeit'),
    ('einheiten', 6, 'm²', 'flaeche'),
    ('einheiten', 7, 'm³', 'volumen'),
    ('einheiten', 8, 'l', 'volumen'),
    ('einheiten', 9, 'Personen', 'personen'),
    ('einheiten', 10, 'Schichten', 'schichten'),
    ('einheiten', 11, 'Kd', 'gradtage'),
    ('einheiten', 12, '°C', 'temperatur')
$$;

-- Sind alle Einträge eines JSONB-Arrays Wörter des Vokabulars `befunde`? Ein
-- leeres Array ist erlaubt (eine Zeile ohne Befund), ein Wort nie doppelt.
CREATE OR REPLACE FUNCTION bezugsdaten_befunde_gueltig(p_befunde JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_befunde) IS DISTINCT FROM 'array' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_befunde) e
                 WHERE jsonb_typeof(e) <> 'string'
                    OR NOT coalesce(public.bezugsdaten_wort('befunde', e #>> '{}'), false))
    AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(p_befunde) e) = jsonb_array_length(p_befunde)
  END
$$;

-- E14: so lange bleibt ein Zeilentext; danach entfernt ihn der tägliche Lauf.
-- EINE Stelle — der Trigger und `ZeilentextAufbewahrung` fragen beide sie.
CREATE OR REPLACE FUNCTION bezugsdaten_zeilentext_frist()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT interval '2 years'
$$;

-- -----------------------------------------------------------------------------
-- bezugsdaten_vorlage: die Zuordnung als Fassungen (C3/C9, E12).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsdaten_vorlage (
    tenant_id       UUID        NOT NULL,
    vorlage_id      UUID        NOT NULL,
    fassung         INTEGER     NOT NULL,
    name            TEXT        NOT NULL,
    -- Kodierung, Trennzeichen, Kopfzeile, Spalten, Deutung, Zahlformat, feste
    -- Einheit/Bezugsgröße — die Form der Vorschau-Zuordnung (Vertrag `vorschau_zuordnung`).
    formatregeln    JSONB       NOT NULL,
    bezug_tabelle   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    synonyme        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsdaten_vorlage_pk PRIMARY KEY (tenant_id, vorlage_id, fassung),
    CONSTRAINT bezugsdaten_vorlage_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsdaten_vorlage_fassung_chk CHECK (fassung >= 1),
    CONSTRAINT bezugsdaten_vorlage_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT bezugsdaten_vorlage_json_chk CHECK (coalesce(
        jsonb_typeof(formatregeln) = 'object' AND jsonb_typeof(bezug_tabelle) = 'object'
        AND jsonb_typeof(synonyme) = 'object', false)),
    CONSTRAINT bezugsdaten_vorlage_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsdaten_vorlage_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsdaten_vorlage_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

-- -----------------------------------------------------------------------------
-- bezugsdaten_import: ein Import als Fassungen (C6/C7).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsdaten_import (
    tenant_id        UUID        NOT NULL,
    kennung          TEXT        NOT NULL,
    fassung          INTEGER     NOT NULL,
    status           TEXT        NOT NULL,
    -- Nur Fassung 1: die Datei OHNE ihren Inhalt (E14) …
    datei_name       TEXT,
    datei_bytes      INTEGER,
    datei_sha256     TEXT,
    kodierung        TEXT,
    trennzeichen     TEXT,
    kopfzeile        BOOLEAN,
    -- … die benutzte Vorlage in ihrer Fassung (C9) …
    vorlage_id       UUID,
    vorlage_fassung  INTEGER,
    -- … und die Zähler der Vorschau, mit der übernommen wurde (C4).
    zeilen           INTEGER,
    neu              INTEGER,
    wiederholung     INTEGER,
    konflikt         INTEGER,
    berichtigung     INTEGER,
    uebersprungen    INTEGER,
    abgelehnt        INTEGER,
    mit_hinweis      INTEGER,
    aenderungen      INTEGER,
    befunde          JSONB,
    -- Konflikte „ersetzen“ (Fassung 1, E9) oder Rücknahme (Fassung > 1, C7).
    begruendung      TEXT,
    actor_sub        TEXT,
    actor_name       TEXT        NOT NULL,
    actor_rolle      TEXT,
    actor_art        TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsdaten_import_pk PRIMARY KEY (tenant_id, kennung, fassung),
    CONSTRAINT bezugsdaten_import_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsdaten_import_vorlage_fk FOREIGN KEY (tenant_id, vorlage_id, vorlage_fassung)
        REFERENCES bezugsdaten_vorlage (tenant_id, vorlage_id, fassung) ON DELETE RESTRICT,
    CONSTRAINT bezugsdaten_import_kennung_chk CHECK (kennung ~ '^I-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT bezugsdaten_import_fassung_chk CHECK (fassung >= 1),
    -- Ein gespeicherter Import ist nie eine Vorschau; Fassung 1 legt ihn mit dem
    -- Ergebnis der Übernahme an, jede weitere ist eine Rücknahme.
    CONSTRAINT bezugsdaten_import_status_chk CHECK (coalesce(
        bezugsdaten_wort('import_status', status) AND status <> 'vorschau'
        AND (fassung = 1) = (status <> 'zurueckgenommen'), false)),
    CONSTRAINT bezugsdaten_import_erste_fassung_chk CHECK (coalesce(
        (fassung = 1
         AND datei_name IS NOT NULL AND datei_bytes IS NOT NULL AND datei_sha256 IS NOT NULL
         AND kodierung IS NOT NULL AND trennzeichen IS NOT NULL AND kopfzeile IS NOT NULL
         AND zeilen IS NOT NULL AND neu IS NOT NULL AND wiederholung IS NOT NULL AND konflikt IS NOT NULL
         AND berichtigung IS NOT NULL AND uebersprungen IS NOT NULL AND abgelehnt IS NOT NULL
         AND mit_hinweis IS NOT NULL AND aenderungen IS NOT NULL AND befunde IS NOT NULL)
        OR (fassung > 1
         AND datei_name IS NULL AND datei_bytes IS NULL AND datei_sha256 IS NULL
         AND kodierung IS NULL AND trennzeichen IS NULL AND kopfzeile IS NULL
         AND vorlage_id IS NULL AND vorlage_fassung IS NULL
         AND zeilen IS NULL AND neu IS NULL AND wiederholung IS NULL AND konflikt IS NULL
         AND berichtigung IS NULL AND uebersprungen IS NULL AND abgelehnt IS NULL
         AND mit_hinweis IS NULL AND aenderungen IS NULL AND befunde IS NULL
         AND begruendung IS NOT NULL), false)),
    CONSTRAINT bezugsdaten_import_datei_chk CHECK (
        (datei_name IS NULL OR char_length(btrim(datei_name)) BETWEEN 1 AND 255)
        AND (datei_bytes IS NULL OR datei_bytes BETWEEN 1 AND 5242880)
        AND (datei_sha256 IS NULL OR datei_sha256 ~ '^[0-9a-f]{64}$')),
    CONSTRAINT bezugsdaten_import_kodierung_chk
        CHECK (kodierung IS NULL OR coalesce(bezugsdaten_wort('kodierung', kodierung), false)),
    CONSTRAINT bezugsdaten_import_trennzeichen_chk
        CHECK (trennzeichen IS NULL OR coalesce(bezugsdaten_wort('trennzeichen', trennzeichen), false)),
    CONSTRAINT bezugsdaten_import_vorlage_chk CHECK ((vorlage_id IS NULL) = (vorlage_fassung IS NULL)),
    -- Zähler (C4): ≥ 0, höchstens 100 000 Datenzeilen, ein Import ohne Datenzeile
    -- hat keinen Datensatz (§7 B12); geschrieben werden nur neu + berichtigung.
    CONSTRAINT bezugsdaten_import_zaehler_chk CHECK (
        zeilen IS NULL
        OR (zeilen BETWEEN 1 AND 100000 AND neu >= 0 AND wiederholung >= 0 AND konflikt >= 0
            AND berichtigung >= 0 AND uebersprungen >= 0 AND abgelehnt >= 0 AND mit_hinweis >= 0
            AND neu + wiederholung + berichtigung + uebersprungen + abgelehnt <= zeilen
            AND mit_hinweis <= zeilen AND konflikt <= zeilen
            AND aenderungen = neu + berichtigung)),
    CONSTRAINT bezugsdaten_import_befunde_chk
        CHECK (befunde IS NULL OR coalesce(bezugsdaten_befunde_gueltig(befunde), false)),
    CONSTRAINT bezugsdaten_import_begruendung_chk
        CHECK (begruendung IS NULL OR coalesce(bezugsdaten_begruendung_gueltig(begruendung), false)),
    CONSTRAINT bezugsdaten_import_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsdaten_import_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsdaten_import_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- `datei_bekannt` (B2): die Vorschau fragt je Kundenbereich nach dem Fingerabdruck.
CREATE INDEX IF NOT EXISTS idx_bezugsdaten_import_datei
    ON bezugsdaten_import (tenant_id, datei_sha256) WHERE fassung = 1;

-- -----------------------------------------------------------------------------
-- bezugsdaten_import_zeile: je Datenzeile ihr Urteil (C5), an Fassung 1.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsdaten_import_zeile (
    tenant_id                 UUID          NOT NULL,
    import_kennung            TEXT          NOT NULL,
    import_fassung            INTEGER       GENERATED ALWAYS AS (1) STORED,
    nr                        INTEGER       NOT NULL,
    -- Der Zeilentext, wie er in der Datei stand — zwei Jahre (E14).
    text                      TEXT,
    text_entfernt_am          TIMESTAMPTZ,
    urteil                    TEXT          NOT NULL,
    befunde                   JSONB         NOT NULL DEFAULT '[]'::jsonb,
    -- Der fachliche Schlüssel (C2): Bezugsgröße + Periode (Tage, letzter
    -- einschließlich) bzw. + Zeitpunkt. Das Kennzeichen, wie es beim Import hieß,
    -- bleibt, wenn die Bezugsgröße gelöscht wird (Grabstein).
    bezugsgroesse_id          UUID,
    bezugsgroesse_kennzeichen TEXT,
    periode_von               DATE,
    periode_bis               DATE,
    zeitpunkt                 TIMESTAMPTZ,
    zeitzone                  TEXT,
    betrag                    NUMERIC(18,6),
    einheit                   TEXT,
    geliefert_wert            TEXT,
    geliefert_einheit         TEXT,
    fingerabdruck             TEXT,
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT bezugsdaten_import_zeile_pk PRIMARY KEY (tenant_id, import_kennung, nr),
    CONSTRAINT bezugsdaten_import_zeile_import_fk FOREIGN KEY (tenant_id, import_kennung, import_fassung)
        REFERENCES bezugsdaten_import (tenant_id, kennung, fassung) ON DELETE RESTRICT,
    CONSTRAINT bezugsdaten_import_zeile_bezugsgroesse_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse (id, tenant_id) ON DELETE SET NULL (bezugsgroesse_id),
    CONSTRAINT bezugsdaten_import_zeile_nr_chk CHECK (nr >= 1),
    CONSTRAINT bezugsdaten_import_zeile_text_chk CHECK ((text IS NULL) = (text_entfernt_am IS NOT NULL)),
    CONSTRAINT bezugsdaten_import_zeile_urteil_chk
        CHECK (coalesce(bezugsdaten_wort('zeilen_urteil', urteil), false)),
    CONSTRAINT bezugsdaten_import_zeile_befunde_chk
        CHECK (coalesce(bezugsdaten_befunde_gueltig(befunde), false)),
    CONSTRAINT bezugsdaten_import_zeile_einheit_chk
        CHECK (einheit IS NULL OR coalesce(bezugsdaten_wort('einheiten', einheit), false)),
    -- Ein Schlüssel ist GENAU eine Periode ODER ein Zeitpunkt (auf die Minute), mit
    -- Zone und Betrag; ohne Schlüssel kein Fingerabdruck.
    CONSTRAINT bezugsdaten_import_zeile_schluessel_chk CHECK (coalesce(
        (fingerabdruck IS NULL AND periode_von IS NULL AND periode_bis IS NULL AND zeitpunkt IS NULL)
        OR (fingerabdruck ~ '^[0-9a-f]{64}$' AND betrag IS NOT NULL AND einheit IS NOT NULL
            AND zeitzone IS NOT NULL AND bezugsgroesse_kennzeichen IS NOT NULL
            AND ((periode_von IS NOT NULL AND periode_bis >= periode_von AND zeitpunkt IS NULL)
                 OR (periode_von IS NULL AND periode_bis IS NULL
                     AND zeitpunkt = date_trunc('minute', zeitpunkt)))), false)),
    -- Was geschrieben wird, wiederholt oder eine Entscheidung braucht, hat einen Schlüssel.
    CONSTRAINT bezugsdaten_import_zeile_urteil_schluessel_chk CHECK (coalesce(
        urteil IN ('abgelehnt', 'uebersprungen') OR fingerabdruck IS NOT NULL, false))
);
CREATE INDEX IF NOT EXISTS idx_bezugsdaten_import_zeile_fingerabdruck
    ON bezugsdaten_import_zeile (tenant_id, fingerabdruck) WHERE fingerabdruck IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsdaten_import_zeile_bezugsgroesse
    ON bezugsdaten_import_zeile (bezugsgroesse_id, tenant_id) WHERE bezugsgroesse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsdaten_import_zeile_text_frist
    ON bezugsdaten_import_zeile (created_at) WHERE text IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Append-only.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS bezugsdaten_vorlage_append_only ON bezugsdaten_vorlage;
CREATE TRIGGER bezugsdaten_vorlage_append_only BEFORE UPDATE ON bezugsdaten_vorlage
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS bezugsdaten_import_append_only ON bezugsdaten_import;
CREATE TRIGGER bezugsdaten_import_append_only BEFORE UPDATE ON bezugsdaten_import
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Die Zeile: nur die beiden Übergänge des Vergessens (siehe Kopf).
CREATE OR REPLACE FUNCTION bezugsdaten_import_zeile_nur_vergessen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Grabstein: die Bezugsgröße wurde gelöscht (ON DELETE SET NULL).
  IF OLD.bezugsgroesse_id IS NOT NULL AND NEW.bezugsgroesse_id IS NULL
     AND (NEW.text, NEW.text_entfernt_am) IS NOT DISTINCT FROM (OLD.text, OLD.text_entfernt_am)
     AND (to_jsonb(NEW) - 'bezugsgroesse_id' - 'import_fassung') = (to_jsonb(OLD) - 'bezugsgroesse_id' - 'import_fassung') THEN
    RETURN NEW;
  END IF;
  -- Zwei Jahre: der Zeilentext geht, alles andere bleibt.
  IF OLD.text IS NOT NULL AND NEW.text IS NULL AND NEW.text_entfernt_am IS NOT NULL
     AND OLD.created_at <= now() - public.bezugsdaten_zeilentext_frist()
     AND (to_jsonb(NEW) - 'text' - 'text_entfernt_am' - 'import_fassung')
         = (to_jsonb(OLD) - 'text' - 'text_entfernt_am' - 'import_fassung') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsdaten_import_zeile_append_only';
END $$;
DROP TRIGGER IF EXISTS bezugsdaten_import_zeile_append_only ON bezugsdaten_import_zeile;
CREATE TRIGGER bezugsdaten_import_zeile_append_only BEFORE UPDATE ON bezugsdaten_import_zeile
    FOR EACH ROW EXECUTE FUNCTION bezugsdaten_import_zeile_nur_vergessen();

-- Fassungen lückenlos: n > 1 nur, wenn n − 1 besteht (Vorlage und Import).
CREATE OR REPLACE FUNCTION bezugsdaten_fassung_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  da BOOLEAN;
BEGIN
  IF NEW.fassung = 1 THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'bezugsdaten_vorlage' THEN
    SELECT EXISTS (SELECT 1 FROM public.bezugsdaten_vorlage
                    WHERE tenant_id = NEW.tenant_id AND vorlage_id = NEW.vorlage_id AND fassung = NEW.fassung - 1)
      INTO da;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.bezugsdaten_import
                    WHERE tenant_id = NEW.tenant_id AND kennung = NEW.kennung AND fassung = NEW.fassung - 1)
      INTO da;
  END IF;
  IF NOT da THEN
    RAISE EXCEPTION '%: Fassung % folgt auf keine Fassung %', TG_TABLE_NAME, NEW.fassung, NEW.fassung - 1
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_fassung_lueckenlos';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bezugsdaten_vorlage_fassung_folgt ON bezugsdaten_vorlage;
CREATE TRIGGER bezugsdaten_vorlage_fassung_folgt BEFORE INSERT ON bezugsdaten_vorlage
    FOR EACH ROW EXECUTE FUNCTION bezugsdaten_fassung_folgt();
DROP TRIGGER IF EXISTS bezugsdaten_import_fassung_folgt ON bezugsdaten_import;
CREATE TRIGGER bezugsdaten_import_fassung_folgt BEFORE INSERT ON bezugsdaten_import
    FOR EACH ROW EXECUTE FUNCTION bezugsdaten_fassung_folgt();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsdaten_vorlage ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsdaten_vorlage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsdaten_vorlage_tenant_isolation ON bezugsdaten_vorlage;
CREATE POLICY bezugsdaten_vorlage_tenant_isolation ON bezugsdaten_vorlage
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bezugsdaten_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsdaten_import FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsdaten_import_tenant_isolation ON bezugsdaten_import;
CREATE POLICY bezugsdaten_import_tenant_isolation ON bezugsdaten_import
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bezugsdaten_import_zeile ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsdaten_import_zeile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsdaten_import_zeile_tenant_isolation ON bezugsdaten_import_zeile;
CREATE POLICY bezugsdaten_import_zeile_tenant_isolation ON bezugsdaten_import_zeile
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles — hier wird
-- ALLES genommen und eng neu gegeben: die Anwendung liest und legt an (ohne
-- `created_at`, das setzt die Datenbank), sie ändert und löscht nie. Die
-- Verwaltungsrolle liest, löscht (das Offboarding) und entfernt Zeilentexte nach
-- der Frist — nur diese beiden Spalten.
-- -----------------------------------------------------------------------------
REVOKE ALL ON bezugsdaten_vorlage, bezugsdaten_import, bezugsdaten_import_zeile FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT ON bezugsdaten_vorlage, bezugsdaten_import, bezugsdaten_import_zeile TO ${appDbUser};
GRANT INSERT (tenant_id, vorlage_id, fassung, name, formatregeln, bezug_tabelle, synonyme,
              actor_sub, actor_name, actor_rolle, actor_art)
    ON bezugsdaten_vorlage TO ${appDbUser};
GRANT INSERT (tenant_id, kennung, fassung, status, datei_name, datei_bytes, datei_sha256, kodierung,
              trennzeichen, kopfzeile, vorlage_id, vorlage_fassung, zeilen, neu, wiederholung, konflikt,
              berichtigung, uebersprungen, abgelehnt, mit_hinweis, aenderungen, befunde, begruendung,
              actor_sub, actor_name, actor_rolle, actor_art)
    ON bezugsdaten_import TO ${appDbUser};
GRANT INSERT (tenant_id, import_kennung, nr, text, urteil, befunde, bezugsgroesse_id, bezugsgroesse_kennzeichen,
              periode_von, periode_bis, zeitpunkt, zeitzone, betrag, einheit, geliefert_wert, geliefert_einheit,
              fingerabdruck)
    ON bezugsdaten_import_zeile TO ${appDbUser};

GRANT SELECT, DELETE ON bezugsdaten_vorlage, bezugsdaten_import, bezugsdaten_import_zeile TO ${adminDbUser};
GRANT UPDATE (text, text_entfernt_am) ON bezugsdaten_import_zeile TO ${adminDbUser};

COMMENT ON TABLE bezugsdaten_vorlage IS
    'UEMS AP-09 C9/E12: Zuordnungs-Vorlagen als Fassungen (append-only, lueckenlos); Routen mit IP-14.';
COMMENT ON TABLE bezugsdaten_import IS
    'UEMS AP-09 C6/C7: Importe als Fassungen (append-only); Fassung 1 = Uebernahme mit Datei-Metadaten und Fingerabdruck, NIE die Datei (E14), nie Status vorschau.';
COMMENT ON TABLE bezugsdaten_import_zeile IS
    'UEMS AP-09 C5: je Datenzeile Urteil, Befunde, fachlicher Schluessel und Fingerabdruck; Zeilentext zwei Jahre (bezugsdaten_zeilentext_frist).';
COMMENT ON FUNCTION bezugsdaten_zeilentext_frist() IS
    'E14: so lange bleibt der Zeilentext eines Imports; der Trigger und ZeilentextAufbewahrung fragen diese eine Stelle.';

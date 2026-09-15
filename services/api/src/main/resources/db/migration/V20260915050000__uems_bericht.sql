-- =============================================================================
-- UEMS AP-12 IP-4: der BERICHT als Tabellen — ein freigegebener Berichtsstand ist
-- eine KOPIE (Abzug als Text mit Prüfsumme), nie ein Verweis, und er wird nie
-- geändert und nie gelöscht (Konzept vp-uems-ap12-berichte §4.2, §4.3, §4.14,
-- §6.1, §8 IP-4; Captain-Entscheide E1, E2, E8, E13 = A vom 14.09.2026).
-- Maßgeblich ist der Vertrag docs/contracts/v2/bericht.md + bericht-vectors.json
-- + bericht-vorlagen.json mit dem Modul uems/BerichtRegeln — jede Regel hier sagt
-- DASSELBE wie dort; UemsBerichtMigrationTest liest die Dateien und spielt sie
-- gegen die Datenbank.
--
-- Acht mandantengebundene Tabellen, rein additiv (keine bestehende Tabelle, kein
-- Vertrag, keine Route, kein Lauf und keine Box wird berührt):
--
--   bericht                   Vorlage × Geltung × Zeitraum, Kennung BR-<Jahr>-<Nr.>
--   bericht_entwurf           genau EIN gespeicherter Entwurf je Bericht (EW1, E8)
--   bericht_stand             die freigegebenen Berichtsstände Nr. 1, 2, … —
--                             APPEND-ONLY (E1, E13 S1)
--   bericht_quelle            das Quellenverzeichnis eines Entwurfs (stand_nr NULL,
--                             wird ersetzt) oder eines Stands (eingefroren)
--   bericht_revision_anstoss  ein Anstoß an einen Stand, idempotent (B7)
--   bericht_abruf             jeder Abruf einer Ausgabe eines Stands (DA5)
--   bericht_aenderung         das Protokoll des Berichts
--   bericht_kennung_seq       der Kennungs-Zähler je Kundenbereich und Jahr
--
-- ⚠ DER ABZUG IST TEXT, NIE JSONB (A7): jsonb normalisiert Schlüsselreihenfolge,
-- Leerraum und Zahlen und bräche die Prüfsumme. Die Prüfsumme ist ein CHECK
-- (A6): `pruefsumme` = 'sha256:' + SHA-256 (hex, klein) über die UTF-8-Bytes des
-- Texts — eine Zeile, deren Prüfsumme nicht zu ihrem Text passt, gibt es nicht.
--
-- ⚠ EIN BERICHTSSTAND WIRD NIE GEÄNDERT UND NIE GELÖSCHT — von keiner Rolle, auch
-- nicht von der Verwaltungsrolle MIT Recht und nicht vom Eigentümer (E13 S1). Der
-- Trigger bericht_stand_bleibt lehnt jedes UPDATE und jedes DELETE ab; die EINE
-- Änderung ist `ersetzt_durch_nr`, GENAU EINMAL von NULL auf die Nummer des
-- Nachfolgers (R2). Ebenso append-only (S1): die Quellen eines Stands, die Anstöße
-- (nur ihr Abschluss — offen → erledigt oder verworfen, einmal), die Abrufe und
-- das Protokoll. Der EINE Ausgang ist das Offboarding über
-- uems_berichte_des_kundenbereichs_entfernen() (Muster
-- uems_kennzahlwerte_des_kundenbereichs_entfernen, V20260915003000).
--
-- ⚠ DER LÖSCHSCHUTZ WIRKT NUR AN DIESEN NEUEN TABELLEN — KEIN BESTEHENDER WEG WIRD
-- ENGER. Es gibt keinen Fremdschlüssel auf etwas, das heute gelöscht werden kann:
-- `bericht_quelle.objekt_id` ist ein Verweis OHNE Fremdschlüssel (Kennzeichen und
-- Name zum Datenstand stehen daneben, Muster messreihe_ereignis); die Geltung
-- zeigt auf Standort bzw. Unternehmen, die nur das Offboarding löscht (und das
-- räumt die Berichte vorher ab). Ob ein harter Löschweg (Komponente, Anlage,
-- Purge) künftig ablehnt, entscheidet ERST AP-12 IP-12 mit uems_berichts_belege()
-- — diese Migration ruft sie nirgends an.
--
-- ⚠ KEINE HYPERTABLE, KEINE AUFBEWAHRUNG, KEINE KOMPRESSION (§4.14, S1/S4): der
-- Abzug soll die Fristen der Messdaten gerade NICHT kennen.
--
-- DIE VOKABULARE KOMMEN AUS DEM VERTRAG. bericht_vokabular() ist die EINE Stelle
-- in der Datenbank, an der sie stehen — Zeile für Zeile die Listen
-- `vokabulare.vorlage|geltung_art|zeitraum_art|quelle_art|quelle_bezug|
-- anstoss_art|anstoss_zustand|handlung` der Vektor-Datei, in ihrer Reihenfolge.
-- JEDER CHECK auf ein Wort dieser Vokabulare fragt sie über bericht_wort(); keiner
-- trägt eine eigene Wortliste. Welche Vorlage zu welcher Geltung und welchem
-- Zeitraum gehört, sagt bericht_vorlage() — Zeile für Zeile bericht-vorlagen.json.
-- Weitet der Vertrag ein Vokabular, ersetzt eine NEUE Migration nur die Funktion.
-- Wörter ohne eigenen Vokabular-Block stehen als Literale mit Quelle:
--   * das Protokoll spricht die Wörter von `handlung` (anlegen, freigeben,
--     verwerfen, archivieren, abrufen, pdf, csv) — der Vertrag kennt keinen
--     Block `protokoll`, Konzept §4.2 („angelegt · freigegeben · …“) ist dafür
--     keine zweite Liste;
--   * ein Abruf ist `pdf` oder `csv` (DA5: nur Ausgaben eines Stands);
--   * ein Entwurf wird gebildet beim `anlegen`, beim `abruf` (D4), von der
--     `kaskade` (Pfad 1) oder vom `struktur`-Läufer (Pfad 2) — bericht.md EW1;
--   * Akteur-Art und -Rolle wie an kennzahl_aenderung.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags (siehe Kopf). `nr` ist die Stelle im Vertrag.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bericht_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('vorlage', 1, 'monatsbericht_standort'),
    ('vorlage', 2, 'jahresbericht_standort'),
    ('vorlage', 3, 'monatsbericht_unternehmen'),
    ('vorlage', 4, 'jahresbericht_unternehmen'),
    ('geltung_art', 1, 'standort'),
    ('geltung_art', 2, 'unternehmen'),
    ('zeitraum_art', 1, 'monat'),
    ('zeitraum_art', 2, 'jahr'),
    ('quelle_art', 1, 'messstelle'),
    ('quelle_art', 2, 'kostenstelle'),
    ('quelle_art', 3, 'bezugsgroesse'),
    ('quelle_art', 4, 'stammdatum'),
    ('quelle_art', 5, 'kennzahl'),
    ('quelle_bezug', 1, 'unmittelbar'),
    ('quelle_bezug', 2, 'mittelbar'),
    ('quelle_bezug', 3, 'vergleich'),
    ('anstoss_art', 1, 'korrektur_freigegeben'),
    ('anstoss_art', 2, 'korrektur_zurueckgenommen'),
    ('anstoss_art', 3, 'ersatzwert_wirksam'),
    ('anstoss_art', 4, 'ersatzwert_zurueckgenommen'),
    ('anstoss_art', 5, 'bezugsgroesse_fassung'),
    ('anstoss_art', 6, 'kennzahl_fassung_rueckwirkend'),
    ('anstoss_art', 7, 'zuordnung_rueckwirkend'),
    ('anstoss_art', 8, 'anlage_umzug_rueckwirkend'),
    ('anstoss_art', 9, 'flaeche_rueckwirkend'),
    ('anstoss_art', 10, 'verteilung_rueckwirkend'),
    ('anstoss_zustand', 1, 'offen'),
    ('anstoss_zustand', 2, 'erledigt'),
    ('anstoss_zustand', 3, 'verworfen'),
    ('handlung', 1, 'abrufen'),
    ('handlung', 2, 'pdf'),
    ('handlung', 3, 'csv'),
    ('handlung', 4, 'anlegen'),
    ('handlung', 5, 'freigeben'),
    ('handlung', 6, 'verwerfen'),
    ('handlung', 7, 'archivieren')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION bericht_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.bericht_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- Die Vorlagen des Katalogs mit ihrer Geltung und ihrem Zeitraum (V2) — Zeile für
-- Zeile `vorlagen[].schluessel|geltung_art|zeitraum_art` von bericht-vorlagen.json.
-- Die Fassung einer Vorlage steht NICHT hier: eine neue Fassung braucht keine
-- Migration (sie ändert keinen Berichtsstand, V3).
CREATE OR REPLACE FUNCTION bericht_vorlage()
RETURNS TABLE (vorlage TEXT, geltung_art TEXT, zeitraum_art TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('monatsbericht_standort', 'standort', 'monat'),
    ('jahresbericht_standort', 'standort', 'jahr'),
    ('monatsbericht_unternehmen', 'unternehmen', 'monat'),
    ('jahresbericht_unternehmen', 'unternehmen', 'jahr')
$$;

CREATE OR REPLACE FUNCTION bericht_vorlage_passt(p_vorlage TEXT, p_geltung_art TEXT, p_zeitraum_art TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.bericht_vorlage() v
                 WHERE v.vorlage = p_vorlage AND v.geltung_art = p_geltung_art
                   AND v.zeitraum_art = p_zeitraum_art)
$$;

-- A6: die Prüfsumme eines kanonischen Texts — 'sha256:' + SHA-256 (hex, klein)
-- über seine UTF-8-Bytes, genau wie BerichtRegeln.pruefsumme.
CREATE OR REPLACE FUNCTION bericht_pruefsumme(p_abzug TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_abzug, 'UTF8')), 'hex')
$$;

-- -----------------------------------------------------------------------------
-- bericht: der Bericht selbst (§4.2, bericht.md §1).
--
-- Die Geltung ist GENAU EINE gesetzte Verweis-Spalte, passend zu `geltung_art`
-- (Muster kennzahl): standort → standort_id, unternehmen → unternehmen_id; beide
-- gehen erst mit dem Offboarding. `geltung_id` fasst sie für den Schlüssel „gibt
-- es schon“ (V4) zusammen. Kennung, Vorlage, Geltung, Zeitraum und Zeitzone
-- bleiben (Trigger bericht_identitaet_bleibt); ein Bericht wird archiviert, nie
-- gelöscht.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    -- BR-<Jahr>-<Nr.>, Jahr des Anlegens (B15: Jahresbericht 2026 = BR-2027-0002).
    kennung              TEXT        NOT NULL,
    vorlage              TEXT        NOT NULL,
    -- Die Fassung der Vorlage beim Anlegen; jeder Stand trägt seine eigene.
    vorlage_fassung      INTEGER     NOT NULL,
    geltung_art          TEXT        NOT NULL,
    standort_id          UUID,
    unternehmen_id       UUID,
    geltung_id           UUID GENERATED ALWAYS AS (coalesce(standort_id, unternehmen_id)) STORED,
    zeitraum_art         TEXT        NOT NULL,
    -- 2026-10 (Monat) oder 2026 (Jahr), in der Zeitzone der Geltung.
    zeitraum_schluessel  TEXT        NOT NULL,
    zeitzone             TEXT        NOT NULL,
    angelegt_von_sub     TEXT,
    angelegt_von_name    TEXT        NOT NULL,
    angelegt_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = nicht archiviert. Archivieren verbirgt in der Liste; die Stände bleiben lesbar.
    archiviert_am        TIMESTAMPTZ,
    CONSTRAINT bericht_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_kennung_eindeutig UNIQUE (tenant_id, kennung),
    -- V4: 409 bericht_gibt_es_schon — auch ein archivierter Bericht belegt seinen Schlüssel.
    CONSTRAINT bericht_gibt_es_schon UNIQUE (tenant_id, vorlage, geltung_art, geltung_id, zeitraum_schluessel),
    -- Ziel der zusammengesetzten Verweise (der Mandant reist mit).
    CONSTRAINT bericht_id_tenant_uq UNIQUE (id, tenant_id),
    -- Postgres prüft CHECKs in Namensreihenfolge: das Vokabular einer Spalte vor
    -- jeder Regel, die ihr Wort voraussetzt.
    CONSTRAINT bericht_angelegt_von_chk
        CHECK (btrim(angelegt_von_name) <> '' AND (angelegt_von_sub IS NULL OR angelegt_von_sub <> '')),
    CONSTRAINT bericht_geltung_art_chk CHECK (coalesce(bericht_wort('geltung_art', geltung_art), false)),
    CONSTRAINT bericht_geltung_chk
        CHECK ((standort_id IS NOT NULL) = (geltung_art = 'standort')
               AND (unternehmen_id IS NOT NULL) = (geltung_art = 'unternehmen')),
    CONSTRAINT bericht_kennung_chk CHECK (kennung ~ '^BR-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT bericht_vorlage_chk CHECK (coalesce(bericht_wort('vorlage', vorlage), false)),
    CONSTRAINT bericht_vorlage_fassung_chk CHECK (vorlage_fassung >= 1),
    CONSTRAINT bericht_zeitraum_art_chk CHECK (coalesce(bericht_wort('zeitraum_art', zeitraum_art), false)),
    CONSTRAINT bericht_zeitraum_schluessel_chk
        CHECK (CASE zeitraum_art
                   WHEN 'monat' THEN zeitraum_schluessel ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
                   WHEN 'jahr' THEN zeitraum_schluessel ~ '^[0-9]{4}$'
                   ELSE false
               END),
    CONSTRAINT bericht_zeitraum_zur_vorlage_chk
        CHECK (coalesce(bericht_vorlage_passt(vorlage, geltung_art, zeitraum_art), false)),
    CONSTRAINT bericht_zeitzone_chk CHECK (btrim(zeitzone) <> '')
);
CREATE INDEX IF NOT EXISTS idx_bericht_geltung
    ON bericht (tenant_id, geltung_art, geltung_id, zeitraum_schluessel);

-- -----------------------------------------------------------------------------
-- bericht_entwurf: genau EIN gespeicherter Entwurf je Bericht (EW1, E8). Er wird
-- ersetzt (UPDATE), nie versioniert — die Versionen sind die Berichtsstände.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_entwurf (
    tenant_id     UUID        NOT NULL,
    bericht_id    UUID        NOT NULL,
    abzug         TEXT        NOT NULL,
    pruefsumme    TEXT        NOT NULL,
    -- D1: der Zeitpunkt der Bildung des Abzugs.
    datenstand    TIMESTAMPTZ NOT NULL,
    gebildet_von  TEXT        NOT NULL,
    CONSTRAINT bericht_entwurf_pk PRIMARY KEY (tenant_id, bericht_id),
    CONSTRAINT bericht_entwurf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_entwurf_bericht_fk FOREIGN KEY (bericht_id, tenant_id)
        REFERENCES bericht (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_entwurf_gebildet_von_chk
        CHECK (gebildet_von IN ('anlegen', 'abruf', 'kaskade', 'struktur')),
    CONSTRAINT bericht_entwurf_pruefsumme_chk CHECK (pruefsumme = bericht_pruefsumme(abzug))
);

-- -----------------------------------------------------------------------------
-- bericht_stand: ein freigegebener Berichtsstand (F2, F3, R2) — APPEND-ONLY.
--
-- Nr. 1, 2, … lückenlos je Bericht (Trigger bericht_stand_folgt); der Abzug ist
-- die byte-gleiche Kopie des gesehenen Entwurfs; Person, Zeitpunkt, Darstellung,
-- Regelwerk und Vorlagen-Fassung stehen am Stand (F3). `ersetzt_durch_nr` zeigt
-- auf den Nachfolger desselben Berichts und wird genau einmal gesetzt.
-- `anlass_anstoss_id` nennt den Anstoß, den die Revision erledigt — ohne
-- Fremdschlüssel (Anstoß und Stand zeigten sonst im Kreis aufeinander), geprüft
-- vom Trigger bericht_stand_folgt.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_stand (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    bericht_id          UUID        NOT NULL,
    nr                  INTEGER     NOT NULL,
    abzug               TEXT        NOT NULL,
    pruefsumme          TEXT        NOT NULL,
    datenstand          TIMESTAMPTZ NOT NULL,
    freigegeben_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- F3: die freigebende Person (Muster actor_*, kein FK auf einen Benutzer-Spiegel).
    freigeber_sub       TEXT        NOT NULL,
    freigeber_name      TEXT        NOT NULL,
    freigeber_rolle     TEXT,
    darstellung         JSONB       NOT NULL,
    regelwerk           JSONB       NOT NULL,
    vorlage_fassung     INTEGER     NOT NULL,
    ersetzt_durch_nr    INTEGER,
    anlass_anstoss_id   UUID,
    CONSTRAINT bericht_stand_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_stand_bericht_fk FOREIGN KEY (bericht_id, tenant_id)
        REFERENCES bericht (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_stand_nr_eindeutig UNIQUE (tenant_id, bericht_id, nr),
    CONSTRAINT bericht_stand_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT bericht_stand_ersetzt_durch_fk FOREIGN KEY (tenant_id, bericht_id, ersetzt_durch_nr)
        REFERENCES bericht_stand (tenant_id, bericht_id, nr) ON DELETE RESTRICT,
    CONSTRAINT bericht_stand_anlass_chk CHECK (anlass_anstoss_id IS NULL OR nr >= 2),
    CONSTRAINT bericht_stand_darstellung_chk
        CHECK (jsonb_typeof(darstellung) = 'object' AND jsonb_typeof(regelwerk) = 'object'),
    -- D3: die Freigabe liegt nie vor dem Datenstand.
    CONSTRAINT bericht_stand_datenstand_chk CHECK (datenstand <= freigegeben_am),
    CONSTRAINT bericht_stand_ersetzt_durch_chk CHECK (ersetzt_durch_nr IS NULL OR ersetzt_durch_nr > nr),
    CONSTRAINT bericht_stand_freigeber_chk CHECK (btrim(freigeber_name) <> '' AND freigeber_sub <> ''),
    CONSTRAINT bericht_stand_freigeber_rolle_chk
        CHECK (freigeber_rolle IS NULL OR freigeber_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bericht_stand_nr_chk CHECK (nr >= 1),
    CONSTRAINT bericht_stand_pruefsumme_chk CHECK (pruefsumme = bericht_pruefsumme(abzug)),
    CONSTRAINT bericht_stand_vorlage_fassung_chk CHECK (vorlage_fassung >= 1)
);

-- -----------------------------------------------------------------------------
-- bericht_quelle: eine Quelle eines Entwurfs (stand_nr NULL) oder eines Stands
-- (B1, Q6). `objekt_id` ist ein Verweis OHNE Fremdschlüssel — Kennzeichen und
-- Name zum Datenstand stehen daneben (A5). Tage einschließlich wie
-- `Betroffen.ersterTag/letzterTag` (bericht.schema.json $defs/quelle).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_quelle (
    id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID    NOT NULL,
    bericht_id           UUID    NOT NULL,
    -- NULL = die Quelle des Entwurfs (wird mit ihm ersetzt), sonst die Nummer des Stands.
    stand_nr             INTEGER,
    art                  TEXT    NOT NULL,
    kennzeichen          TEXT    NOT NULL,
    objekt_id            UUID    NOT NULL,
    bezug                TEXT    NOT NULL,
    erster_tag           DATE    NOT NULL,
    letzter_tag          DATE    NOT NULL,
    version              INTEGER,
    fassung              INTEGER,
    name_zum_datenstand  TEXT    NOT NULL,
    CONSTRAINT bericht_quelle_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_quelle_bericht_fk FOREIGN KEY (bericht_id, tenant_id)
        REFERENCES bericht (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_quelle_stand_fk FOREIGN KEY (tenant_id, bericht_id, stand_nr)
        REFERENCES bericht_stand (tenant_id, bericht_id, nr) ON DELETE RESTRICT,
    CONSTRAINT bericht_quelle_art_chk CHECK (coalesce(bericht_wort('quelle_art', art), false)),
    CONSTRAINT bericht_quelle_bezug_chk CHECK (coalesce(bericht_wort('quelle_bezug', bezug), false)),
    CONSTRAINT bericht_quelle_kennzeichen_chk
        CHECK (btrim(kennzeichen) <> '' AND btrim(name_zum_datenstand) <> ''),
    CONSTRAINT bericht_quelle_tage_chk CHECK (letzter_tag >= erster_tag),
    CONSTRAINT bericht_quelle_version_chk
        CHECK ((version IS NULL OR version >= 1) AND (fassung IS NULL OR fassung >= 1))
);
-- B1: Betroffen = Zeitraum × Quellenverzeichnis (tenant_id vorn).
CREATE INDEX IF NOT EXISTS idx_bericht_quelle_objekt
    ON bericht_quelle (tenant_id, objekt_id, erster_tag, letzter_tag);
CREATE INDEX IF NOT EXISTS idx_bericht_quelle_bericht
    ON bericht_quelle (tenant_id, bericht_id, stand_nr);

-- -----------------------------------------------------------------------------
-- bericht_revision_anstoss: ein Anstoß an einen Stand (B4, R1–R4). IDEMPOTENT
-- über Stand, Art, Anlass, Fassung und Status (B7) — auch ohne Fassung oder
-- Status (NULLS NOT DISTINCT): dieselbe Wiederholung ist dieselbe Zeile.
-- Geschrieben von Naht und Läufer; abgeschlossen durch die Freigabe (erledigt)
-- oder mit Begründung (verworfen, F5) — genau einmal, sonst nie geändert.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_revision_anstoss (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL,
    stand_id               UUID        NOT NULL,
    art                    TEXT        NOT NULL,
    -- K-…, EW-…, BK-… oder die Kennung einer Strukturänderung.
    anlass_kennung         TEXT        NOT NULL,
    anlass_fassung         INTEGER,
    anlass_status          TEXT,
    -- Die Meldung bericht_revision_angestossen in messreihe_ereignis (ohne FK).
    ereignis_id            UUID,
    erkannt_am             TIMESTAMPTZ NOT NULL DEFAULT now(),
    zustand                TEXT        NOT NULL DEFAULT 'offen',
    erledigt_durch_nr      INTEGER,
    verworfen_begruendung  TEXT,
    verworfen_von_sub      TEXT,
    verworfen_von_name     TEXT,
    verworfen_am           TIMESTAMPTZ,
    CONSTRAINT bericht_revision_anstoss_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_revision_anstoss_stand_fk FOREIGN KEY (stand_id, tenant_id)
        REFERENCES bericht_stand (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_revision_anstoss_einmal
        UNIQUE NULLS NOT DISTINCT (tenant_id, stand_id, art, anlass_kennung, anlass_fassung, anlass_status),
    CONSTRAINT bericht_revision_anstoss_anlass_chk
        CHECK (btrim(anlass_kennung) <> ''
               AND (anlass_fassung IS NULL OR anlass_fassung >= 1)
               AND (anlass_status IS NULL OR btrim(anlass_status) <> '')),
    CONSTRAINT bericht_revision_anstoss_art_chk CHECK (coalesce(bericht_wort('anstoss_art', art), false)),
    CONSTRAINT bericht_revision_anstoss_erledigt_durch_chk CHECK (erledigt_durch_nr IS NULL OR erledigt_durch_nr >= 2),
    CONSTRAINT bericht_revision_anstoss_zustand_chk
        CHECK (coalesce(bericht_wort('anstoss_zustand', zustand), false)),
    -- offen: nichts abgeschlossen · erledigt: durch Nr. n · verworfen: Begründung, Person, Zeit (R4).
    CONSTRAINT bericht_revision_anstoss_zustand_passt_chk
        CHECK (CASE zustand
                   WHEN 'offen' THEN erledigt_durch_nr IS NULL AND verworfen_begruendung IS NULL
                        AND verworfen_von_sub IS NULL AND verworfen_von_name IS NULL AND verworfen_am IS NULL
                   WHEN 'erledigt' THEN erledigt_durch_nr IS NOT NULL AND verworfen_begruendung IS NULL
                        AND verworfen_von_sub IS NULL AND verworfen_von_name IS NULL AND verworfen_am IS NULL
                   WHEN 'verworfen' THEN erledigt_durch_nr IS NULL
                        AND coalesce(btrim(verworfen_begruendung) <> '', false)
                        AND coalesce(btrim(verworfen_von_name) <> '', false)
                        AND (verworfen_von_sub IS NULL OR verworfen_von_sub <> '')
                        AND verworfen_am IS NOT NULL
                   ELSE false
               END)
);
CREATE INDEX IF NOT EXISTS idx_bericht_revision_anstoss_stand
    ON bericht_revision_anstoss (tenant_id, stand_id, zustand);

-- -----------------------------------------------------------------------------
-- bericht_abruf: jeder Abruf einer Ausgabe eines Stands (DA5) — nie eines
-- Entwurfs (EW4). APPEND-ONLY.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_abruf (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL,
    stand_id      UUID        NOT NULL,
    format        TEXT        NOT NULL,
    -- G3: die Teilansicht (Kopfzeile nach R-A4).
    teilansicht   BOOLEAN     NOT NULL DEFAULT false,
    actor_sub     TEXT,
    actor_name    TEXT        NOT NULL,
    actor_rolle   TEXT,
    actor_art     TEXT        NOT NULL,
    abgerufen_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bericht_abruf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_abruf_stand_fk FOREIGN KEY (stand_id, tenant_id)
        REFERENCES bericht_stand (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_abruf_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bericht_abruf_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT bericht_abruf_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bericht_abruf_format_chk CHECK (coalesce(bericht_wort('handlung', format), false)),
    -- DA5: nur die Ausgaben eines Stands (PDF, CSV), kein anderes Wort von `handlung`.
    CONSTRAINT bericht_abruf_format_zur_ausgabe_chk CHECK (format IN ('pdf', 'csv'))
);
CREATE INDEX IF NOT EXISTS idx_bericht_abruf_stand
    ON bericht_abruf (tenant_id, stand_id, abgerufen_am DESC);

-- -----------------------------------------------------------------------------
-- bericht_aenderung: das Protokoll (Muster kennzahl_aenderung). Die Art ist ein
-- Wort von `handlung` (siehe Kopf). APPEND-ONLY.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_aenderung (
    id           BIGSERIAL   PRIMARY KEY,
    tenant_id    UUID        NOT NULL,
    bericht_id   UUID        NOT NULL,
    stand_nr     INTEGER,
    art          TEXT        NOT NULL,
    alt          JSONB,
    neu          JSONB,
    grund        TEXT,
    actor_sub    TEXT,
    actor_name   TEXT        NOT NULL,
    actor_rolle  TEXT,
    actor_art    TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bericht_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_aenderung_bericht_fk FOREIGN KEY (bericht_id, tenant_id)
        REFERENCES bericht (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_aenderung_stand_fk FOREIGN KEY (tenant_id, bericht_id, stand_nr)
        REFERENCES bericht_stand (tenant_id, bericht_id, nr) ON DELETE RESTRICT,
    CONSTRAINT bericht_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bericht_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT bericht_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bericht_aenderung_art_chk CHECK (coalesce(bericht_wort('handlung', art), false))
);
CREATE INDEX IF NOT EXISTS idx_bericht_aenderung_bericht
    ON bericht_aenderung (tenant_id, bericht_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- bericht_kennung_seq: der Kennungs-Zähler BR-<Jahr>-<Nr.> je Kundenbereich und
-- Jahr — eine Tabelle, nie ein BIGSERIAL (Muster geraet_kennzeichen_seq).
-- `naechste_nummer` ist die nächste Nummer (fehlt die Zeile: 1); der Zähler rückt
-- nur mit einer vergebenen Kennung vor (dieselbe Transaktion) und nie zurück.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bericht_kennung_seq (
    tenant_id        UUID    NOT NULL,
    jahr             INTEGER NOT NULL,
    naechste_nummer  INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT bericht_kennung_seq_pk PRIMARY KEY (tenant_id, jahr),
    CONSTRAINT bericht_kennung_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_kennung_seq_jahr_chk CHECK (jahr BETWEEN 1000 AND 9999),
    CONSTRAINT bericht_kennung_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

-- Die nächste freie Kennung BR-<Jahr>-<Nr.> des Kundenbereichs — und der Zähler
-- rückt dahinter. Die Zeile (Mandant, Jahr) wird gesperrt oder angelegt: parallele
-- Vergaben warten aufeinander. Eine Kennung, die ein Bericht schon trägt, wird
-- übersprungen. Läuft als Aufrufer: unter RLS vergibt die App-Rolle nur für ihren
-- eigenen Mandanten. Welches Jahr, sagt der Aufrufer (das des Anlegens).
CREATE OR REPLACE FUNCTION uems_bericht_kennung(p_tenant UUID, p_jahr INTEGER) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
    n INTEGER;
BEGIN
    IF p_tenant IS NULL OR p_jahr IS NULL THEN
        RAISE EXCEPTION 'a tenant scope and a year are required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO bericht_kennung_seq AS z (tenant_id, jahr, naechste_nummer)
    VALUES (p_tenant, p_jahr, 1)
    ON CONFLICT (tenant_id, jahr) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    WHILE EXISTS (SELECT 1 FROM bericht b
                  WHERE b.tenant_id = p_tenant
                    AND b.kennung = 'BR-' || p_jahr || '-' || lpad(n::text, greatest(4, length(n::text)), '0')) LOOP
        n := n + 1;
    END LOOP;
    UPDATE bericht_kennung_seq SET naechste_nummer = n + 1 WHERE tenant_id = p_tenant AND jahr = p_jahr;
    RETURN 'BR-' || p_jahr || '-' || lpad(n::text, greatest(4, length(n::text)), '0');
END
$$;

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- Ein Bericht bleibt, was er ist: nur `archiviert_am` ändert sich. (`geltung_id`
-- ist berechnet und steht im BEFORE-Trigger noch nicht fest.)
CREATE OR REPLACE FUNCTION bericht_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['archiviert_am', 'geltung_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['archiviert_am', 'geltung_id']) THEN
    RAISE EXCEPTION 'bericht %: Kennung, Vorlage, Geltung und Zeitraum bleiben — nur archiviert_am ändert sich', OLD.kennung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_identitaet_bleibt';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bericht_identitaet_bleibt ON bericht;
CREATE TRIGGER bericht_identitaet_bleibt BEFORE UPDATE ON bericht
    FOR EACH ROW EXECUTE FUNCTION bericht_identitaet_bleibt();

-- ⚠ E13 S1: ein Berichtsstand wird nie geändert und nie gelöscht — von JEDER Rolle.
-- Die eine Änderung: `ersetzt_durch_nr` von NULL auf den Nachfolger, genau einmal
-- (R2). Die eine Löschung: das Offboarding (siehe Kopf).
CREATE OR REPLACE FUNCTION bericht_stand_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('uems.berichte_entfernen', true) = OLD.tenant_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'bericht_stand ist append-only: ein freigegebener Berichtsstand (Nr. %) wird nie gelöscht', OLD.nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_stand_append_only';
  END IF;
  IF (to_jsonb(NEW) - 'ersetzt_durch_nr') IS DISTINCT FROM (to_jsonb(OLD) - 'ersetzt_durch_nr') THEN
    RAISE EXCEPTION 'bericht_stand ist append-only: ein freigegebener Berichtsstand (Nr. %) wird nie geändert — eine Revision ist ein neuer Stand', OLD.nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_stand_append_only';
  END IF;
  IF OLD.ersetzt_durch_nr IS NOT NULL OR NEW.ersetzt_durch_nr IS NULL THEN
    RAISE EXCEPTION 'bericht_stand Nr. %: „ersetzt durch“ wird genau einmal gesetzt und nie geändert', OLD.nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_stand_ersetzt_einmal';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bericht_stand_append_only ON bericht_stand;
CREATE TRIGGER bericht_stand_append_only BEFORE UPDATE OR DELETE ON bericht_stand
    FOR EACH ROW EXECUTE FUNCTION bericht_stand_bleibt();

-- F2/R2: Nr. = letzte + 1 je Bericht; der Anlass ist ein Anstoß an einen
-- früheren Stand DESSELBEN Berichts. (Zwei gleichzeitige Freigaben fängt
-- bericht_stand_nr_eindeutig.)
CREATE OR REPLACE FUNCTION bericht_stand_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nr <> coalesce((SELECT max(s.nr) FROM bericht_stand s
                         WHERE s.tenant_id = NEW.tenant_id AND s.bericht_id = NEW.bericht_id), 0) + 1 THEN
    RAISE EXCEPTION 'bericht_stand: Nr. % folgt nicht auf den letzten Stand des Berichts', NEW.nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_stand_folgt';
  END IF;
  IF NEW.anlass_anstoss_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM bericht_revision_anstoss a
         JOIN bericht_stand s ON s.id = a.stand_id AND s.tenant_id = a.tenant_id
        WHERE a.id = NEW.anlass_anstoss_id AND a.tenant_id = NEW.tenant_id
          AND s.bericht_id = NEW.bericht_id AND s.nr < NEW.nr) THEN
    RAISE EXCEPTION 'bericht_stand Nr. %: der Anlass ist kein Anstoß an einen früheren Stand dieses Berichts', NEW.nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_stand_folgt';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bericht_stand_folgt ON bericht_stand;
CREATE TRIGGER bericht_stand_folgt BEFORE INSERT ON bericht_stand
    FOR EACH ROW EXECUTE FUNCTION bericht_stand_folgt();

-- Die Quellen eines Stands sind eingefroren; die des Entwurfs werden mit ihm
-- ersetzt (gelöscht und neu geschrieben) — geändert wird keine.
CREATE OR REPLACE FUNCTION bericht_quelle_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.stand_nr IS NULL OR current_setting('uems.berichte_entfernen', true) = OLD.tenant_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'bericht_quelle ist append-only: die Quelle eines Berichtsstands (Nr. %) wird nie gelöscht', OLD.stand_nr
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_quelle_append_only';
  END IF;
  RAISE EXCEPTION 'bericht_quelle ist append-only: eine Quelle wird nie geändert — der Entwurf ersetzt seine Quellen'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_quelle_append_only';
END $$;
DROP TRIGGER IF EXISTS bericht_quelle_append_only ON bericht_quelle;
CREATE TRIGGER bericht_quelle_append_only BEFORE UPDATE OR DELETE ON bericht_quelle
    FOR EACH ROW EXECUTE FUNCTION bericht_quelle_bleibt();

-- Ein Anstoß wird nie gelöscht; nur ein OFFENER wird genau einmal erledigt oder
-- verworfen (R3, R4) — sonst ändert sich an ihm nichts.
CREATE OR REPLACE FUNCTION bericht_revision_anstoss_nur_abschluss() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  abschluss CONSTANT TEXT[] := ARRAY['zustand', 'erledigt_durch_nr', 'verworfen_begruendung',
                                     'verworfen_von_sub', 'verworfen_von_name', 'verworfen_am'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('uems.berichte_entfernen', true) = OLD.tenant_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'bericht_revision_anstoss ist append-only: ein Anstoß wird erledigt oder verworfen, nie gelöscht'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_revision_anstoss_append_only';
  END IF;
  IF OLD.zustand <> 'offen' OR (to_jsonb(NEW) - abschluss) IS DISTINCT FROM (to_jsonb(OLD) - abschluss) THEN
    RAISE EXCEPTION 'bericht_revision_anstoss ist append-only: nur ein offener Anstoß wird einmal erledigt oder verworfen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_revision_anstoss_append_only';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bericht_revision_anstoss_append_only ON bericht_revision_anstoss;
CREATE TRIGGER bericht_revision_anstoss_append_only BEFORE UPDATE OR DELETE ON bericht_revision_anstoss
    FOR EACH ROW EXECUTE FUNCTION bericht_revision_anstoss_nur_abschluss();

-- Abrufe und Protokoll: nie geändert, nie gelöscht (außer im Offboarding).
CREATE OR REPLACE FUNCTION bericht_protokoll_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('uems.berichte_entfernen', true) = OLD.tenant_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% ist append-only: ein Eintrag wird nie geändert und nie gelöscht', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;
DROP TRIGGER IF EXISTS bericht_abruf_append_only ON bericht_abruf;
CREATE TRIGGER bericht_abruf_append_only BEFORE UPDATE OR DELETE ON bericht_abruf
    FOR EACH ROW EXECUTE FUNCTION bericht_protokoll_bleibt();
DROP TRIGGER IF EXISTS bericht_aenderung_append_only ON bericht_aenderung;
CREATE TRIGGER bericht_aenderung_append_only BEFORE UPDATE OR DELETE ON bericht_aenderung
    FOR EACH ROW EXECUTE FUNCTION bericht_protokoll_bleibt();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE bericht ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_tenant_isolation ON bericht;
CREATE POLICY bericht_tenant_isolation ON bericht
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_entwurf ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_entwurf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_entwurf_tenant_isolation ON bericht_entwurf;
CREATE POLICY bericht_entwurf_tenant_isolation ON bericht_entwurf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_stand ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_stand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_stand_tenant_isolation ON bericht_stand;
CREATE POLICY bericht_stand_tenant_isolation ON bericht_stand
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_quelle ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_quelle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_quelle_tenant_isolation ON bericht_quelle;
CREATE POLICY bericht_quelle_tenant_isolation ON bericht_quelle
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_revision_anstoss ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_revision_anstoss FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_revision_anstoss_tenant_isolation ON bericht_revision_anstoss;
CREATE POLICY bericht_revision_anstoss_tenant_isolation ON bericht_revision_anstoss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_abruf ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_abruf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_abruf_tenant_isolation ON bericht_abruf;
CREATE POLICY bericht_abruf_tenant_isolation ON bericht_abruf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_aenderung_tenant_isolation ON bericht_aenderung;
CREATE POLICY bericht_aenderung_tenant_isolation ON bericht_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bericht_kennung_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_kennung_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_kennung_seq_tenant_isolation ON bericht_kennung_seq;
CREATE POLICY bericht_kennung_seq_tenant_isolation ON bericht_kennung_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Die Belege (E13 S2, für AP-12 IP-12): welche freigegebenen Berichtsstände
-- zitieren ein Objekt? Jede Quelle eines Stands zählt — unmittelbar, mittelbar
-- und als Vergleich —, auch ein ersetzter Stand (B12: Nr. 1 UND Nr. 2).
-- Entwürfe schützen nichts. SECURITY INVOKER (Muster uems_messreihen_belege): die
-- Anwendung sieht unter RLS nur ihren Kundenbereich. Noch ruft niemand an.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_berichts_belege(p_objekt UUID)
RETURNS TABLE (bericht_id UUID, kennung TEXT, nr INTEGER, stand_id UUID, ersetzt_durch_nr INTEGER)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT b.id, b.kennung, s.nr, s.id, s.ersetzt_durch_nr
      FROM bericht_stand s
      JOIN bericht b ON b.id = s.bericht_id AND b.tenant_id = s.tenant_id
     WHERE EXISTS (SELECT 1 FROM bericht_quelle q
                    WHERE q.tenant_id = s.tenant_id AND q.bericht_id = s.bericht_id
                      AND q.stand_nr = s.nr AND q.objekt_id = p_objekt)
     ORDER BY b.kennung, s.nr
$$;

REVOKE ALL ON FUNCTION uems_berichts_belege(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_berichts_belege(UUID) TO ${appDbUser};
REVOKE ALL ON FUNCTION uems_bericht_kennung(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_bericht_kennung(UUID, INTEGER) TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Der eine Ausgang der Belege: das Offboarding (siehe Kopf). Nur die
-- Verwaltungsrolle darf die Funktion ausführen; sie setzt den Zaun und die
-- Kennzeichnung für GENAU ihren Kundenbereich und nimmt beide wieder zurück. Die
-- Kennzeichnung ist keine Sicherheitsgrenze — die sind die Rechte —, sondern der
-- ausdrücklich benannte Weg. Entwurf, Bericht und Zähler löscht danach
-- TenantRepository.offboard (Recht der Verwaltungsrolle).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_berichte_des_kundenbereichs_entfernen(p_tenant UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    entfernt BIGINT := 0;
    n BIGINT;
    zaun TEXT := current_setting('app.tenant_id', true);
BEGIN
    IF p_tenant IS NULL THEN
        RAISE EXCEPTION 'a tenant scope is required' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.tenant_id', p_tenant::text, true);
    PERFORM set_config('uems.berichte_entfernen', p_tenant::text, true);
    DELETE FROM bericht_abruf WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM bericht_aenderung WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM bericht_revision_anstoss WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM bericht_quelle WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM bericht_stand WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    PERFORM set_config('uems.berichte_entfernen', '', true);
    PERFORM set_config('app.tenant_id', coalesce(zaun, ''), true);
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_berichte_des_kundenbereichs_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_berichte_des_kundenbereichs_entfernen(UUID) TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben (§6.1). Niemand hat
-- DELETE auf Stand, Anstoß, Abruf oder Protokoll; die Quellen löscht nur, wer
-- einen Entwurf ersetzt (der Trigger lässt nur dessen Zeilen gehen).
-- -----------------------------------------------------------------------------
REVOKE ALL ON bericht, bericht_entwurf, bericht_stand, bericht_quelle, bericht_revision_anstoss, bericht_abruf,
    bericht_aenderung, bericht_kennung_seq FROM ${appDbUser}, ${adminDbUser};

-- Die Anwendung (IP-5, IP-7, IP-10): anlegen und archivieren, den Entwurf bilden
-- und ersetzen, freigeben (Stand + Quellen, „ersetzt durch“ am Vorgänger),
-- Anstöße erledigen oder verwerfen, Abrufe und Protokoll anhängen, Kennung vergeben.
GRANT SELECT, INSERT ON bericht TO ${appDbUser};
GRANT UPDATE (archiviert_am) ON bericht TO ${appDbUser};
GRANT SELECT, INSERT ON bericht_entwurf TO ${appDbUser};
GRANT UPDATE (abzug, pruefsumme, datenstand, gebildet_von) ON bericht_entwurf TO ${appDbUser};
GRANT SELECT, INSERT ON bericht_stand TO ${appDbUser};
GRANT UPDATE (ersetzt_durch_nr) ON bericht_stand TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON bericht_quelle TO ${appDbUser};
GRANT SELECT ON bericht_revision_anstoss TO ${appDbUser};
GRANT UPDATE (zustand, erledigt_durch_nr, verworfen_begruendung, verworfen_von_sub, verworfen_von_name, verworfen_am)
    ON bericht_revision_anstoss TO ${appDbUser};
GRANT SELECT, INSERT ON bericht_abruf TO ${appDbUser};
GRANT SELECT, INSERT ON bericht_aenderung TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON bericht_kennung_seq TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: Kaskade (IP-8) und Strukturläufer (IP-9)
-- bilden den Entwurf neu (samt Quellen) und hängen Anstöße an; das Offboarding
-- löscht Entwurf, Bericht und Zähler — die Belege nur über die Funktion oben.
GRANT SELECT ON bericht, bericht_entwurf, bericht_stand, bericht_quelle, bericht_revision_anstoss, bericht_abruf,
    bericht_aenderung, bericht_kennung_seq TO ${adminDbUser};
GRANT UPDATE (abzug, pruefsumme, datenstand, gebildet_von) ON bericht_entwurf TO ${adminDbUser};
GRANT INSERT, DELETE ON bericht_quelle TO ${adminDbUser};
GRANT INSERT ON bericht_revision_anstoss TO ${adminDbUser};
GRANT DELETE ON bericht, bericht_entwurf, bericht_kennung_seq TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE bericht_aenderung_id_seq TO ${appDbUser};

COMMENT ON FUNCTION bericht_vokabular() IS
    'UEMS AP-12 IP-4: die Vokabulare des Bericht-Vertrags (docs/contracts/v2/bericht-vectors.json → vokabulare), '
    'Zeile für Zeile — die EINE Stelle, die jeder Vokabular-CHECK der Berichts-Tabellen fragt.';
COMMENT ON FUNCTION bericht_vorlage() IS
    'UEMS AP-12 IP-4: Vorlage → Geltung und Zeitraum, Zeile für Zeile docs/contracts/v2/bericht-vorlagen.json.';
COMMENT ON TABLE bericht_stand IS
    'UEMS AP-12 IP-4: ein freigegebener Berichtsstand — Abzug als Text mit Prüfsumme (E1), append-only für jede '
    'Rolle (E13 S1); nur ersetzt_durch_nr wird genau einmal gesetzt; einziger Ausgang ist das Offboarding.';
COMMENT ON FUNCTION uems_berichts_belege(UUID) IS
    'UEMS AP-12 IP-4: die freigegebenen Berichtsstände, die ein Objekt als Quelle zitieren (E13 S2) — '
    'SECURITY INVOKER; gerufen erst von den harten Löschwegen in IP-12.';

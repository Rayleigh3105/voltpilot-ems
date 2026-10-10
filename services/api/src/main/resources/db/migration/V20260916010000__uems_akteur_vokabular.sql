-- =============================================================================
-- UEMS AP-03 IP-7 — EIN Akteur-Vokabular in Register-Journal, Handeingriff,
-- Befehls-Verlauf und Änderungsprotokoll
-- =============================================================================
--
-- Das Vokabular (AP-03 §4.4 Invariante 11, W7, §6.3) steht seit V20260911140000
-- an messstelle_aenderung und an jedem späteren *_aenderung-Protokoll:
--
--   actor_sub    das JWT-Subject (NULL nur für VoltPilot selbst, ohne Person)
--   actor_name   der Name, wie er im Protokoll steht
--   actor_rolle  die Rolle, unter der gehandelt wurde (NULL = nicht festgehalten)
--   actor_art    kunde | unterstuetzung | voltpilot | notfall
--
-- Geschrieben wird es an EINER Stelle: uems/ProtokollAkteur (aus dem Zugriff-Kontext
-- der Anfrage). Diese Migration bringt die vier Protokolle auf dieselben Spalten:
--
--   1. ort_aenderung          akteur_sub/akteur_name HEISSEN jetzt actor_sub/actor_name;
--                             actor_rolle, actor_art neu und NULLBAR: der Bestand hat keine
--                             Rolle und — außer bei VoltPilot, das der Name sagt — keine Art.
--                             Für ihn wird keine erfunden; das Lesemodell antwortet für ihn
--                             Zeichen für Zeichen wie vorher.
--   2. register_write_event   actor_sub/actor_name gab es; actor_rolle, actor_art neu,
--                             im Bestand leer. actor_role/origin bleiben (Altbestand).
--   3. device_override,       Handeingriffe: created_by bleibt (das Subject, wie heute);
--      consumer_override,     actor_sub … actor_art neu, im Bestand leer.
--      consumer_audit_event   (actor bleibt das Subject.)
--   4. device_command_log     Befehls-Verlauf: actor_* neu, nur an Ereignissen, die ein
--                             Mensch auslöst (heute „Jetzt voll laden"/„Laden pausieren");
--                             abgeleitete Zeilen tragen keinen Urheber.
--
-- ⚠ Nur ort_aenderung ändert Bestandszeilen (Spaltenname + Art). Alle anderen Tabellen
--   bekommen LEERE Spalten — der Bestandsschutz-Fingerabdruck bleibt dort gleich.
-- ⚠ Rechte: alle sechs Tabellen haben Tabellen-Grants (keine Spalten-Grants) — die neuen
--   Spalten sind ohne weiteren GRANT beschreibbar, UPDATE/DELETE bleiben, wie sie waren.

-- -----------------------------------------------------------------------------
-- 1. ort_aenderung — die Form der übrigen Protokolle
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'ort_aenderung'
                 AND column_name = 'akteur_sub') THEN
        ALTER TABLE ort_aenderung RENAME COLUMN akteur_sub TO actor_sub;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'ort_aenderung'
                 AND column_name = 'akteur_name') THEN
        ALTER TABLE ort_aenderung RENAME COLUMN akteur_name TO actor_name;
    END IF;
END $$;

ALTER TABLE ort_aenderung ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE ort_aenderung ADD COLUMN IF NOT EXISTS actor_art TEXT;

-- Die Art des Bestands steht nur dort, wo die Zeile sie schon SAGT: VoltPilot ohne Person
-- (Subject NULL: Bestandsübernahme, Anlegen des Kundenbereichs) und die Plattform am
-- Umschalter, die OrtProtokoll als „VoltPilot (…)" schreibt — genau die Ableitung, die das
-- Lesemodell bis heute zur Lesezeit macht. Jede andere Zeile behält KEINE Art und KEINE
-- Rolle: beides wurde nicht festgehalten, und geraten wird nichts.
-- Das Protokoll ist append-only (Trigger); diese Nachtragung ist die EINE Ausnahme.
ALTER TABLE ort_aenderung DISABLE TRIGGER ort_aenderung_append_only;
UPDATE ort_aenderung
   SET actor_art = 'voltpilot'
 WHERE actor_art IS NULL
   AND (actor_sub IS NULL OR actor_name LIKE 'VoltPilot (%');
ALTER TABLE ort_aenderung ENABLE TRIGGER ort_aenderung_append_only;

ALTER TABLE ort_aenderung DROP CONSTRAINT IF EXISTS ort_aenderung_actor_art_chk;
ALTER TABLE ort_aenderung ADD CONSTRAINT ort_aenderung_actor_art_chk
    CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'));
ALTER TABLE ort_aenderung DROP CONSTRAINT IF EXISTS ort_aenderung_actor_rolle_chk;
ALTER TABLE ort_aenderung ADD CONSTRAINT ort_aenderung_actor_rolle_chk
    CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
           'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'));
-- Der bestehende CHECK ort_aenderung_akteur_chk bleibt, wie er ist (die Umbenennung zieht
-- seinen Ausdruck mit): Name nicht leer, Subject nicht leer. Dazu die Regel der übrigen
-- Protokolle, aber nur für Zeilen, die eine Art TRAGEN — der Bestand hat keine.
ALTER TABLE ort_aenderung DROP CONSTRAINT IF EXISTS ort_aenderung_actor_voltpilot_chk;
ALTER TABLE ort_aenderung ADD CONSTRAINT ort_aenderung_actor_voltpilot_chk
    CHECK (actor_art IS NULL OR actor_sub IS NOT NULL OR actor_art = 'voltpilot');

COMMENT ON COLUMN ort_aenderung.actor_rolle IS
    'AP-03 IP-7: Rolle, unter der gehandelt wurde; NULL = nicht festgehalten (Bestand vor V20260916010000).';
COMMENT ON COLUMN ort_aenderung.actor_art IS
    'AP-03 IP-7: kunde | unterstuetzung | voltpilot | notfall (uems/ProtokollAkteur); NULL nur im Bestand.';

-- -----------------------------------------------------------------------------
-- 2. register_write_event — Rolle und Art neben der bisherigen Herkunft
-- -----------------------------------------------------------------------------
ALTER TABLE register_write_event ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE register_write_event ADD COLUMN IF NOT EXISTS actor_art TEXT;
ALTER TABLE register_write_event DROP CONSTRAINT IF EXISTS ck_register_write_event_actor_art;
ALTER TABLE register_write_event ADD CONSTRAINT ck_register_write_event_actor_art
    CHECK (actor_art IS NULL OR actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'));
ALTER TABLE register_write_event DROP CONSTRAINT IF EXISTS ck_register_write_event_actor_rolle;
ALTER TABLE register_write_event ADD CONSTRAINT ck_register_write_event_actor_rolle
    CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
           'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'));
COMMENT ON COLUMN register_write_event.actor_art IS
    'AP-03 IP-7: kunde | unterstuetzung | voltpilot | notfall; NULL im Bestand und an Box-Meldungen (origin geraet).';

-- -----------------------------------------------------------------------------
-- 3. Handeingriffe — der laufende Eingriff und sein Journal
-- -----------------------------------------------------------------------------
ALTER TABLE device_override ADD COLUMN IF NOT EXISTS actor_sub TEXT;
ALTER TABLE device_override ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE device_override ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE device_override ADD COLUMN IF NOT EXISTS actor_art TEXT;
ALTER TABLE device_override DROP CONSTRAINT IF EXISTS device_override_actor_chk;
ALTER TABLE device_override ADD CONSTRAINT device_override_actor_chk
    CHECK (coalesce(
        CASE WHEN actor_art IS NULL
             THEN actor_sub IS NULL AND actor_name IS NULL AND actor_rolle IS NULL
             ELSE actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
                  AND btrim(actor_name) <> ''
                  AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')
                  AND (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
                       'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
        END, false));

ALTER TABLE consumer_override ADD COLUMN IF NOT EXISTS actor_sub TEXT;
ALTER TABLE consumer_override ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE consumer_override ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE consumer_override ADD COLUMN IF NOT EXISTS actor_art TEXT;
ALTER TABLE consumer_override DROP CONSTRAINT IF EXISTS consumer_override_actor_chk;
ALTER TABLE consumer_override ADD CONSTRAINT consumer_override_actor_chk
    CHECK (coalesce(
        CASE WHEN actor_art IS NULL
             THEN actor_sub IS NULL AND actor_name IS NULL AND actor_rolle IS NULL
             ELSE actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
                  AND btrim(actor_name) <> ''
                  AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')
                  AND (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
                       'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
        END, false));

ALTER TABLE consumer_audit_event ADD COLUMN IF NOT EXISTS actor_sub TEXT;
ALTER TABLE consumer_audit_event ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE consumer_audit_event ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE consumer_audit_event ADD COLUMN IF NOT EXISTS actor_art TEXT;
ALTER TABLE consumer_audit_event DROP CONSTRAINT IF EXISTS consumer_audit_event_actor_chk;
ALTER TABLE consumer_audit_event ADD CONSTRAINT consumer_audit_event_actor_chk
    CHECK (coalesce(
        CASE WHEN actor_art IS NULL
             THEN actor_sub IS NULL AND actor_name IS NULL AND actor_rolle IS NULL
             ELSE actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
                  AND btrim(actor_name) <> ''
                  AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')
                  AND (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
                       'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
        END, false));

-- -----------------------------------------------------------------------------
-- 4. device_command_log — der Urheber eines Ereignisses, das ein Mensch auslöst
-- -----------------------------------------------------------------------------
ALTER TABLE device_command_log ADD COLUMN IF NOT EXISTS actor_sub TEXT;
ALTER TABLE device_command_log ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE device_command_log ADD COLUMN IF NOT EXISTS actor_rolle TEXT;
ALTER TABLE device_command_log ADD COLUMN IF NOT EXISTS actor_art TEXT;
ALTER TABLE device_command_log DROP CONSTRAINT IF EXISTS device_command_log_actor_chk;
ALTER TABLE device_command_log ADD CONSTRAINT device_command_log_actor_chk
    CHECK (coalesce(
        CASE WHEN actor_art IS NULL
             THEN actor_sub IS NULL AND actor_name IS NULL AND actor_rolle IS NULL
             ELSE kind = 'ereignis'
                  AND actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
                  AND btrim(actor_name) <> ''
                  AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')
                  AND (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
                       'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
        END, false));

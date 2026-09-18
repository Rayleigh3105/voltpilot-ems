-- =============================================================================================
-- AP-14 · Bestandsblatt NACH den Migrationen und Start-Läufern            Stand 18.09.2026
-- Nach dem Captain-Entscheid vom 18.09.2026 (E1 = B: kein Freigabe-Tor) durchgesehen: die Abfragen
-- sind unverändert, geändert sind nur Kommentarzeilen „ENTSCHEIDUNG“ (Z05, Z06, Z07).
-- =============================================================================================
-- REIN LESEND. Zwei Einsätze:
--   (1) auf der KOPIE der Generalprobe (Kasten E3) — dort ist es die Vorschau, die das Fundament
--       vermisst hat: was die Läufer aus dem echten Bestand ABLEITEN würden, bevor es in Produktion
--       geschieht (ist/A §2: „Funktion/Teilnahme — kein lesender Trockenlauf“);
--   (2) am Rollout-Tag im Wartungsfenster, VOR dem Öffnen des Portals (Drehbuch Schritt 7) —
--       stimmen die Zählungen mit der Generalprobe überein, ist das der Beleg für „Go“.
--
-- Schema-Stand: `uems` @ ad3f64df. Gelesen sind nur Tabellen, deren Spalten an den Migrationen
-- dieses Stands geprüft wurden (V20260914190000 funktion/funktion_teilnahme,
-- V20260916060000 zugriff_bestand, flyway_schema_history, pg_constraint).
-- Geprüft von `BetriebsabfragenBlaetterTest` gegen eine Wegwerf-Datenbank mit dem vollen
-- Migrationssatz von `uems`: jede Abfrage läuft, keine schreibt, und die Ergebnisform
-- (Spaltenname und -typ) ist je Abfrage festgehalten. Fahren: `README.md` daneben.
-- =============================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

-- Z01 · FRAGE: Sind alle Migrationen angewandt, keine fehlgeschlagen — und welche dauerten am längsten?
--       ENTSCHEIDUNG: Länge des Wartungsfensters (Regel D4: gemessene Summe × 3, mindestens 30 min).
--       AUFFÄLLIG, WENN: fehlgeschlagen > 0 · eine einzelne Migration über 60 s (dann hält sie eine
--       Sperre, die der Writer spürt — Checkliste PR 933 und PR 943).
SELECT count(*) FILTER (WHERE success) AS angewandt, count(*) FILTER (WHERE NOT success) AS fehlgeschlagen,
       max(version::numeric) FILTER (WHERE success AND version ~ '^[0-9]+$') AS hoechste_version,
       sum(execution_time) FILTER (WHERE installed_on > now() - interval '1 day') AS millisekunden_letzter_tag
  FROM flyway_schema_history;
SELECT version, description, execution_time AS millisekunden, installed_on
  FROM flyway_schema_history
 WHERE installed_on > now() - interval '1 day'
 ORDER BY execution_time DESC LIMIT 12;

-- Z02 · FRAGE: Trägt `ort_aenderung_art_chk` die Zwölfer-Liste (Befund ist/D §0 geheilt)?
--       ENTSCHEIDUNG: Go/No-Go am Rollout-Tag. Fehlt `rolle_gesetzt`, scheitert nach dem Öffnen
--       jede Rollen-Zuordnung am CHECK — still, ohne Test (ist/D §0, Folge b).
SELECT conname, pg_get_constraintdef(oid) LIKE '%rolle_gesetzt%' AS traegt_rolle_gesetzt,
       pg_get_constraintdef(oid) LIKE '%rolle_entzogen%' AS traegt_rolle_entzogen
  FROM pg_constraint WHERE conname = 'ort_aenderung_art_chk';

-- Z03 · FRAGE: Was hat der Funktions-Läufer aus dem Bestand abgeleitet?
--       ENTSCHEIDUNG: die VORSCHAU für den Betreiber (Regel B6). Jede steuernde Bestandsanlage muss
--       als `aktiv` + `uebernommen` stehen; `eingerichtet` heißt: Bestandsfakten sagen „steuert
--       nicht“ (FunktionBestandFakten.java:70-108). Eine Teilnahme wird vom Läufer „nie wieder
--       betrachtet“ — ein falsches Urteil bliebe stehen, deshalb wird es HIER gelesen, bevor es gilt.
SELECT f.funktion, f.zustand AS zustand_am_standort, count(*) AS standorte
  FROM funktion f GROUP BY 1, 2 ORDER BY 1, 2;
SELECT ft.zustand AS zustand_der_anlage, ft.uebernommen, count(*) AS anlagen
  FROM funktion_teilnahme ft GROUP BY 1, 2 ORDER BY 1, 2;

-- Z04 · FRAGE: Welche Anlagen haben NACH den Läufern keine Teilnahme?
--       ENTSCHEIDUNG: Regel N2 (nicht zugeordnet) — das dürfen nur Anlagen ohne Standort sein (Mehr-Anlagen-Kunden mit
--       offenem Vorschlag). Eine Anlage MIT Standort und OHNE Teilnahme ist der Halb-Zustand aus
--       ist/A §1.4 und gehört nach Bau-Paket IP-3 der Vergangenheit an.
SELECT count(*) FILTER (WHERE hat_standort AND NOT hat_teilnahme) AS mit_standort_ohne_teilnahme,
       count(*) FILTER (WHERE NOT hat_standort)                    AS ohne_standort,
       count(*)                                                    AS anlagen
  FROM (SELECT s.id,
               EXISTS (SELECT 1 FROM anlage_standort z WHERE z.site_id = s.id
                          AND z.aufgehoben_am IS NULL AND z.gueltig_bis IS NULL) AS hat_standort,
               EXISTS (SELECT 1 FROM funktion_teilnahme ft WHERE ft.site_id = s.id) AS hat_teilnahme
          FROM site s) x;

-- Z05 · FRAGE: Hat der Rechte-Läufer jeden Kundenbereich erreicht?
--       ENTSCHEIDUNG: Regel N5 (nicht zugeordnet) — ohne Stichtag gilt AP-03 E12 weiter (niemand ist ausgesperrt), aber die
--       Benutzerverwaltung des Kunden ist leer. Ursachen: Keycloak nicht erreichbar beim Start,
--       oder über 1 000 Konten. „ohne_stichtag“ muss auf der Kopie erklärt sein und am Rollout-Tag der
--       Generalprobe entsprechen (Regel D8) — ein Tor G2 gibt es mit E1 = B nicht mehr.
SELECT (SELECT count(*) FROM tenant)                                                   AS kundenbereiche,
       (SELECT count(*) FROM zugriff_bestand WHERE herkunft = 'bestandslauf')          AS stichtag_bestandslauf,
       (SELECT count(*) FROM zugriff_bestand WHERE herkunft = 'neuer_kundenbereich')   AS stichtag_neu,
       (SELECT count(*) FROM tenant t
         WHERE NOT EXISTS (SELECT 1 FROM zugriff_bestand z WHERE z.tenant_id = t.id))  AS ohne_stichtag,
       (SELECT sum(konten) FROM zugriff_bestand)                                       AS konten_uebernommen;

-- Z06 · FRAGE: Ist der Registry-Schlüssel gewechselt und der Befehlsverlauf geschlossen?
--       ENTSCHEIDUNG: Go/No-Go am Rollout-Tag (Regel D8) — beide Werte müssen der Generalprobe
--       entsprechen: der Schlüsselwechsel von `site_id` auf den Schlüssel je Box (V20260915040000) ist
--       vollzogen, und V20260913200000 hat den Befehlsverlauf abgemeldeter Boxen beendet (die Zahl
--       dazu liefert Q11 für die Release-Notiz).
--       AUFFÄLLIG, WENN: registry_schluessel_je_box = false · offene_perioden_ohne_box > 0.
SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_registry_state_je_box') AS registry_schluessel_je_box,
       (SELECT count(*) FROM device_command_log l
         WHERE l.kind = 'periode' AND l.ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM device d WHERE d.id = l.device_id AND d.ausgebaut_am IS NULL))
                                                                                         AS offene_perioden_ohne_box;

-- Z07 · FRAGE: Stehen die Arbeitslisten nach dem ersten Lauf, oder laufen sie auf?
--       ENTSCHEIDUNG: Nachlauf M-6 — ein Tor G2 (Pilot öffnen) gibt es mit E1 = B nicht mehr. Wachsen
--       die Listen nach 24 h, ist das ein Befund: den betroffenen Läufer per gitops-Wert aus (Regel P6)
--       und niemanden über die Pilotkunden hinaus ansprechen (E10), bis sie stehen.
SELECT (SELECT count(*) FROM messreihe_viertelstunde_arbeit) AS arbeit_viertelstunde_offen,
       (SELECT count(*) FROM messreihe_tag_arbeit)           AS arbeit_tag_offen,
       (SELECT count(*) FROM messreihe_periode_arbeit)       AS arbeit_periode_offen;

COMMIT;

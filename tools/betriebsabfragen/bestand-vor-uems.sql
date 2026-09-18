-- =============================================================================================
-- AP-14 · Bestandsblatt VOR der Zusammenführung uems → main              Stand 18.09.2026
-- Nach dem Captain-Entscheid vom 18.09.2026 (E1 = B: kein Freigabe-Tor) durchgesehen: die Abfragen
-- sind unverändert, geändert sind nur Kommentarzeilen „ENTSCHEIDUNG“ (Q02, Q03, Q07, Q17, Q18).
-- =============================================================================================
-- REIN LESEND. Der Captain fährt dieses Blatt selbst gegen die Produktions-Datenbank; firstmate
-- und jede Crew haben keinen Produktionszugang.
--
-- Schema-Stand: `main` @ 4aa1e7fb (= Produktions-Image laut gitops 4aa30e9). Jede Tabelle und
-- Spalte unten ist an den Migrationen dieses Stands gelesen (V1__core_schema, V20260719030000,
-- V20260803000000, V20260823000000, V20260841000000, V20260845000000, V20260911100000,
-- V20260911140000, V20260911290000, V20260912093000, V20260912170000 …). Es wird KEINE Tabelle
-- berührt, die erst `uems` anlegt.
-- Geprüft von `BetriebsabfragenBlaetterTest` gegen eine Wegwerf-Datenbank mit GENAU dem
-- Migrationssatz von `main` (`services/api/src/test/resources/migration/main-migrations.txt`):
-- jede Abfrage läuft, keine schreibt, und die Ergebnisform (Spaltenname und -typ) ist je
-- Abfrage festgehalten. Wie man das Blatt fährt: `tools/betriebsabfragen/README.md`.
--
-- Ausführung: Rolle mit BYPASSRLS bzw. Superuser. `row_security = off` verhindert einen scheinbar
-- leeren Befund durch die Mandanten-RLS; `READ ONLY` macht jeden Schreibversuch zum Fehler.
-- Teil A–C liefern NUR ZÄHLUNGEN (teilbar mit der Crew). Teil D nennt interne Kennungen
-- (UUIDs, keine Kundennamen) und ist für die Augen des Captains.
--
-- Je Abfrage steht: FRAGE · ENTSCHEIDUNG, die an ihrem Ergebnis hängt · AUFFÄLLIG, WENN.
-- =============================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

-- =============================================================================================
-- TEIL A — Von welchem Zustand aus wird geplant? (Kasten W3: „Einführung“ gegen „Fortsetzung“)
-- =============================================================================================

-- Q01 · FRAGE: Welcher Migrationsstand liegt in Produktion, und gibt es fehlgeschlagene Zeilen?
--       ENTSCHEIDUNG: Tor G1 (Ausrollen) — die Generalprobe (E3) muss auf GENAU diesem Stand
--       aufsetzen; ein fehlgeschlagener Eintrag sperrt das Ausrollen, bis er verstanden ist.
--       AUFFÄLLIG, WENN: fehlgeschlagen > 0 · hoechste_version <> 20260916203000 ·
--       helfer_check_angewandt = false (dann gilt Befund ist/D §0 anders als angenommen).
SELECT count(*) FILTER (WHERE success)                                         AS angewandt,
       count(*) FILTER (WHERE NOT success)                                     AS fehlgeschlagen,
       max(version::numeric) FILTER (WHERE success AND version ~ '^[0-9]+$')   AS hoechste_version,
       bool_or(version = '20260916203000' AND success)                         AS helfer_check_angewandt,
       count(*) FILTER (WHERE success AND script ILIKE '%uems_%')              AS uems_migrationen,
       max(installed_on)                                                       AS letzter_lauf
  FROM flyway_schema_history;

-- Q02 · FRAGE: Wie viele Kundenbereiche haben keine, eine, mehrere Anlagen?
--       ENTSCHEIDUNG: E10 (Betreuungs-Reihenfolge des Bestands — mit E1 = B gibt es keine
--       Freigabe-Wellen mehr) und die Auswahl der Pilotkunden P1/P2: Ein-Anlagen-Kunden bekommen
--       nichts zu bestätigen, Mehr-Anlagen-Kunden sehen am Rollout-Tag die Vorschlags-Karte — alle zugleich.
--       AUFFÄLLIG, WENN: die Klasse „6 und mehr“ groß ist — dann wiegt „alles in einem Zug
--       zuordnen“ (Regel N4) schwerer als angenommen.
WITH je AS (
    SELECT t.id, count(s.id) AS anlagen
      FROM tenant t LEFT JOIN site s ON s.tenant_id = t.id
     GROUP BY t.id)
SELECT CASE WHEN anlagen = 0 THEN 'a · 0 Anlagen'
            WHEN anlagen = 1 THEN 'b · 1 Anlage'
            WHEN anlagen BETWEEN 2 AND 5 THEN 'c · 2 bis 5 Anlagen'
            ELSE 'd · 6 und mehr Anlagen' END                                  AS klasse,
       count(*)                                                                AS kundenbereiche,
       sum(anlagen)                                                            AS anlagen
  FROM je GROUP BY 1 ORDER BY 1;

-- Q03 · FRAGE: Wie weit ist die Standort-Übernahme gelaufen, die `main` seit dem 11.09.2026 bei
--       jedem api-Start fährt (BestandsuebernahmeLaeufer, Vorgabe AN)?
--       ENTSCHEIDUNG: W3 — der Plan setzt auf DIESEM Bild auf. Lage c und f sind Läufer-Fehler
--       oder Sonderfälle und müssen vor Tor G1 einzeln verstanden sein (Teil D, Q16). Lage d ist
--       mit E1 = B die Zahl der Kundenbereiche, die am Rollout-Tag die Vorschlags-Karte sehen.
--       AUFFÄLLIG, WENN: Lage c > 0 · Lage f > 0 · ohne_unternehmen > 0.
WITH je AS (
    SELECT t.id,
           (SELECT count(*) FROM site s WHERE s.tenant_id = t.id)                          AS anlagen,
           (SELECT count(*) FROM unternehmen u WHERE u.tenant_id = t.id)                   AS unternehmen,
           (SELECT count(*) FROM standort st
             WHERE st.tenant_id = t.id AND st.zustand = 'entwurf')                         AS standorte_entwurf,
           (SELECT count(*) FROM standort st
             WHERE st.tenant_id = t.id AND st.archiviert_am IS NOT NULL)                   AS standorte_archiviert,
           (SELECT count(DISTINCT z.site_id) FROM anlage_standort z
             WHERE z.tenant_id = t.id AND z.aufgehoben_am IS NULL
               AND z.gueltig_bis IS NULL)                                                  AS anlagen_zugeordnet,
           (SELECT count(*) FROM standort_vorschlag v WHERE v.tenant_id = t.id)            AS vorschlaege
      FROM tenant t)
SELECT CASE WHEN anlagen = 0                                        THEN 'a · ohne Anlage'
            WHEN anlagen = 1 AND anlagen_zugeordnet = 1             THEN 'b · eine Anlage, Standort da'
            WHEN anlagen = 1                                        THEN 'c · eine Anlage, KEIN Standort'
            WHEN vorschlaege = anlagen AND anlagen_zugeordnet = 0   THEN 'd · mehrere Anlagen, alle als Vorschlag offen'
            WHEN anlagen_zugeordnet = anlagen                       THEN 'e · mehrere Anlagen, alle zugeordnet'
            ELSE                                                         'f · gemischt — ansehen' END AS lage,
       count(*)                                  AS kundenbereiche,
       sum(anlagen)                              AS anlagen,
       sum(vorschlaege)                          AS offene_vorschlagszeilen,
       sum(standorte_entwurf)                    AS standorte_im_entwurf,
       sum(standorte_archiviert)                 AS standorte_archiviert,
       count(*) FILTER (WHERE unternehmen = 0)   AS ohne_unternehmen
  FROM je GROUP BY 1 ORDER BY 1;

-- Q04 · FRAGE: Wer hat bisher ins Ortsprotokoll geschrieben, und mit welchen Wörtern?
--       ENTSCHEIDUNG: (1) Prämisse des Bau-Pakets vp-uems-migration-produktionsreihenfolge —
--       gibt es Zeilen `rolle_gesetzt`/`rolle_entzogen`, wäre die unberichtigte V20260916150000
--       in Produktion GESCHEITERT (ist/D §0, Folge a); die Generalprobe muss mit diesen Zeilen
--       bestehen. (2) Dauer des einen UPDATE in V20260916010000 (es fasst jede Zeile OHNE Person an —
--       in Produktion heute praktisch alle; der append-only-Trigger ist dafür kurz ausgesetzt).
--       AUFFÄLLIG, WENN: zeilen_einer_person > 0 bei den Arten angelegt/verschoben — auf `main`
--       gibt es dafür keine Fläche · zeilen_fremder_automat > 0.
--       ⚠ Der Akteur wird GEZÄHLT, nicht genannt: Teil A bleibt teilbar (der Name eines Akteurs ist
--         der Name einer Person). Wer es war, liest der Betreiber danach an derselben Tabelle.
SELECT art,
       count(*)                                                                  AS zeilen,
       count(DISTINCT akteur_name)                                               AS akteure,
       count(*) FILTER (WHERE akteur_sub IS NULL)                                AS zeilen_ohne_person,
       count(*) FILTER (WHERE akteur_sub IS NOT NULL)                            AS zeilen_einer_person,
       count(*) FILTER (WHERE akteur_sub IS NULL
                          AND akteur_name <> 'VoltPilot (Bestandsübernahme)')    AS zeilen_fremder_automat,
       min(created_at)                                                           AS erste,
       max(created_at)                                                           AS letzte
  FROM ort_aenderung GROUP BY art ORDER BY zeilen DESC;

-- Q05 · FRAGE: Wie groß ist der Helfer-Bestand, den zwei der neuen Migrationen anfassen?
--       ENTSCHEIDUNG: Umfang der Rückfüllung „Fassung 1 gilt seit Beginn“ (V20260912210000) und
--       Prämisse von V20260913143000 (beide ändern messstelle_formel_term, das in Produktion
--       `gilt_als_erzeugung` schon trägt — ist/D §0, nicht geprüfter Rest). Zusammen mit der
--       H-4-Abfrage fahren.
SELECT (SELECT count(*) FROM messstelle)                                       AS messstellen,
       (SELECT count(*) FROM messstelle WHERE art = 'berechnet')               AS davon_berechnet,
       (SELECT count(*) FROM messstelle_formel_term)                           AS formel_terme,
       (SELECT count(*) FROM messstelle_formel_term WHERE gilt_als_erzeugung)  AS terme_gelten_als_erzeugung,
       (SELECT count(DISTINCT tenant_id) FROM messstelle)                      AS kundenbereiche_mit_messstellen;

-- =============================================================================================
-- TEIL B — Boxen, ältere Edges, Messlast (Kästen E4, E5, E6; Regeln X1–X6, L1–L6)
-- =============================================================================================

-- Q06 · FRAGE: Welche Box-Zustände gibt es, und wie viele Anlagen haben mehr als eine Box?
--       ENTSCHEIDUNG: Pilotfall P3 (Anlage mit zwei Boxen) — echt oder nur im Simulator; Zahl der
--       Anlagen, deren Registry-Push sich ändert, sobald dort Datenquellen entstehen (Regel X3).
SELECT status, kind, count(*) AS boxen FROM device GROUP BY status, kind ORDER BY boxen DESC;
SELECT boxen_je_anlage, count(*) AS anlagen
  FROM (SELECT site_id, count(*) AS boxen_je_anlage FROM device GROUP BY site_id) x
 GROUP BY boxen_je_anlage ORDER BY boxen_je_anlage;

-- Q07 · FRAGE: Welche Edge-Stände laufen im Feld?
--       ENTSCHEIDUNG: E4 (welches Edge-Release gehört zur ersten Freigabe) und Nachweis NW-3 — jedes
--       hier genannte Paar (core, palette) mit mindestens einer Box ist ein AUSGELIEFERTES Image,
--       gegen das die neue Cloud geprüft wird. „(keine Meldung)“ = Box ohne ausgerollte Automation
--       (V20260803000000: dann gibt es keine Zeile) — sie zählt als „unbekannt“, nie als aktuell.
SELECT coalesce(v.core_version, '(keine Meldung)')    AS core_version,
       coalesce(v.palette_version, '(keine Meldung)') AS palette_version,
       count(*)                                       AS boxen,
       min(v.reported_at)                             AS aelteste_meldung,
       max(v.reported_at)                             AS juengste_meldung
  FROM device d LEFT JOIN device_edge_version v ON v.device_id = d.id
 GROUP BY 1, 2 ORDER BY boxen DESC;

-- Q08 · FRAGE: Welche Bestandsboxen lehnt eine Box mit dem neuen Messbudget ab (PR 936)?
--       Ein freies Register kostet 2 000 ms je Lesung: Anteil = 200 / Kadenz in Sekunden [%];
--       Grenze 20 % (einschließlich erlaubt). Das ist die UNTERGRENZE — Katalogpunkte kommen dazu;
--       das exakte Urteil fährt Bau-Paket IP-17 über den Vertrag.
--       ENTSCHEIDUNG: Tor des Edge-Releases A (Regel X5): Klasse c muss 0 sein oder jeder
--       betroffene Kunde vorher umgestellt; Klasse b geht in die exakte Prüfung.
WITH je AS (
    SELECT device_id,
           count(*)                                         AS freie_register,
           sum(200.0 / cadence_s)                           AS anteil_frei_prozent,
           count(*) FILTER (WHERE cadence_s IS NULL)        AS ohne_kadenz
      FROM device_measurement_selection
     WHERE enabled AND custom_definition IS NOT NULL
     GROUP BY device_id)
SELECT CASE WHEN anteil_frei_prozent > 20 THEN 'c · über 20 % — neue Box LEHNT AB'
            WHEN anteil_frei_prozent > 10 THEN 'b · 10 bis 20 % — exakt prüfen (IP-17)'
            ELSE                               'a · bis 10 %' END AS klasse,
       count(*) AS boxen, sum(freie_register) AS freie_register, sum(ohne_kadenz) AS zeilen_ohne_kadenz
  FROM je GROUP BY 1 ORDER BY 1;

-- Q09 · FRAGE: Wie nah sind die Bestandsboxen heute an den Grenzen 120 (Warnung) und 600 Samples/min?
--       ENTSCHEIDUNG: E6 (Lastprofil) und die Wahl der Pilot-Boxen — eine Box, die schon warnt,
--       trägt keinen Messkunden-Piloten.
WITH je AS (
    SELECT device_id, count(*) AS punkte, sum(60.0 / cadence_s) AS samples_je_minute
      FROM device_measurement_selection
     WHERE enabled AND cadence_s IS NOT NULL
     GROUP BY device_id)
SELECT CASE WHEN samples_je_minute > 600 THEN 'd · über 600 (harte Grenze)'
            WHEN samples_je_minute >= 120 THEN 'c · 120 bis 600 (Warnung)'
            WHEN samples_je_minute >= 60  THEN 'b · 60 bis unter 120'
            ELSE                               'a · unter 60' END AS klasse,
       count(*) AS boxen, round(avg(samples_je_minute), 1) AS mittel, round(max(samples_je_minute), 1) AS hoechstwert
  FROM je GROUP BY 1 ORDER BY 1;

-- Q10 · FRAGE: Mit welchem Katalogstand sind Mess-Auswahlen gespeichert, und was hängt in der Luft?
--       ENTSCHEIDUNG: Regel X4 — vor jedem Heben von RUNTIME_VERSION (Edge-Release B) muss
--       `pending_edge` leer oder erklärt sein; sonst trifft die Sperre „jede Messwert-Änderung
--       abgelehnt bis Update“ laufende Änderungen.
SELECT catalog_version, apply_status, count(*) AS zeilen, count(DISTINCT device_id) AS boxen
  FROM device_measurement_selection GROUP BY 1, 2 ORDER BY 1, 2;

-- =============================================================================================
-- TEIL C — Was die Migrationen und das Wartungsfenster antreffen (Kasten E2; Regeln D1–D9)
-- =============================================================================================

-- Q11 · FRAGE: Wie viele offene Perioden im Befehlsverlauf gehören zu Boxen, die es nicht mehr gibt?
--       ENTSCHEIDUNG: Erwartete sichtbare Änderung von V20260913200000 („eine Anweisung, die für
--       immer lief, endet“) — die Zahl gehört in die Release-Notiz; 0 = nichts zu sagen.
SELECT count(*) AS offene_perioden_ohne_box
  FROM device_command_log l
 WHERE l.kind = 'periode' AND l.ended_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM device d WHERE d.id = l.device_id);

-- Q12 · FRAGE: Trägt der Registry-Zustand, was V20260915040000 annimmt?
--       ENTSCHEIDUNG: keine — reine Absicherung der Generalprobe (Schlüsselwechsel von `site_id`
--       auf (tenant_id, site_id, device_id); Zeilen ohne Box bleiben erlaubt).
SELECT count(*) AS zeilen, count(*) FILTER (WHERE device_id IS NULL) AS ohne_box FROM entity_registry_state;

-- Q13 · FRAGE: Welche Handeingriffe und Pausen laufen, und welche enden in den nächsten drei Stunden?
--       ENTSCHEIDUNG: Lage des Wartungsfensters (Regel D4): solange die api steht, erneuert niemand
--       eine Pause. Kein Fenster, in dem ein Handeingriff ausläuft, ohne dass der Kunde es weiß.
SELECT kind,
       count(*) FILTER (WHERE ends_at > now())                                AS laufend,
       count(*) FILTER (WHERE ends_at > now() AND ends_at < now() + interval '3 hours') AS endet_in_3h
  FROM device_override GROUP BY kind ORDER BY kind;

-- Q14 · FRAGE: Wie groß ist die Datenbank, und was haben Verdichter und Rückrechnung schon geschrieben?
--       ENTSCHEIDUNG: W5 — Schwelle des Speicher-Alarms aus der ECHTEN Belegung statt aus dem Satz
--       „0,5 TB“ der Doku; Zahl der 100-Messstellen-Kunden, die die Datenebene trägt (Regel L6);
--       Dauer von Sicherung und Wiederherstellung (Kasten E2).
SELECT pg_size_pretty(pg_database_size(current_database())) AS datenbank,
       pg_database_size(current_database())                 AS bytes;
SELECT h.hypertable_name AS tabelle,
       pg_size_pretty(hypertable_size(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass)) AS groesse,
       h.compression_enabled
  FROM timescaledb_information.hypertables h
 ORDER BY hypertable_size(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass) DESC
 LIMIT 15;
SELECT (SELECT count(*) FROM messreihe_viertelstunde_arbeit) AS arbeit_viertelstunde_offen,
       (SELECT count(*) FROM messreihe_tag_arbeit)           AS arbeit_tag_offen,
       (SELECT count(*) FROM messreihe_periode_arbeit)       AS arbeit_periode_offen;

-- Q15 · FRAGE: Gibt es den Rückweg überhaupt — läuft das WAL-Archiv (docs/backup-restore.md)?
--       ENTSCHEIDUNG: Kasten E2, Tor G1 — ohne laufendes WAL-Archiv gibt es keinen
--       Wiederherstellungspunkt und damit KEINEN Rückweg am Rollout-Tag.
--       AUFFÄLLIG, WENN: last_archived_time älter als eine Stunde · failed_count steigt.
--       Dazu außerhalb von SQL: `tools/backup/vp-db-backup-check.sh` (Alter des Basis-Backups).
SELECT archived_count, last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver;

-- =============================================================================================
-- TEIL D — Einzelfälle mit internen Kennungen (nur für die Augen des Captains)
-- =============================================================================================

-- Q16 · FRAGE: Welche Anlagen haben weder Standort noch Vorschlag (Lage c/f aus Q03)?
--       ENTSCHEIDUNG: vor Tor G1 je Zeile klären — der Läufer versucht es bei jedem api-Start neu
--       (BestandsuebernahmeLaeufer.java:46-47); bleibt eine Zeile stehen, ist es ein Fehler im Bau.
SELECT s.tenant_id, s.id AS site_id, s.created_at
  FROM site s
 WHERE NOT EXISTS (SELECT 1 FROM anlage_standort z
                    WHERE z.site_id = s.id AND z.aufgehoben_am IS NULL AND z.gueltig_bis IS NULL)
   AND NOT EXISTS (SELECT 1 FROM standort_vorschlag v WHERE v.site_id = s.id)
 ORDER BY s.created_at;

-- Q17 · FRAGE: Welche Boxen trifft Q08 Klasse b/c — wen muss man vor dem Edge-Release A ansprechen?
--       ENTSCHEIDUNG: Tor GA (Regel X5) — das ist die Kundenliste: wen der Betreiber vor dem
--       Edge-Release A anspricht. Eine Box der Klasse c bekommt das Release erst, nachdem ihr Plan
--       mit dem Kunden umgestellt ist; Klasse b geht in die exakte Prüfung (Bau-Paket IP-17).
SELECT device_id, site_id, tenant_id, count(*) AS freie_register,
       round(sum(200.0 / cadence_s), 1) AS anteil_frei_prozent, min(cadence_s) AS schnellste_kadenz_s
  FROM device_measurement_selection
 WHERE enabled AND custom_definition IS NOT NULL AND cadence_s IS NOT NULL
 GROUP BY device_id, site_id, tenant_id
HAVING sum(200.0 / cadence_s) > 10
 ORDER BY anteil_frei_prozent DESC;

-- Q18 · FRAGE: Welche Anlagen haben mehr als eine Box (Kandidaten für Pilotfall P3)?
--       ENTSCHEIDUNG: Pilotwahl (Regel P1) — gibt es eine Zeile, ist der Pilotfall P3 echt wählbar;
--       gibt es keine, läuft P3 nur im Simulator (Nachweis NW-3 mit zwei Box-Identitäten).
SELECT site_id, tenant_id, count(*) AS boxen, array_agg(status ORDER BY created_at) AS zustaende
  FROM device GROUP BY site_id, tenant_id HAVING count(*) > 1 ORDER BY boxen DESC;

COMMIT;

-- =============================================================================================
-- NICHT PER SQL BEANTWORTBAR (gehört trotzdem vor Tor G1):
--  · Konten je Kundenbereich über 1 000 (Keycloak-Verwaltung) — dort schreibt der Rechte-Läufer
--    keinen Stichtag, die Bestandsregel AP-03 E12 gilt weiter (KeycloakAdminClient.java:218).
--  · Alter des letzten Basis-Backups und eine geprobte Wiederherstellung (tools/backup/).
--  · Aufbewahrung im Ereignis-Bus: deckt sie das Wartungsfenster plus Reserve (Regel D5)?
--  · Bestandskunde mit reiner Verbrauchsanlage und Tarif (Geld-Regel, Kasten W7): zwei bekannte
--    Kunden am Portal ansehen — das Tarifmodell wurde für dieses Blatt nicht gelesen.
-- =============================================================================================

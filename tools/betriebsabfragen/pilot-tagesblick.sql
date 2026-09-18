-- =============================================================================================
-- AP-14 · Pilot-Tagesblick — die tägliche Betreiber-Sicht                  Stand 18.09.2026
-- =============================================================================================
-- REIN LESEND. Der Betreiber fährt dieses Blatt ab dem Rollout-Tag täglich (Ablauf §5.4 Schritt 3)
-- gegen das Schema von `uems`. Es ist die Betreiber-Sicht, bis ein Dashboard sie ersetzt (Regel P5).
--
-- ⚠ Es gibt KEIN Tor und KEINEN Zustand „Pilot“ (Entscheid E1 = B vom 18.09.2026). Das Blatt legt
-- nichts an, liest keinen Pilot-Zustand und filtert nach NICHTS außer der Betreiber-Liste.
-- „Pilotkunde“ heißt allein: der Betreiber sieht hin. Im System unterscheidet ihn nichts.
--
-- EINGABE: die Betreiber-Liste — die internen Kennungen der betreuten Kundenbereiche. Der Captain
-- führt sie selbst; sie steht in keiner Tabelle und ist ein Parameter des Blatts, kein Tor.
--   psql -v ON_ERROR_STOP=1 -v betreiber_liste='<uuid>,<uuid>,…' -f pilot-tagesblick.sql
-- Eine leere Liste liefert leere Ergebnisse — das ist kein Fehler, sondern eine leere Liste.
--
-- AUSGABE: NUR Zählungen und Alter. Die Kennungen, die in den Zeilen stehen, sind die der Liste
-- (und die der Boxen/Reihen des Betreuten) — der Betreiber hat sie ohnehin; er gibt dieses Blatt
-- nicht heraus. Teilbar ist es nicht, anders als Teil A–C des Bestandsblatts.
--
-- Ausführung wie bei den Bestandsblättern: Rolle mit BYPASSRLS bzw. Superuser. `row_security = off`
-- verhindert einen scheinbar leeren Befund durch die Mandanten-RLS; `READ ONLY` macht jeden
-- Schreibversuch zum Fehler.
--
-- Geprüft von `BetriebsabfragenBlaetterTest` gegen eine Wegwerf-Datenbank mit dem vollen
-- Migrationssatz von `uems`: jede Abfrage läuft, keine schreibt, Ergebnisform festgehalten.
-- Was der Bau heute NICHT protokolliert, steht als Lücke im README — geraten wird nichts.
-- =============================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

-- =============================================================================================
-- T01 · EINGANG JE QUELLE
-- =============================================================================================

-- T01a · FRAGE: Wie alt ist der jüngste Eingang je Quelle — Box für Box, Reihe für Reihe?
--       Quelle des Stands ist `messreihe_luecke_stand.zuletzt`, das der Lücken-Melder je Einheit
--       führt (Box: jüngster Eingang; Reihe: Messzeit des jüngsten guten Werts). Kein Scan über
--       die Rohwerte — der Stand ist die Buchführung des Baus.
--       ENTSCHEIDUNG: Ansprache des betreuten Kunden am selben Tag; ein Befund der Stufe 1
--       („ein Messwert geht verloren“) beginnt hier.
--       AUFFÄLLIG, WENN: einheiten_ueber_1h > 0 bei Boxen · aeltester_stand_min wächst von Tag zu Tag.
WITH liste AS (SELECT DISTINCT btrim(x)::uuid AS tenant_id
                 FROM unnest(string_to_array(:'betreiber_liste', ',')) AS x
                WHERE btrim(x) <> '')
SELECT l.tenant_id,
       st.art                                                                       AS quellen_art,
       count(*)                                                                     AS einheiten,
       count(*) FILTER (WHERE st.zuletzt < now() - interval '1 hour')                AS einheiten_ueber_1h,
       count(*) FILTER (WHERE st.zuletzt < now() - interval '24 hours')              AS einheiten_ueber_24h,
       round(extract(epoch FROM now() - min(st.zuletzt)) / 60)                       AS aeltester_stand_min,
       round(extract(epoch FROM now() - max(st.zuletzt)) / 60)                       AS juengster_stand_min
  FROM liste l
  JOIN messreihe_luecke_stand st ON st.tenant_id = l.tenant_id
 GROUP BY 1, 2 ORDER BY 1, 2;

-- T01b · FRAGE: Wie viele Rohwerte sind in den letzten 24 Stunden je Eingangsweg angekommen?
--       Zwei Wege in derselben Tabelle: die Box (`device_id` gesetzt) und die Ablesung von Hand
--       oder aus einem Import (`ablesung_quelle_id` gesetzt, V20260916180000). Gezählt wird über
--       die EINGANGSZEIT, damit eine Nachlieferung mitzählt, auch wenn ihre Messzeit alt ist.
--       ENTSCHEIDUNG: stimmt der Eingang mit dem, was die Box liefern soll (Kadenz × Kanäle)?
--       AUFFÄLLIG, WENN: ein Weg, der gestern zählte, steht heute auf 0 · nicht_gut steigt.
--       ⚠ Diese Abfrage liest die Rohwert-Hypertabelle über `received_at`, nicht über `time`;
--          sie fasst deshalb jeden Abschnitt an, in dem noch nachgeliefert wird.
WITH liste AS (SELECT DISTINCT btrim(x)::uuid AS tenant_id
                 FROM unnest(string_to_array(:'betreiber_liste', ',')) AS x
                WHERE btrim(x) <> '')
SELECT l.tenant_id,
       CASE WHEN s.ablesung_quelle_id IS NOT NULL THEN 'ablesung' ELSE 'box' END     AS eingangsweg,
       count(*)                                                                      AS rohwerte_24h,
       count(*) FILTER (WHERE s.quality <> 'good')                                   AS nicht_gut,
       count(*) FILTER (WHERE s.gap)                                                 AS mit_luecken_kennzeichen,
       coalesce(sum(s.dropped_samples), 0)                                           AS verworfene_samples,
       count(DISTINCT coalesce(s.device_id, s.ablesung_quelle_id))                   AS quellen,
       round(extract(epoch FROM now() - max(s.received_at)) / 60)                    AS juengster_eingang_min
  FROM liste l
  JOIN device_measurement_sample s ON s.tenant_id = l.tenant_id
 WHERE s.received_at > now() - interval '24 hours'
 GROUP BY 1, 2 ORDER BY 1, 2;

-- =============================================================================================
-- T02 · OFFENE LÜCKEN
-- =============================================================================================

-- T02 · FRAGE: Wie viele Einheiten haben eine OFFENE Lücke, und wie alt ist die älteste?
--       `luecke_seit IS NOT NULL` ist die offene Lücke der Einheit (Box: aus dem Herzschlag,
--       Reihe: aus der Kadenz); `nachlieferung_von` zeigt ein Eingangsfenster, das noch nicht
--       verarbeitet ist.
--       ENTSCHEIDUNG: Ansprache; und ob eine Lücke steht (dann Befund) oder wandert (dann läuft
--       die Nachlieferung).
--       AUFFÄLLIG, WENN: aelteste_luecke_min wächst über Tage · offene_nachlieferung > 0 bleibt stehen.
WITH liste AS (SELECT DISTINCT btrim(x)::uuid AS tenant_id
                 FROM unnest(string_to_array(:'betreiber_liste', ',')) AS x
                WHERE btrim(x) <> '')
SELECT l.tenant_id,
       st.art                                                                        AS quellen_art,
       count(*) FILTER (WHERE st.luecke_seit IS NOT NULL)                            AS offene_luecken,
       count(*) FILTER (WHERE st.nachlieferung_von IS NOT NULL)                      AS offene_nachlieferung,
       round(extract(epoch FROM now() - min(st.luecke_seit)) / 60)                    AS aeltester_luecke_min,
       round(extract(epoch FROM now() - max(st.luecke_seit)) / 60)                    AS juengste_luecke_min
  FROM liste l
  JOIN messreihe_luecke_stand st ON st.tenant_id = l.tenant_id
 GROUP BY 1, 2 ORDER BY 1, 2;

-- =============================================================================================
-- T03 · ARBEITSLISTEN-ALTER
-- =============================================================================================

-- T03 · FRAGE: Wie lang und wie alt sind die drei Arbeitslisten je betreutem Kundenbereich?
--       Die drei Listen sind alles, was der Bau heute als Arbeitsvorrat führt: Viertelstunde
--       (V20260912170000), Tag (V20260912190000), Periode (V20260912205000). Jede trägt
--       `eingetragen_am`; das Alter des ältesten Eintrags ist der Rückstand.
--       ENTSCHEIDUNG: Regel P6 — wachsen die Listen nach 24 h, ist das ein Befund: den Läufer per
--       gitops-Wert aus und niemanden über die Betreuten hinaus ansprechen.
--       AUFFÄLLIG, WENN: aeltester_min über 15 (Dauerlauf-Grenze aus L4) · offen wächst von Tag zu Tag.
WITH liste AS (SELECT DISTINCT btrim(x)::uuid AS tenant_id
                 FROM unnest(string_to_array(:'betreiber_liste', ',')) AS x
                WHERE btrim(x) <> ''),
     arbeit AS (
    SELECT tenant_id, 'viertelstunde' AS liste, grund, eingetragen_am FROM messreihe_viertelstunde_arbeit
    UNION ALL
    SELECT tenant_id, 'tag',                    grund, eingetragen_am FROM messreihe_tag_arbeit
    UNION ALL
    SELECT tenant_id, 'periode',                grund, eingetragen_am FROM messreihe_periode_arbeit)
SELECT l.tenant_id,
       a.liste,
       a.grund,
       count(*)                                                                      AS offen,
       round(extract(epoch FROM now() - min(a.eingetragen_am)) / 60)                 AS aeltester_min,
       round(extract(epoch FROM now() - max(a.eingetragen_am)) / 60)                 AS juengster_min
  FROM liste l
  JOIN arbeit a ON a.tenant_id = l.tenant_id
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- =============================================================================================
-- T04 · LETZTER LAUF JE LÄUFER
-- =============================================================================================

-- T04 · FRAGE: Wann ist jeder Läufer zuletzt gelaufen, und wie weit ist er gekommen?
--       ⚠ Diese Abfrage kennt die Betreiber-Liste NICHT: die drei Laufzustände sind GLOBAL, je
--       Schlüssel eine Zeile ohne `tenant_id` (V20260912170000, V20260912190000,
--       V20260913130500). Ein Läufer-Stand je Kundenbereich existiert im Bau nicht — ihn hier zu
--       erfinden hieße, eine Zahl zu zeigen, die keiner schreibt. Siehe README, Abschnitt „Lücken“.
--       ENTSCHEIDUNG: steht ein Läufer, erklärt das jeden Rückstand aus T03 auf einen Schlag —
--       dann ist die Frage nicht „welcher Kunde“, sondern „welcher Läufer“.
--       AUFFÄLLIG, WENN: alter_min eines Zeigers über 15 · `zeitpunkt IS NULL` nach dem Rollout-Tag
--       (= noch nie gelaufen) · `rueckrechnung` ohne notiz = 'fertig' nach dem Nachlauf.
SELECT 'viertelstunde' AS laeufer, schluessel, zeitpunkt, zahl, notiz, geaendert_am,
       round(extract(epoch FROM now() - geaendert_am) / 60) AS alter_min
  FROM messreihe_viertelstunde_lauf
UNION ALL
SELECT 'tag',           schluessel, zeitpunkt, zahl, notiz, geaendert_am,
       round(extract(epoch FROM now() - geaendert_am) / 60)
  FROM messreihe_tag_lauf
UNION ALL
SELECT 'luecke',        schluessel, zeitpunkt, zahl, notiz, geaendert_am,
       round(extract(epoch FROM now() - geaendert_am) / 60)
  FROM messreihe_luecke_lauf
 ORDER BY 1, 2;

COMMIT;

-- =============================================================================================
-- WAS DIESES BLATT NICHT SAGT (und wo es hingehört):
--  · Läufer ohne Laufzustand: Endgültigkeit, Ersatzwert, Korrektur-Kaskade, Übergabe,
--    Struktur-Änderung, Ablauf, Zeilentext-Aufbewahrung und die drei Start-Läufer schreiben
--    keinen Lauf-Stand in die Datenbank. Ihr letzter Lauf steht heute nur im Log der api.
--    Die Metriken dazu baut AP-14 IP-9 — hier wird nichts geraten.
--  · Eingang je Quelle über die Grenze eines Tages hinaus (Trend statt Stand): dafür gibt es
--    keine Aufzeichnung; der Betreiber vergleicht die Blätter zweier Tage von Hand.
--  · Alles, was ein Kunde sieht: dieses Blatt ist die Betreiber-Sicht, keine Kundenfläche.
-- =============================================================================================

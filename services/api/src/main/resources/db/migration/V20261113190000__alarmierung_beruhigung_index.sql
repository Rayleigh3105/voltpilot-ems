-- Kunden-Alarmierung P4 · Ruhe statt Flut, eine Aussage (Konzept vp-kunden-alarmierung-konzept §6.5, §7 P4).
--
-- Nur ein Index, keine neue Spalte: die Beruhigung ("dieselbe Meldungsart an derselben Anlage meldet höchstens
-- einmal in sechs Stunden") fragt beim Senden je Person und Weg nach der letzten gesendeten Auslösung, der
-- Zustellstand an jeder Meldung und der Hinweis "ein Weg fällt aus" lesen die Zeilen einer Person. Den Grund
-- 'beruhigt' trägt die vorhandene Spalte benachrichtigung.grund (ohne CHECK, wie 'kein_weg' und 'vor_dem_weg').
--
-- Wiederholbar (IF NOT EXISTS); in Versionsreihenfolge auf frischer DB läuft sie auf einer leeren Tabelle.

CREATE INDEX IF NOT EXISTS idx_benachrichtigung_person_weg
    ON benachrichtigung (tenant_id, empfaenger_sub, weg, erstellt_am DESC);

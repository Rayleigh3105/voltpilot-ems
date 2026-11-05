-- Geräte & Updates G2: die drei Fakten einer Zuweisung getrennt -
-- angefragt (Portal, device_update_target.assigned_at/assigned_by gibt es schon),
-- angenommen (Box) und bestätigt (Box), je mit EIGENEM Zeitpunkt.
--
-- target_verdict_at: seit wann die Cloud das gemeldete Prüfurteil der Box zu
--   ihrem gemeldeten Ziel sieht (Serverzeit des Herzschlags, mit dem Urteil oder
--   Ziel wechselten). NULL = unbekannt (Bestand vor dieser Migration, oder die
--   Box meldet kein Urteil).
-- current_since: seit wann die Box ihren gemeldeten laufenden Stand fährt
--   (Serverzeit des ersten Herzschlags mit diesem Stempel). NULL = unbekannt -
--   die erste Meldung einer Box sagt nicht, seit wann sie diesen Stand fährt.
--
-- Beide Spalten schreibt allein der Ingest (UpdateStatusRepository.upsert) unter
-- der App-Rolle. Die Tabelle ist seit V20260803010000 RLS-gefencet (FORCE), die
-- Rechte sind tabellenweit vergeben; neue Spalten erben sie.
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS target_verdict_at TIMESTAMPTZ;
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS current_since TIMESTAMPTZ;

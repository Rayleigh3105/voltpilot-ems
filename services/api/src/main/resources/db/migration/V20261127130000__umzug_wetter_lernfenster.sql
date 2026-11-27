-- =============================================================================
-- V20261127130000 - Umzug (vp-standort-konzept §7, E1 = B): das Wetter trennt sich am
-- Umzugstag, und die Prognose lernt erst ab dann wieder (Bericht 6.4/E1 Punkt 4/5).
--
-- `ort_wetter_nachholung.ab_tag` unterscheidet die zwei Auslöser derselben Outbox-Tabelle
-- (V20261126150000): NULL bleibt "Ort berichtigen" (B3) - der Nachholer verwirft WEITER
-- das ganze gespeicherte Wetter und holt 28 Tage am neuen Punkt nach, wie bisher ("Adresse
-- war falsch" darf alles ersetzen). Gesetzt ist es ein Umzug - der Nachholer behält das
-- Wetter VOR `ab_tag` (am alten Punkt gelernt, unverändert richtig) und ersetzt nur AB
-- `ab_tag` durch das neue am neuen Punkt (services/forecast, wetter_nachholung.py).
--
-- `site.umzug_seit` ist der jüngste Umzugstag der Anlage - der Prognose-Sammler
-- (forecast_collect.py) liest ihn und beginnt sein Lernfenster bei
-- max(heute minus 28 Tage, umzug_seit) statt immer bei heute minus 28 Tage; vor einem
-- Umzug, der länger als 28 Tage zurückliegt, wirkt sich das von selbst nicht mehr aus
-- (das Maximum fällt auf den normalen Wert zurück) - kein eigenes Aufräumen nötig.
-- =============================================================================

ALTER TABLE ort_wetter_nachholung ADD COLUMN IF NOT EXISTS ab_tag DATE;

ALTER TABLE site ADD COLUMN IF NOT EXISTS umzug_seit DATE;

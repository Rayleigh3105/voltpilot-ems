-- Edge Industrie (WAGO PFC200) ist eine eigene Box-Art mit eigener
-- Release-Linie (edge-industrie-JJJJ.MM.N, Backend industrie, ota.BoxArt).
-- Die Automatik beim ersten Verbinden lässt sich deshalb auch für diese Linie
-- schalten. Auf dem aktuellen Schema aufgebaut: die Prüfung wird ersetzt, die
-- vorhandenen Bereiche bleiben gültig. Keine Zeile heißt weiter an.
ALTER TABLE ota_erstverbindung_schalter
    DROP CONSTRAINT IF EXISTS ota_erstverbindung_schalter_bereich_chk;
ALTER TABLE ota_erstverbindung_schalter
    ADD CONSTRAINT ota_erstverbindung_schalter_bereich_chk
        CHECK (bereich IN ('alle', 'docker', 'light', 'industrie'));

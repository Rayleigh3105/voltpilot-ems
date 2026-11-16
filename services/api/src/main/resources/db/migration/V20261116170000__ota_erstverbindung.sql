-- Erstverbindung mit Update (S1): Bei der ersten Meldung einer neu verbundenen
-- Box weist die Plattform ihr selbst die neueste zuweisbare Fassung ihrer Linie
-- zu (Regel ota.Erstverbindung, Takt des RolloutWatcher).
--
-- 1. erste_meldung_am: wann die Box sich unter dieser Gerätezeile zum ersten
--    Mal gemeldet hat. Bestehende Zeilen bleiben NULL - so greift die Regel nie
--    rückwirkend für die Flotte am Tag der Einführung. Neue Zeilen bekommen die
--    Serverzeit des ersten Herzschlags über den Default; das Upsert des Ingest
--    (UpdateStatusRepository) fasst die Spalte nicht an, auch ältere api-Pods
--    im rollenden Wechsel nicht.
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS erste_meldung_am TIMESTAMPTZ;
ALTER TABLE device_update_status ALTER COLUMN erste_meldung_am SET DEFAULT now();

-- 2. Der Schalter für den Betrieb: die Automatik je Linie oder für alle ohne
--    Deploy abschalten. Keine Zeile heißt an (ab Werk an). Plattform-Betriebsdaten
--    wie rollout_event, ohne Mandant; geschrieben nur aus /api/v1/admin/** an der
--    Admin-Verbindung, jede Änderung zusätzlich als Eintrag in rollout_event.
CREATE TABLE IF NOT EXISTS ota_erstverbindung_schalter (
    bereich       TEXT        PRIMARY KEY,
    an            BOOLEAN     NOT NULL,
    geaendert_von TEXT        NOT NULL,
    geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ota_erstverbindung_schalter_bereich_chk
        CHECK (bereich IN ('alle', 'docker', 'light'))
);

-- Die Admin-Rolle deckt V4s ALTER DEFAULT PRIVILEGES ab. Die App-Rolle bekommt
-- bewusst nichts (V2s Default-Rechte zurückgenommen): es gibt keinen
-- Kunden-Lesepfad auf den Schalter.
REVOKE ALL ON ota_erstverbindung_schalter FROM ${appDbUser};

-- Probe-Migration fuer MigrationHygieneTest: NICHT auf dem Flyway-Pfad.
-- Rein additiv, ohne Marker. Der Waechter darf sie nicht anfassen.
-- Der Text nennt DROP COLUMN und RENAME COLUMN nur im Kommentar.
ALTER TABLE messreihe_tag ADD COLUMN IF NOT EXISTS probe_feld text;
ALTER TABLE messreihe_tag DROP CONSTRAINT IF EXISTS messreihe_tag_probe_chk;

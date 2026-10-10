-- Probe-Migration fuer MigrationHygieneTest: NICHT auf dem Flyway-Pfad.
-- Sie traegt drei Aussagen, nach denen der alte Code nicht mehr laeuft,
-- und KEINEN Marker `-- freigabe: fenster`. Der Waechter muss sie ablehnen.
ALTER TABLE ort_aenderung RENAME COLUMN akteur_sub TO actor_sub;
ALTER TABLE messreihe_tag DROP COLUMN summe;
ALTER TABLE entity_registry_state DROP CONSTRAINT entity_registry_state_pkey;

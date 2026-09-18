-- Probe-Migration fuer MigrationHygieneTest: NICHT auf dem Flyway-Pfad.
-- Dieselben drei Aussagen, aber mit dem Marker. Der Waechter laesst sie durch;
-- der Marker sagt: diese Migration braucht ein Wartungsfenster.
-- freigabe: fenster
ALTER TABLE ort_aenderung RENAME COLUMN akteur_sub TO actor_sub;
ALTER TABLE messreihe_tag DROP COLUMN summe;
ALTER TABLE entity_registry_state DROP CONSTRAINT entity_registry_state_pkey;

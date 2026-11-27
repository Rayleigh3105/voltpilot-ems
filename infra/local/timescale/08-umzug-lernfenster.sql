-- =============================================================================
-- Voltpilot-EMS - Umzug (vp-standort-konzept §7, E1 = B): das Lernfenster-Datum der Anlage
-- (DEV bootstrap, runs once on first init).
-- -----------------------------------------------------------------------------
-- Additive dev-only init file mirroring the read-side of the api Flyway migration
-- services/api/.../db/migration/V20261127130000__umzug_wetter_lernfenster.sql
-- so the forecast collector (services/forecast, which never runs Flyway) sees the
-- column even before the api's Flyway runs - the same split as 03-weather.sql.
-- Keep the two in sync. `ort_wetter_nachholung.ab_tag` (same migration) needs no
-- mirror: it is written and read only by the api/forecast weather catch-up path,
-- never by the init-time dev seed.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS umzug_seit DATE;

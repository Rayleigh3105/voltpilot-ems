-- Befund vp-kunde-sofort-loeschen (E2E am lokalen Stack): auf jedem Stack, dessen TimescaleDB die
-- Writer-Tabellen über die Init-Skripte (infra/local/timescale, auch im Compose-/Demo-Image) VOR den
-- Migrationen anlegt, fehlen der Verwaltungsrolle die Rechte an vier Tabellen - die
-- DEFAULT PRIVILEGES aus V4 wirken nur auf SPÄTER angelegte Tabellen, und die Migrationen dieser
-- vier (CREATE TABLE IF NOT EXISTS) legen dann nichts mehr an. Der Löschzug eines Kundenbereichs
-- (IP-18, Wache zählt JEDE Tabelle mit tenant_id) scheiterte dort an „permission denied for table
-- entity_plan_slot" - auch auf dem Frist-Weg, nicht erst beim sofortigen Löschen.
--
-- Auf einer frischen, nur über Flyway gebauten Datenbank sind die GRANTs ein No-op: dieselben
-- Rechte kommen dort schon aus den DEFAULT PRIVILEGES (V4). monthly_market_value trägt keinen
-- Mandanten, gehört aber zur selben Init-Lücke (Marktwert-Anzeige der Verwaltung).
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_plan_slot TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON site_plan_run TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON forecast_weekly TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON monthly_market_value TO ${adminDbUser};

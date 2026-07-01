-- =============================================================================
-- Voltpilot-EMS - site geo-coordinates + weather_forecast hypertable (LOCAL DEV).
-- -----------------------------------------------------------------------------
-- Additive dev-only init file (runs once, after 01/02, on first container start).
-- It mirrors the read-side of the api Flyway migration
--   services/api/.../db/migration/V20260701010000__site_geo_and_data_feeds.sql
-- so the local stack has the columns/table the weather collector writes into even
-- before the api's Flyway runs. The migration is authoritative (see AGENTS.md);
-- keep the two in sync.
--
-- Two differences from the migration, both intentional:
--   * NO RLS / GRANT here: the voltpilot_app role does not exist yet at init time
--     (Flyway V1 creates it). The api migration adds the RLS policy + grant on the
--     already-existing table (CREATE ... IF NOT EXISTS is then a no-op), exactly
--     like telemetry (01-init creates it, V1 IF NOT EXISTS, V2 adds RLS).
--   * Only the Berlin dev site exists at init time (01-init seeds it); the Hamburg
--     site + both sites' coordinates are set by Flyway (V100 seed + the migration).
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9, 6);
ALTER TABLE site ADD COLUMN IF NOT EXISTS longitude NUMERIC(9, 6);

-- Berlin dev site (seeded in 01-init): give it coordinates so weather flows.
UPDATE site SET latitude = 52.520000, longitude = 13.405000
    WHERE id = '00000000-0000-0000-0000-000000000002' AND latitude IS NULL;

CREATE TABLE IF NOT EXISTS weather_forecast (
    time            TIMESTAMPTZ   NOT NULL,          -- forecast target hour (UTC)
    tenant_id       UUID          NOT NULL,          -- carried for RLS (like telemetry)
    site_id         UUID          NOT NULL,
    run_at          TIMESTAMPTZ   NOT NULL,          -- issue time of the forecast run
    temperature_c   NUMERIC(6, 2),
    cloud_cover_pct NUMERIC(5, 2),
    ghi_w_m2        NUMERIC(8, 2),                   -- shortwave / GHI
    dni_w_m2        NUMERIC(8, 2),                   -- direct (beam)
    dhi_w_m2        NUMERIC(8, 2),                   -- diffuse
    source          TEXT          NOT NULL DEFAULT 'open-meteo',
    PRIMARY KEY (site_id, run_at, time)
);

SELECT create_hypertable('weather_forecast', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_weather_forecast_site_run
    ON weather_forecast (site_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_forecast_tenant_time
    ON weather_forecast (tenant_id, time DESC);

-- =============================================================================
-- V20260701010000 - Site geo-coordinates + read-side data-feed tables.
-- -----------------------------------------------------------------------------
-- Adds what the portal's data-feed widgets need, owned by the api (it owns the
-- app role + every RLS policy). Two concerns:
--
--   1. site.latitude / site.longitude - so a site can be tied to a weather
--      forecast by location (Open-Meteo). Seeds the two dev sites.
--   2. The read-side of the KEYLESS data feeds:
--        * day_ahead_prices  - written by services/market-data (energy-charts /
--          ENTSO-E). Market-wide PER BIDDING ZONE, so NO tenant_id / NO RLS. The
--          api only reads it, so it just needs a SELECT grant for the app role.
--        * weather_forecast  - written by services/forecast (Open-Meteo). Tied to
--          a site, so it carries tenant_id and is RLS-scoped exactly like
--          telemetry, so the portal read shows each tenant only its own weather.
--
-- Both tables are created IF NOT EXISTS with the same DDL the owning services
-- ship (services/market-data/db/migration + infra/local/timescale), so:
--   * on a FRESH DB (Testcontainers / staging) the api creates them and their
--     grants outright, making the price/weather endpoints self-sufficient;
--   * on the dev-compose DB (already bootstrapped by infra/local/timescale/*),
--     the IF NOT EXISTS is a no-op and only the explicit grants/policies apply.
--
-- Version: date-based (like the market-data migration) so it never collides with
-- the api's V1/V2 or the forecast service's V3 (AGENTS.md version coordination).
-- =============================================================================

-- ---- 1. Site coordinates ----------------------------------------------------
ALTER TABLE site ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9, 6);
ALTER TABLE site ADD COLUMN IF NOT EXISTS longitude NUMERIC(9, 6);

-- Seed coordinates for the deterministic dev sites (Berlin / Hamburg). Harmless
-- 0-row update where those sites don't exist (staging/prod without the dev seed).
UPDATE site SET latitude = 52.520000, longitude = 13.405000
    WHERE id = '00000000-0000-0000-0000-000000000002' AND latitude IS NULL;
UPDATE site SET latitude = 53.551100, longitude = 9.993700
    WHERE id = '10000000-0000-0000-0000-000000000002' AND latitude IS NULL;

-- ---- 2a. day_ahead_prices (public per zone; read-only for the app role) ------
CREATE TABLE IF NOT EXISTS day_ahead_prices (
    ts             TIMESTAMPTZ   NOT NULL,           -- slot start (UTC)
    bidding_zone   TEXT          NOT NULL,           -- 'DE-LU' | 'AT' | 'CH'
    resolution     TEXT          NOT NULL,           -- ISO-8601 'PT15M' | 'PT60M'
    price_eur_mwh  NUMERIC(12, 4) NOT NULL,          -- native EUR/MWh
    currency       TEXT          NOT NULL DEFAULT 'EUR',
    source         TEXT          NOT NULL DEFAULT 'entsoe',  -- provider tag
    fetched_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (bidding_zone, resolution, ts)
);
SELECT create_hypertable('day_ahead_prices', 'ts',
                         chunk_time_interval => INTERVAL '30 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_day_ahead_prices_zone_ts
    ON day_ahead_prices (bidding_zone, ts DESC);

-- Prices are public market data: no RLS, the app role only reads. Explicit GRANT
-- covers the dev case where the table pre-existed the app role (so the default
-- privileges from V2 never applied to it).
GRANT SELECT ON day_ahead_prices TO ${appDbUser};

-- ---- 2b. weather_forecast (per site; tenant-scoped via RLS) ------------------
CREATE TABLE IF NOT EXISTS weather_forecast (
    time            TIMESTAMPTZ   NOT NULL,          -- forecast target hour (UTC)
    tenant_id       UUID          NOT NULL,          -- carried for RLS (like telemetry)
    site_id         UUID          NOT NULL,
    run_at          TIMESTAMPTZ   NOT NULL,          -- issue time of the forecast run
    temperature_c   NUMERIC(6, 2),                   -- 2 m air temperature
    cloud_cover_pct NUMERIC(5, 2),                   -- total cloud cover 0..100
    ghi_w_m2        NUMERIC(8, 2),                   -- shortwave / global horizontal irradiance
    dni_w_m2        NUMERIC(8, 2),                   -- direct (beam) radiation
    dhi_w_m2        NUMERIC(8, 2),                   -- diffuse radiation
    source          TEXT          NOT NULL DEFAULT 'open-meteo',
    -- One row per (site, run, target hour): a new run supersedes an old one while
    -- both stay queryable, and the collector's upsert is idempotent.
    PRIMARY KEY (site_id, run_at, time)
);
SELECT create_hypertable('weather_forecast', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_weather_forecast_site_run
    ON weather_forecast (site_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_forecast_tenant_time
    ON weather_forecast (tenant_id, time DESC);

-- The app role reads weather; the collector writes as the superuser (bypasses
-- RLS) and stamps tenant_id. Explicit SELECT grant covers the pre-existing-table
-- dev case; RLS then scopes the portal read to the caller's tenant.
GRANT SELECT ON weather_forecast TO ${appDbUser};

ALTER TABLE weather_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE weather_forecast FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS weather_forecast_isolation ON weather_forecast;
CREATE POLICY weather_forecast_isolation ON weather_forecast
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

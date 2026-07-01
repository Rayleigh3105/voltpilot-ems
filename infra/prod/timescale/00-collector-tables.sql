-- =============================================================================
-- Voltpilot-EMS - PRODUCTION TimescaleDB bootstrap (collector-owned tables)
-- -----------------------------------------------------------------------------
-- Runs ONCE, on a fresh prod data volume, before any app service starts (mounted
-- at /docker-entrypoint-initdb.d in docker-compose.prod.yml). It creates only the
-- two hypertables that are NOT owned by the api's Flyway migrations:
--
--   * day_ahead_prices  -> written by services/market-data (market-wide, no RLS)
--   * forecast          -> forecast hypertable (ready for the forecast collector)
--
-- The CORE schema (tenant/site/device/asset/telemetry + RLS + the voltpilot_app
-- role) is owned by the api's Flyway V1/V2, which run when the `api` container
-- starts and own a fresh DB outright. `CREATE EXTENSION IF NOT EXISTS timescaledb`
-- here is idempotent with the api's V1, and guarantees the extension exists before
-- these create_hypertable() calls (init scripts run before the api boots).
--
-- These are the canonical service migrations, mirrored here for the prod init
-- path (keep in sync):
--   services/market-data/db/migration/V20260701001200__day_ahead_prices_hypertable.sql
--   services/forecast/migrations/V3__forecast_hypertable.sql
--
-- Owned by the bootstrap superuser (POSTGRES_USER). day_ahead_prices/forecast are
-- non-RLS collector tables; the market-data collector writes them over the same
-- POSTGRES_* superuser connection, so no extra GRANTs are needed here.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- --- day_ahead_prices (ENTSO-E day-ahead spot prices, market-wide per zone) ---
CREATE TABLE IF NOT EXISTS day_ahead_prices (
    ts             TIMESTAMPTZ    NOT NULL,          -- slot start (UTC)
    bidding_zone   TEXT           NOT NULL,          -- 'DE-LU' | 'AT' | 'CH'
    resolution     TEXT           NOT NULL,          -- ISO-8601 'PT15M' | 'PT60M'
    price_eur_mwh  NUMERIC(12, 4) NOT NULL,          -- ENTSO-E native EUR/MWh
    currency       TEXT           NOT NULL DEFAULT 'EUR',
    source         TEXT           NOT NULL DEFAULT 'entsoe',
    fetched_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (bidding_zone, resolution, ts)
);

SELECT create_hypertable('day_ahead_prices', 'ts',
                         chunk_time_interval => INTERVAL '30 days',
                         if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_day_ahead_prices_zone_ts
    ON day_ahead_prices (bidding_zone, ts DESC);

-- --- forecast (baseline load/PV forecasts) ------------------------------------
CREATE TABLE IF NOT EXISTS forecast (
    time            TIMESTAMPTZ    NOT NULL,   -- slot start = target time of the value
    tenant_id       UUID           NOT NULL,   -- carried for RLS (architecture 9/10)
    site_id         UUID           NOT NULL,
    kind            TEXT           NOT NULL
                        CHECK (kind IN ('load', 'pv')),
    value_kw        NUMERIC(12, 4) NOT NULL,   -- mean power over the 15-min slot (kW)
    run_at          TIMESTAMPTZ    NOT NULL,   -- issue time of the forecast run
    horizon_min     INTEGER        NOT NULL,   -- lead time in minutes (time - run_at)
    method          TEXT           NOT NULL,
    schema_version  INTEGER        NOT NULL DEFAULT 1,
    PRIMARY KEY (site_id, kind, run_at, time)
);

SELECT create_hypertable('forecast', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_run
    ON forecast (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_time
    ON forecast (site_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_time
    ON forecast (tenant_id, time DESC);

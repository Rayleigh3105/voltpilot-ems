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
--   services/forecast/migrations/V20260702000000__forecast_model_column.sql
-- (the api's V20260701040000 retrofits/creates the same forecast shape
--  idempotently and owns the RLS-scoped forecast-quality tables outright)
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

-- --- forecast (model-tagged load/PV forecasts; shadow-mode registry) ----------
CREATE TABLE IF NOT EXISTS forecast (
    time            TIMESTAMPTZ    NOT NULL,   -- slot start = target time of the value
    tenant_id       UUID           NOT NULL,   -- carried for RLS (architecture 9/10)
    site_id         UUID           NOT NULL,
    kind            TEXT           NOT NULL
                        CHECK (kind IN ('load', 'pv')),
    model           TEXT           NOT NULL,   -- registry model id (voltpilot_forecast.registry)
    value_kw        NUMERIC(12, 4) NOT NULL,   -- mean power over the 15-min slot (kW)
    run_at          TIMESTAMPTZ    NOT NULL,   -- issue time of the forecast run
    horizon_min     INTEGER        NOT NULL,   -- lead time in minutes (time - run_at)
    method          TEXT           NOT NULL,
    schema_version  INTEGER        NOT NULL DEFAULT 1,
    PRIMARY KEY (site_id, kind, model, run_at, time)
);

SELECT create_hypertable('forecast', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_run
    ON forecast (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_model_run
    ON forecast (site_id, kind, model, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_time
    ON forecast (site_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_time
    ON forecast (tenant_id, time DESC);

-- --- monthly_market_value (EEG Monatsmarktwert per technology) -----------------
-- Mirrors services/market-data/db/migration/V20260707001000 (canonical); the
-- api's V20260707020000 applies the same DDL idempotently and grants SELECT to
-- the app role. Market-wide data: no tenant_id, no RLS; deliberately NOT a
-- hypertable (twelve rows per technology per year). `provisional` marks a
-- Voltpilot-computed approximation for a month not yet published by the TSOs.
CREATE TABLE IF NOT EXISTS monthly_market_value (
    month         DATE           NOT NULL,  -- first day of the German calendar month
    technology    TEXT           NOT NULL,  -- 'solar' (wind technologies later)
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, month)
);

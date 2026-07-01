-- =============================================================================
-- Voltpilot-EMS - forecast hypertable (Flyway migration)
-- -----------------------------------------------------------------------------
-- Forecasts are timeseries (architecture section 10: Hypertables Telemetrie,
-- *Prognosen*, Fahrpläne, KPIs). This is the production exposure the optimizer
-- reads: the forecast service writes runs here, the optimizer selects the latest
-- run per (site, kind) over its horizon.
--
-- VERSION COORDINATION (see AGENTS.md):
--   V1  reserved for core master data (tenant/site/device/asset)  <- services/api
--   V2  reserved for the core telemetry hypertable                <- services/api
--   V3  this migration: the forecast hypertable                   <- services/forecast
-- services/api does not yet ship Flyway (schema is dev-bootstrapped from
-- infra/local/timescale/*.sql today). This file claims V3 up front so that when
-- services/api introduces Flyway it can adopt V1/V2 without colliding. The
-- forecast service owns this migration and applies it against the shared
-- TimescaleDB (one Postgres instance, architecture section 10).
--
-- The local dev stack applies an identical DDL via
-- infra/local/timescale/02-forecast.sql on first container init, so
-- `docker compose up` gives the same table without running Flyway.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast (
    time            TIMESTAMPTZ  NOT NULL,   -- slot start = target time of the value
    tenant_id       UUID         NOT NULL,   -- carried for RLS (architecture section 9/10)
    site_id         UUID         NOT NULL,
    kind            TEXT         NOT NULL    -- 'load' | 'pv'
                        CHECK (kind IN ('load', 'pv')),
    value_kw        NUMERIC(12, 4) NOT NULL, -- mean power over the 15-min slot (kW)
    run_at          TIMESTAMPTZ  NOT NULL,   -- issue time of the forecast run
    horizon_min     INTEGER      NOT NULL,   -- lead time in minutes (time - run_at)
    method          TEXT         NOT NULL,   -- 'persistence' | 'profile' | 'clear_sky_v1:...'
    schema_version  INTEGER      NOT NULL DEFAULT 1,
    -- One value per (site, kind, run, target slot). Lets a new run supersede an
    -- old one while both remain queryable, and makes writes idempotent.
    PRIMARY KEY (site_id, kind, run_at, time)
);

SELECT create_hypertable(
    'forecast', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- The optimizer's hot path: latest run, then all slots of that run in time order.
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_run
    ON forecast (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_time
    ON forecast (site_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_time
    ON forecast (tenant_id, time DESC);

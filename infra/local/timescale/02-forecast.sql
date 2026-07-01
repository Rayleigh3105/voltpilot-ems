-- =============================================================================
-- Voltpilot-EMS - forecast hypertable (DEV bootstrap, runs once on first init)
-- -----------------------------------------------------------------------------
-- Local-dev mirror of services/forecast/migrations/V3__forecast_hypertable.sql
-- so `docker compose up` gives the forecast service its table without a Flyway
-- run. Keep this DDL in sync with that migration (the migration is the source of
-- truth in staging/prod). Forecasts are timeseries (architecture section 10).
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast (
    time            TIMESTAMPTZ  NOT NULL,   -- slot start = target time of the value
    tenant_id       UUID         NOT NULL,   -- carried for RLS (architecture section 9/10)
    site_id         UUID         NOT NULL,
    kind            TEXT         NOT NULL
                        CHECK (kind IN ('load', 'pv')),
    value_kw        NUMERIC(12, 4) NOT NULL, -- mean power over the 15-min slot (kW)
    run_at          TIMESTAMPTZ  NOT NULL,   -- issue time of the forecast run
    horizon_min     INTEGER      NOT NULL,   -- lead time in minutes (time - run_at)
    method          TEXT         NOT NULL,
    schema_version  INTEGER      NOT NULL DEFAULT 1,
    PRIMARY KEY (site_id, kind, run_at, time)
);

SELECT create_hypertable(
    'forecast', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_run
    ON forecast (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_time
    ON forecast (site_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_time
    ON forecast (tenant_id, time DESC);

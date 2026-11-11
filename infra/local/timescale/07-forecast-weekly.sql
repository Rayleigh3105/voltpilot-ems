-- =============================================================================
-- Voltpilot-EMS - forecast_weekly hypertable (DEV bootstrap, runs once on first
-- init).
-- -----------------------------------------------------------------------------
-- S4 ("die Woche je Stunde", report vp-prognosen-konzept section 9): the
-- hourly week-ahead outlook, stored SEPARATELY from the quarter-hour
-- `forecast` table. Additive dev-only init file mirroring the read-side of
-- the api Flyway migration that owns this table (RLS/grants wait for that
-- migration - the voltpilot_app role does not exist yet at init time, the
-- same split as 03-weather.sql). Keep the two in sync.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast_weekly (
    time       TIMESTAMPTZ    NOT NULL,  -- target hour (UTC)
    tenant_id  UUID           NOT NULL,  -- carried for RLS, like weather_forecast
    site_id    UUID           NOT NULL,
    kind       TEXT           NOT NULL
                   CHECK (kind IN ('load', 'pv')),
    model      TEXT           NOT NULL,  -- registry model id (always deterministic per kind here)
    value_kw   NUMERIC(12, 4) NOT NULL,  -- mean power over the hour (kW)
    run_at     TIMESTAMPTZ    NOT NULL,  -- issue time of the outlook run
    method     TEXT           NOT NULL,
    PRIMARY KEY (site_id, kind, model, run_at, time)
);

SELECT create_hypertable('forecast_weekly', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_forecast_weekly_site_kind_run
    ON forecast_weekly (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_weekly_tenant_time
    ON forecast_weekly (tenant_id, time DESC);

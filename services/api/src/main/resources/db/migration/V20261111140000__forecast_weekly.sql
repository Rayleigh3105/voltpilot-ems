-- =============================================================================
-- V20261111140000 - S4 ("die Woche je Stunde", report vp-prognosen-konzept
--                   section 9): the hourly week-ahead PV/load outlook, stored
--                   SEPARATELY from the quarter-hour `forecast` table.
-- -----------------------------------------------------------------------------
-- Today and tomorrow stay the existing 48h quarter-hour forecast (`forecast`,
-- no RLS - compressed, cannot get it). `forecast_weekly` only carries
-- "übermorgen" onward, at hourly resolution, and is NOT compressed, so it CAN
-- carry RLS from day one - the weather_forecast precedent (V20260701010000),
-- not the forecast one. Written by services/forecast (the collector,
-- forecast_collect.weekly_outlook_timestamps) as the trusted backend role
-- (bypasses RLS, stamps tenant_id from the owning site); read by the portal
-- through the RLS-scoped app role via the S1 lesepunkt
-- (`GET /api/v1/sites/{siteId}/forecast`).
--
-- `model` is deterministic per `kind` here (no candidate comparison - this is
-- an outlook product, not shadow-mode forecasting): PV always the active
-- physical model's own id, load always `load-profile` (the Tagestyp model),
-- regardless of which model a site has chosen as ACTIVE for the quarter-hour
-- series. Dev bootstrap mirror: infra/local/timescale/07-forecast-weekly.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast_weekly (
    time       TIMESTAMPTZ    NOT NULL,  -- target hour (UTC)
    tenant_id  UUID           NOT NULL,
    site_id    UUID           NOT NULL,
    kind       TEXT           NOT NULL
                   CHECK (kind IN ('load', 'pv')),
    model      TEXT           NOT NULL,
    value_kw   NUMERIC(12, 4) NOT NULL,
    run_at     TIMESTAMPTZ    NOT NULL,
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

GRANT SELECT ON forecast_weekly TO ${appDbUser};

ALTER TABLE forecast_weekly ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_weekly FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forecast_weekly_isolation ON forecast_weekly;
CREATE POLICY forecast_weekly_isolation ON forecast_weekly
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Retention only (compression is blocked on RLS/FORCE hypertables) - the
-- weather_forecast/schedule precedent (V20260809000000). A week-ahead outlook
-- is stale fast; 14 days trivially covers the read horizon (7 days) plus a
-- margin for the daily-evaluation-style lookback S3 may later want.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'forecast_weekly') THEN
        PERFORM add_retention_policy('forecast_weekly', INTERVAL '14 days');
    END IF;
END
$$;

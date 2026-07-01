-- =============================================================================
-- Voltpilot-EMS - day_ahead_prices hypertable (LOCAL DEV bootstrap)
-- -----------------------------------------------------------------------------
-- Additive dev-only init file (runs once, after 01-init.sql, on first container
-- start). It mirrors the canonical Flyway migration
--   services/market-data/db/migration/V20260701001200__day_ahead_prices_hypertable.sql
-- so the local stack has the table the market-data service writes into. Keep the
-- two in sync; in staging/prod the migration is authoritative (see AGENTS.md).
--
-- Day-ahead prices are timeseries + market-wide PER BIDDING ZONE (no tenant_id,
-- no RLS). See the migration header for the full rationale.
-- =============================================================================

CREATE TABLE IF NOT EXISTS day_ahead_prices (
    ts             TIMESTAMPTZ   NOT NULL,           -- slot start (UTC)
    bidding_zone   TEXT          NOT NULL,           -- 'DE-LU' | 'AT' | 'CH'
    resolution     TEXT          NOT NULL,           -- ISO-8601 'PT15M' | 'PT60M'
    price_eur_mwh  NUMERIC(12, 4) NOT NULL,          -- ENTSO-E native EUR/MWh
    currency       TEXT          NOT NULL DEFAULT 'EUR',
    source         TEXT          NOT NULL DEFAULT 'entsoe',
    fetched_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (bidding_zone, resolution, ts)
);

SELECT create_hypertable('day_ahead_prices', 'ts',
                         chunk_time_interval => INTERVAL '30 days',
                         if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_day_ahead_prices_zone_ts
    ON day_ahead_prices (bidding_zone, ts DESC);

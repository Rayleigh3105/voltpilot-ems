-- =============================================================================
-- Voltpilot-EMS - day_ahead_prices hypertable (market-data service)
-- -----------------------------------------------------------------------------
-- Flyway/Liquibase-compatible, forward-only migration. Adds the TimescaleDB
-- hypertable that stores ENTSO-E Transparency day-ahead spot prices per bidding
-- zone (architecture sections 11/13). This is the canonical schema artifact for
-- staging/prod; the local dev stack mirrors it via a matching init file
-- (infra/local/timescale/02-day-ahead-prices.sql).
--
-- Version coordination: this migration is intentionally versioned with a
-- date-based, high/uniquely-scoped number (V20260701001200) so it does NOT
-- collide with the api service's future baseline sequence (V1, V2, ...). When
-- Flyway is wired into services/api, add this file's directory
-- (services/market-data/db/migration) to `spring.flyway.locations` OR let the
-- market-data service own and run its own migrations.
--
-- Design notes:
--   * Prices are TIMESERIES data -> hypertable (not a relational table).
--   * Prices are market-wide PER BIDDING ZONE, not per tenant: every tenant in
--     a zone shares the same public spot price, so there is deliberately no
--     tenant_id here (unlike telemetry). No RLS applies.
--   * PK includes the partition column `ts`, as TimescaleDB requires.
-- =============================================================================

CREATE TABLE day_ahead_prices (
    ts             TIMESTAMPTZ   NOT NULL,           -- slot start (UTC)
    bidding_zone   TEXT          NOT NULL,           -- 'DE-LU' | 'AT' | 'CH'
    resolution     TEXT          NOT NULL,           -- ISO-8601 'PT15M' | 'PT60M'
    price_eur_mwh  NUMERIC(12, 4) NOT NULL,          -- ENTSO-E native EUR/MWh
    currency       TEXT          NOT NULL DEFAULT 'EUR',
    source         TEXT          NOT NULL DEFAULT 'entsoe',  -- provider tag (ACL)
    fetched_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (bidding_zone, resolution, ts)
);

SELECT create_hypertable('day_ahead_prices', 'ts',
                         chunk_time_interval => INTERVAL '30 days');

-- Optimizer reads "latest series for a zone over a window" -> zone + time desc.
CREATE INDEX idx_day_ahead_prices_zone_ts
    ON day_ahead_prices (bidding_zone, ts DESC);

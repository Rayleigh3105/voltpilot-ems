-- =============================================================================
-- Voltpilot-EMS - monthly_market_value (LOCAL DEV bootstrap)
-- -----------------------------------------------------------------------------
-- Additive dev-only init file mirroring the canonical Flyway migration
--   services/market-data/db/migration/V20260707001000__monthly_market_value.sql
-- (the api's V20260707020000 applies the same DDL idempotently at runtime and
-- grants the app role SELECT). Keep the shapes in sync; the migrations are
-- authoritative.
--
-- The German EEG Monatsmarktwert per technology, published monthly by the TSOs
-- on netztransparenz.de. Market-wide data: NO tenant_id, NO RLS; deliberately
-- NOT a hypertable (twelve rows per technology per year). `provisional` marks
-- a Voltpilot-computed approximation for a month whose official value is not
-- yet published.
-- =============================================================================

CREATE TABLE IF NOT EXISTS monthly_market_value (
    month         DATE           NOT NULL,  -- first day of the German calendar month
    technology    TEXT           NOT NULL,  -- 'solar' (wind technologies later)
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, month)
);

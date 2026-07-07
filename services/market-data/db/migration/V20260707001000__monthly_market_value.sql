-- =============================================================================
-- Voltpilot-EMS - monthly_market_value (market-data service)
-- -----------------------------------------------------------------------------
-- Stores the German EEG Monatsmarktwert per technology (today: 'solar'),
-- published monthly by the four TSOs on netztransparenz.de. This is what turns
-- a plant's fixed ANZULEGENDER WERT into the month's actual Marktpraemie:
--     premium(M) = max(0, anzulegender_wert - monatsmarktwert(M))  [ct/kWh]
--
-- Version coordination: date-based V20260707001000, in the market-data
-- service's V2026... scope (see V20260701001200). The api service's
-- V20260707020000 applies the same DDL idempotently as the canonical runtime
-- owner and grants the app role SELECT (the day_ahead_prices precedent).
--
-- Design notes:
--   * Market values are market-wide PER TECHNOLOGY - like day_ahead_prices
--     there is deliberately NO tenant_id and NO RLS.
--   * Deliberately NOT a hypertable: one technology gains twelve rows per
--     YEAR, so time partitioning would be pure overhead. Plain table with
--     PK (technology, month).
--   * `month` is the FIRST DAY of the German calendar month.
--   * `provisional` marks a Voltpilot-computed approximation for a month whose
--     official value is not yet published (always the running month, and the
--     previous month until the TSOs publish, legally by the 10th working day).
--     The collector's upsert lets a published value always overwrite, and a
--     provisional value never overwrite a published one.
-- =============================================================================

CREATE TABLE monthly_market_value (
    month         DATE           NOT NULL,  -- first day of the German calendar month
    technology    TEXT           NOT NULL,  -- 'solar' (wind technologies later)
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, month)
);

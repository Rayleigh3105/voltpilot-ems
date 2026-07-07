-- =============================================================================
-- V20260707020000 - dynamic Marktprämie model (captain domain fix 2026-07-07):
--                   site.anzulegender_wert_ct_kwh + monthly_market_value.
-- -----------------------------------------------------------------------------
-- The Marktprämie of a direct-marketed plant is NOT a fixed ct/kWh: fixed is
-- the plant's ANZULEGENDER WERT (its EEG reference rate, from the EEG award /
-- Direktvermarktungsvertrag); the premium in month M is the dynamic difference
--
--     premium(M) = max(0, anzulegender_wert - monatsmarktwert_solar(M))
--
-- where the Monatsmarktwert Solar is published monthly by the TSOs on
-- netztransparenz.de (fetched by services/market-data; a Voltpilot-computed
-- PROVISIONAL value covers months not yet published).
--
--   1. site.anzulegender_wert_ct_kwh - the plant's fixed EEG reference rate
--      (nullable; NULL = no premium in the earnings, byte-identical to the
--      pure-spot numbers). Existing site RLS policy (V2) + grants cover new
--      columns; pure additive ALTER, no infra bootstrap mirror needed.
--
--      The PREDECESSOR column site.marktpraemie_ct_kwh (V20260706040000, a
--      manually entered FIXED premium) had the wrong semantics and is now
--      DEPRECATED: no code reads or writes it anymore (the API echoes it
--      read-only for one release; openapi.yaml marks it deprecated). Its
--      values are NOT migrated - a fixed premium and an anzulegender Wert are
--      different quantities, so any auto-conversion would be silently wrong,
--      and the column shipped only one day before this fix (2026-07-06, PR
--      #88), so meaningful production values are unlikely but NOT verifiable
--      from here - hence keep-one-release instead of drop. A follow-up
--      migration removes the column next release.
--
--   2. monthly_market_value - the Monatsmarktwert per technology. Canonical
--      owner is the market-data service migration V20260707001000 (this DDL
--      is its idempotent twin, the day_ahead_prices precedent from
--      V20260701010000, so the api is self-sufficient on a fresh DB). Market-
--      wide data: NO tenant_id, NO RLS; deliberately NOT a hypertable (twelve
--      rows per technology per YEAR - time partitioning would be pure
--      overhead). `provisional` marks a computed approximation for a month
--      whose official value is not yet published; the collector's upsert
--      replaces it with the official number after publication. The app role
--      reads it in the earnings math (premium + the "erzielter Marktwert vs.
--      Monatsmarktwert" benchmark); writes stay with the trusted collector.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS anzulegender_wert_ct_kwh NUMERIC(8, 3)
    CHECK (anzulegender_wert_ct_kwh IS NULL OR anzulegender_wert_ct_kwh >= 0);

CREATE TABLE IF NOT EXISTS monthly_market_value (
    month         DATE           NOT NULL,  -- first day of the German calendar month
    technology    TEXT           NOT NULL,  -- 'solar' (wind technologies later)
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, month)
);

GRANT SELECT ON monthly_market_value TO voltpilot_app;

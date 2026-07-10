-- =============================================================================
-- V20260710000000 - Priced battery degradation (optimizer redesign Stage 1, P2).
-- -----------------------------------------------------------------------------
-- Two additive concerns for services/optimization:
--
--   1. asset.wear_cost_ct_per_kwh - the OPTIONAL per-asset battery wear cost
--      in ct per kWh CYCLED (one kWh charged and discharged again, AC side).
--      NULL = use the platform default (env OPTIMIZER_WEAR_COST_CT_PER_KWH,
--      default 4.0 ct/kWh - LFP-representative: ~250 EUR/kWh replacement over
--      ~6,000 full cycles; derivation in services/optimization
--      voltpilot_optimization/config.py). The optimizer levies half the rate
--      on each direction of battery throughput in its objective, so a cycle
--      is planned only when the price spread genuinely clears the wear - the
--      pre-P2 model over-cycled ~3 full cycles/day chasing sub-cent spreads
--      (critique finding F2). Tuned per asset by the forthcoming admin config
--      UI. The existing asset RLS policy + grants (V2) cover new columns;
--      pure additive ALTER (the plant_kind precedent).
--
--   2. schedule.wear_cost_eur - the priced degradation each planned slot
--      spends (EUR, >= 0), persisted alongside cost_eur/baseline_cost_eur so
--      the admin "why" view and an honest net savings figure (baseline - cost
--      - wear) can read it. Nullable: rows written before this migration have
--      no wear information (NULL, the curtail_kw precedent); new optimizer
--      rows carry 0 for an idle slot. The V20260701020000 SELECT grant on
--      schedule is column-agnostic. Bootstrap mirror:
--      infra/local/timescale/04-schedule.sql (kept in sync). This is the
--      internal schedule table - the frozen MQTT schedule contract is
--      untouched.
-- =============================================================================

ALTER TABLE asset ADD COLUMN IF NOT EXISTS wear_cost_ct_per_kwh NUMERIC(8, 3)
    CHECK (wear_cost_ct_per_kwh IS NULL OR wear_cost_ct_per_kwh >= 0);

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS wear_cost_eur NUMERIC(12, 6);

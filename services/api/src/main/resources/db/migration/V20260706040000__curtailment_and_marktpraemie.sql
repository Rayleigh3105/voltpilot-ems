-- =============================================================================
-- V20260706040000 - Phase 3 of the fleet overview: negative-price curtailment
--                   + Marktprämie (captain decisions #2/#3, 2026-07-06).
-- -----------------------------------------------------------------------------
-- Two additive concerns:
--
--   1. schedule.curtail_kw - the optimizer (services/optimization) now plans
--      PV curtailment at negative prices (a new MILP decision variable) and
--      persists it per slot like the other plan fields. Nullable: rows written
--      before this migration have no curtailment information (NULL), rows from
--      the extended optimizer carry 0 for "no curtailment". The api owns the
--      read side; the existing V20260701020000 SELECT grant on `schedule` is
--      column-agnostic, so no new grant is needed. Bootstrap mirror:
--      infra/local/timescale/04-schedule.sql (kept in sync).
--
--   2. site.marktpraemie_ct_kwh - the OPTIONAL per-site Marktprämie (ct/kWh)
--      from the customer's Direktvermarktungsvertrag. NULL = not configured
--      (the earnings math is then byte-identical to Phase 2). When configured,
--      EarningsRepository credits export * premium on BOTH the actual and the
--      baseline side for slots with a NON-NEGATIVE day-ahead price - the
--      simplified §51-EEG rule (the premium lapses in negative-price slots);
--      the real 4h/1h window rules are deliberately NOT modelled. Relevant for
--      plant_kind = 'direktvermarktung' only (the SQL gates on it). The
--      existing site RLS policy (V2) and grants cover new columns; pure
--      additive ALTER, no infra bootstrap mirror needed (the plant_kind
--      precedent, V20260706010000).
-- =============================================================================

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS curtail_kw NUMERIC(12, 4);

ALTER TABLE site ADD COLUMN IF NOT EXISTS marktpraemie_ct_kwh NUMERIC(8, 3)
    CHECK (marktpraemie_ct_kwh IS NULL OR marktpraemie_ct_kwh >= 0);

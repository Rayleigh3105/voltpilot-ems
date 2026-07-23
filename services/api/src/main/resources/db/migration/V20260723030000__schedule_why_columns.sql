-- =============================================================================
-- V20260723030000 - Fahrplan-Warum: persist the per-slot decision facts
-- (design scout vp-fahrplan-why-design §5.1; owner-approved D1-D6).
-- -----------------------------------------------------------------------------
-- After each solve the optimizer's explain layer (voltpilot_optimization/
-- explain.py) re-solves the already-solved MILP as a fixed-binary LP (~30 ms)
-- and extracts the honest per-slot "why": the slot's role, which constraints
-- bound it, and the shadow-price economics the optimizer itself decided with.
-- Persisted with the plan so the api/portal read FACTS instead of
-- reconstructing (the terminal_value precedent: only the solver knows them).
--
--   slot_role            - §6 vocabulary id (warten, pv_speichern,
--                          guenstig_laden, eigenverbrauch, verkaufen,
--                          spitze_kappen, reserve_halten, abregeln; additive -
--                          new ids are new TEXT values, never a migration)
--   slot_flags           - CSV of binding codes (soc_max, soc_floor,
--                          reserve_backup, reserve_peak, charge_cap,
--                          discharge_cap, solar_only, grid_limit_14a,
--                          feed_in_cap, peak_defining, curtailing)
--   stored_value_ct_kwh  - lambda_t: the exact value of a stored kWh at slot
--                          end (the SoC shadow price, ct/kWh, rounded 0.1 ct)
--                          - replaces the admin diagnostics' approximation
--   grid_value_ct_kwh    - pi_t: effective energy value at the grid
--                          connection point (ct/kWh)
--   peak_pressure_eur_kw - mu_t: the Leistungspreis allocation on this slot
--                          (EUR/kW; sums to the Leistungspreis + ratchet over
--                          the horizon); NULL = peak module off
--   fallback_14a         - run-level fact repeated per row (terminal_value
--                          pattern): TRUE = the advisory build without the
--                          infeasible §14a constraint
--
-- All nullable, deliberately: NULL = pre-feature rows, explain layer off
-- (OPTIMIZER_EXPLAIN_ENABLED=false) or a degraded run - consumers then render
-- exactly today's view, never a fabricated explanation. Typed columns instead
-- of JSONB (repo discipline; SQL-aggregatable; trivial JDBC mapping). No RLS
-- change: the existing schedule policies + the column-agnostic SELECT grant
-- (V20260701020000) cover new columns. The frozen MQTT schedule contract is
-- untouched - the why never goes to the edge. Bootstrap mirror:
-- infra/local/timescale/04-schedule.sql (kept in sync).
-- =============================================================================

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS slot_role TEXT;
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS slot_flags TEXT;
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS stored_value_ct_kwh NUMERIC(12, 4);
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS grid_value_ct_kwh NUMERIC(12, 4);
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS peak_pressure_eur_kw NUMERIC(12, 4);
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS fallback_14a BOOLEAN;

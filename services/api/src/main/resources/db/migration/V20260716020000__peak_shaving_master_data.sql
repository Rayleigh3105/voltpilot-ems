-- =============================================================================
-- V20260716020000 - Peak shaving / Lastspitzenkappung master data (PS-1 + PS-2,
-- scout vp-battery-models-b9 Teil 3; captain go 2026-07-16).
-- -----------------------------------------------------------------------------
-- RLM-metered sites (registrierende 15-min-Leistungsmessung) pay a
-- Leistungspreis on the highest 15-min mean grid IMPORT of the billing period.
-- The optimizer (services/optimization) prices that ECONOMICALLY: an epigraph
-- variable over the horizon's import anchored at the period's measured peak so
-- far, weighed against arbitrage/self-consumption - never a hard cap.
--
-- site.leistungspreis_eur_kw: EUR per kW per billing period. NULL = the
--   peak-shaving module is OFF (non-NULL IS the module flag - the
--   max_feed_in_kw philosophy: one knob, no separate boolean).
-- site.abrechnung_leistung: 'jahr' (Jahresleistungspreis, the RLM default) or
--   'monat' (Monatsleistungspreis). Picks the Europe/Berlin calendar period
--   the peak anchor is computed over. NOT NULL with default so the optimizer
--   never has to guess.
-- site.peak_reserve_soc_pct (PS-2): SoC floor reserved for shaving a peak
--   BEYOND the 24h horizon (reserve myopia - the MPC never sees the whole
--   billing period). Joins the reservation stack as an ABSOLUTE floor
--   (technical < backup < peak-reserve; the highest configured floor binds),
--   hard like the backup reserve. NULL = no peak reserve.
--
-- There is deliberately NO stored peak column: peak_so_far is computed fresh
-- per optimizer cycle from telemetry_rollup_15m (the freshness principle -
-- a stored value could go stale or be poisoned permanently).
--
-- schedule.peak_target_kw: the run's planned billing-period peak target (the
--   solved epigraph variable), a RUN-level fact repeated on every slot row
--   (the terminal_value_eur_per_kwh precedent, V20260716010000) - feeds the
--   later PS-4 reporting increment ("der Plan hielt 62 kW"). NULL on
--   pre-PS-1 runs and whenever the site's module is off. Bootstrap mirror:
--   infra/local/timescale/04-schedule.sql (kept in sync).
--
-- Configuration surface is ADMIN-ONLY (captain decision: VoltPilot richtet
-- vertragsnahe Module ein, nicht der Kunde): written via the platform-admin
-- optimizer-config endpoint, echoed read-only on the customer SiteDto.
--
-- Pure additive ALTERs (the backup_reserve_soc_pct precedent V20260710010000):
-- layer over any existing volume; the existing site/schedule RLS policies +
-- grants (V2, V20260701020000) cover the new columns.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS leistungspreis_eur_kw NUMERIC(8, 2)
    CHECK (leistungspreis_eur_kw IS NULL OR leistungspreis_eur_kw >= 0);

ALTER TABLE site ADD COLUMN IF NOT EXISTS abrechnung_leistung TEXT NOT NULL DEFAULT 'jahr'
    CHECK (abrechnung_leistung IN ('jahr', 'monat'));

ALTER TABLE site ADD COLUMN IF NOT EXISTS peak_reserve_soc_pct NUMERIC(5, 2)
    CHECK (peak_reserve_soc_pct IS NULL
           OR (peak_reserve_soc_pct >= 0 AND peak_reserve_soc_pct <= 100));

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS peak_target_kw NUMERIC(12, 4);

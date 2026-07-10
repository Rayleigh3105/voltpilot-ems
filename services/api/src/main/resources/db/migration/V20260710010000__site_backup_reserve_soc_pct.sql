-- =============================================================================
-- V20260710010000 - site.backup_reserve_soc_pct (customer backup-reserve floor).
-- -----------------------------------------------------------------------------
-- Optimizer redesign Stage 3, P11: a per-site MINIMUM state of charge the
-- dispatch plan never discharges below, so the customer keeps configurable
-- headroom for outages/backup. NULL (the default) means "no reserve": the
-- optimizer's platform-wide 5% technical floor applies unchanged. When set,
-- the effective lower SoC bound is max(5% technical floor, backup reserve) -
-- a HARD constraint in the MILP (services/optimization solver.py), never a
-- soft objective preference (the Deye-Copilot scout documented that product
-- silently overriding its configured min-SoC; VoltPilot's must really hold).
--
-- The optimizer reads the column per site (inputs.load_battery_sites); the
-- admin/portal UI exposing it is follow-up work.
--
-- Pure additive ALTER (the netzladen_erlaubt precedent V20260707000000):
-- layers over any existing volume, no infra bootstrap mirror needed. The
-- existing site RLS policy + grants (V2) cover the new column.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS backup_reserve_soc_pct NUMERIC(5, 2)
    CHECK (backup_reserve_soc_pct IS NULL
           OR (backup_reserve_soc_pct >= 0 AND backup_reserve_soc_pct <= 100));

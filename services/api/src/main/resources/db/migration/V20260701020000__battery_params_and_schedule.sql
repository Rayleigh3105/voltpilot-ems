-- =============================================================================
-- V20260701020000 - Battery master data + the schedule hypertable (optimizer).
-- -----------------------------------------------------------------------------
-- Two concerns for the optimization engine (services/optimization):
--
--   1. asset.roundtrip_efficiency_pct - the one battery parameter the asset
--      table was missing (capacity_kwh / max_charge_kw / max_discharge_kw exist
--      since V1). Seeds 92 % for the deterministic dev battery assets, mirroring
--      how V20260701010000 seeded the dev sites' coordinates (harmless 0-row
--      update without the dev seed).
--   2. The `schedule` hypertable - every optimizer run persists its full plan
--      here (planned battery power, grid power, SoC trajectory, the forecast
--      inputs used, and projected cost vs. the no-battery baseline per slot).
--      This is the ML groundwork: plan-vs-actual against `telemetry` later.
--      Written by services/optimization as the trusted backend role (bypasses
--      RLS, stamps tenant_id - exactly like the weather collector); read by the
--      portal via the RLS-scoped app role, so it is tenant-scoped like
--      telemetry/weather_forecast.
--
-- Owned by the api (it owns the app role + every RLS policy); created
-- IF NOT EXISTS so it layers over the dev bootstrap mirror
-- (infra/local/timescale/04-schedule.sql) and owns a fresh DB outright.
-- Version: date-based per the AGENTS.md migration-version coordination.
-- =============================================================================

-- ---- 1. Battery round-trip efficiency ----------------------------------------
ALTER TABLE asset ADD COLUMN IF NOT EXISTS roundtrip_efficiency_pct NUMERIC(5, 2)
    CHECK (roundtrip_efficiency_pct > 0 AND roundtrip_efficiency_pct <= 100);

-- Seed the two deterministic dev battery assets (tenant A / tenant B).
UPDATE asset SET roundtrip_efficiency_pct = 92.00
    WHERE id IN ('00000000-0000-0000-0000-000000000004',
                 '10000000-0000-0000-0000-000000000004')
      AND roundtrip_efficiency_pct IS NULL;

-- ---- 2. schedule (per-slot optimizer plans; tenant-scoped via RLS) -----------
CREATE TABLE IF NOT EXISTS schedule (
    time              TIMESTAMPTZ    NOT NULL,  -- slot start (UTC, 15-min grid)
    tenant_id         UUID           NOT NULL,  -- carried for RLS (like telemetry)
    site_id           UUID           NOT NULL,
    device_id         UUID,                     -- executing battery device (nullable: unclaimed battery)
    plan_id           UUID           NOT NULL,  -- one optimizer run
    generated_at      TIMESTAMPTZ    NOT NULL,  -- issue time of the run
    battery_kw        NUMERIC(12, 4) NOT NULL,  -- planned battery power (+charge/-discharge)
    grid_kw           NUMERIC(12, 4),           -- projected net grid power (+import/-export)
    soc_pct           NUMERIC(5, 2),            -- planned SoC at slot END
    load_kw           NUMERIC(12, 4),           -- load forecast input used
    pv_kw             NUMERIC(12, 4),           -- PV forecast input used
    price_eur_mwh     NUMERIC(12, 4),           -- day-ahead price of the slot
    cost_eur          NUMERIC(12, 6),           -- projected slot cost WITH the plan
    baseline_cost_eur NUMERIC(12, 6),           -- projected slot cost with the battery idle
    -- One row per (site, run, slot): a new run supersedes an old one while both
    -- stay queryable (plan-vs-actual), and the optimizer's upsert is idempotent.
    PRIMARY KEY (site_id, generated_at, time)
);
SELECT create_hypertable('schedule', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_schedule_site_generated
    ON schedule (site_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_tenant_time
    ON schedule (tenant_id, time DESC);

-- The app role reads plans; the optimizer writes as the trusted backend role
-- (bypasses RLS) and stamps tenant_id. Explicit SELECT grant covers the
-- pre-existing-table dev case; RLS then scopes the portal read to the tenant.
GRANT SELECT ON schedule TO ${appDbUser};

ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schedule_isolation ON schedule;
CREATE POLICY schedule_isolation ON schedule
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

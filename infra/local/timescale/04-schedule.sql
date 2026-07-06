-- =============================================================================
-- Voltpilot-EMS - battery params + schedule hypertable (LOCAL DEV).
-- -----------------------------------------------------------------------------
-- Additive dev-only init file (runs once, after 01/02/03, on first container
-- start). It mirrors the api Flyway migration
--   services/api/.../db/migration/V20260701020000__battery_params_and_schedule.sql
-- so the local stack has the column/table the optimizer writes into even before
-- the api's Flyway runs. The migration is authoritative (see AGENTS.md); keep
-- the two in sync.
--
-- NO RLS / GRANT here, intentionally: the voltpilot_app role does not exist yet
-- at init time (Flyway V1 creates it). The api migration adds the RLS policy +
-- grant on the already-existing table (CREATE ... IF NOT EXISTS is then a
-- no-op), exactly like telemetry and weather_forecast.
-- =============================================================================

ALTER TABLE asset ADD COLUMN IF NOT EXISTS roundtrip_efficiency_pct NUMERIC(5, 2)
    CHECK (roundtrip_efficiency_pct > 0 AND roundtrip_efficiency_pct <= 100);

-- Tenant A's dev battery (seeded in 01-init): give it an efficiency so the
-- optimizer has full params. Tenant B's asset is seeded by Flyway (V100 + the
-- migration's update).
UPDATE asset SET roundtrip_efficiency_pct = 92.00
    WHERE id = '00000000-0000-0000-0000-000000000004'
      AND roundtrip_efficiency_pct IS NULL;

CREATE TABLE IF NOT EXISTS schedule (
    time              TIMESTAMPTZ    NOT NULL,  -- slot start (UTC, 15-min grid)
    tenant_id         UUID           NOT NULL,  -- carried for RLS (like telemetry)
    site_id           UUID           NOT NULL,
    device_id         UUID,                     -- executing battery device
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
    curtail_kw        NUMERIC(12, 4),           -- planned PV curtailment (V20260706040000)
    PRIMARY KEY (site_id, generated_at, time)
);

SELECT create_hypertable('schedule', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_schedule_site_generated
    ON schedule (site_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_tenant_time
    ON schedule (tenant_id, time DESC);

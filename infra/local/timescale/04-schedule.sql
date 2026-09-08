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

-- Per-asset battery wear-cost override (ct per kWh cycled); NULL = platform
-- default. Mirrors api migration V20260710000000.
ALTER TABLE asset ADD COLUMN IF NOT EXISTS wear_cost_ct_per_kwh NUMERIC(8, 3)
    CHECK (wear_cost_ct_per_kwh IS NULL OR wear_cost_ct_per_kwh >= 0);

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
    stur_cost_eur     NUMERIC(12, 6),           -- projected slot cost of the STUR battery, no smart control (V20260867000000)
    curtail_kw        NUMERIC(12, 4),           -- planned PV curtailment (V20260706040000)
    wear_cost_eur     NUMERIC(12, 6),           -- priced battery degradation of the slot (V20260710000000)
    terminal_value_eur_per_kwh NUMERIC(12, 6),  -- run's P3 terminal value per stored kWh (V20260716010000)
    peak_target_kw    NUMERIC(12, 4),           -- run's PS-1 planned billing-period peak target (V20260716020000)
    slot_role         TEXT,                     -- Fahrplan-Warum role id (V20260723030000)
    slot_flags        TEXT,                     -- CSV of binding-constraint codes (V20260723030000)
    stored_value_ct_kwh NUMERIC(12, 4),         -- lambda: exact value of a stored kWh (V20260723030000)
    grid_value_ct_kwh NUMERIC(12, 4),           -- pi: effective grid-point energy value (V20260723030000)
    peak_pressure_eur_kw NUMERIC(12, 4),        -- mu: Leistungspreis allocation on the slot (V20260723030000)
    fallback_14a      BOOLEAN,                  -- run is the advisory no-§14a build (V20260723030000)
    cover_load_from_battery  BOOLEAN,           -- in-slot duty: follow the measured house (V20260802010000)
    unplanned_load_discharge BOOLEAN,            -- additive idle-slot load coverage (V20260847010000)
    charge_from_surplus_only BOOLEAN,           -- in-slot duty: charge only the measured surplus (V20260802010000)
    effective_floor_soc_pct NUMERIC(5, 2),      -- run: max technical/backup/peak floor (V20260847010000)
    why_terminal_anchor TEXT,                   -- run: which branch anchored the stored-energy value (V20260824000000)
    why_refill_free_pct NUMERIC(5, 1),          -- run: free PV refill share of the usable band, 0-100 (V20260824000000)
    why_next_best     TEXT,                     -- resting slot: the best REJECTED action (V20260824000000)
    why_next_best_margin_ct NUMERIC(12, 4),     -- its disadvantage in ct/kWh, <= 0 (V20260824000000)
    pv_anchor_ratio   NUMERIC(12, 4),           -- run: PV nowcast anchor ratio measured/predicted (V20260836000000)
    why_night_reserve_kwh NUMERIC(12, 3),       -- run: charge held for a heavier night, kWh over the floor (V20260868000000)
    why_night_reserve_q NUMERIC(4, 3),          -- run: its quantile (0.75 = needed in 1 of 4 nights) (V20260868000000)
    PRIMARY KEY (site_id, generated_at, time)
);

SELECT create_hypertable('schedule', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_schedule_site_generated
    ON schedule (site_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_tenant_time
    ON schedule (tenant_id, time DESC);

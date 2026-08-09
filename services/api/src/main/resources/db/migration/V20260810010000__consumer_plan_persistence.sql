-- =============================================================================
-- V20260810010000 - v2 plan persistence: site_plan_run + entity_plan_slot
-- (Verbrauchssteuerung Inkrement 2, docs/verbrauchssteuerung.md §9.5).
-- -----------------------------------------------------------------------------
-- The v1 `schedule` table is site-/battery-centric; the co-optimizer's
-- multi-entity plan needs an ADDITIVE per-entity persistence so the Fahrplan,
-- plan-vs-actual and "Warum läuft die Pumpe jetzt?" can be answered without
-- reconstructing an MQTT payload:
--
--   site_plan_run    - one row per co-optimizer run (plan metadata + site
--                      economics). Hypertable on generated_at purely so the
--                      180-day retention rides the same drop_chunks machinery.
--   entity_plan_slot - one row per (run, entity, slot): the planned command
--                      (`on_off` | `setpoint_kw`), its target value, the §15
--                      reason_code and the requirement the slot serves.
--                      entity_id is TEXT - the mqtt-schedule-2.0 entity-id
--                      vocabulary (consumer entities are measurement_point
--                      UUIDs as strings; storage/producer ids like
--                      `storage-main` are registry strings).
--
-- Written by services/optimization as the trusted backend role (bypasses RLS,
-- stamps tenant_id - the weather-collector pattern); read by the portal via
-- the RLS-scoped app role. In Inkrement 2 the writer runs ONLY for
-- shadow-flagged sites (VOLTPILOT_V2_PLAN_SITES) with active consumer
-- policies - production stays empty until the flag is set.
--
-- Persistenz-Disziplin ab der ERSTEN Migration (§9.5):
--   * RLS + FORCE + default-deny exactly like `schedule`.
--   * Retention 180 days (RLS tables get retention, NEVER compression - the
--     measured Timescale restriction, see V20260809000000).
--   * Index (entity_id, time, generated_at DESC) so latest-run-per-slot
--     readers SkipScan (the V20260809010000 lesson); readers follow the
--     DISTINCT-ON-LATERAL pattern.
--
-- Idempotent (IF NOT EXISTS everywhere) so it layers over the dev bootstrap
-- mirror (infra/local/timescale/06-consumer-plan.sql) and owns a fresh DB.
-- Date-versioned ABOVE the highest shipped migration (V20260810000000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_plan_run (
    plan_id           UUID           NOT NULL,
    tenant_id         UUID           NOT NULL,  -- carried for RLS (like schedule)
    site_id           UUID           NOT NULL,
    generated_at      TIMESTAMPTZ    NOT NULL,  -- issue time of the run
    horizon_slots     INTEGER        NOT NULL,
    slot_minutes      INTEGER        NOT NULL,
    objective_eur     NUMERIC(14, 6),           -- solved objective value
    cost_eur          NUMERIC(14, 6),           -- projected site cashflow with the plan
    baseline_cost_eur NUMERIC(14, 6),           -- storages idle, consumers excluded
    -- One row per run; generated_at is in the key because a hypertable's
    -- unique constraint must include the partition column.
    PRIMARY KEY (plan_id, generated_at)
);
SELECT create_hypertable('site_plan_run', 'generated_at',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_site_plan_run_site
    ON site_plan_run (site_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS entity_plan_slot (
    time           TIMESTAMPTZ    NOT NULL,  -- slot start (UTC, 15-min grid)
    tenant_id      UUID           NOT NULL,  -- carried for RLS (like schedule)
    site_id        UUID           NOT NULL,
    plan_id        UUID           NOT NULL,  -- the site_plan_run this row belongs to
    generated_at   TIMESTAMPTZ    NOT NULL,  -- denormalized run time (SkipScan + splice reads)
    entity_id      TEXT           NOT NULL,  -- mqtt-schedule-2.0 entity id
    command        TEXT           NOT NULL
                   CHECK (command IN ('on_off', 'setpoint_kw')),
    target_value   NUMERIC(12, 4),           -- planned power in kW (on_off: rated when on, 0 when off)
    reason_code    TEXT,                     -- §15 vocabulary; NULL on an off slot
    requirement_id TEXT,                     -- served requirement (NULL on an off slot)
    -- One row per (entity, run, slot): a new run supersedes an old one while
    -- both stay queryable; the optimizer's upsert is idempotent.
    PRIMARY KEY (entity_id, generated_at, time)
);
SELECT create_hypertable('entity_plan_slot', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
-- The SkipScan index for latest-run-per-slot readers (§9.5 discipline; the
-- schedule table learned this the measured way - V20260809010000).
CREATE INDEX IF NOT EXISTS idx_entity_plan_slot_skipscan
    ON entity_plan_slot (entity_id, time, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_plan_slot_site
    ON entity_plan_slot (site_id, generated_at DESC);

-- The app role reads plans; the optimizer writes as the trusted backend role.
GRANT SELECT ON site_plan_run    TO ${appDbUser};
GRANT SELECT ON entity_plan_slot TO ${appDbUser};

ALTER TABLE site_plan_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_plan_run FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_plan_run_isolation ON site_plan_run;
CREATE POLICY site_plan_run_isolation ON site_plan_run
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE entity_plan_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_plan_slot FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_plan_slot_isolation ON entity_plan_slot;
CREATE POLICY entity_plan_slot_isolation ON entity_plan_slot
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Retention 180 days from the FIRST migration (§9.5; RLS tables only ever get
-- retention, never compression - V20260809000000's measured restriction).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'site_plan_run') THEN
        PERFORM add_retention_policy('site_plan_run', INTERVAL '180 days');
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_name = 'policy_retention'
                     AND hypertable_name = 'entity_plan_slot') THEN
        PERFORM add_retention_policy('entity_plan_slot', INTERVAL '180 days');
    END IF;
END
$$;

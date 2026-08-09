-- =============================================================================
-- Voltpilot-EMS - v2 consumer plan persistence (LOCAL DEV).
-- -----------------------------------------------------------------------------
-- Additive dev-only init file (runs once, after 01..05, on first container
-- start). It mirrors the api Flyway migration
--   services/api/.../db/migration/V20260810010000__consumer_plan_persistence.sql
-- so the local stack has the tables the co-optimizer's shadow writer targets
-- even before the api's Flyway runs. The migration is authoritative (see
-- AGENTS.md); keep the two in sync.
--
-- NO RLS / GRANT / retention here, intentionally: the voltpilot_app role does
-- not exist yet at init time and the api migration adds policy + grant +
-- retention on the already-existing tables (CREATE ... IF NOT EXISTS is then a
-- no-op), exactly like 04-schedule.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_plan_run (
    plan_id           UUID           NOT NULL,
    tenant_id         UUID           NOT NULL,
    site_id           UUID           NOT NULL,
    generated_at      TIMESTAMPTZ    NOT NULL,
    horizon_slots     INTEGER        NOT NULL,
    slot_minutes      INTEGER        NOT NULL,
    objective_eur     NUMERIC(14, 6),
    cost_eur          NUMERIC(14, 6),
    baseline_cost_eur NUMERIC(14, 6),
    PRIMARY KEY (plan_id, generated_at)
);
SELECT create_hypertable('site_plan_run', 'generated_at',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_site_plan_run_site
    ON site_plan_run (site_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS entity_plan_slot (
    time           TIMESTAMPTZ    NOT NULL,
    tenant_id      UUID           NOT NULL,
    site_id        UUID           NOT NULL,
    plan_id        UUID           NOT NULL,
    generated_at   TIMESTAMPTZ    NOT NULL,
    entity_id      TEXT           NOT NULL,
    command        TEXT           NOT NULL
                   CHECK (command IN ('on_off', 'setpoint_kw')),
    target_value   NUMERIC(12, 4),           -- planned power in kW
    reason_code    TEXT,
    requirement_id TEXT,
    PRIMARY KEY (entity_id, generated_at, time)
);
SELECT create_hypertable('entity_plan_slot', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_entity_plan_slot_skipscan
    ON entity_plan_slot (entity_id, time, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_plan_slot_site
    ON entity_plan_slot (site_id, generated_at DESC);

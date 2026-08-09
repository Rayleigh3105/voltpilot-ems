-- =============================================================================
-- V20260811000000 - consumer_runtime_status: the edge-reported LIVE state of
-- every controllable consumer entity (Verbrauchssteuerung Inkrement 3, D9/
-- §15.1). ADDITIVE (new table only).
-- -----------------------------------------------------------------------------
-- The status heartbeat carries an additive `consumers` block: per consumer
-- entity {state, reason_code, actual_kw, confirmed, requirement_progress}.
-- Its own SIBLING listener (ConsumerRuntimeStatusListener - never an extension
-- of an existing listener's early-return) ingests it here: ONE row per entity,
-- the device's whole set REPLACED per heartbeat (the entity_observed_state
-- discipline). Unknown state/reason words are DISCARDED at ingest, never
-- stored.
--
--   state        §14.13 vocabulary (running_forced | running_optimized |
--                waiting | clamped | offline | ...) - the edge only ever
--                claims what it can know.
--   reason_code  §15 vocabulary incl. the cycle-guard extension
--                (guard_min_on/guard_min_off/guard_max_starts/guard_ramp).
--   actual_kw    the entity's own fresh measured power; NULL = not measured
--                (never a fabricated 0).
--   confirmed    TRI-STATE readback verdict: NULL = no readback evidence
--                ("Ausführung nicht bestätigt" territory), false = the
--                readback disagreed, true = confirmed.
--   runtime_seconds_today / starts_today
--                the edge's own per-day counters (requirement_progress) -
--                the device view, next to the cloud-side fulfilment ledger
--                that keys on telemetry (§9.4, later increments).
--   reported_at  the heartbeat timestamp - the block's own freshness anchor.
--
-- No row = an older edge or a site without consumer entities => every surface
-- keeps its pre-Inkrement-3 wording ("Zustand nicht bestätigt"), never a
-- fabricated live state.
--
-- Tenant-scoped + RLS exactly like device_curtailment_status (the listener
-- runs as the app role with the topic's tenant in app.tenant_id; the WITH
-- CHECK stamps the row).
--
-- Date-based version ABOVE the highest shipped stand (V20260810010000) per the
-- AGENTS.md out-of-order rule.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consumer_runtime_status (
    entity_id             UUID          PRIMARY KEY,
    tenant_id             UUID          NOT NULL,
    site_id               UUID          NOT NULL,
    device_id             UUID          NOT NULL,
    state                 TEXT          NOT NULL,
    reason_code           TEXT,
    actual_kw             DOUBLE PRECISION,
    confirmed             BOOLEAN,
    runtime_seconds_today INTEGER,
    starts_today          INTEGER,
    reported_at           TIMESTAMPTZ   NOT NULL,
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumer_runtime_status_site
    ON consumer_runtime_status (site_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_runtime_status_device
    ON consumer_runtime_status (device_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_runtime_status TO ${appDbUser};

ALTER TABLE consumer_runtime_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_runtime_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_runtime_status_isolation ON consumer_runtime_status;
CREATE POLICY consumer_runtime_status_isolation ON consumer_runtime_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

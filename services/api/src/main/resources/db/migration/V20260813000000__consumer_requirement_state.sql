-- =============================================================================
-- V20260813000000 - consumer_requirement_state: the FULFILMENT ledger of every
-- recurring consumer requirement (Verbrauchssteuerung Inkrement 5 / §9.4).
-- ADDITIVE (new table only).
-- -----------------------------------------------------------------------------
-- Increment 4 deliberately did NOT create this table (there was no writer yet).
-- Increment 5 adds the CLOUD-side writer: it derives the ACTUAL fulfilment of a
-- recurring requirement (fixed window / flexible task) from CONFIRMED consumer
-- telemetry + readback, NEVER from the sent setpoint (§9.4). The writer rides
-- the consumers heartbeat listener (ConsumerRuntimeStatusListener), so it keys
-- on the SAME telemetry that feeds consumer_runtime_status.
--
--   requirement_instance_id  the deterministic per-period id (UUIDv3 of
--                            entity_id + requirement_id + period_start) so a
--                            re-computation is an idempotent UPSERT and later
--                            telemetry overwrites the same row honestly.
--   requirement_id           the stable document requirement id (§10).
--   period_start / deadline  the current recurrence instance in SITE time,
--                            DST-correct (stored as UTC instants).
--   required_energy_kwh /    the demand of the requirement (either or both;
--   required_runtime_seconds NULL = not that kind of goal).
--   actual_energy_kwh /      the confirmed Ist, from telemetry - never the plan.
--   actual_runtime_seconds
--   energy_confirmation      the D3 confirmation level of the energy figure:
--                              measured   = a kWh channel confirmed it,
--                              integrated = kW telemetry integrated it,
--                              assumed    = only relay readback -> Nennleistung x Zeit,
--                            NULL = no energy tracked (a pure runtime goal). Once
--                            it is `assumed` the surface labels the energy
--                            "angenommen", never "gemessen" (§14.13).
--   state                    pending | running | fulfilled | missed | blocked
--                            (§9.4). "Frist gefährdet" (§17) is a DERIVED warn on
--                            the read side, never a stored state.
--   reason_code              §15 vocabulary - why it is where it is.
--
-- No row = no recurring requirement, or no telemetry evidence yet: every
-- surface then reads its honest empty state, never a fabricated fulfilment.
--
-- Tenant-scoped + ENABLE/FORCE ROW LEVEL SECURITY + default-deny exactly like
-- consumer_runtime_status (V20260811000000): the writer runs as the app role
-- with the heartbeat's tenant in app.tenant_id, the WITH CHECK stamps the row.
--
-- Date-based version ABOVE the highest shipped stand (V20260812000000) per the
-- AGENTS.md out-of-order rule.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consumer_requirement_state (
    requirement_instance_id  UUID          PRIMARY KEY,
    requirement_id           TEXT          NOT NULL,
    entity_id                UUID          NOT NULL,
    tenant_id                UUID          NOT NULL,
    site_id                  UUID          NOT NULL,
    period_start             TIMESTAMPTZ   NOT NULL,
    deadline                 TIMESTAMPTZ   NOT NULL,
    required_energy_kwh      NUMERIC(12,3),
    required_runtime_seconds INTEGER,
    actual_energy_kwh        NUMERIC(12,3) NOT NULL DEFAULT 0,
    actual_runtime_seconds   INTEGER       NOT NULL DEFAULT 0,
    energy_confirmation      TEXT          CHECK (energy_confirmation IN
                                 ('measured', 'integrated', 'assumed')),
    state                    TEXT          NOT NULL CHECK (state IN
                                 ('pending', 'running', 'fulfilled', 'missed', 'blocked')),
    reason_code              TEXT,
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumer_requirement_state_entity
    ON consumer_requirement_state (entity_id, deadline DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_requirement_state_site
    ON consumer_requirement_state (site_id, deadline DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_requirement_state TO ${appDbUser};

ALTER TABLE consumer_requirement_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_requirement_state FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_requirement_state_isolation ON consumer_requirement_state;
CREATE POLICY consumer_requirement_state_isolation ON consumer_requirement_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

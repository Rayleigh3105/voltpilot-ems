-- =============================================================================
-- V20260802020000 - device_curtailment_status: the EXECUTION truth of the
-- feed-in curtailment ("Abregeln"). ADDITIVE (new table only).
-- -----------------------------------------------------------------------------
-- The optimizer plans `schedule.curtail_kw` and publishes the per-slot
-- `pv_limit_kw` cap, but WHETHER the plant actually throttles is a device fact:
-- the curtailment actor (Fronius SunSpec Model 123) writes only after a manual
-- per-unit First-Light release, and the primary Deye hybrid cannot curtail on
-- its live remote-control path at all. The edge has been folding exactly that
-- truth into its status heartbeat (the additive `curtailment` block) since it
-- was built - "damit die Cloud 'geplant und ausgeführt' von 'geplant, Anlage
-- kann es (noch) nicht' unterscheiden kann" - and the cloud has been ignoring
-- it, so the portal claimed "die PV wird gedrosselt" next to a measured
-- 16,6 kW feed-in (scout vp-pilsting-abregeln, Frage 2/3; PR 3 of 4).
--
--   units             curtailment-capable units the device has configured.
--   certified_units   units with a persisted per-unit First-Light release.
--                     certified_units < units is THE actionable cause the
--                     portal names ("0 von 2 Wechselrichtern freigegeben").
--   control_enabled   the device's control kill-switch.
--   active            at least one unit currently APPLIES a cap.
--   applied_cap_kw    the summed applied caps (NULL = none applied).
--   all_match         over the applying units' readbacks (NULL = nothing
--                     applied) - only TRUE is a confirmation.
--   possible_override a unit's MEASURED power exceeds its cap after the settle
--                     window: a foreign controller (local setting, Solar.web,
--                     smart meter - Modbus has the lowest priority on Fronius)
--                     may be overriding the limit.
--   checked_at        the newest per-unit readback timestamp - the freshness
--                     anchor. It is the CURTAILMENT block's own timestamp, NOT
--                     the control block's: a device that stops reporting
--                     curtailment while control keeps flowing must not keep an
--                     old "ausgeführt" claim alive.
--
-- Gate flags (units/certified_units/control_enabled) are sourced by the edge
-- from its CORE, the observations (active/all_match/possible_override) from the
-- latest per-unit readbacks - the same split the `control` block learned the
-- hard way (a readback stamp is a Layer-1 observation, never a gate authority).
--
-- No row = an older edge or a plant without a curtailment actor => every
-- consumer keeps its pre-PR-3 PLAN wording ("Abregeln - geplant"), never a
-- fabricated execution claim. One row per device, REPLACED per heartbeat.
--
-- Tenant-scoped + RLS exactly like device_control_status (the listener runs as
-- the app role with the topic's tenant in app.tenant_id, and the WITH CHECK
-- guarantees the row lands in that tenant).
--
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_curtailment_status (
    device_id         UUID          PRIMARY KEY,
    tenant_id         UUID          NOT NULL,
    site_id           UUID          NOT NULL,
    units             INTEGER       NOT NULL,
    certified_units   INTEGER       NOT NULL,
    control_enabled   BOOLEAN       NOT NULL,
    active            BOOLEAN       NOT NULL,
    applied_cap_kw    DOUBLE PRECISION,
    all_match         BOOLEAN,
    possible_override BOOLEAN       NOT NULL,
    checked_at        TIMESTAMPTZ   NOT NULL,
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_curtailment_status_site
    ON device_curtailment_status (site_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_curtailment_status TO ${appDbUser};

ALTER TABLE device_curtailment_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_curtailment_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_curtailment_status_isolation ON device_curtailment_status;
CREATE POLICY device_curtailment_status_isolation ON device_curtailment_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================================================
-- V20260833000000 - device_curtailment_unit: die Abregelung JE EINHEIT.
-- ADDITIVE (new table only).
-- -----------------------------------------------------------------------------
-- V20260802020000 stores the curtailment truth per DEVICE, and it can only
-- COUNT: "0 von 2 Wechselrichtern freigegeben". Which of the two is released,
-- which one holds a cap and which one's readback confirmed it was not
-- answerable - so the Befehle-Seite had to say "an alle freigegebenen
-- Wechselrichter", and the PV device page could not show its OWN curtailment
-- at all (scout vp-geraeteseite-rev-b8 R4a, Captain-Entscheid E2).
--
-- E2 rejected deriving it in the cloud ("alle PV-Geräte mit SunSpec-Steuerpfad
-- gelten als Ziel"): only the BOX knows which unit it wrote to and what came
-- back, so a cloud-side heuristic would be exactly the fabricated attribution
-- ANLAGENWEITE_BEFEHLE exists to avoid. The edge therefore reports the list
-- additively (`curtailment.per_unit[]`), and this table is its store.
--
--   source_id       the JOIN KEY to the reported sources (device_source_status
--                   .source_id): it is how a unit becomes a device NAME, and
--                   the cloud names devices through its ONE name builder - a
--                   name arriving over the wire would be a second naming truth.
--                   PART OF THE KEY: a device reports at most one unit per
--                   source.
--   certified       this unit carries a persisted per-unit First-Light release.
--                   Sourced by the edge from its CORE, never from the readback
--                   stamp - the same gate/observation split the `control` block
--                   learned the hard way.
--   applied_cap_kw  the cap THIS unit currently applies. NULL = none (a release
--                   lifted the limit) - never a fabricated 0.
--   match           this unit's readback verdict. NULL = observed-only, nothing
--                   was commanded; "nothing applied" must never read as "the
--                   readback disagreed". Only TRUE is a confirmation.
--
-- ⚠ The set is REPLACED per heartbeat, exactly like device_source_status: the
-- heartbeat carries the COMPLETE list, so a unit that disappeared must not
-- linger as a ghost.
--
-- ⚠ It carries NO checked_at of its own on purpose. The list arrives inside the
-- `curtailment` block and ages on ITS anchor (device_curtailment_status
-- .checked_at) - a second freshness stamp for the same observation would be a
-- second answer to the same question. Consumers read the list through the
-- status row and inherit its staleness rule.
--
-- ⚠ The list may be SHORTER than device_curtailment_status.units: an entry
-- without a source_id carries no join key and is dropped at ingest rather than
-- attributed to nothing. `units` stays THE count - never derive it from the
-- row count here.
--
-- No rows = an older edge (the block predates this list) or a device whose
-- units carry no source id. Every consumer keeps its "an alle freigegebenen
-- Wechselrichter (N)" wording then, never a fabricated per-unit claim.
--
-- Tenant-scoped + RLS + FORCE exactly like device_curtailment_status.
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_curtailment_unit (
    device_id      UUID    NOT NULL,
    source_id      TEXT    NOT NULL,
    tenant_id      UUID    NOT NULL,
    site_id        UUID    NOT NULL,
    certified      BOOLEAN NOT NULL,
    applied_cap_kw DOUBLE PRECISION,
    match          BOOLEAN,
    PRIMARY KEY (device_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_device_curtailment_unit_site
    ON device_curtailment_unit (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_curtailment_unit TO ${appDbUser};

ALTER TABLE device_curtailment_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_curtailment_unit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_curtailment_unit_isolation ON device_curtailment_unit;
CREATE POLICY device_curtailment_unit_isolation ON device_curtailment_unit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

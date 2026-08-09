-- =============================================================================
-- V20260812000000 - Label-Hygiene: `measurement_point.label` carries ONLY the
-- name a HUMAN gave (concept vp-entity-alias-k1, Captain decision Q1 = "Pfad B",
-- 09.08.2026). Data-only migration (no DDL, no grants - the V2 RLS policies and
-- the app-role privileges already cover this column).
-- -----------------------------------------------------------------------------
-- WHY this exists at all: `label` had TWO writer classes, and that ambiguity is
-- the one structural reason a customer's own name could not win.
--
--   * HUMANS   - the rename pencil (updateEntity), the adopt dialog (a proposal
--                a human confirmed), the Verbraucher-Assistent's "Name" field.
--                These labels ARE customer names.
--   * THE COMPOSITION - bootstrap/backfill wrote exactly the THREE constants
--                below to say HOW a value is measured. They are provenance
--                prose, never a name.
--
-- The customer-facing name chain (`entityLabel.deviceName`) must put the human
-- name FIRST, above the edge label. Doing that while the composition still
-- writes those constants would rename a Deye PV row to "Batteriespeicher
-- (Hybrid-Wechselrichter)" - so the constants are cleared here and the
-- composition stops writing them (EntityRegistryService, same change).
--
-- AFTER this migration the invariant is: label IS NOT NULL  =>  human-given.
-- A new flag column was deliberately NOT added (rejected alternative A): the
-- ambiguity would live in the schema forever and every DTO plus all three
-- topology derivations (Go/TS/Java) would have to carry the flag alongside the
-- label.
--
-- HOUSE PRECEDENT: exactly this cleanup already ran for the edge-source side
-- (V20260729020000__entity_observed_edge_model.sql - "label carries ONLY the
-- operator-given"; brand/model became their own columns). This applies the same
-- principle to the registry side.
--
-- VISIBLE EFFECT, named honestly: an UNNAMED composed row stops reading
-- "Batteriespeicher (Hybrid-Wechselrichter)" and falls back to its role word
-- ("Speicher", komponenten.ts COMPONENT_ROLE_LABELS). Nothing is lost - the
-- provenance line has said the same thing better since M6 ("gemessen über Deye
-- SUN-30K"). A row a human DID name is untouched by construction: the WHERE
-- clause matches the three exact strings and nothing else.
--
-- IDEMPOTENT: re-running matches zero rows.
-- =============================================================================

UPDATE measurement_point
   SET label = NULL
 WHERE label IN (
        'Batteriespeicher (Hybrid-Wechselrichter)',
        'Netzanschluss (Messung über Wechselrichter)',
        'Hausverbrauch (Messung über Wechselrichter)'
       );

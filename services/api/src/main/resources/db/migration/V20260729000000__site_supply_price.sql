-- =============================================================================
-- V20260729000000 - structured supply price per site (Bezugspreis-Komponenten),
-- ADDITIVE. Report vp-nacht-bezug-e7 §3.1 (Stufe 1 of the Nachtbezug fix).
-- -----------------------------------------------------------------------------
-- The optimizer priced grid IMPORT as bare spot for tarif_art='ohne' and
-- 'dynamisch'-without-Aufschlag sites, missing the ~15-19 ct/kWh of real
-- volumetric components (Netzentgelt-Arbeitspreis, Stromsteuer, Konzessions-
-- abgabe, Umlagen, Vertriebsaufschlag) - which made "sell the battery into the
-- evening peak, buy the night back at spot" look profitable while it really
-- destroys ~14 ct per shifted kWh (report §1.4).
--
-- This table is the site's structured Preisblatt, ONE row per site, an own
-- table instead of more site columns (the site row already carries 10+ price
-- fields; the sheet stays maintainable as a unit). All components ct/kWh
-- NETTO, all nullable (NULL = unknown, contributes nothing). The three
-- Umlagen (KWKG + Offshore + §19 StromNEV) are deliberately ONE sum - the
-- operator reads them off one sheet, single columns would be scheingenau.
-- ust_pct is the multiplicative USt on EVERYTHING incl. the spot share
-- (household 19, C&I with Vorsteuer-Abzug 0). komponenten_stand is the
-- "Preisblatt gültig ab" date (yearly operator maintenance).
--
-- Composition (services/optimization pricing.py + api SlotEconomics mirror):
--   dynamisch/ohne + maintained row: (spot + Σ Komponenten netto) × (1 + USt)
--   fest: UNCHANGED all-in retail price - a maintained row is IGNORED with a
--         warning (fest wins, nothing is double-counted).
-- ROLLOUT RULE (byte-identical): NO row = the exact legacy import model; only
-- an explicitly maintained row activates the new composition. This migration
-- therefore seeds NOTHING - tarif_param_ct_kwh is deliberately NOT migrated
-- into rows (the operator fills the sheet in the portal, Stufe 2).
--
-- Tenant-scoped + RLS exactly like site (the V2 pattern via
-- site_profile_state precedent): customers maintain their own sheet through
-- the RLS-scoped app datasource, admins via the X-Tenant-Id switcher - no
-- BYPASSRLS. The optimizer reads it with the trusted backend role (bypasses
-- RLS like telemetry/schedule reads). Date-based version per the AGENTS.md
-- migration coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_supply_price (
    site_id    UUID PRIMARY KEY REFERENCES site(id)   ON DELETE CASCADE,
    tenant_id  UUID NOT NULL    REFERENCES tenant(id) ON DELETE CASCADE,
    -- Preisblatt components, all ct/kWh NETTO, NULL = unknown:
    netzentgelt_arbeitspreis_ct NUMERIC(6, 3)
        CHECK (netzentgelt_arbeitspreis_ct IS NULL OR netzentgelt_arbeitspreis_ct >= 0),
    stromsteuer_ct              NUMERIC(6, 3)
        CHECK (stromsteuer_ct IS NULL OR stromsteuer_ct >= 0),
    konzessionsabgabe_ct        NUMERIC(6, 3)
        CHECK (konzessionsabgabe_ct IS NULL OR konzessionsabgabe_ct >= 0),
    -- KWKG + Offshore + §19 StromNEV as ONE sum (2026: 2.946):
    umlagen_ct                  NUMERIC(6, 3)
        CHECK (umlagen_ct IS NULL OR umlagen_ct >= 0),
    -- Supplier margin on dynamic tariffs (Tibber/Rabot ~1-3 ct):
    vertriebsaufschlag_ct       NUMERIC(6, 3)
        CHECK (vertriebsaufschlag_ct IS NULL OR vertriebsaufschlag_ct >= 0),
    -- USt multiplier on everything incl. spot; 0 for Vorsteuer-Abzug (C&I):
    ust_pct                     NUMERIC(5, 2) NOT NULL DEFAULT 19.0
        CHECK (ust_pct >= 0 AND ust_pct <= 100),
    -- "Preisblatt gültig ab" (operator maintenance metadata):
    komponenten_stand           DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_supply_price_tenant ON site_supply_price (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_supply_price TO ${appDbUser};

ALTER TABLE site_supply_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_supply_price FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_supply_price_isolation ON site_supply_price;
CREATE POLICY site_supply_price_isolation ON site_supply_price
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

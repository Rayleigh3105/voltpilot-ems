-- =============================================================================
-- V20260708010000 - site tariff model (Meine Anlage nachvollziehbar, captain
-- decision 2026-07-08). REPLACES the fixed site.strompreis_ct_kwh.
-- -----------------------------------------------------------------------------
-- The money-centric "Meine Anlage" view values a site's SELF-CONSUMED energy in
-- euros. A single fixed retail price (the old strompreis_ct_kwh) is WRONG for
-- the many customers on a DYNAMIC tariff: their price changes every quarter
-- hour and there is no single fixed value - only the anzulegender Wert is truly
-- fixed. VoltPilot already knows the Börsenpreis of every 15-min slot, so a
-- dynamic tariff is "Börsenpreis + fester Aufschlag" (Netzentgelte, Abgaben,
-- Marge) and the Eigenverbrauchs-Wert can be computed EXACTLY, slot by slot.
--
-- Cleanest schema = ONE enum + ONE numeric (not two fixed/dynamic numerics):
-- the numeric is mutually exclusive by tarif_art, so a single shared column
-- avoids two nullable numerics of which only one is ever meaningful, and gives
-- one column to migrate the old strompreis into.
--
--   site.tarif_art          - 'dynamisch' | 'fest' | 'ohne' (default 'ohne').
--   site.tarif_param_ct_kwh - the tarif parameter (ct/kWh), meaning per art:
--        fest      -> the fixed retail price (the old strompreis behaviour);
--        dynamisch -> the OPTIONAL Aufschlag on the spot price (grid fees,
--                     levies, margin) - null/0 = value at pure spot (honest,
--                     conservative);
--        ohne      -> no euro value (self-consumption shown in kWh only).
--
-- Migration of the existing strompreis_ct_kwh (added one day earlier by
-- V20260707030000): a non-null value is a fixed retail price, so it maps to
-- tarif_art='fest' with that value; a null value meant "no euro for
-- self-consumption", which is EXACTLY 'ohne' - the least-surprising default
-- (reproduces today's kWh-only behaviour with zero change). The old column is
-- then dropped: unlike the deprecated marktpraemie_ct_kwh (a DIFFERENT quantity,
-- kept one release), strompreis IS faithfully migratable, so we migrate its data
-- and drop it - no data loss, no dead column.
--
-- Pure additive ALTER + a data copy + a DROP: the existing site RLS policy +
-- grants (V2) already cover the new columns, so no infra bootstrap mirror and no
-- new grant are needed. The anzulegender Wert stays its own fixed field,
-- unchanged.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS tarif_art TEXT NOT NULL DEFAULT 'ohne'
    CHECK (tarif_art IN ('dynamisch', 'fest', 'ohne'));

ALTER TABLE site ADD COLUMN IF NOT EXISTS tarif_param_ct_kwh NUMERIC(8, 3)
    CHECK (tarif_param_ct_kwh IS NULL OR tarif_param_ct_kwh >= 0);

-- Carry the old fixed strompreis into the new model as a 'fest' tariff. Guarded
-- so it never fails if the column was already dropped on some odd path.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'site' AND column_name = 'strompreis_ct_kwh'
    ) THEN
        EXECUTE 'UPDATE site SET tarif_art = ''fest'', tarif_param_ct_kwh = strompreis_ct_kwh'
                || ' WHERE strompreis_ct_kwh IS NOT NULL';
    END IF;
END $$;

ALTER TABLE site DROP COLUMN IF EXISTS strompreis_ct_kwh;

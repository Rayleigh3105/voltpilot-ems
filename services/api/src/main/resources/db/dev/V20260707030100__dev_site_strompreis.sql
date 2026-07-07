-- =============================================================================
-- DEV-ONLY SEED (see V100): a retail electricity price for the demo household.
-- -----------------------------------------------------------------------------
-- The money-centric "Meine Anlage" view values self-consumed energy in euros
-- only when the site carries a strompreis_ct_kwh (V20260707030000). Give Hof
-- Lindenberg (the demo fleet's Eigenverbrauch household, seeded in
-- V20260706020000) a realistic ~32.5 ct/kWh so the demo shows a real
-- Eigenverbrauchs-Wert next to the feed-in revenue. UPDATE = inherently
-- existence-guarded (a no-op when the fleet seed is absent, the V100 pattern).
-- =============================================================================

UPDATE site SET strompreis_ct_kwh = 32.500
WHERE id = '00000000-0000-0000-0000-000000000022';

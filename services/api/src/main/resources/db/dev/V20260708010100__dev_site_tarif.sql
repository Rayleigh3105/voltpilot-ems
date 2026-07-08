-- =============================================================================
-- DEV-ONLY SEED (see V100): give the demo household a DYNAMIC tariff so the
-- money view demonstrates the new slot-by-slot Eigenverbrauchs-Wert.
-- -----------------------------------------------------------------------------
-- V20260707030100 seeded Hof Lindenberg a fixed strompreis (32.5 ct/kWh), which
-- V20260708010000 migrated to tarif_art='fest'. Switch it to a DYNAMIC tariff
-- with an 18 ct/kWh Aufschlag (the mockup's example) so the demo shows the
-- headline feature: self-consumption valued at the Börsenpreis of each quarter
-- hour plus the fixed Aufschlag. UPDATE = inherently existence-guarded (a no-op
-- when the fleet seed is absent, the V100 pattern).
-- =============================================================================

UPDATE site SET tarif_art = 'dynamisch', tarif_param_ct_kwh = 18.000
WHERE id = '00000000-0000-0000-0000-000000000022';

-- =============================================================================
-- DEV-ONLY SEED (see V100): Monatsmarktwert Solar + Dachau's anzulegender Wert.
-- -----------------------------------------------------------------------------
-- The dynamic Marktprämie (V20260707020000) needs BOTH a per-site anzulegender
-- Wert and the month's Monatsmarktwert Solar. Without the feeds profile the
-- collector never runs locally, so the demo fleet would show no premium and no
-- benchmark KPI. Seed:
--
--   * Solarpark Dachau (Direktvermarktung) gets a realistic anzulegender Wert
--     of 8.11 ct/kWh (rooftop-tender scale). UPDATE = inherently
--     existence-guarded (no-op without the fleet seed).
--   * monthly_market_value gets plausible MW Solar rows for the current and
--     the previous three German calendar months (covering the rolling 30-day
--     rollup seed of V20260706030000 across month boundaries); the current
--     month is flagged provisional like the real collector would. Deterministic
--     values in the 2025/26 range (~3-6 ct/kWh). ON CONFLICT DO NOTHING so
--     rows written by a real collector run always win; tests that pin exact
--     premium numbers must OWN their months via ON CONFLICT DO UPDATE (the
--     seedHistoryDay price rule).
-- =============================================================================

UPDATE site SET anzulegender_wert_ct_kwh = 8.11
WHERE id = '00000000-0000-0000-0000-000000000012';

INSERT INTO monthly_market_value (month, technology, value_ct_kwh, provisional, source)
VALUES
    (date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')::date,
     'solar', 5.923, TRUE,  'voltpilot-provisional'),
    ((date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') - INTERVAL '1 month')::date,
     'solar', 4.107, FALSE, 'netztransparenz'),
    ((date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') - INTERVAL '2 months')::date,
     'solar', 3.163, FALSE, 'netztransparenz'),
    ((date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') - INTERVAL '3 months')::date,
     'solar', 1.317, FALSE, 'netztransparenz')
ON CONFLICT (technology, month) DO NOTHING;

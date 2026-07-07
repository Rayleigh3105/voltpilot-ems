-- =============================================================================
-- DEV-ONLY SEED (see V100): Solarpark Dachau runs with grid charging enabled.
-- -----------------------------------------------------------------------------
-- The demo fleet should show BOTH modes of the per-site grid-charging switch
-- (V20260707000000): Dachau (Direktvermarktung) flips to "Netzladen aktiv",
-- Demo Site Berlin + Hof Lindenberg stay on the compliant default
-- "Nur Solarladen (EEG)".
--
-- Existence-guarded by construction (the 2026-07-07 dev-seed rule): an UPDATE
-- of an absent row is a no-op, so a deployment without the demo fleet seed
-- migrates cleanly.
-- =============================================================================

UPDATE site SET netzladen_erlaubt = TRUE
WHERE id = '00000000-0000-0000-0000-000000000012';

-- Give Dachau's seeded plans (V20260706020000, grid_kw = 0 everywhere) a
-- cheap-night GRID-CHARGE window (02:00-06:00 Berlin: charging while
-- net-importing), so the Fahrplan chart demos its "Laden aus dem Netz" color
-- next to the solar-charge midday window. Costs/baselines stay untouched -
-- the savings numbers other seeds/tests read are unaffected.
UPDATE schedule
SET battery_kw = 30.0, grid_kw = 34.0
WHERE site_id = '00000000-0000-0000-0000-000000000012'
  AND EXTRACT(HOUR FROM time AT TIME ZONE 'Europe/Berlin') BETWEEN 2 AND 5;

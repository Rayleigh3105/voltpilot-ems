-- =============================================================================
-- V20260716000000 - site.max_feed_in_kw (static feed-in cap at the grid
-- connection point / Einspeisegrenze am Netzanschlusspunkt).
-- -----------------------------------------------------------------------------
-- Optimizer sharpening FK1 (scout vp-solver-xlsx-f2, the captain's Excel
-- reference spec models "Max Einspeisung am Netzpunkt" as a site parameter):
-- the maximum power the site may EXPORT at its grid connection point, in kW.
-- NULL (the default) means no connection-point limit. The optimizer
-- (services/optimization inputs.py -> solver.py) enforces it as a hard cap on
-- grid EXPORT ONLY - import is never limited by it, which distinguishes it
-- from the telemetry-driven §14a grid_limit_kw (symmetric, observed); when
-- both exist the tighter one wins on export. A site with 100-kW PV on a
-- 75-kW connection becomes correctly plannable: the plan caps export and
-- curtails/charges the surplus instead of scheduling an impossible feed-in.
--
-- Pure additive ALTER (the backup_reserve_soc_pct precedent V20260710010000):
-- layers over any existing volume, no infra bootstrap mirror needed. The
-- existing site RLS policy + grants (V2) cover the new column.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS max_feed_in_kw NUMERIC(8, 2)
    CHECK (max_feed_in_kw IS NULL OR max_feed_in_kw > 0);

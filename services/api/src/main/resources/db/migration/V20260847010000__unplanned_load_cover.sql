-- Additive unforeseen-load coverage contract + execution evidence.
-- Existing fields keep their meaning; nullable columns make old plans/edges
-- honest unknowns and require no backfill.
ALTER TABLE schedule
    ADD COLUMN IF NOT EXISTS unplanned_load_discharge BOOLEAN,
    ADD COLUMN IF NOT EXISTS effective_floor_soc_pct NUMERIC(5, 2);

ALTER TABLE device_control_status
    ADD COLUMN IF NOT EXISTS execution_floor_soc_pct DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS execution_measurements_fresh BOOLEAN;

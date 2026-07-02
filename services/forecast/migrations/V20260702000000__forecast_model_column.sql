-- =============================================================================
-- Voltpilot-EMS - forecast model tagging (shadow-mode forecasting foundation)
-- -----------------------------------------------------------------------------
-- Every persisted forecast row is tagged with the registry-level MODEL ID that
-- produced it (voltpilot_forecast.registry): the baselines 'load-persistence' /
-- 'pv-physical' and the shadow challengers 'load-xgb' / 'pv-residual-xgb'. The
-- active model and its challengers coexist in this one table; the optimizer
-- filters on the ACTIVE model id only, the daily evaluation compares all of
-- them against telemetry actuals. Existing rows are backfilled as the baseline
-- ids (they were produced by the baseline implementations).
--
-- VERSION COORDINATION (see AGENTS.md): the forecast service owns the forecast
-- hypertable (V3); this follow-up takes a date-based version so it can never
-- collide with the api's V1/V2/V4 or its V2026-07-01 date scope, nor with
-- market-data's V20260701001200. The api's V20260701040000 applies the SAME
-- idempotent DDL (canonical runtime owner - api Flyway is what actually runs in
-- every deployment), exactly like the weather_forecast precedent; the dev/prod
-- bootstrap mirrors are infra/local/timescale/02-forecast.sql and
-- infra/prod/timescale/00-collector-tables.sql. Keep all four in sync.
-- =============================================================================

ALTER TABLE forecast ADD COLUMN IF NOT EXISTS model TEXT;

UPDATE forecast
SET model = CASE kind WHEN 'pv' THEN 'pv-physical' ELSE 'load-persistence' END
WHERE model IS NULL;

ALTER TABLE forecast ALTER COLUMN model SET NOT NULL;

-- Widen the primary key to include the model, so two models forecasting the
-- same site/kind/slot in the same run instant stay distinct rows and each
-- model's upsert stays idempotent. Guarded: only swaps when the current PK
-- does not already contain `model` (re-runs are no-ops).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'forecast'::regclass
          AND c.contype = 'p'
          AND a.attname = 'model'
    ) THEN
        ALTER TABLE forecast DROP CONSTRAINT forecast_pkey;
        ALTER TABLE forecast ADD CONSTRAINT forecast_pkey
            PRIMARY KEY (site_id, kind, model, run_at, time);
    END IF;
END
$$;

-- The optimizer's hot path becomes "latest run of THE ACTIVE MODEL".
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_model_run
    ON forecast (site_id, kind, model, run_at DESC);

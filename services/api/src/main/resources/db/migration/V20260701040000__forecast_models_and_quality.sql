-- =============================================================================
-- V20260701040000 - Shadow-mode forecasting: model-tagged forecasts + the
--                   measurement tables behind "Prognosequalität".
-- -----------------------------------------------------------------------------
-- The captain-approved ML path keeps the decision layer (the MILP) untouched
-- and turns the FORECAST layer into a measurable, comparable, swappable model
-- registry (docs/forecasting.md):
--
--   1. `forecast.model` - every persisted prediction is tagged with the
--      registry-level model id that produced it ('load-persistence' /
--      'pv-physical' baselines, 'load-xgb' / 'pv-residual-xgb' challengers).
--      Existing rows backfill as the baseline ids. The PK widens to include
--      the model so active + shadow models coexist idempotently; the
--      optimizer reads ONLY the active model's rows (env-selected, default =
--      baselines), so nothing changes behaviorally until the captain promotes.
--   2. `forecast_model_state` - per site x model: lifecycle status
--      ('collecting' while the challenger gathers its minimum training days,
--      'ready' once it predicts in shadow) + the explainability trail of the
--      last training run (trained_at, rows, top feature importances with
--      plain-German labels).
--   3. `forecast_accuracy` - the daily evaluation: per site x model x
--      Europe/Berlin day, forecast-vs-actual MAE (kW), nMAE (% of mean
--      absolute actual), bias, and the skill score vs the kind's baseline
--      (positive = challenger better). This is the evidence a promotion
--      decision is based on - promotion itself stays a human env flip.
--   4. `plan_accuracy` - daily plan economics: realized grid cost (telemetry x
--      day-ahead price) vs the optimizer's projected cost and its no-battery
--      baseline, per site x Berlin day (extends the plan-vs-actual groundwork).
--
-- All three new tables carry tenant_id and get the SAME RLS policy as
-- telemetry/weather/schedule; the forecast collector/evaluator write as the
-- trusted backend role (bypasses RLS, stamps tenant_id from the owning site -
-- the weather-collector pattern) and the portal reads through the RLS-scoped
-- app role. `forecast` itself stays api-unread (the optimizer consumes it with
-- backend credentials), so it keeps having no RLS policy - unchanged stance.
--
-- Ownership: the api migration is the canonical RUNTIME owner (its Flyway is
-- what actually runs in every deployment), layering idempotently over the dev
-- bootstrap (infra/local/timescale/02-forecast.sql) and owning a fresh DB
-- outright - exactly the weather_forecast precedent (V20260701010000). The
-- forecast service mirrors the forecast-table change in its own migration
-- chain (services/forecast/migrations/V20260702000000__forecast_model_column
-- .sql); the prod bootstrap mirror is infra/prod/timescale/00-collector-
-- tables.sql. Keep them in sync. Date-based version per AGENTS.md.
-- =============================================================================

-- ---- 1. forecast: create fresh (new shape) or retrofit the model column ------

CREATE TABLE IF NOT EXISTS forecast (
    time            TIMESTAMPTZ    NOT NULL,   -- slot start = target time of the value
    tenant_id       UUID           NOT NULL,
    site_id         UUID           NOT NULL,
    kind            TEXT           NOT NULL
                        CHECK (kind IN ('load', 'pv')),
    model           TEXT           NOT NULL,   -- registry model id (tagged provenance)
    value_kw        NUMERIC(12, 4) NOT NULL,   -- mean power over the 15-min slot (kW)
    run_at          TIMESTAMPTZ    NOT NULL,   -- issue time of the forecast run
    horizon_min     INTEGER        NOT NULL,   -- lead time in minutes (time - run_at)
    method          TEXT           NOT NULL,
    schema_version  INTEGER        NOT NULL DEFAULT 1,
    PRIMARY KEY (site_id, kind, model, run_at, time)
);
SELECT create_hypertable('forecast', 'time',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);

-- Retrofit path (dev bootstrap DB created before the model column existed).
ALTER TABLE forecast ADD COLUMN IF NOT EXISTS model TEXT;
UPDATE forecast
SET model = CASE kind WHEN 'pv' THEN 'pv-physical' ELSE 'load-persistence' END
WHERE model IS NULL;
ALTER TABLE forecast ALTER COLUMN model SET NOT NULL;

-- Widen the PK to include the model (guarded; no-op when already widened).
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

CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_run
    ON forecast (site_id, kind, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_model_run
    ON forecast (site_id, kind, model, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_site_kind_time
    ON forecast (site_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_time
    ON forecast (tenant_id, time DESC);

-- ---- 2. forecast_model_state (challenger lifecycle + explainability trail) ---

CREATE TABLE IF NOT EXISTS forecast_model_state (
    tenant_id          UUID        NOT NULL,
    site_id            UUID        NOT NULL,
    model              TEXT        NOT NULL,   -- registry model id
    kind               TEXT        NOT NULL CHECK (kind IN ('load', 'pv')),
    -- 'collecting': the self-gate is not met yet, the model emits NO
    --               predictions (days_collected of days_required tell the
    --               portal the honest "sammelt Daten: Tag X von N" story).
    -- 'ready':      trained and predicting (in shadow unless env-active).
    status             TEXT        NOT NULL CHECK (status IN ('collecting', 'ready')),
    days_collected     INTEGER,
    days_required      INTEGER,
    trained_at         TIMESTAMPTZ,            -- last training run (NULL for baselines)
    train_rows         INTEGER,                -- training samples of that run
    -- Top feature importances of the last training run, most important first:
    -- [{"feature": "...", "label": "<plain German>", "weight": 0..1}, ...]
    feature_importance JSONB,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, model)
);

-- ---- 3. forecast_accuracy (daily forecast-vs-actual metrics per model) -------

CREATE TABLE IF NOT EXISTS forecast_accuracy (
    day               DATE           NOT NULL,  -- Europe/Berlin day (like Historie)
    tenant_id         UUID           NOT NULL,
    site_id           UUID           NOT NULL,
    model             TEXT           NOT NULL,  -- registry model id
    kind              TEXT           NOT NULL CHECK (kind IN ('load', 'pv')),
    mae_kw            NUMERIC(12, 4) NOT NULL,  -- mean |forecast - actual| over the day
    nmae_pct          NUMERIC(8, 3),            -- MAE / mean(|actual|) * 100 (NULL on all-zero days)
    bias_kw           NUMERIC(12, 4),           -- mean (forecast - actual): systematic error sign
    skill_vs_baseline NUMERIC(8, 4),            -- 1 - mae/mae_baseline; >0 = better than baseline;
                                                -- NULL for the baseline itself
    n_slots           INTEGER        NOT NULL,  -- 15-min slots with both forecast and actual
    computed_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, model, day)
);
CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_site_day
    ON forecast_accuracy (site_id, day DESC);

-- ---- 4. plan_accuracy (daily plan economics: realized vs planned) ------------

CREATE TABLE IF NOT EXISTS plan_accuracy (
    day               DATE           NOT NULL,  -- Europe/Berlin day
    tenant_id         UUID           NOT NULL,
    site_id           UUID           NOT NULL,
    planned_cost_eur  NUMERIC(12, 4),           -- optimizer's projected cost (latest run per slot)
    baseline_cost_eur NUMERIC(12, 4),           -- projected cost with the battery idle
    realized_cost_eur NUMERIC(12, 4),           -- actual signed grid cost (telemetry x price)
    n_slots           INTEGER        NOT NULL,  -- slots where plan, actual AND price all exist
    computed_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, day)
);

-- ---- 5. RLS + read grants (exactly the telemetry/schedule pattern) -----------

GRANT SELECT ON forecast_model_state, forecast_accuracy, plan_accuracy
    TO ${appDbUser};

ALTER TABLE forecast_model_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_model_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forecast_model_state_isolation ON forecast_model_state;
CREATE POLICY forecast_model_state_isolation ON forecast_model_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE forecast_accuracy ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_accuracy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forecast_accuracy_isolation ON forecast_accuracy;
CREATE POLICY forecast_accuracy_isolation ON forecast_accuracy
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE plan_accuracy ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_accuracy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_accuracy_isolation ON plan_accuracy;
CREATE POLICY plan_accuracy_isolation ON plan_accuracy
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

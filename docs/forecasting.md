# Shadow-mode forecasting: the model lifecycle

This document is the reference for how VoltPilot's forecast layer evolves from the shipped baselines toward ML - with **Nachvollziehbarkeit (traceability) as the core requirement**.
The decision layer (the battery-dispatch MILP in `services/optimization`) never changes; only the forecast layer becomes a measurable, comparable, swappable **model registry**.

## The principle

1. **Every prediction is tagged.** Each forecaster carries a stable model id (`voltpilot_forecast/registry.py`); every persisted row in the `forecast` hypertable carries that id in its `model` column.
2. **Exactly one model per kind is active.** The optimizer consumes ONLY the active model's rows; everything else runs in **shadow** - predicting and persisting every cycle exactly like the active model, influencing nothing.
3. **A challenger must prove itself on recorded history.** The daily evaluation compares every model's predictions against telemetry actuals and stores the result (`forecast_accuracy`), including a skill score vs the baseline.
4. **Promotion is a human act.** There is NO automatic promotion. The captain flips the active-model env vars after the evaluation shows a sustained win. The portal ("Prognosequalität") shows the same evidence to the customer in plain German.

## The models

| Model id | Kind | Role | Implementation |
|---|---|---|---|
| `load-persistence` | load | **Baseline, active default** | Same slot yesterday (`SeasonalPersistenceLoadForecaster`) |
| `pv-physical` | pv | **Baseline, active default** | Solar geometry + irradiance + PVWatts derate (`PhysicalPvForecaster`, Open-Meteo weather when stored) |
| `load-xgb` | load | Challenger (shadow) | XGBoost on tabular features: Berlin-local slot-of-day, weekday, weekend, German-holiday flag, leakage-safe lags (-1d/-7d same slot), windowed means, outdoor temperature (`voltpilot_forecast/ml.py`) |
| `pv-residual-xgb` | pv | Challenger (shadow) | Physical model + learned residual on weather features; prediction = physical + residual, clipped to [0, capacity] |

Library choice: **xgboost** behind the optional `[ml]` extra (the HiGHS-solver pattern - baselines and all evaluation math run without it).
LightGBM's wheel situation is no friendlier (both need OpenMP: `brew install libomp` on macOS, `libgomp1` on Linux - the Dockerfile installs it); xgboost won on native NaN handling and gain importances feeding the explainability trail.
The code uses the native Booster API, not the sklearn wrapper, so scikit-learn is not a dependency.

## Self-gating (honesty before cleverness)

A challenger refuses to train until a site has **21 full telemetry days** (`VOLTPILOT_ML_MIN_DAYS`; a day counts when at least half of its 96 15-min slots have data).
Below the gate it emits **no predictions** and records `status = collecting` with `days_collected`/`days_required` in `forecast_model_state` - the portal renders this as "Sammelt Daten: Tag X von 21" instead of pretending.

Challengers retrain **once per Berlin day** (first collector cycle after midnight).
Every training run persists its explainability trail: `trained_at`, `train_rows`, and the top-5 feature importances with plain-German labels (`FEATURE_LABELS_DE` in `features.py`).

## The pipeline

```
                     every 15 min                          nightly
telemetry ─┐   ┌──────────────────────────┐   ┌──────────────────────────────┐
weather ───┼──▶│ forecast collector        │   │ evaluation                    │
           │   │ (forecast_collect.py)     │   │ (evaluate.py)                 │
           │   │  baselines + gated        │   │  per site x model x Berlin day│
           │   │  challengers, ALL persist │   │  MAE / nMAE / bias / skill    │
           │   │  model-tagged             │   │  + plan economics             │
           │   └─────────────┬────────────┘   └──────────────┬───────────────┘
           │                 ▼                                ▼
           │        forecast (hypertable,            forecast_accuracy,
           │        model column)                    plan_accuracy,
           │                 │                       forecast_model_state
           │                 ▼                                │
           │        optimizer reads ONLY                      ▼
           └───────▶ the ACTIVE model            api /forecast-quality ─▶ portal
                     (inputs.py model filter)        "Prognosequalität"
```

One container (`forecast-collector`, compose `feeds` profile; the `forecast` service in prod) covers collect + nightly retrain + daily evaluation.

## Evaluation semantics

Stored in `forecast_accuracy`, one row per site x model x **Europe/Berlin day** (idempotent upserts; re-running a day after late telemetry overwrites):

* **Which prediction counts:** per 15-min slot, the model's freshest prediction issued at or before the slot start (`run_at <= time`) - exactly what the optimizer would have consumed had that model been active. All models re-predict every cycle, so the comparison is lead-time-fair.
* **MAE (kW)** - the headline "Ø Abweichung". **nMAE (%)** - MAE / mean absolute actual (NULL on all-zero days). **Bias (kW)** - mean signed error.
* **Skill vs baseline** = `1 - mae_model / mae_baseline`. Positive = the challenger was better that day. NULL for the baseline itself and when the baseline MAE is ~0.

`plan_accuracy` extends the plan-vs-actual groundwork: per site x day, the optimizer's projected cost (freshest plan per slot, `generated_at <= time`) and its no-battery baseline vs the **realized** signed grid cost (telemetry x day-ahead price), summed over exactly the slots where plan, actual and price all exist.

## Promotion (and rollback)

```bash
# .env (dev) / /srv/docker/voltpilot/.env (prod) - then recreate the services
VOLTPILOT_ACTIVE_LOAD_MODEL=load-xgb      # default: load-persistence
VOLTPILOT_ACTIVE_PV_MODEL=pv-physical     # default: pv-physical
```

Set the SAME values on all three consumers - `forecast-collector`/`forecast` (logs them), `optimizer`/`optimization` (filters its forecast reads), and `api` (displays the "live" badge) - and recreate those containers.
Rollback is the same flip in reverse; shadow history for all models is retained either way, so the comparison never stops.

A promotion should be justified by `forecast_accuracy` showing a sustained positive skill (e.g. clearly positive on most of the last 14+ evaluated days, both seasons of load behavior if possible) - the portal's "Prognosequalität" page and a direct SQL query tell the same story.

## Storage (all owned by api Flyway `V20260701040000`)

| Table | Grain | RLS |
|---|---|---|
| `forecast` (+ `model` column) | site x kind x model x run x slot | none (backend-only consumers) |
| `forecast_model_state` | site x model | tenant-scoped, portal reads |
| `forecast_accuracy` | site x model x Berlin day | tenant-scoped, portal reads |
| `plan_accuracy` | site x Berlin day | tenant-scoped, portal reads |

The collector/evaluator write as the trusted backend role and stamp `tenant_id` from the owning site (the weather-collector pattern); the api reads through the RLS-scoped app role.
Version coordination and the bootstrap mirrors are documented in AGENTS.md and in the migration headers.

## Future work

Quantile objectives for uncertainty bands (architecture 12.2), per-Bundesland holidays, an ML PV model beyond residual correction, automatic promotion *proposals* (never automatic promotion), and per-tenant evaluation windows.

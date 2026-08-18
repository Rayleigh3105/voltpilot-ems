# Shadow-mode forecasting: the model lifecycle

This document is the reference for how VoltPilot's forecast layer evolves from the shipped baselines toward ML - with **Nachvollziehbarkeit (traceability) as the core requirement**.
The decision layer (the battery-dispatch MILP in `services/optimization`) never changes; only the forecast layer becomes a measurable, comparable, swappable **model registry**.

## The principle

1. **Every prediction is tagged.** Each forecaster carries a stable model id (`voltpilot_forecast/registry.py`); every persisted row in the `forecast` hypertable carries that id in its `model` column.
2. **Exactly one model per kind is active.** The optimizer consumes ONLY the active model's rows; everything else runs in **shadow** - predicting and persisting every cycle exactly like the active model, influencing nothing.
3. **A challenger must prove itself on recorded history.** The daily evaluation compares every model's predictions against telemetry actuals and stores the result (`forecast_accuracy`), including a skill score vs the baseline.
4. **Promotion is a human act.** There is NO automatic promotion. Since 18.08.2026 it is **one button in the portal** (Prognosequalität → „Kandidat übernehmen", platform-admin only) instead of an env flip on three containers; the same page shows the evidence the decision rests on, in plain German.

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
* **Skill vs the ACTIVE model** = `1 - mae_model / mae_reference`, where the reference is the kind's **active** model - i.e. the one that really plans. Positive = the other model was better that day. NULL for the reference itself and when its MAE is ~0. (While nothing is promoted, active == baseline, so every stored number is unchanged from before the switch; after a promotion the roles swap cleanly and the demoted model keeps getting a skill number. The DB column keeps its historical name `skill_vs_baseline` - an applied migration is immutable.)

`plan_accuracy` extends the plan-vs-actual groundwork: per site x day, the optimizer's projected cost (freshest plan per slot, `generated_at <= time`) and its no-battery baseline vs the **realized** signed grid cost (telemetry x day-ahead price), summed over exactly the slots where plan, actual and price all exist.

## Promotion (and rollback)

**Der Weg ist das Portal.** Prognosequalität → der Kandidat einer Prognoseart → „Kandidat übernehmen" (nur Portal-Admins; die Bestätigung nennt die Folgen). Ab dem nächsten Planungslauf - spätestens 15 Minuten später - konsumiert der Optimierer die Prognosereihen des neuen Modells; das abgelöste Modell rechnet unverändert im Schatten weiter und wird weiter täglich bewertet. **Der Rückweg ist derselbe Knopf in die Gegenrichtung** - es geht keine Historie verloren, und ein zurückgetauschtes Modell hat sofort wieder seine Bewertung.

Technisch dahinter: `POST /api/v1/admin/forecast-models {kind, model}` schreibt eine Zeile in die globale, **append-only** Tabelle `forecast_model_choice` (api-Migration `V20260825000000`). Sie ist zugleich das Audit-Journal - jede Zeile trägt von→zu, das JWT-Subject des Umstellers, seinen Anzeige-Namen und den Zeitpunkt; „was gilt gerade" ist die jüngste Zeile je Art.

**Die Präzedenz ist der ganze Vertrag** und steht wortgleich in der Migration, in `ForecastModelService` (api), in `voltpilot_forecast/model_choice.py` und in `voltpilot_optimization/inputs.py`:

1. die jüngste Zeile in `forecast_model_choice` je Art - sie gewinnt,
2. sonst die Umgebungsvariable (`VOLTPILOT_ACTIVE_LOAD_MODEL` / `VOLTPILOT_ACTIVE_PV_MODEL`),
3. sonst der Registry-Default (das Basismodell).

Ohne eine einzige Zeile ist damit jeder Pfad **byte-identisch** zu vorher. Umgekehrt heißt es: auf einer umgestellten Flotte ist ein späterer Env-Edit **wirkungslos** - genau richtig, denn sonst nähme ein Redeploy die bewusste Portal-Entscheidung stillschweigend zurück. Wer wirklich zur Umgebung zurück will, stellt im Portal auf den Env-Wert zurück (dann steht dort dieselbe Modell-Id, die Quelle bleibt aber ehrlich „portal": es IST eine Entscheidung).

Der Env-Weg bleibt als **Vorgabe** für frische Deployments bestehen:

```bash
# .env (dev) / /srv/docker/voltpilot/.env (prod) - then recreate the services
VOLTPILOT_ACTIVE_LOAD_MODEL=load-xgb      # default: load-persistence
VOLTPILOT_ACTIVE_PV_MODEL=pv-physical     # default: pv-physical
```

Dieselben Werte auf allen drei Verbrauchern setzen - `forecast-collector`/`forecast`, `optimizer`/`optimization` und `api` - und die Container neu erzeugen. Alle drei lösen dieselbe Präzedenz auf und lesen dieselbe Tabelle, können also nicht auseinanderlaufen; der Optimierer liest sie **einmal je Lauf** für die ganze Flotte.

Eine Beförderung sollte durch `forecast_accuracy` gedeckt sein (klar positiver Skill an den meisten der letzten 14+ bewerteten Tage, möglichst über beide Lastsaisons) - die Prognosequalität-Seite legt genau diese Tage als aufklappbare Liste offen, und eine direkte SQL-Abfrage erzählt dieselbe Geschichte.

## Storage (all owned by api Flyway `V20260701040000`)

| Table | Grain | RLS |
|---|---|---|
| `forecast` (+ `model` column) | site x kind x model x run x slot | none (backend-only consumers) |
| `forecast_model_state` | site x model | tenant-scoped, portal reads |
| `forecast_accuracy` | site x model x Berlin day | tenant-scoped, portal reads |
| `plan_accuracy` | site x Berlin day | tenant-scoped, portal reads |
| `forecast_model_choice` (V20260825000000) | kind x Umstellung (append-only) | none - PLATTFORM-weit, wie `edge_release`; App-Rolle nur SELECT |

The collector/evaluator write as the trusted backend role and stamp `tenant_id` from the owning site (the weather-collector pattern); the api reads through the RLS-scoped app role.
Version coordination and the bootstrap mirrors are documented in AGENTS.md and in the migration headers.

## Future work

Quantile objectives for uncertainty bands (architecture 12.2), per-Bundesland holidays, an ML PV model beyond residual correction, automatic promotion *proposals* (never automatic promotion), and per-tenant evaluation windows.

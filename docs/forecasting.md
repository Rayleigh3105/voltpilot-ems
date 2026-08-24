# Shadow-mode forecasting: the model lifecycle

This document is the reference for how VoltPilot's forecast layer evolves from the shipped baselines toward ML - with **Nachvollziehbarkeit (traceability) as the core requirement**.
The decision layer (the battery-dispatch MILP in `services/optimization`) never changes; only the forecast layer becomes a measurable, comparable, swappable **model registry**.

## The principle

1. **Every prediction is tagged.** Each forecaster carries a stable model id (`voltpilot_forecast/registry.py`); every persisted row in the `forecast` hypertable carries that id in its `model` column.
2. **Exactly one model per kind is active.** The optimizer consumes ONLY the active model's rows; everything else runs in **shadow** - predicting and persisting every cycle exactly like the active model, influencing nothing.
3. **A challenger must prove itself on recorded history.** The daily evaluation compares every model's predictions against telemetry actuals and stores the result (`forecast_accuracy`), including a skill score vs the baseline.
4. **Promotion is a human act, PER PLANT.** There is NO automatic promotion. Since 18.08.2026 it is **one button in the portal** (Prognosequalität → „Kandidat übernehmen") instead of an env flip on three containers, and since 19.08.2026 the decision belongs to the **plant** and to its **owner**: which model fits best depends on the individual plant (load profile, weather, storage size), so a candidate that wins on a commercial yard can lose on a single-family house. The same page shows the evidence the decision rests on, in plain German.

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

## The PV nowcast anchor (Morgenprognose, 2026-08-24)

Between the stored forecast and the plan sits ONE more correction, and it is
deliberately NOT a model: **the optimizer scales the ACTIVE PV model's near
horizon by that model's own recent, measured error** (the classic clear-sky-index
persistence nowcast, with the site's active model in the place of the clear-sky
reference). Rule: `voltpilot_optimization/nowcast.py` (pure); wiring:
`inputs._anchor_pv_input`, applied to the final PV series just before the night
floor - the same "defensive correction on the PV input" slot as
`fallback.night_floor_pv`.

Why it lives in the OPTIMIZER and not here:

* it depends on `now` and on telemetry fresher than the last collector run, so
  it is a plan-time correction, not a stored forecast;
* writing it back under `pv-physical` would corrupt this document's whole
  evaluation contract - the model would be scored on a number it did not
  produce, and the challenger's skill against it would stop meaning anything;
* as a NEW model id it would need a per-site promotion, i.e. it would not reach
  the fleet at all. In the optimizer it corrects **whichever model is active**,
  so promoting `pv-residual-xgb` later composes with it rather than competing.

The consequence to keep straight: `forecast_accuracy` measures the STORED model,
not the anchored series the plan really used. That is correct and intended - the
anchor is a nowcast that expires within a couple of hours, not a forecast - and
the number the run corrected by is visible per run in the admin optimizer
diagnostics (`schedule.pv_anchor_ratio` → `pvAnchorRatio`, "PV-Anker (Messung)").

The case it exists for (scout report `vp-negativpreis-herzogau-g3` §5.1): the
09:36 run of 23.08.2026 at Pilsting/Herzogau had the 09:30 measurement of ~38 kW
in the database and still planned a 0,5 kW DISCHARGE for 09:30/09:45 - its PV
forecast for those slots sat below the house load, during a negative-price
window. Two independent causes, both closed by the same mechanism: **one array
per site** (`forecast_collect.load_sites` reads a SINGLE `pv` asset row, so one
`azimuth_deg`/`tilt_deg`, south/30° by default - an east-heavy roof is
structurally low every morning) and **nothing looking at the live plant**.

Knobs (all safety bounds, not tuning dials; defaults are what the replay test
pins):

| Env | Default | Meaning |
|---|---|---|
| `OPTIMIZER_PV_ANCHOR_ENABLED` | `true` | Kill switch. Default-ON deliberately - a default-OFF flag has to be pulled through gitops to have any effect. |
| `OPTIMIZER_PV_ANCHOR_LOOKBACK_MINUTES` | `120` | Evidence window of COMPLETED slots. |
| `OPTIMIZER_PV_ANCHOR_MIN_SLOTS` | `3` | Below this nothing is established and the forecast passes through unchanged. |
| `OPTIMIZER_PV_ANCHOR_MAX_RATIO` | `5` | Symmetric clamp (`1/5 .. 5`). The hard physical bound is the plant nameplate. |
| `OPTIMIZER_PV_ANCHOR_DECAY_SLOTS` | `8` (2 h) | Linear decay back to the untouched forecast. |

Still open, and now less urgent: the STRUCTURAL fix of the same first cause -
a PV forecast composed per Erzeuger source with its own orientation. The
measurement-point model carries `capacity_kwp` and a MaStR reference per source
but no azimuth/tilt, so it needs a data-model step. The anchor absorbs the
orientation bias in the near horizon, which is where dispatch is decided.

## Promotion (and rollback)

**Der Weg ist das Portal, und er gehört dem Kunden.** Prognosequalität → der Kandidat einer Prognoseart → „Kandidat übernehmen" (jeder, der die Anlage erreicht; die Bestätigung nennt die Folgen und sagt ausdrücklich, dass sie **nur für diese Anlage** gelten). Ab dem nächsten Planungslauf - spätestens 15 Minuten später - konsumiert der Optimierer die Prognosereihen des neuen Modells **für genau diese Anlage**; alle anderen bleiben unverändert, und das abgelöste Modell rechnet im Schatten weiter und wird weiter täglich bewertet. **Der Rückweg ist derselbe Knopf in die Gegenrichtung** - es geht keine Historie verloren, und ein zurückgetauschtes Modell hat sofort wieder seine Bewertung.

Technisch dahinter: `POST /api/v1/sites/{siteId}/forecast-models {kind, model}` schreibt eine Zeile in die mandantengebundene, **append-only** Tabelle `site_forecast_model_choice` (api-Migration `V20260826000000`). Sie ist zugleich das Audit-Journal - jede Zeile trägt von→zu, das JWT-Subject des Umstellers, seinen Anzeige-Namen und den Zeitpunkt; „was gilt gerade" ist die jüngste Zeile je (Anlage, Art). Der Zaun ist Postgres-RLS: eine fremde Anlage ist **404**, nie 403; ein Portal-Admin erreicht jede Anlage über den `X-Tenant-Id`-Umschalter auf demselben Pfad.

**Die zwei Sperren der Oberfläche werden SERVER-seitig ein zweites Mal geprüft** - ein Kandidat, der auf DIESER Anlage noch sammelt, und ein Modell ohne eine einzige Tagesbewertung auf ihr sind je ein 409 mit deutschem Grund. Beide schützen vor derselben Sache: einer Umstellung auf ein Modell, für das es hier keine Prognosezeilen gibt (der Optimierer fiele dann still auf seine Persistenz-Baseline zurück, während das Portal das neue Modell als „live" zeigt).

Die plattformweite `POST /api/v1/admin/forecast-models` (platform-admin, `forecast_model_choice`, Migration `V20260825000000`) bleibt bestehen - sie setzt seither die **VORGABE** für jede Anlage ohne eigene Wahl.

**Die Präzedenz ist der ganze Vertrag** und steht wortgleich in beiden Migrationen, in `ForecastModels.resolve` (api), in `voltpilot_forecast/model_choice.py` und in `voltpilot_optimization/inputs.py`:

1. die jüngste Zeile in `site_forecast_model_choice` je (Anlage, Art) - sie gewinnt,
2. sonst die jüngste Zeile in `forecast_model_choice` je Art (die Plattform-Vorgabe),
3. sonst die Umgebungsvariable (`VOLTPILOT_ACTIVE_LOAD_MODEL` / `VOLTPILOT_ACTIVE_PV_MODEL`),
4. sonst der Registry-Default (das Basismodell).

Ohne eine einzige Zeile ist damit jeder Pfad **byte-identisch** zu vorher. Umgekehrt heißt es: auf einer umgestellten Anlage ist ein späterer Env-Edit **wirkungslos**, und auch ein Betreiber-Klick auf die Plattform-Vorgabe nimmt ihr die Entscheidung nicht ab - genau richtig, denn sonst nähme ein Redeploy bzw. ein fremder Klick die bewusste Entscheidung stillschweigend zurück. Wer wirklich zur Vorgabe zurück will, stellt im Portal auf denselben Modell-Wert zurück (dann steht dort dieselbe Modell-Id, die Quelle bleibt aber ehrlich „anlage": es IST eine Entscheidung).

Der Env-Weg bleibt als **Vorgabe** für frische Deployments bestehen:

```bash
# .env (dev) / /srv/docker/voltpilot/.env (prod) - then recreate the services
VOLTPILOT_ACTIVE_LOAD_MODEL=load-xgb      # default: load-persistence
VOLTPILOT_ACTIVE_PV_MODEL=pv-physical     # default: pv-physical
```

Dieselben Werte auf allen drei Verbrauchern setzen - `forecast-collector`/`forecast`, `optimizer`/`optimization` und `api` - und die Container neu erzeugen. Alle drei lösen dieselbe Präzedenz auf und lesen dieselben zwei Tabellen, können also nicht auseinanderlaufen; der Optimierer liest sie **einmal je Lauf** (zwei kleine indizierte Abfragen) und löst sie dann **pro Anlage** auf - nie ein Read je Anlage.

Eine Beförderung sollte durch `forecast_accuracy` **dieser Anlage** gedeckt sein (klar positiver Skill an den meisten der letzten 14+ bewerteten Tage, möglichst über beide Lastsaisons) - die Prognosequalität-Seite legt genau diese Tage als aufklappbare Liste offen, und eine direkte SQL-Abfrage erzählt dieselbe Geschichte.

⚠ **Der Skill-Maßstab ist das AKTIVE Modell der jeweiligen ANLAGE**, nicht das der Flotte: seit dem Anlagen-Schalter können zwei Anlagen desselben Mandanten legitim verschieden planen, und ein flottenweiter Maßstab würde eine von ihnen gegen ein Modell bewerten, das sie gar nicht benutzt (`evaluate.evaluate_day` löst ihn je Anlage auf).

## Storage (all owned by api Flyway `V20260701040000`)

| Table | Grain | RLS |
|---|---|---|
| `forecast` (+ `model` column) | site x kind x model x run x slot | none (backend-only consumers) |
| `forecast_model_state` | site x model | tenant-scoped, portal reads |
| `forecast_accuracy` | site x model x Berlin day | tenant-scoped, portal reads |
| `plan_accuracy` | site x Berlin day | tenant-scoped, portal reads |
| `forecast_model_choice` (V20260825000000) | kind x Umstellung (append-only) | none - die PLATTFORM-Vorgabe, wie `edge_release`; App-Rolle nur SELECT |
| `site_forecast_model_choice` (V20260826000000) | site x kind x Umstellung (append-only) | tenant-scoped + FORCE - es ist eine Entscheidung über EINE Kundenanlage; App-Rolle SELECT+INSERT, kein UPDATE/DELETE |

The collector/evaluator write as the trusted backend role and stamp `tenant_id` from the owning site (the weather-collector pattern); the api reads through the RLS-scoped app role.
Version coordination and the bootstrap mirrors are documented in AGENTS.md and in the migration headers.

## Future work

Quantile objectives for uncertainty bands (architecture 12.2), per-Bundesland holidays, an ML PV model beyond residual correction, automatic promotion *proposals* (never automatic promotion), and per-tenant evaluation windows.

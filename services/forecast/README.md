# services/forecast - Forecast Service

**Language:** Python 3.10+
**State:** stateless
**Responsibility (architecture section 8/12):** Last-/PV-Prognose, Features.

Separates prediction from decision (a Leitprinzip): this service produces the load and PV forecasts that the optimizer consumes, and knows nothing about the optimization itself.
The ACTIVE production models are the deliberately ML-free baselines (architecture section 12): a persistence baseline for load and a physical model for PV.
On top of them sits the **shadow-mode model registry** (see [`docs/forecasting.md`](../../docs/forecasting.md)): XGBoost challengers that predict and persist every cycle without influencing anything, a daily evaluation against telemetry actuals, and manual-only promotion via env.

## Methods (baselines = the active models)

| Forecast | Method | Where |
|---|---|---|
| **Load** | Baseline. Two swappable implementations: `SeasonalPersistenceLoadForecaster` (repeat the value from the same slot one day ago) and `ProfileLoadForecaster` (typical daily profile per weekday-type, averaged over recent history). Both fall back to flat last-value when history is sparse. | `voltpilot_forecast/load.py` |
| **PV** | Physical model. Solar geometry (NOAA position) -> clear-sky irradiance -> plane-of-array transposition -> PVWatts-style capacity/derate, clipped to nameplate. No ML correction yet. | `voltpilot_forecast/pv.py`, `voltpilot_forecast/solar.py` |
| **Weather** | Anti-corruption layer. `WeatherProvider` interface with a dependency-free `ClearSkyWeatherProvider` default (analytic GHI), plus the **keyless Open-Meteo** provider (`OpenMeteoWeatherProvider`) that feeds *measured* irradiance to the PV model. A real EU-hosted weather API drops in here without touching the PV forecaster. | `voltpilot_forecast/weather.py`, `voltpilot_forecast/openmeteo.py` |

Day-ahead price is **not** forecast (given via ENTSO-E; architecture section 12) and is out of scope for this service.

## Shadow-mode model registry, challengers, evaluation

The full lifecycle (shadow -> evaluate -> promote via env) is documented in [`docs/forecasting.md`](../../docs/forecasting.md). The moving parts in this package:

| Piece | Where |
|---|---|
| Model ids + active-model resolution (`VOLTPILOT_ACTIVE_LOAD_MODEL`/`VOLTPILOT_ACTIVE_PV_MODEL`, defaults = baselines, typos fail loudly) | `registry.py` |
| Tabular features (Berlin-local calendar + German-holiday flag, leakage-safe lags/means, weather lookup) with plain-German labels | `features.py`, `holidays.py` |
| XGBoost challengers `load-xgb` + `pv-residual-xgb` (native Booster API, optional `[ml]` extra, deterministic seed, 21-full-day self-gate, `TrainingReport` explainability trail) | `ml.py` |
| Forecast collector: all models per site every 15 min, model-tagged persistence, `forecast_model_state` upserts, nightly retrain + daily evaluation trigger (`voltpilot-forecast-collect fetch|serve`) | `forecast_collect.py` |
| Evaluation math (MAE/nMAE/bias/skill, plan economics; pure + unit-tested to the digit) and the daily job (`voltpilot-forecast-eval run|serve`) | `evaluation.py`, `evaluate.py` |
| `forecast_model_state` / `forecast_accuracy` / `plan_accuracy` writers (in-memory + psycopg) | `quality_repository.py` |

```bash
pip install -e '.[db,weather,ml]'      # macOS: brew install libomp (xgboost wheel)
python -m voltpilot_forecast.forecast_collect fetch    # one cycle over all sites
python -m voltpilot_forecast.evaluate run              # evaluate yesterday (Berlin)
```

In compose the collector runs as **`forecast-collector`** in the `feeds` profile; in prod it is the `forecast` service. The portal surfaces everything under **"Prognosequalität"** via `GET /api/v1/sites/{siteId}/forecast-quality`.

## Weather forecast collector (KEYLESS Open-Meteo)

Beyond the load/PV forecast, this service ships a **weather collector** that stores
a real hourly weather forecast per site for the portal (and to enrich PV):

- **Source.** `openmeteo.py` - the **Open-Meteo** API (`api.open-meteo.com`, EU-hosted,
  **no API key**): hourly `temperature_2m`, `cloud_cover`, and shortwave/direct/diffuse
  radiation (GHI is the PV-relevant channel) over the coming days.
- **Storage.** A new **`weather_forecast`** hypertable (`(site_id, run_at, time)`),
  carrying `tenant_id` and **RLS-scoped like telemetry** (schema owned by the api
  Flyway migration `V20260701010000`; dev mirror `infra/local/timescale/03-weather.sql`).
  `TimescaleWeatherForecastRepository` writes it; `InMemoryWeatherForecastRepository`
  is the offline default.
- **Collector.** `weather_collect.py` (console script `voltpilot-weather`): reads every
  site's `latitude`/`longitude`, fetches, and upserts. `fetch` = one-shot, `serve` =
  startup + periodic (`WEATHER_REFRESH_SECONDS`, default 3h).

```bash
pip install -e '.[db,weather]'
python -m voltpilot_forecast.weather_collect fetch --persist   # all sites, once
python -m voltpilot_forecast.weather_collect serve --persist   # startup + periodic
```

In compose it runs as the `weather-collector` service in the `feeds` profile
(`docker compose --profile feeds up -d --build weather-collector`). Read in the
portal via `GET /api/v1/sites/{siteId}/weather`.

## Interfaces (the swap points)

Every method sits behind an ABC so consumers never depend on a concrete implementation:

- `LoadForecaster` - swap the load baseline for the future XGBoost/LightGBM model (architecture section 12.2/12.3) without changing the optimizer.
- `PvForecaster` - swap the physical model for a later ML-corrected one.
- `WeatherProvider` - swap the clear-sky default for a real weather API (the ACL).
- `ForecastRepository` - how forecasts are exposed/stored (see below).

`ForecastService` (`voltpilot_forecast/service.py`) is the façade the optimizer calls; it wires a load forecaster + PV forecaster + repository together and defaults to a fully working, offline v1.

## Exposure: the `forecast` hypertable

Forecasts are timeseries (architecture section 10 lists *Prognosen* among the hypertables), so the production exposure is a TimescaleDB `forecast` hypertable that the optimizer reads via `TimescaleForecastRepository`.
An `InMemoryForecastRepository` is the dependency-free default for tests/offline runs.

**Schema / migration.** The table is defined in `migrations/V3__forecast_hypertable.sql` (Flyway naming).
Version **V3** is coordinated to avoid collision: V1/V2 are reserved for the core schema (master data, telemetry hypertable) that `services/api` will own once it introduces Flyway; today that core schema is dev-bootstrapped from `infra/local/timescale/01-init.sql`.
The local dev stack applies an identical DDL via `infra/local/timescale/02-forecast.sql` on first container init, so `docker compose up` provides the table without a Flyway run. Keep the two files in sync (the migration is the source of truth in staging/prod).

Columns: `time` (slot start / target), `tenant_id`, `site_id`, `kind` (`load`|`pv`), **`model`** (the registry model id every row is tagged with - added by `migrations/V20260702000000__forecast_model_column.sql`), `value_kw` (mean power over the 15-min slot), `run_at` (issue time), `horizon_min` (lead time), `method` (implementation detail, e.g. `persistence` / `clear_sky_v1:open_meteo`), `schema_version`. Primary key `(site_id, kind, model, run_at, time)` makes each model's writes idempotent and keeps active + shadow runs queryable side by side. The optimizer reads only the active model's rows.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
python -m voltpilot_forecast     # offline demo: 24h load + PV forecast for the seeded demo site
pytest

# Optional: TimescaleDB persistence (TimescaleForecastRepository)
pip install -e '.[db]'           # pulls psycopg; the forecast logic itself is dependency-free
```

The demo and all tests run **offline** (no DB, no network): the clear-sky weather default and the in-memory repository keep the service self-contained, matching the scaffold's offline-first stance.

## Later ML path (beyond the shadow-mode foundation)

- Quantile objectives for uncertainty bands (architecture section 12.2), per-Bundesland holidays, and a full ML PV model beyond the residual correction.
- MLOps via MLflow + batch training (architecture section 12) once model artifacts need versioned storage (today the challengers retrain nightly in-process).
- Automatic promotion **proposals** (never automatic promotion): a job that flags a sustained positive skill for the captain to act on.

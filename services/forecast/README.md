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

## From an hourly weather API to a quarter-hour forecast

`OpenMeteoWeatherProvider` is the only place that turns hourly irradiance into
per-slot irradiance, and two rules there decide whether a dusk or sunrise slot
is believable. Both were found by the Pilsting case of 28.08.2026, where the
plan assumed a 3 kW PV surplus at 19:45 local while the plant made 1.3 kW
against a 2.7 kW house and bought the difference at 25 ct.

**1. An hourly value labels the PRECEDING hour.** Open-Meteo documents its
radiation as "average of the preceding hour", and the API confirms it: at
`minutely_15`, the four quarters of `[T-1h, T)` average back to the hourly value
at `T` at every hour of the day, while the following hour never matches (the
table is in `tests/fixtures/README-pilsting.md`). Reading the label `floor(t)`
therefore serves a window centred **30 to 105 minutes in the past** - too low
every morning, too high every evening. Measured on that day, against the plant's
own quarter hours through the same physical model:

| Band (local)  | slots | bias before | MAE before | bias after | MAE after |
|---------------|-------|-------------|------------|------------|-----------|
| dusk 19-20    |     4 |   +4.17 kW  |  4.17 kW   |  +0.04 kW  |  0.38 kW  |
| evening 18-21 |    12 |   +1.40 kW  |  1.63 kW   |  +0.03 kW  |  0.73 kW  |
| morning 05-09 |    16 |   -2.99 kW  |  2.99 kW   |  -0.02 kW  |  0.21 kW  |
| whole day     |    92 |   +0.42 kW  |  4.87 kW   |  -0.01 kW  |  1.78 kW  |

**2. Within the hour, the mean is redistributed by solar position.** A flat hour
mean cannot fall, so the last quarter before sunset inherits the first quarter's
sunshine. Each quarter instead takes the hour's mean scaled by its share of the
hour's clear-sky energy (`solar.clear_sky_ghi_mean`). The share is a ratio of
means, so **the four quarters average back to the hour mean exactly** - the split
moves energy inside the hour and never creates or destroys any - and a quarter
whose sun is below the horizon gets exactly 0. The beam carries its own shape
(`solar.clear_sky_dni`), because DNI decays far more slowly than GHI at dusk.

`forecast_accuracy` scores whole Berlin days, so neither error was visible in it;
the band table above is how this class of defect gets measured.

## The clear-sky ceiling (`pvceiling.py`)

Whatever the active model says, a plant cannot beat the clear-sky output of its
own geometry at that instant. The ceiling is a **no-op on a correctly aligned
physical forecast** by construction (real irradiance never exceeds clear-sky
irradiance through the same geometry), so it changes nothing in daylight - it
exists as the structural reason a slot whose irradiance does not belong to that
slot's sun cannot reach a plan, and as the **only** physical bound on the
residual challenger, whose `physical + residual` was previously clipped to
nameplate alone and free to invent generation after sunset.

Two choices keep it from ever clipping real production: the beam is bounded by
an air-mass DNI model rather than `GHI / cos(zenith)` (which explodes at low
sun - that is what let a dusk forecast claim kilowatts), and it is never tighter
than a horizontal plane, so a plant whose stored orientation is wrong is not
punished for our book-keeping.

| Env | Default | Meaning |
|---|---|---|
| `VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED` | `true` | kill switch |
| `VOLTPILOT_PV_CLEAR_SKY_HEADROOM` | `1.25` | margin over the envelope (cloud enhancement, model spread); must be >= 1 |

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

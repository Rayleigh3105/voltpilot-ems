# services/forecast - Forecast Service

**Language:** Python 3.10+
**State:** stateless
**Responsibility (architecture section 8/12):** Last-/PV-Prognose, Features.

Separates prediction from decision (a Leitprinzip): this service produces the load and PV forecasts that the optimizer consumes, and knows nothing about the optimization itself.
v1 is deliberately ML-free (architecture section 12): a persistence/profile baseline for load and a physical model for PV.
ML (XGBoost/LightGBM, quantile objectives) is a later stage that slots in behind the same interfaces.

## Methods (v1, no ML)

| Forecast | Method | Where |
|---|---|---|
| **Load** | Baseline. Two swappable implementations: `SeasonalPersistenceLoadForecaster` (repeat the value from the same slot one day ago) and `ProfileLoadForecaster` (typical daily profile per weekday-type, averaged over recent history). Both fall back to flat last-value when history is sparse. | `voltpilot_forecast/load.py` |
| **PV** | Physical model. Solar geometry (NOAA position) -> clear-sky irradiance -> plane-of-array transposition -> PVWatts-style capacity/derate, clipped to nameplate. No ML correction yet. | `voltpilot_forecast/pv.py`, `voltpilot_forecast/solar.py` |
| **Weather** | Anti-corruption layer. `WeatherProvider` interface with a dependency-free `ClearSkyWeatherProvider` default (analytic GHI). A real EU-hosted weather API drops in here without touching the PV forecaster. | `voltpilot_forecast/weather.py` |

Day-ahead price is **not** forecast (given via ENTSO-E; architecture section 12) and is out of scope for this service.

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

Columns: `time` (slot start / target), `tenant_id`, `site_id`, `kind` (`load`|`pv`), `value_kw` (mean power over the 15-min slot), `run_at` (issue time), `horizon_min` (lead time), `method` (provenance, e.g. `persistence` / `clear_sky_v1:clear_sky`), `schema_version`. Primary key `(site_id, kind, run_at, time)` makes writes idempotent and keeps multiple runs queryable.

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

## Later ML path (not built here)

- Load: implement `LoadForecaster` with XGBoost/LightGBM (quantile objective for uncertainty bands). Register it in `ForecastService` in place of the baseline; the optimizer is unaffected. MLOps via MLflow + batch training (architecture section 12) lands when there is ML to train.
- PV: implement `PvForecaster` (or a `WeatherProvider` backed by a real forecast API) to add an ML correction on top of the physical model.
- Storage/consumers are unchanged: new methods write the same `forecast` hypertable, distinguished by the `method` column.

"""Forecast collector: run ALL registered models per site, every cycle.

The production heartbeat of shadow-mode forecasting (docs/forecasting.md).
Every 15 minutes, for every site, it:

1. loads recent telemetry (load + PV) and the stored weather (latest run per
   hour - past hours give "the weather that was forecast for that hour",
   future hours the current outlook);
2. runs the BASELINE models (``load-persistence``, ``pv-physical``) and every
   CHALLENGER whose self-gate is met (``load-xgb``, ``pv-residual-xgb``),
   persisting each prediction run into the ``forecast`` hypertable tagged with
   its model id;
3. upserts each model's ``forecast_model_state`` row - the honest lifecycle
   the portal shows, including "collecting: day X of N" while a challenger is
   still gathering its minimum training history;
4. once per Berlin day (first cycle after midnight) retrains the challengers
   and triggers the daily evaluation (:mod:`voltpilot_forecast.evaluate`) for
   the completed day(s), so one container covers collect + retrain + evaluate.

The optimizer consumes ONLY the active model's rows (default = baselines);
challenger predictions are pure measurement material. Promotion is a manual
env flip - this job treats active and shadow models identically on purpose.

    python -m voltpilot_forecast.forecast_collect fetch    # one cycle
    python -m voltpilot_forecast.forecast_collect serve    # every 15 min

Runs as the trusted backend DB role (reads all tenants' telemetry/weather,
writes rows stamped with each site's tenant_id - the weather-collector
pattern). The ML extra is optional: without ``xgboost`` installed the
baselines still run and a warning marks the challengers as unavailable.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

from voltpilot_forecast import registry
from voltpilot_forecast.domain import (
    ForecastKind,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
    ensure_utc,
)
from voltpilot_forecast.evaluation import BERLIN
from voltpilot_forecast.features import WeatherHistory
from voltpilot_forecast.load import SeasonalPersistenceLoadForecaster
from voltpilot_forecast.openmeteo import (
    OpenMeteoWeatherProvider,
    WeatherForecast,
    WeatherPoint,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.quality_repository import (
    STATUS_COLLECTING,
    STATUS_READY,
    ModelState,
    QualityRepository,
    TimescaleQualityRepository,
)
from voltpilot_forecast.repository import (
    ForecastRepository,
    TimescaleForecastRepository,
)

logger = logging.getLogger("voltpilot.forecast.collect")

#: Telemetry window feeding baselines, challenger training and lag features.
DEFAULT_HISTORY_DAYS = 28

#: Fallback location for a site without coordinates (PV physics needs one;
#: load forecasting does not care). Berlin, the platform's v1 reference point.
DEFAULT_LOCATION = GeoLocation(latitude=52.52, longitude=13.405)

#: A site's PV nameplate is not modelled yet; estimate it from the observed
#: generation peak (5 % headroom) - self-calibrating and always consistent
#: with reality. Sites without any PV telemetry get no PV plant (zero series).
CAPACITY_HEADROOM = 1.05
MIN_CAPACITY_KWP = 0.05


def _dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _ml_available() -> bool:
    try:  # noqa: SIM105
        import numpy  # noqa: F401, PLC0415
        import xgboost  # noqa: F401, PLC0415
    except Exception:
        return False
    return True


@dataclass(frozen=True)
class SiteRow:
    tenant_id: str
    site_id: str
    location: GeoLocation | None
    #: Registry-confirmed PV parameters from the site's `pv` asset row (the
    #: MaStR "Anlage verknüpfen" step). None = fall back to the observed-peak
    #: capacity estimate below.
    plant: PlantSpec | None = None


@dataclass
class CollectorConfig:
    min_training_days: int = 21
    history_days: int = DEFAULT_HISTORY_DAYS
    horizon_hours: float = 24.0

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "CollectorConfig":
        return cls(
            min_training_days=int(env.get("VOLTPILOT_ML_MIN_DAYS", "21")),
            history_days=int(env.get("FORECAST_HISTORY_DAYS", str(DEFAULT_HISTORY_DAYS))),
            horizon_hours=float(env.get("FORECAST_HORIZON_HOURS", "24")),
        )


# ---- DB reads -------------------------------------------------------------------

def load_sites(conn) -> list[SiteRow]:
    """Every site, with its authoritative PV asset parameters when linked.

    The LEFT JOIN picks the site's `pv` asset row (created by the portal's
    MaStR "Anlage verknüpfen" apply step); orientation/tilt are nullable there
    on purpose (Balkonkraftwerk / Ost-West), so PlantSpec's DACH defaults
    (south, 30 deg) fill the gaps.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.tenant_id, s.id, s.latitude, s.longitude,
                   a.pv_capacity_kwp, a.azimuth_deg, a.tilt_deg
            FROM site s
            LEFT JOIN LATERAL (
                SELECT pv_capacity_kwp, azimuth_deg, tilt_deg
                FROM asset
                WHERE site_id = s.id AND type = 'pv' AND pv_capacity_kwp > 0
                ORDER BY created_at DESC
                LIMIT 1
            ) a ON TRUE
            ORDER BY s.id
            """
        )
        rows = cur.fetchall()
    sites = []
    for tenant_id, site_id, lat, lon, kwp, azimuth, tilt in rows:
        location = (
            GeoLocation(latitude=float(lat), longitude=float(lon))
            if lat is not None and lon is not None
            else None
        )
        plant = (
            PlantSpec(
                capacity_kwp=float(kwp),
                azimuth_deg=float(azimuth) if azimuth is not None else 180.0,
                tilt_deg=float(tilt) if tilt is not None else 30.0,
            )
            if kwp is not None
            else None
        )
        sites.append(SiteRow(str(tenant_id), str(site_id), location, plant))
    return sites


def _telemetry_history(
    conn, site_id: str, column: str, since: datetime
) -> list[Observation]:
    # Fixed set, never user input - a hard raise (not assert, which is
    # stripped under python -O) keeps the f-string interpolation safe (S15).
    if column not in ("load_kw", "pv_power_kw"):
        raise ValueError(f"unsupported telemetry column: {column}")
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT time, {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL AND time >= %s
            ORDER BY time
            """,
            (site_id, since),
        )
        return [Observation(ensure_utc(ts), float(v)) for ts, v in cur.fetchall()]


def _weather_history(conn, site_id: str, since: datetime) -> list[WeatherPoint]:
    """Latest stored weather value per hour - past AND future (the newest run
    reaches ~3 days ahead), one query for training features and prediction."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (time) time, temperature_c, cloud_cover_pct,
                   ghi_w_m2, dni_w_m2, dhi_w_m2
            FROM weather_forecast
            WHERE site_id = %s AND time >= %s
            ORDER BY time, run_at DESC
            """,
            (site_id, since),
        )
        rows = cur.fetchall()
    return [
        WeatherPoint(
            timestamp=ensure_utc(ts),
            temperature_c=None if t is None else float(t),
            cloud_cover_pct=None if c is None else float(c),
            ghi_w_m2=None if g is None else float(g),
            dni_w_m2=None if dn is None else float(dn),
            dhi_w_m2=None if dh is None else float(dh),
        )
        for ts, t, c, g, dn, dh in rows
    ]


# ---- one site, one cycle ---------------------------------------------------------

@dataclass
class SiteSummary:
    site_id: str
    saved_models: list[str] = field(default_factory=list)
    collecting: dict[str, int] = field(default_factory=dict)  # model -> days_collected


class ChallengerCache:
    """Per-process cache of trained challengers, retrained once per Berlin day."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], tuple[date, object]] = {}

    def get(self, site_id: str, model_id: str, berlin_day: date):
        entry = self._entries.get((site_id, model_id))
        if entry is None or entry[0] != berlin_day:
            return None
        return entry[1]

    def put(self, site_id: str, model_id: str, berlin_day: date, forecaster) -> None:
        self._entries[(site_id, model_id)] = (berlin_day, forecaster)


def _baseline_state(
    site: SiteRow, model_id: str, kind: ForecastKind, now: datetime
) -> ModelState:
    return ModelState(
        tenant_id=site.tenant_id,
        site_id=site.site_id,
        model=model_id,
        kind=kind.value,
        status=STATUS_READY,
        updated_at=now,
    )


def collect_site(
    conn,
    forecasts: ForecastRepository,
    quality: QualityRepository,
    site: SiteRow,
    now: datetime,
    cfg: CollectorConfig,
    cache: ChallengerCache,
    ml_available: bool,
) -> SiteSummary:
    """Run every model for one site: baselines always, challengers when gated in."""
    from voltpilot_forecast import ml  # noqa: PLC0415 - safe: pure-Python module

    summary = SiteSummary(site.site_id)
    since = now - timedelta(days=cfg.history_days)
    load_history = _telemetry_history(conn, site.site_id, "load_kw", since)
    pv_history = _telemetry_history(conn, site.site_id, "pv_power_kw", since)
    weather_points = _weather_history(conn, site.site_id, since)
    weather = WeatherHistory(weather_points) if weather_points else None
    horizon = Horizon.hours(cfg.horizon_hours)
    berlin_day = now.astimezone(BERLIN).date()

    location = site.location or DEFAULT_LOCATION
    # Registry-confirmed plant parameters (MaStR link) are authoritative;
    # without them the nameplate is estimated from the observed peak.
    plant = site.plant
    if plant is None:
        peak_pv = max((obs.value_kw for obs in pv_history), default=0.0)
        plant = (
            PlantSpec(capacity_kwp=round(peak_pv * CAPACITY_HEADROOM, 3))
            if peak_pv > MIN_CAPACITY_KWP
            else None
        )
    config = SiteForecastConfig(
        tenant_id=site.tenant_id,
        site_id=site.site_id,
        location=location,
        plant=plant,
    )
    provider = (
        OpenMeteoWeatherProvider(
            WeatherForecast(
                tenant_id=site.tenant_id,
                site_id=site.site_id,
                latitude=location.latitude,
                longitude=location.longitude,
                run_at=now,
                points=tuple(weather_points),
            )
        )
        if weather_points
        else None
    )

    # -- baselines: always run, always persisted, always 'ready' ----------------
    persistence = SeasonalPersistenceLoadForecaster()
    forecasts.save(
        persistence.forecast(site.site_id, site.tenant_id, load_history, horizon, now)
    )
    quality.upsert_model_state(
        _baseline_state(site, registry.LOAD_PERSISTENCE, ForecastKind.LOAD, now)
    )
    summary.saved_models.append(registry.LOAD_PERSISTENCE)

    physical = PhysicalPvForecaster(provider) if provider else PhysicalPvForecaster()
    forecasts.save(physical.forecast(config, horizon, now))
    quality.upsert_model_state(
        _baseline_state(site, registry.PV_PHYSICAL, ForecastKind.PV, now)
    )
    summary.saved_models.append(registry.PV_PHYSICAL)

    if not ml_available:
        return summary

    # -- challengers: self-gated, shadow-persisted -------------------------------
    def run_challenger(model_id, kind, make, train, predict) -> None:
        forecaster = cache.get(site.site_id, model_id, berlin_day)
        if forecaster is None:
            forecaster = make()
            try:
                train(forecaster)
            except ml.InsufficientHistory as gate:
                quality.upsert_model_state(
                    ModelState(
                        tenant_id=site.tenant_id,
                        site_id=site.site_id,
                        model=model_id,
                        kind=kind.value,
                        status=STATUS_COLLECTING,
                        days_collected=gate.days_collected,
                        days_required=gate.days_required,
                        updated_at=now,
                    )
                )
                summary.collecting[model_id] = gate.days_collected
                return
            cache.put(site.site_id, model_id, berlin_day, forecaster)
        forecasts.save(predict(forecaster))
        report = forecaster.report
        quality.upsert_model_state(
            ModelState(
                tenant_id=site.tenant_id,
                site_id=site.site_id,
                model=model_id,
                kind=kind.value,
                status=STATUS_READY,
                days_collected=report.days_used if report else None,
                days_required=cfg.min_training_days,
                trained_at=report.trained_at if report else None,
                train_rows=report.train_rows if report else None,
                feature_importance=[
                    {"feature": fi.feature, "label": fi.label, "weight": fi.weight}
                    for fi in (report.feature_importance if report else ())
                ],
                updated_at=now,
            )
        )
        summary.saved_models.append(model_id)

    run_challenger(
        registry.LOAD_XGB,
        ForecastKind.LOAD,
        make=lambda: ml.XgbLoadForecaster(
            weather=weather, min_days=cfg.min_training_days
        ),
        train=lambda f: (f.update_weather(weather), f.train(load_history, now)),
        predict=lambda f: (
            f.update_weather(weather),
            f.forecast(site.site_id, site.tenant_id, load_history, horizon, now),
        )[1],
    )
    run_challenger(
        registry.PV_RESIDUAL_XGB,
        ForecastKind.PV,
        make=lambda: ml.PvResidualXgbForecaster(
            physical=physical, weather=weather, min_days=cfg.min_training_days
        ),
        train=lambda f: (f.update_weather(weather, physical), f.train(config, pv_history, now)),
        predict=lambda f: (
            f.update_weather(weather, physical),
            f.forecast(config, horizon, now),
        )[1],
    )
    return summary


# ---- the cycle + serve loop -------------------------------------------------------

def run_cycle(
    dsn: str, cfg: CollectorConfig, cache: ChallengerCache, ml_available: bool
) -> list[SiteSummary]:
    import psycopg  # noqa: PLC0415 - optional [db] extra

    now = datetime.now(timezone.utc)
    summaries: list[SiteSummary] = []
    with psycopg.connect(dsn) as conn:
        forecasts = TimescaleForecastRepository(conn)
        quality = TimescaleQualityRepository(conn)
        sites = load_sites(conn)
        if not sites:
            logger.warning("collect.no_sites")
            return summaries
        for site in sites:
            try:
                summary = collect_site(
                    conn, forecasts, quality, site, now, cfg, cache, ml_available
                )
                summaries.append(summary)
                parts = [f"models={','.join(summary.saved_models)}"]
                if summary.collecting:
                    parts.append(
                        "collecting="
                        + ",".join(
                            f"{m}:{d}/{cfg.min_training_days}"
                            for m, d in summary.collecting.items()
                        )
                    )
                print(f"voltpilot-forecast-collect: site={site.site_id} " + " ".join(parts))
            except Exception as exc:  # one bad site must not sink the cycle
                logger.warning(
                    "collect.site_failed site=%s error=%s", site.site_id, exc
                )
    return summaries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voltpilot-forecast-collect")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch", help="run one forecast cycle over all sites")
    fetch.add_argument("--log-level", default="INFO")
    serve = sub.add_parser("serve", help="cycle on startup then periodically")
    serve.add_argument(
        "--interval-seconds", type=int,
        default=int(os.environ.get("FORECAST_INTERVAL_SECONDS", "900")),
        help="seconds between cycles (default FORECAST_INTERVAL_SECONDS, else 900)",
    )
    serve.add_argument("--max-cycles", type=int, default=0)
    serve.add_argument(
        "--no-eval", action="store_true",
        help="do not trigger the daily forecast/plan evaluation",
    )
    serve.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    env = dict(os.environ)
    dsn = _dsn_from_env(env)
    cfg = CollectorConfig.from_env(env)
    cache = ChallengerCache()
    ml_available = _ml_available()
    if not ml_available:
        logger.warning(
            "collect.ml_unavailable: xgboost/numpy not installed - baselines only "
            "(install the [ml] extra to run the shadow challengers)"
        )
    # Log the active models once: the collector runs ALL models either way, but
    # this line is the operator's confirmation of what the optimizer consumes.
    logger.info(
        "collect.active_models load=%s pv=%s",
        registry.active_model(ForecastKind.LOAD, env),
        registry.active_model(ForecastKind.PV, env),
    )

    if args.command == "fetch":
        run_cycle(dsn, cfg, cache, ml_available)
        return 0

    if args.command == "serve":
        from voltpilot_forecast import evaluate  # noqa: PLC0415

        last_eval_day: date | None = None
        cycle = 0
        while True:
            try:
                run_cycle(dsn, cfg, cache, ml_available)
                if not args.no_eval:
                    yesterday = evaluate.yesterday_berlin()
                    if last_eval_day != yesterday:
                        evaluate.run_for(dsn, yesterday, days_back=2)
                        last_eval_day = yesterday
            except Exception as exc:  # keep the loop alive across DB blips
                logger.warning("serve.cycle_failed: %s", exc)
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            time.sleep(args.interval_seconds)

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

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
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from voltpilot_forecast import model_choice, registry
from voltpilot_forecast.anlage import anlage_slot_kw, fuehrende_box
from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
    ensure_utc,
)
from voltpilot_forecast.evaluation import BERLIN, berlin_day_bounds
from voltpilot_forecast.features import WeatherHistory
from voltpilot_forecast.kundenbereich import NICHT_BEENDET
from voltpilot_forecast.load import ProfileLoadForecaster, SeasonalPersistenceLoadForecaster
from voltpilot_forecast.openmeteo import (
    OpenMeteoWeatherProvider,
    WeatherForecast,
    WeatherPoint,
    hour_label_for,
)
from voltpilot_forecast.pgdsn import dsn_from_env
from voltpilot_forecast.pv import PhysicalPvForecaster, PhysicalPvForecasterLegacyDni
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
from voltpilot_forecast.runtime import ServeRuntime, serve_health
from voltpilot_forecast.weekly_repository import (
    TimescaleWeeklyForecastRepository,
    WeeklyForecastRepository,
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

#: S4 (die Woche je Stunde): a safety cap on how far the weekly hourly outlook
#: reaches beyond "übermorgen", regardless of how much weather the feed
#: happens to return. ``WEATHER_FORECAST_DAYS`` configures the feed itself
#: (report `vp-prognosen-konzept` section 9 asks for 7 days); this only bounds
#: a misconfigured one - the real stop is "no more weather", same as
#: :func:`pv_horizon`.
WEEKLY_OUTLOOK_MAX_HOURS = 5 * 24


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
    #: S4 (vp-mastr-mehrere-einheiten-konzept §5.2): one PlantSpec per roof
    #: face across every CONFIRMED PV register_einheit of the site ("Prognose
    #: je Fläche, Leistung addiert") - an empty tuple (the default) falls
    #: `collect_site` back to the single `plant` above, byte-identically
    #: (see :func:`load_pv_flaechen`).
    plants: tuple[PlantSpec, ...] = ()


@dataclass
class CollectorConfig:
    min_training_days: int = 21
    history_days: int = DEFAULT_HISTORY_DAYS
    #: 48 h since the optimizer plans a 48 h window (Captain-Entscheid
    #: 28.08.2026): a plan made at midday must see the FOLLOWING evening,
    #: and it may only do so on REAL forecasts. The weather feed reaches
    #: ~7 days since S4 (``openmeteo`` ``forecast_days=7``) - well beyond
    #: this 48h quarter-hour horizon, the rest feeding the separate weekly
    #: hourly outlook (:func:`weekly_outlook_timestamps`); ``pv_horizon``
    #: below still clips the PV models to what weather actually covers.
    horizon_hours: float = 48.0

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "CollectorConfig":
        return cls(
            min_training_days=int(env.get("VOLTPILOT_ML_MIN_DAYS", "21")),
            history_days=int(env.get("FORECAST_HISTORY_DAYS", str(DEFAULT_HISTORY_DAYS))),
            horizon_hours=float(env.get("FORECAST_HORIZON_HOURS", "48")),
        )


# ---- DB reads -------------------------------------------------------------------

def load_sites(conn) -> list[SiteRow]:
    """Every site of a live area, with its authoritative PV asset parameters when linked.

    A "beendet" customer area is left out (UEMS AP-20 E10 = A,
    :mod:`voltpilot_forecast.kundenbereich`): no new forecast for it.

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
            JOIN tenant t ON t.id = s.tenant_id
            LEFT JOIN LATERAL (
                SELECT pv_capacity_kwp, azimuth_deg, tilt_deg
                FROM asset
                WHERE site_id = s.id AND type = 'pv' AND is_primary AND pv_capacity_kwp > 0
                ORDER BY created_at DESC
                LIMIT 1
            ) a ON TRUE
            WHERE """
            + NICHT_BEENDET
            + """
            ORDER BY s.id
            """
        )
        rows = cur.fetchall()
    # S4: the site's confirmed PV register_einheit faces, if any (an empty
    # entry falls `collect_site` back to the single `plant` below).
    flaechen = load_pv_flaechen(conn)
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
        sites.append(
            SiteRow(
                str(tenant_id),
                str(site_id),
                location,
                plant,
                tuple(flaechen.get(str(site_id), [])),
            )
        )
    return sites


def load_pv_flaechen(conn) -> dict[str, list[PlantSpec]]:
    """``{site_id: [PlantSpec, ...]}`` - one per roof face across every
    CONFIRMED PV ``register_einheit`` of the site (S4, vp-mastr-mehrere-
    einheiten-konzept §5.2: "Prognose je Fläche, Leistung addiert").

    A unit without any confirmed ``einheit_flaeche`` row still contributes
    ONE PlantSpec at its full ``leistung_kwp`` with the DACH defaults (south,
    30°) - the same single-asset fallback :func:`load_sites` already applies,
    simply per unit instead of per site. This module only ever reads already
    degree-converted columns, never the register's raw catalog words (same as
    :func:`load_sites` today), so a unit's RAW register direction is NOT read
    here while no Fläche is confirmed yet - a documented S4 simplification
    (report's "Einheit ohne Fläche: Register-Richtung" collapses into "ohne
    beides: Süd/30°").

    A site where ANY confirmed PV unit is missing ``leistung_kwp`` is left out
    of the returned mapping entirely - the report's Lücken rule, mirroring
    the optimizer's ``load_pv_einheiten``.

    Before the S1 migration (``register_einheit``/``einheit_flaeche`` absent -
    an older DB snapshot, or a test fixture that only creates the forecast
    service's own tables), this is "no faces" for every site, exactly like
    :func:`voltpilot_optimization.inputs.load_pv_einheiten`. The caller's
    connection is NOT autocommit, so the aborted SELECT is rolled back before
    returning - otherwise every later query on the SAME connection (``conn``
    is shared across the whole collection cycle, see :func:`run_cycle`) would
    fail with "current transaction is aborted".
    """
    import psycopg  # noqa: PLC0415 - optional [db] extra

    with conn.cursor() as cur:
        try:
            cur.execute(
                """
                SELECT re.site_id, re.id, re.leistung_kwp,
                       ef.richtung_grad, ef.neigung_grad, ef.anteil_kwp
                FROM register_einheit re
                LEFT JOIN einheit_flaeche ef ON ef.einheit_id = re.id
                WHERE re.art = 'pv' AND re.bestaetigt_am IS NOT NULL
                ORDER BY re.site_id, re.inbetriebnahme NULLS LAST, re.created_at, ef.richtung_grad
                """
            )
            rows = cur.fetchall()
        except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn):
            conn.rollback()
            return {}
    leistung_by_unit: dict[str, float] = {}
    flaechen_by_unit: dict[str, list[tuple[float, float, float]]] = {}
    unit_order: dict[str, list[str]] = {}
    incomplete_sites: set[str] = set()
    for site_id, einheit_id, leistung_kwp, richtung, neigung, anteil in rows:
        site_id, einheit_id = str(site_id), str(einheit_id)
        if leistung_kwp is None:
            incomplete_sites.add(site_id)
            continue
        if einheit_id not in leistung_by_unit:
            leistung_by_unit[einheit_id] = float(leistung_kwp)
            flaechen_by_unit[einheit_id] = []
            unit_order.setdefault(site_id, []).append(einheit_id)
        if richtung is not None and neigung is not None and anteil is not None:
            flaechen_by_unit[einheit_id].append(
                (float(richtung), float(neigung), float(anteil))
            )
    by_site: dict[str, list[PlantSpec]] = {}
    for site_id, einheit_ids in unit_order.items():
        if site_id in incomplete_sites:
            continue
        plants: list[PlantSpec] = []
        for einheit_id in einheit_ids:
            faces = flaechen_by_unit[einheit_id]
            if faces:
                for richtung, neigung, anteil in faces:
                    plants.append(
                        PlantSpec(
                            capacity_kwp=anteil, azimuth_deg=richtung, tilt_deg=neigung
                        )
                    )
            else:
                plants.append(PlantSpec(capacity_kwp=leistung_by_unit[einheit_id]))
        by_site[site_id] = plants
    return by_site


def _telemetry_history(
    conn, site_id: str, column: str, since: datetime
) -> list[Observation]:
    # Fixed set, never user input - a hard raise (not assert, which is
    # stripped under python -O) keeps the f-string interpolation safe (S15).
    if column not in ("load_kw", "pv_power_kw"):
        raise ValueError(f"unsupported telemetry column: {column}")
    with conn.cursor() as cur:
        # A multi-box site with a determined leading box: the site's quarter-hour
        # means by the api's one rule (AP-15 W2/B1) - interleaving the boxes'
        # raw samples would average them. One observation per slot is what
        # slot_means makes of it anyway.
        if fuehrende_box(cur, site_id) is not None:
            return [
                Observation(ts, kw)
                for ts, kw in anlage_slot_kw(cur, site_id, column, since, None)
            ]
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
                   ghi_w_m2, dni_w_m2, dhi_w_m2, dni_normal_w_m2
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
            dni_normal_w_m2=None if dnn is None else float(dnn),
        )
        for ts, t, c, g, dn, dh, dnn in rows
    ]


def pv_horizon(
    horizon: Horizon, weather_points: list[WeatherPoint], run_at: datetime
) -> Horizon:
    """The sub-horizon REAL weather covers, for the PV models only.

    Pure (no DB, no clock beyond ``run_at``) so the rule is directly testable.

    :class:`~voltpilot_forecast.openmeteo.OpenMeteoWeatherProvider` answers a
    timestamp outside its samples with ``0 W/m2`` - indistinguishable from
    night. At the old 24 h horizon that branch was unreachable (the weather feed
    reaches ~3 days), but a 48 h horizon can outrun a weather feed that has been
    down for a day, and a fabricated PV zero for tomorrow evening is exactly the
    synthetic value the 48 h window must never be extended on. So the PV models
    forecast only the contiguous prefix whose HOUR carries a usable sample; the
    optimizer's own truncation (``inputs.real_forecast_horizon``) then ends its
    window where this series ends.

    ⚠ "Whose hour" is asked through
    :func:`~voltpilot_forecast.openmeteo.hour_label_for`, the SAME helper the
    provider looks up with - an hourly value labels the PRECEDING hour, so a
    slot needs the label one hour ABOVE its own floor. Deciding coverage with
    ``floor(t)`` while the provider reads ``floor(t) + 1h`` hands back exactly
    the fabricated zeros this function exists to prevent, for the feed's last
    hour. Pinned by ``test_pv_horizon_agrees_with_what_the_provider_can_answer``.

    LOAD keeps the full horizon on purpose - the seasonal-persistence baseline
    needs telemetry, not weather.

    Without weather points at all the caller uses the clear-sky provider, which
    is a real physical model at any timestamp; the horizon is then unclipped.
    """
    if not weather_points:
        return horizon
    hours = {
        ensure_utc(p.timestamp).replace(minute=0, second=0, microsecond=0)
        for p in weather_points
        if p.ghi_w_m2 is not None
    }
    covered = 0
    for ts in horizon.slot_starts(run_at):
        if hour_label_for(ensure_utc(ts)) not in hours:
            break
        covered += 1
    if covered >= horizon.slots:
        return horizon
    if covered == 0:
        # Every slot is beyond the samples - fall back to the full horizon on
        # the clear-sky physics rather than writing no PV forecast at all.
        return horizon
    return Horizon(slots=covered, slot_minutes=horizon.slot_minutes)


def weekly_outlook_timestamps(
    weather_points: list[WeatherPoint], now: datetime
) -> list[datetime]:
    """S4's hourly slot starts: "übermorgen" 00:00 Berlin through the end of
    what real weather actually covers - the contiguous prefix with a GHI
    sample, never fabricated past it (:func:`pv_horizon`'s own discipline).

    Today and tomorrow stay the EXISTING quarter-hour 48h forecast; this is
    purely the day-after-tomorrow-onward hourly extension that
    :mod:`voltpilot_forecast.weekly_repository` stores separately. An empty
    result (no weather that far out yet, e.g. ``WEATHER_FORECAST_DAYS`` still
    at its pre-S4 default) means "nothing to persist this cycle", not an
    error - the caller simply skips the weekly save.
    """
    today = ensure_utc(now).astimezone(BERLIN).date()
    start, _ = berlin_day_bounds(today + timedelta(days=2))
    hours = {
        ensure_utc(p.timestamp).replace(minute=0, second=0, microsecond=0)
        for p in weather_points
        if p.ghi_w_m2 is not None
    }
    timestamps: list[datetime] = []
    candidate = start
    for _ in range(WEEKLY_OUTLOOK_MAX_HOURS):
        if hour_label_for(candidate) not in hours:
            break
        timestamps.append(candidate)
        candidate += timedelta(hours=1)
    return timestamps


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
    weekly_forecasts: WeeklyForecastRepository | None = None,
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
        plants=site.plants,
    )
    # N1 fix (Captain 11.11.2026: "Behebe den Lesefehler"): the ACTIVE model
    # now gets the correctly-read beam-normal DNI (``direct_normal_irradiance``,
    # ``use_true_dni=True``). The historical (mislabeled, horizontal-as-DNI)
    # reading is built separately below, purely as the permanent comparison
    # candidate - never the one fed to ``physical``/the baseline.
    weather_forecast = (
        WeatherForecast(
            tenant_id=site.tenant_id,
            site_id=site.site_id,
            latitude=location.latitude,
            longitude=location.longitude,
            run_at=now,
            points=tuple(weather_points),
        )
        if weather_points
        else None
    )
    provider = (
        OpenMeteoWeatherProvider(weather_forecast, use_true_dni=True)
        if weather_forecast
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

    # N4/S5 (Captain 11.11.2026): das Tagestyp-Modell lief bisher nur im
    # Wochen-Ausblick (S4, weiter unten) - ohne Viertelstunden-Reihen auf dem
    # regulären Horizont gäbe es für "load-profile" nie eine Tagesbewertung,
    # auf die sich die Automatik (S5, R.4) stützen könnte. Deterministic wie
    # `persistence`, läuft darum unabhängig von `ml_available`.
    load_profile_baseline = ProfileLoadForecaster()
    forecasts.save(
        load_profile_baseline.forecast(
            site.site_id, site.tenant_id, load_history, horizon, now
        )
    )
    quality.upsert_model_state(
        _baseline_state(site, registry.LOAD_PROFILE, ForecastKind.LOAD, now)
    )
    summary.saved_models.append(registry.LOAD_PROFILE)

    physical = PhysicalPvForecaster(provider) if provider else PhysicalPvForecaster()
    # PV stops where real weather stops (see :func:`pv_horizon`); LOAD does not.
    pv_hor = pv_horizon(horizon, weather_points, now) if provider else horizon
    forecasts.save(physical.forecast(config, pv_hor, now))
    quality.upsert_model_state(
        _baseline_state(site, registry.PV_PHYSICAL, ForecastKind.PV, now)
    )
    summary.saved_models.append(registry.PV_PHYSICAL)

    # -- S0 comparison-only candidate (N1): the OLD, mislabeled reading --------
    # Deterministic, not ML, so it runs independently of ``ml_available``. Kept
    # running forever so "alt gegen neu gegen gemessen" stays measured daily
    # per site and the pauschale 14% loss assumption can later be checked
    # against it (report section 4.2). Only meaningful with real weather - the
    # clear-sky fallback has no DNI distinction to make, so a site without
    # weather simply gets no row for this model this cycle. Deliberately NOT
    # a registry.KNOWN_MODELS entry (see PV_PHYSICAL_LEGACY_DNI): it can never
    # become active, by construction.
    if weather_forecast:
        legacy_provider = OpenMeteoWeatherProvider(weather_forecast, use_true_dni=False)
        legacy = PhysicalPvForecasterLegacyDni(legacy_provider)
        forecasts.save(legacy.forecast(config, pv_hor, now))
        quality.upsert_model_state(
            _baseline_state(site, registry.PV_PHYSICAL_LEGACY_DNI, ForecastKind.PV, now)
        )
        summary.saved_models.append(registry.PV_PHYSICAL_LEGACY_DNI)

    # -- S4: the week ahead, per HOUR, stored separately (forecast_weekly) -----
    # "ab übermorgen" onward; today/tomorrow stay the quarter-hour forecast
    # above. Needs real weather (WEATHER_FORECAST_DAYS reaching that far) - a
    # clear-sky-only week ahead would not be the outlook S4 asks for, so a
    # site without one simply gets no weekly row this cycle, same stance as
    # the legacy-DNI candidate above.
    if weekly_forecasts is not None and provider is not None:
        weekly_ts = weekly_outlook_timestamps(weather_points, now)
        if weekly_ts:
            pv_values = physical.power_series(config, weekly_ts)
            weekly_forecasts.save(
                ForecastSeries(
                    kind=ForecastKind.PV,
                    site_id=site.site_id,
                    tenant_id=site.tenant_id,
                    run_at=now,
                    method=f"{physical.method}:{provider.name}",
                    points=[
                        ForecastPoint(ts, round(kw, 4))
                        for ts, kw in zip(weekly_ts, pv_values)
                    ],
                    model=physical.model_id,
                )
            )
            load_profile = ProfileLoadForecaster()
            load_values = load_profile.values_at(load_history, weekly_ts, 60)
            weekly_forecasts.save(
                ForecastSeries(
                    kind=ForecastKind.LOAD,
                    site_id=site.site_id,
                    tenant_id=site.tenant_id,
                    run_at=now,
                    method=load_profile.method,
                    points=[
                        ForecastPoint(ts, v) for ts, v in zip(weekly_ts, load_values)
                    ],
                    model=load_profile.model_id,
                )
            )
            summary.saved_models.append(f"{physical.model_id}:weekly")
            summary.saved_models.append(f"{load_profile.model_id}:weekly")

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
            f.forecast(config, pv_hor, now),
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
        weekly_forecasts = TimescaleWeeklyForecastRepository(conn)
        quality = TimescaleQualityRepository(conn)
        sites = load_sites(conn)
        if not sites:
            logger.warning("collect.no_sites")
            return summaries
        for site in sites:
            try:
                summary = collect_site(
                    conn, forecasts, quality, site, now, cfg, cache, ml_available,
                    weekly_forecasts=weekly_forecasts,
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
    serve.add_argument(
        "--health-port", type=int,
        default=int(os.environ.get("FORECAST_HEALTH_PORT", "8097")),
        help="probe endpoint port, /health + /ready (default FORECAST_HEALTH_PORT, "
        "else 8097; 0 disables it)",
    )
    serve.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    env = dict(os.environ)
    dsn = dsn_from_env(env)
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
    # It resolves the platform precedence (platform choice > env > baseline, see
    # voltpilot_forecast.model_choice) - printing the raw env would be a lie on
    # a fleet that used the promotion switch. A DB blip degrades to env here
    # exactly like everywhere else.
    #
    # ⚠ This is the fleet DEFAULT, not "what every plant plans with": since the
    # per-plant switch (Captain 19.08.2026) a site can carry its own choice, and
    # the line says so rather than claiming a fleet-wide truth it no longer has.
    _active = model_choice.active_models(env, model_choice.load_choices_dsn(dsn))
    logger.info(
        "collect.active_models load=%s pv=%s (Vorgabe; je Anlage überstimmbar)",
        _active[ForecastKind.LOAD],
        _active[ForecastKind.PV],
    )

    if args.command == "fetch":
        run_cycle(dsn, cfg, cache, ml_available)
        return 0

    if args.command == "serve":
        from voltpilot_forecast import evaluate, rueckblick  # noqa: PLC0415

        # Container runtime contract (docs/k8s-readiness.md): SIGTERM-aware
        # sleep, probe endpoint, and a short exponential back-off after a
        # failed cycle so a Kubernetes cold start (no depends_on - the DB may
        # not be up yet) retries in seconds instead of idling a full interval.
        runtime = ServeRuntime("forecast-collector")
        runtime.install_signal_handlers()
        serve_health(runtime, args.health_port)
        last_eval_day: date | None = None
        cycle = 0
        while not runtime.stopping:
            try:
                run_cycle(dsn, cfg, cache, ml_available)
                if not args.no_eval:
                    yesterday = evaluate.yesterday_berlin()
                    if last_eval_day != yesterday:
                        evaluate.run_for(dsn, yesterday, days_back=2)
                        # S3: derselbe Takt, dieselbe Idempotenz - ein eigener
                        # Fehlschlag darf die Tagesbewertung nicht abreißen.
                        try:
                            rueckblick.run_for(dsn, yesterday, days_back=2)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("serve.rueckblick_failed: %s", exc)
                        last_eval_day = yesterday
                runtime.record_success()
            except Exception as exc:  # keep the loop alive across DB blips
                runtime.record_failure(exc)
                logger.warning("serve.cycle_failed: %s", exc)
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            if not runtime.sleep(runtime.next_delay(args.interval_seconds)):
                break
        logger.info("serve.stopped cycles=%s", cycle)
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

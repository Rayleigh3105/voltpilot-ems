"""Gather one site's optimization inputs from the shared TimescaleDB.

The *predict* side of predict-then-optimize, assembled - the optimizer only
consumes what other layers produced:

- battery master data from ``asset`` (+ ``site`` for the bidding zone),
- day-ahead prices from ``day_ahead_prices`` (services/market-data),
- load/PV forecasts from the ``forecast`` hypertable (services/forecast) when a
  fresh run covers the horizon, else the persistence-baseline **fallback**
  computed from recent telemetry by REUSING ``voltpilot_forecast`` (see
  :mod:`voltpilot_optimization.fallback` - no duplicated forecasting logic),
- current SoC and the observed §14a ``grid_limit_kw`` from latest telemetry,
  each behind a FRESHNESS window (:mod:`voltpilot_optimization.config`): a
  stale §14a reading means "no active limit" (a dimming event is temporary and
  re-asserts itself in live telemetry - one old reading must never cap every
  future plan), a stale SoC falls back to the neutral default instead of
  silently planning from yesterday's value.

Reads run as the trusted backend role (cross-tenant, like the weather
collector); psycopg is a lazy import behind the optional ``db`` extra.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from voltpilot_optimization.config import (
    default_wear_cost_ct_per_kwh,
    grid_limit_max_age,
    soc_max_age,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    SLOT_MINUTES,
    SLOTS_24H,
    ensure_utc,
    horizon_slot_starts,
)
from voltpilot_optimization.fallback import night_floor_pv, persistence_forecast

logger = logging.getLogger("voltpilot.optimization.inputs")

# Sites need at least this many priced slots (4h) for a meaningful plan;
# shorter price coverage skips the site until the next collector run.
MIN_HORIZON_SLOTS = 16

# Telemetry history window feeding the persistence fallback (>= 2 full days so
# "same slot yesterday" always has a candidate).
FALLBACK_HISTORY = timedelta(days=3)

DEFAULT_SOC_PCT = 50.0

# Shadow-mode forecasting (docs/forecasting.md): the forecast hypertable holds
# every model's runs, tagged with a model id; the optimizer consumes ONLY the
# ACTIVE model's rows. Promotion is a deliberate env flip (set the same values
# on the forecast collector); the defaults are the baselines, which mirror
# voltpilot_forecast.registry.BASELINE_MODELS - so out of the box nothing
# changes behaviorally. Read per cycle (not at import) so a restart with new
# env is the only deployment step a promotion needs.
ACTIVE_LOAD_MODEL_ENV = "VOLTPILOT_ACTIVE_LOAD_MODEL"
ACTIVE_PV_MODEL_ENV = "VOLTPILOT_ACTIVE_PV_MODEL"
BASELINE_MODEL_BY_KIND = {"load": "load-persistence", "pv": "pv-physical"}


def active_model(kind: str, env=None) -> str:
    """The forecast model id whose rows this optimizer consumes for ``kind``.

    Delegates to :func:`voltpilot_forecast.registry.active_model`, the sibling
    that feeds the collector/portal, so both sides validate the configured id
    identically: an unknown or wrong-kind id (a promotion typo like ``load_xgb``
    or a PV id under the load env) raises ``ValueError`` here instead of being
    silently accepted - which would find zero stored rows and quietly revert the
    optimizer to its persistence baseline while the portal still shows the
    challenger as "live" (a promotion that is a no-op with no error). Imported
    lazily, mirroring :mod:`voltpilot_optimization.fallback`, so solver-only
    installs without the forecast package are unaffected.
    """
    from voltpilot_forecast import registry
    from voltpilot_forecast.domain import ForecastKind

    env = os.environ if env is None else env
    fkind = ForecastKind.LOAD if kind == "load" else ForecastKind.PV
    return registry.active_model(fkind, env)


class SkipSite(Exception):
    """This site cannot be planned right now (reason in the message)."""


@dataclass(frozen=True)
class BatterySite:
    """A site that owns a battery asset (one optimizer subject).

    ``netzladen_erlaubt`` is the per-site grid-charging switch
    (``site.netzladen_erlaubt``, DB default FALSE): False = EEG mode, the
    battery charges only from PV surplus; True = merchant mode (arbitrage).

    ``latitude``/``longitude`` are the site's WGS84 coordinates
    (``site.latitude``/``site.longitude``, nullable) - used to night-floor the
    PV input so the persistence fallback can never fabricate night "solar" (see
    :func:`voltpilot_optimization.fallback.night_floor_pv`).
    """

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    bidding_zone: str
    battery: BatteryParams
    netzladen_erlaubt: bool
    latitude: float | None = None
    longitude: float | None = None


def load_battery_sites(dsn: str) -> list[BatterySite]:
    """Every site with a battery asset, with full parameters resolved."""
    import psycopg  # lazy: optional [db] extra

    # Platform default for assets without a per-asset wear override (NULL
    # column); resolved once per cycle so an env change needs only a restart.
    default_wear_ct = default_wear_cost_ct_per_kwh()
    sites: list[BatterySite] = []
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.tenant_id, a.site_id, a.device_id, s.bidding_zone,
                   a.capacity_kwh, a.max_charge_kw, a.max_discharge_kw,
                   a.roundtrip_efficiency_pct, s.netzladen_erlaubt,
                   s.latitude, s.longitude, a.wear_cost_ct_per_kwh
            FROM asset a
            JOIN site s ON s.id = a.site_id
            WHERE a.type = 'battery'
            ORDER BY a.site_id
            """
        )
        for row in cur.fetchall():
            (
                tenant_id, site_id, device_id, zone, cap, chg, dis, eff,
                netzladen, lat, lon, wear_ct,
            ) = row
            if cap is None or chg is None or dis is None:
                logger.warning(
                    "site.skipped_missing_params",
                    extra={"context": {"site_id": str(site_id)}},
                )
                continue
            sites.append(
                BatterySite(
                    tenant_id=tenant_id,
                    site_id=site_id,
                    device_id=device_id,
                    bidding_zone=zone,
                    battery=BatteryParams(
                        capacity_kwh=float(cap),
                        max_charge_kw=float(chg),
                        max_discharge_kw=float(dis),
                        roundtrip_efficiency=(
                            float(eff) / 100.0 if eff is not None else 0.92
                        ),
                        wear_cost_ct_per_kwh=(
                            float(wear_ct) if wear_ct is not None
                            else default_wear_ct
                        ),
                    ),
                    netzladen_erlaubt=bool(netzladen),
                    latitude=float(lat) if lat is not None else None,
                    longitude=float(lon) if lon is not None else None,
                )
            )
    return sites


def gather_inputs(
    dsn: str,
    site: BatterySite,
    now: datetime,
    horizon_slots: int = SLOTS_24H,
) -> OptimizationInput:
    """Assemble the slot-aligned :class:`OptimizationInput` for one site.

    The horizon is the next ``horizon_slots`` 15-min slots, truncated to the
    contiguous prefix covered by day-ahead prices (prices are the binding
    input - without a price a slot cannot be optimized). Raises
    :class:`SkipSite` when coverage is below :data:`MIN_HORIZON_SLOTS`.
    """
    now = ensure_utc(now)
    slot_starts = horizon_slot_starts(now, horizon_slots)
    prices = _load_prices(dsn, site.bidding_zone, slot_starts)

    covered = 0
    for start in slot_starts:
        if start not in prices:
            break
        covered += 1
    if covered < MIN_HORIZON_SLOTS:
        raise SkipSite(
            f"only {covered} priced slots for zone {site.bidding_zone} "
            f"(need {MIN_HORIZON_SLOTS}); waiting for the market-data collector"
        )
    slot_starts = slot_starts[:covered]

    load_kw, _ = _forecast_or_fallback(
        dsn, site, "load", "load_kw", slot_starts, now
    )
    pv_kw, pv_used_fallback = _forecast_or_fallback(
        dsn, site, "pv", "pv_power_kw", slot_starts, now
    )
    pv_kw = _night_floor_pv_input(site, slot_starts, pv_kw, pv_used_fallback)

    # Both live readings sit behind a freshness window (F4/P4): a stale
    # section-14a reading must NOT become a standing envelope over every future
    # plan, and a stale SoC must not plan from yesterday's value.
    soc_pct = _fresh_measurement(
        dsn, site.site_id, "soc_pct", now, soc_max_age()
    )
    if soc_pct is None:
        soc_pct = DEFAULT_SOC_PCT
    grid_limit = _fresh_measurement(
        dsn, site.site_id, "grid_limit_kw", now, grid_limit_max_age()
    )

    return OptimizationInput(
        tenant_id=site.tenant_id,
        site_id=site.site_id,
        device_id=site.device_id,
        battery=site.battery,
        slot_starts=slot_starts,
        prices_eur_mwh=[prices[s] for s in slot_starts],
        load_kw=load_kw,
        pv_kw=pv_kw,
        initial_soc_kwh=float(soc_pct) / 100.0 * site.battery.capacity_kwh,
        netzladen_erlaubt=site.netzladen_erlaubt,
        grid_limit_kw=float(grid_limit) if grid_limit is not None else None,
    )


def _load_prices(
    dsn: str, zone: str, slot_starts: list[datetime]
) -> dict[datetime, float]:
    """Day-ahead prices per 15-min slot start over the horizon.

    ``PT15M`` rows map 1:1; ``PT60M`` rows are expanded to the four quarter
    hours they cover (a flat intra-hour price - exact for hourly products).
    15-min prices win where both resolutions are stored.
    """
    import psycopg  # lazy: optional [db] extra

    start, end = slot_starts[0], slot_starts[-1]
    by_slot: dict[datetime, float] = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT ts, resolution, price_eur_mwh
            FROM day_ahead_prices
            WHERE bidding_zone = %s AND ts >= %s AND ts <= %s
            ORDER BY ts
            """,
            (zone, start - timedelta(minutes=45), end),
        )
        rows = cur.fetchall()
    for resolution_pass in ("PT60M", "PT15M"):  # 15-min wins
        for ts, resolution, price in rows:
            if resolution != resolution_pass:
                continue
            ts = ensure_utc(ts)
            slots_covered = 4 if resolution == "PT60M" else 1
            for i in range(slots_covered):
                by_slot[ts + i * timedelta(minutes=SLOT_MINUTES)] = float(price)
    return by_slot


def _forecast_or_fallback(
    dsn: str,
    site: BatterySite,
    kind: str,
    telemetry_column: str,
    slot_starts: list[datetime],
    now: datetime,
) -> tuple[list[float], bool]:
    """The ACTIVE model's latest stored forecast run when it covers the
    horizon, else the persistence baseline over recent telemetry (never fails:
    with no telemetry at all it degrades to zeros, i.e. a pure price-arbitrage
    plan). Shadow challengers' rows are never consumed here.

    Returns ``(series, used_fallback)`` so the PV caller can flag a fallback-fed
    night-floor distinctly (the collector<->optimizer 15-min race, §4a of the
    scout report - visible in monitoring before it silently degrades plans)."""
    stored = _load_forecast(dsn, site.site_id, kind, active_model(kind))
    if all(s in stored for s in slot_starts):
        return [stored[s] for s in slot_starts], False

    history = _load_history(dsn, site.site_id, telemetry_column, now)
    missing = sum(1 for s in slot_starts if s not in stored)
    logger.info(
        "forecast.fallback",
        extra={
            "context": {
                "site_id": str(site.site_id),
                "kind": kind,
                "horizon_slots": len(slot_starts),
                "stored_slots": len(stored),
                "missing_slots": missing,
                "history_points": len(history),
            }
        },
    )
    return persistence_forecast(history, slot_starts), True


def _night_floor_pv_input(
    site: BatterySite,
    slot_starts: list[datetime],
    pv_kw: list[float],
    used_fallback: bool,
) -> list[float]:
    """Apply the night-zero floor to the site's PV input and log any fabrication.

    Defensive: applied to the FINAL PV series regardless of source (a night-zero
    floor can never be physically wrong - the stored physical model is already 0
    at night, so it is a no-op there), so no phantom night PV from any current or
    future PV path reaches the MILP. See
    :func:`voltpilot_optimization.fallback.night_floor_pv`.
    """
    floored, zeroed = night_floor_pv(
        pv_kw, slot_starts, site.latitude, site.longitude
    )
    if site.latitude is None or site.longitude is None:
        if used_fallback:
            logger.warning(
                "forecast.pv_fallback.no_coordinates",
                extra={
                    "context": {
                        "site_id": str(site.site_id),
                        "kind": "pv",
                        "reason": (
                            "PV persistence fallback fired but the site has no "
                            "latitude/longitude - cannot night-floor; a daytime "
                            "value may be smeared across night slots"
                        ),
                    }
                },
            )
        return floored
    if zeroed:
        logger.warning(
            "forecast.pv.night_floor_applied",
            extra={
                "context": {
                    "site_id": str(site.site_id),
                    "kind": "pv",
                    "used_fallback": used_fallback,
                    "night_slots_zeroed": len(zeroed),
                    "max_fabricated_kw": round(max(pv_kw[i] for i in zeroed), 4),
                    "reason": (
                        "PV persistence fallback fabricated non-zero night PV"
                        if used_fallback
                        else "stored PV forecast reported non-zero night values"
                    ),
                }
            },
        )
    return floored


def _load_forecast(
    dsn: str, site_id: UUID, kind: str, model: str
) -> dict[datetime, float]:
    """Latest run of ONE model (the active one) - shadow rows stay invisible."""
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT max(run_at) FROM forecast "
            "WHERE site_id = %s AND kind = %s AND model = %s",
            (site_id, kind, model),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return {}
        cur.execute(
            """
            SELECT time, value_kw FROM forecast
            WHERE site_id = %s AND kind = %s AND model = %s AND run_at = %s
            ORDER BY time
            """,
            (site_id, kind, model, row[0]),
        )
        return {ensure_utc(ts): float(v) for ts, v in cur.fetchall()}


def _load_history(
    dsn: str, site_id: UUID, column: str, now: datetime
) -> list[tuple[datetime, float]]:
    import psycopg  # lazy: optional [db] extra

    assert column in ("load_kw", "pv_power_kw")  # fixed set; never user input
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT time, {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL AND time >= %s
            ORDER BY time
            """,
            (site_id, now - FALLBACK_HISTORY),
        )
        return [(ensure_utc(ts), float(v)) for ts, v in cur.fetchall()]


def _fresh_measurement(
    dsn: str,
    site_id: UUID,
    column: str,
    now: datetime,
    max_age: timedelta,
) -> float | None:
    """The newest telemetry value for ``column`` IF it is fresh, else ``None``.

    Deliberately reads the newest row WITHOUT a time bound and applies the
    window here, so a discarded stale reading is FLAGGED with its age (F4: the
    silent-poisoning failure mode was invisible) instead of just vanishing
    from the query result.
    """
    import psycopg  # lazy: optional [db] extra

    assert column in ("soc_pct", "grid_limit_kw")  # fixed set; never user input
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT time, {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL
            ORDER BY time DESC LIMIT 1
            """,
            (site_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    observed_at, val = ensure_utc(row[0]), float(row[1])
    age = now - observed_at
    if age > max_age:
        logger.warning(
            "telemetry.stale_reading_ignored",
            extra={
                "context": {
                    "site_id": str(site_id),
                    "column": column,
                    "value": val,
                    "age_minutes": round(age.total_seconds() / 60.0, 1),
                    "max_age_minutes": round(max_age.total_seconds() / 60.0, 1),
                }
            },
        )
        return None
    return val

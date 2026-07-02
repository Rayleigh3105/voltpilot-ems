"""Gather one site's optimization inputs from the shared TimescaleDB.

The *predict* side of predict-then-optimize, assembled - the optimizer only
consumes what other layers produced:

- battery master data from ``asset`` (+ ``site`` for the bidding zone),
- day-ahead prices from ``day_ahead_prices`` (services/market-data),
- load/PV forecasts from the ``forecast`` hypertable (services/forecast) when a
  fresh run covers the horizon, else the persistence-baseline **fallback**
  computed from recent telemetry by REUSING ``voltpilot_forecast`` (see
  :mod:`voltpilot_optimization.fallback` - no duplicated forecasting logic),
- current SoC and the observed §14a ``grid_limit_kw`` from latest telemetry.

Reads run as the trusted backend role (cross-tenant, like the weather
collector); psycopg is a lazy import behind the optional ``db`` extra.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    SLOT_MINUTES,
    SLOTS_24H,
    ensure_utc,
    horizon_slot_starts,
)
from voltpilot_optimization.fallback import persistence_forecast

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
    """The forecast model id whose rows this optimizer consumes for ``kind``."""
    env = os.environ if env is None else env
    var = ACTIVE_LOAD_MODEL_ENV if kind == "load" else ACTIVE_PV_MODEL_ENV
    return env.get(var, "").strip() or BASELINE_MODEL_BY_KIND[kind]


class SkipSite(Exception):
    """This site cannot be planned right now (reason in the message)."""


@dataclass(frozen=True)
class BatterySite:
    """A site that owns a battery asset (one optimizer subject)."""

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    bidding_zone: str
    battery: BatteryParams


def load_battery_sites(dsn: str) -> list[BatterySite]:
    """Every site with a battery asset, with full parameters resolved."""
    import psycopg  # lazy: optional [db] extra

    sites: list[BatterySite] = []
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.tenant_id, a.site_id, a.device_id, s.bidding_zone,
                   a.capacity_kwh, a.max_charge_kw, a.max_discharge_kw,
                   a.roundtrip_efficiency_pct
            FROM asset a
            JOIN site s ON s.id = a.site_id
            WHERE a.type = 'battery'
            ORDER BY a.site_id
            """
        )
        for row in cur.fetchall():
            (tenant_id, site_id, device_id, zone, cap, chg, dis, eff) = row
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
                    ),
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

    load_kw = _forecast_or_fallback(dsn, site, "load", "load_kw", slot_starts, now)
    pv_kw = _forecast_or_fallback(dsn, site, "pv", "pv_power_kw", slot_starts, now)

    soc_pct = _latest_measurement(dsn, site.site_id, "soc_pct")
    if soc_pct is None:
        soc_pct = DEFAULT_SOC_PCT
    grid_limit = _latest_measurement(dsn, site.site_id, "grid_limit_kw")

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
) -> list[float]:
    """The ACTIVE model's latest stored forecast run when it covers the
    horizon, else the persistence baseline over recent telemetry (never fails:
    with no telemetry at all it degrades to zeros, i.e. a pure price-arbitrage
    plan). Shadow challengers' rows are never consumed here."""
    stored = _load_forecast(dsn, site.site_id, kind, active_model(kind))
    if all(s in stored for s in slot_starts):
        return [stored[s] for s in slot_starts]

    history = _load_history(dsn, site.site_id, telemetry_column, now)
    logger.info(
        "forecast.fallback",
        extra={
            "context": {
                "site_id": str(site.site_id),
                "kind": kind,
                "stored_slots": len(stored),
                "history_points": len(history),
            }
        },
    )
    return persistence_forecast(history, slot_starts)


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


def _latest_measurement(dsn: str, site_id: UUID, column: str):
    import psycopg  # lazy: optional [db] extra

    assert column in ("soc_pct", "grid_limit_kw")  # fixed set; never user input
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL
            ORDER BY time DESC LIMIT 1
            """,
            (site_id,),
        )
        row = cur.fetchone()
        return row[0] if row else None

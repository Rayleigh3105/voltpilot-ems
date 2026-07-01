"""CLI demo: forecast load + PV for the seeded demo site over 24h.

Runs fully offline (profile load baseline + clear-sky PV, in-memory storage) so
``python -m voltpilot_forecast`` shows a real forecast without a database or
network. Uses the deterministic dev-seed site from
``infra/local/timescale/01-init.sql`` (Demo Site Berlin).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from voltpilot_forecast.domain import (
    ForecastKind,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.service import ForecastService

# Deterministic dev-seed ids (infra/local/timescale/01-init.sql).
DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001"
DEMO_SITE_ID = "00000000-0000-0000-0000-000000000002"
BERLIN = GeoLocation(latitude=52.52, longitude=13.405)


def _synthetic_history(run_at: datetime, days: int = 7) -> list[Observation]:
    """A week of 15-min load history with a simple day/night shape (kW)."""
    history: list[Observation] = []
    start = run_at - timedelta(days=days)
    step = timedelta(minutes=15)
    ts = start
    while ts < run_at:
        hour = ts.hour + ts.minute / 60.0
        # Daytime plateau ~30 kW, night base ~10 kW, weekend a bit lower.
        base = 10.0 + 20.0 * max(0.0, 1.0 - abs(hour - 13.0) / 8.0)
        if ts.weekday() >= 5:
            base *= 0.7
        history.append(Observation(ts, round(base, 3)))
        ts += step
    return history


def main() -> None:
    run_at = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)
    config = SiteForecastConfig(
        tenant_id=DEMO_TENANT_ID,
        site_id=DEMO_SITE_ID,
        location=BERLIN,
        plant=PlantSpec(capacity_kwp=100.0, tilt_deg=30.0, azimuth_deg=180.0),
    )
    horizon = Horizon.hours(24)  # 96 x 15-min slots

    service = ForecastService()
    result = service.forecast_site(config, _synthetic_history(run_at), horizon, run_at)

    load = result[ForecastKind.LOAD]
    pv = result[ForecastKind.PV]
    print(
        f"voltpilot-forecast demo - run_at={run_at.isoformat()} "
        f"horizon={len(load)} slots"
    )
    print(
        f"  load  ({load.method}): peak={max(load.values):.1f} kW  "
        f"min={min(load.values):.1f} kW"
    )
    print(
        f"  pv    ({pv.method}): peak={max(pv.values):.1f} kW  "
        f"daily_kwh~{sum(pv.values) * horizon.slot_minutes / 60:.0f}"
    )
    print("  first 6 slots (start / load_kw / pv_kw):")
    for lp, pp in list(zip(load.points, pv.points))[:6]:
        print(
            f"    {lp.timestamp.strftime('%H:%M')}  "
            f"{lp.value_kw:6.2f}  {pp.value_kw:6.2f}"
        )


if __name__ == "__main__":
    main()

"""Forecast fallback: the persistence baseline over recent telemetry.

When the ``forecast`` hypertable has no fresh run covering the horizon, the
optimizer still needs load/PV series. Per the predict-then-optimize separation
this module does NOT implement forecasting - it REUSES the forecast service's
:class:`~voltpilot_forecast.load.SeasonalPersistenceLoadForecaster` ("this slot
equals the same slot yesterday"), fed with raw telemetry history. That baseline
is generic slot-of-day persistence, so it applies to the PV series exactly as
to load (yesterday's sun ≈ today's sun is the honest keyless baseline).

``voltpilot-forecast`` is a sibling-path dependency (installed alongside in the
image / dev venv - see the README); it is imported lazily so the solver-only
modules and tests never require it.
"""

from __future__ import annotations

from datetime import datetime, timedelta


def persistence_forecast(
    history: list[tuple[datetime, float]],
    slot_starts: list[datetime],
) -> list[float]:
    """Project ``history`` onto the slot grid with the persistence baseline.

    ``history`` is (timestamp, value_kw) telemetry, any order; empty history
    yields zeros (the forecaster's flat last-value fallback of an empty series).
    """
    if not slot_starts:
        return []
    if not history:
        return [0.0] * len(slot_starts)

    # Lazy: reuse the forecast service (see module docstring).
    from voltpilot_forecast.domain import Horizon, Observation
    from voltpilot_forecast.load import SeasonalPersistenceLoadForecaster

    slot_minutes = _slot_minutes(slot_starts)
    horizon = Horizon(slots=len(slot_starts), slot_minutes=slot_minutes)
    # Horizon.slot_starts(run_at) yields the grid starting at the boundary
    # strictly after run_at; anchor run_at one slot before our first slot so
    # the forecaster's grid coincides exactly with ours.
    run_at = slot_starts[0] - timedelta(minutes=slot_minutes)
    series = SeasonalPersistenceLoadForecaster().forecast(
        site_id="-",
        tenant_id="-",
        history=[Observation(ts, value) for ts, value in history],
        horizon=horizon,
        run_at=run_at,
    )
    assert [p.timestamp for p in series.points] == slot_starts
    return [p.value_kw for p in series.points]


def _slot_minutes(slot_starts: list[datetime]) -> int:
    if len(slot_starts) < 2:
        return 15
    return int((slot_starts[1] - slot_starts[0]).total_seconds() // 60)

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


def night_floor_pv(
    pv_kw: list[float],
    slot_starts: list[datetime],
    latitude: float | None,
    longitude: float | None,
) -> tuple[list[float], list[int]]:
    """Zero every PV slot whose sun is below the horizon at the site location.

    A defensive night floor on the optimizer's PV *input*. The physical PV model
    (:class:`voltpilot_forecast.pv.PhysicalPvForecaster`) is already 0 at night,
    so applying this to a stored physical forecast is a no-op; but the
    persistence *fallback* (:func:`persistence_forecast`) reuses the LOAD
    baseline and has NO "PV must be 0 at night" knowledge - on short/reset
    history it smears the last observed daytime PV value across every night slot
    (phantom night "Solarstrom" that mislabels a real night grid-charge and can
    even satisfy the EEG ``solar_only_charge`` constraint). A night-zero floor on
    ``pv_kw`` can never be physically wrong, so it is applied to the final PV
    series regardless of source.

    Reuses ``voltpilot_forecast``'s already-shipped solar geometry
    (``solar_position``/``SolarPosition.is_daytime``, lazy import like
    :func:`persistence_forecast`). The site ``latitude``/``longitude`` are
    nullable; with no coordinates the solar position can't be computed, so the
    series is returned UNCHANGED (never raises - the optimizer must still run).

    Returns ``(masked_series, zeroed_indices)`` - ``zeroed_indices`` is empty
    when nothing changed, so the caller can log any fabrication distinctly.
    """
    if latitude is None or longitude is None:
        return list(pv_kw), []

    # Lazy: reuse the forecast service's solar geometry (see module docstring).
    from voltpilot_forecast.domain import GeoLocation
    from voltpilot_forecast.solar import solar_position

    location = GeoLocation(latitude=latitude, longitude=longitude)
    floored: list[float] = []
    zeroed: list[int] = []
    for i, (value, ts) in enumerate(zip(pv_kw, slot_starts)):
        if value > 0.0 and not solar_position(location, ts).is_daytime:
            floored.append(0.0)
            zeroed.append(i)
        else:
            floored.append(value)
    return floored, zeroed


def _slot_minutes(slot_starts: list[datetime]) -> int:
    if len(slot_starts) < 2:
        return 15
    return int((slot_starts[1] - slot_starts[0]).total_seconds() // 60)

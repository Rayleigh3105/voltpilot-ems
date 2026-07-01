"""Flat persistence helper (v1, no ML) - the simplest load baseline.

The forecast for each slot equals the most recent observed value. This is the
low-level "flat last-value" primitive; the production baselines that carry the
daily/weekly profile and produce timestamped, storable series live behind the
``LoadForecaster`` interface in :mod:`voltpilot_forecast.load`
(``SeasonalPersistenceLoadForecaster``, ``ProfileLoadForecaster``). Kept for the
trivial numeric case and as the documented reference point for architecture
section 12's persistence baseline.
"""

from __future__ import annotations

from collections.abc import Sequence


def persistence_forecast(history: Sequence[float], horizon: int) -> list[float]:
    """Return a flat forecast of length ``horizon`` using the last observation.

    Raises ``ValueError`` if ``history`` is empty or ``horizon`` is negative.
    """
    if horizon < 0:
        raise ValueError("horizon must be non-negative")
    if not history:
        raise ValueError("history must contain at least one observation")
    last = float(history[-1])
    return [last] * horizon

"""Baseline load forecast (v1, no ML).

A persistence baseline: the forecast for each slot equals the most recent
observed value. Deliberately trivial - it stands in for the v1 baseline named in
architecture section 12 until the physical PV model and later ML land.
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

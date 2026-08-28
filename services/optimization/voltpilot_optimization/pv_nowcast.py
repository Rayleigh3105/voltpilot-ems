"""Measured PV for the slot in progress - the mirror of the load nowcast.

The horizon's first slot is ALREADY RUNNING. Its load has been answered from
telemetry since P1/P2 (:mod:`voltpilot_optimization.load_nowcast`: an EWMA of
fresh actual-minus-plan samples, which at slot 0 is the measured load itself).
PV had no such answer - only the ratio anchor
(:mod:`voltpilot_optimization.nowcast`), which by design reads COMPLETED slots
and therefore cannot see the cloud that arrived a minute ago.

That gap is what turned a forecast error into a purchase at Pilsting on
28.08.2026: the plan for the running slot assumed a 3 kW surplus while the
plant was making 1.3 kW against a 2.7 kW house. The forecast bug behind it is
fixed at its root in ``voltpilot_forecast``; this module is the reason the
CURRENT slot can never again be planned from a forecast when a measurement of
it exists.

Shape deliberately identical to :func:`~voltpilot_optimization.load_nowcast.apply_load_nowcast`:
an additive residual that fades linearly to zero. At slot 0 the residual is
exactly ``measured - forecast``, so slot 0 IS the measurement - substitution
and correction are one rule, not two. The fade is short on purpose: PV
persistence is worth something for the next few minutes and nothing at all for
the next few hours, so the plan's own model owns the horizon again quickly.
"""

from __future__ import annotations

import math

#: Slots over which the measurement fades back to the forecast. 2 at 15 minutes
#: = the running slot in full and the next one at half weight, which is the
#: horizon over which "what it is doing now" beats "what the model said".
DEFAULT_DECAY_SLOTS = 2


def apply_pv_nowcast(
    forecast_kw: list[float],
    measured_now_kw: float | None,
    *,
    decay_slots: int = DEFAULT_DECAY_SLOTS,
    capacity_kwp: float | None = None,
) -> list[float]:
    """Anchor the near horizon on the measurement, fading back to the forecast.

    ``measured_now_kw`` of ``None`` (no fresh telemetry) returns the forecast
    byte-for-byte - the freshness gate lives with the caller, and no evidence
    must mean no correction. Negative measurements are refused for the same
    reason: a plant does not generate backwards, so a negative reading is a
    broken channel and not a fact to plan on.
    """
    if measured_now_kw is None or not forecast_kw:
        return list(forecast_kw)
    if decay_slots < 1:
        raise ValueError("decay_slots must be at least 1")
    if not math.isfinite(measured_now_kw) or measured_now_kw < 0.0:
        return list(forecast_kw)

    residual = measured_now_kw - forecast_kw[0]
    out: list[float] = []
    for i, base in enumerate(forecast_kw):
        weight = max(0.0, 1.0 - i / decay_slots)
        value = max(0.0, base + residual * weight)
        if capacity_kwp is not None:
            value = min(value, capacity_kwp)
        out.append(value)
    return out

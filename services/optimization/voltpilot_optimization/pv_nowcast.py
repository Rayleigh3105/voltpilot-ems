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

Two rules were added after the Herzogau incident of 29.08.2026, where the
first shipped version of this module turned a 23 kW export into a commanded
DISCHARGE. Both are about WHICH measurement is allowed to speak:

* :func:`window_mean` - the measurement is a WINDOW MEAN, never one sample.
  See its docstring for the numbers; the short version is that a single
  instantaneous reading of a quantity that swings 8 -> 44 -> 22 kW inside a
  minute is a coin toss, and the house rule for the ratio anchor already says
  so ("ein Einzel-Sample waere ein Zufallsgriff aus der Viertelstunde").
* ``raise_only`` - on a slot the plant is being CURTAILED in, the measurement
  is the output of our OWN cap and therefore only a FLOOR of the potential,
  never the potential itself. Lowering the forecast to it closes a feedback
  loop: cap -> measure less -> plan less -> cap falls away -> export.
"""

from __future__ import annotations

import math

#: Slots over which the measurement fades back to the forecast. 2 at 15 minutes
#: = the running slot in full and the next one at half weight, which is the
#: horizon over which "what it is doing now" beats "what the model said".
DEFAULT_DECAY_SLOTS = 2

#: How far back the samples that speak for the running slot are collected. The
#: same 2 minutes the load nowcast already reads (``_recent_load_samples``), so
#: the two halves of the same correction look at the same stretch of time.
#: Deliberately configurable (``OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS``): a
#: LONGER window is more cloud-robust and a SHORTER one reacts faster at dusk,
#: and which trade an operator wants is not a code decision. Measured on the
#: incident's own samples: 2 min -> +3.6 kW surplus (right), 5 min -> -0.3 kW
#: (practically idle), 10 min -> +6.0 kW; the single sample gave -6.5 kW.
DEFAULT_LOOKBACK_SECONDS = 120.0


def window_mean(samples: list[float]) -> float | None:
    """The arithmetic mean of the recent samples, or ``None`` without any.

    **Arithmetic, deliberately NOT the EWMA of the load path.** The load half
    of this correction weights recent samples heavily (alpha 0.35), which is
    right for a quantity that steps and then stays. PV does not: it is a
    convolution of the sky, and an exponential weighting converges onto the
    last few seconds - i.e. it inherits exactly the coin toss this function
    exists to remove. On the 25 real samples of 09:58:03-10:00:03 at Herzogau
    (29.08.2026) the three estimators of the SAME data were:

    ==================================  ========  ==========================
    estimator                           PV in kW  verdict for the slot
    ==================================  ========  ==========================
    single sample (the shipped bug)         8.67  a DEFICIT -> discharge
    EWMA, alpha 0.35 (the load form)        9.08  a DEFICIT -> discharge
    **arithmetic mean (this function)**  **16.70**  a surplus -> charge
    ==================================  ========  ==========================

    The slot's true mean was 31.22 kW. All three estimators agree to within
    0.3 kW in calm sun (the 10:13-10:15 window: 39.77 / 39.70 / 39.45), so the
    mean costs nothing where the single sample was already fine - it only
    stops it from picking a cloud.

    An empty list is ``None``: no evidence must mean no correction, never a
    fabricated zero.
    """
    if not samples:
        return None
    finite = [v for v in samples if math.isfinite(v)]
    if not finite:
        return None
    return sum(finite) / len(finite)


def apply_pv_nowcast(
    forecast_kw: list[float],
    measured_kw: float | None,
    *,
    decay_slots: int = DEFAULT_DECAY_SLOTS,
    capacity_kwp: float | None = None,
    raise_only: bool = False,
) -> list[float]:
    """Anchor the near horizon on the measurement, fading back to the forecast.

    ``measured_kw`` of ``None`` (no fresh telemetry) returns the forecast
    byte-for-byte - the freshness gate lives with the caller, and no evidence
    must mean no correction. Negative measurements are refused for the same
    reason: a plant does not generate backwards, so a negative reading is a
    broken channel and not a fact to plan on.

    ``raise_only`` is for a running slot the plant is being CURTAILED in. There
    the measurement is not the plant's potential but the output of our own cap,
    so it may only ever be read as a FLOOR: a measurement ABOVE the forecast
    still proves the plant can make at least that much and is applied, while a
    measurement BELOW it proves nothing and leaves the forecast alone. Inventing
    a headroom on top of the cap ("measured + X") was the alternative and is
    refused: nobody knows X, and a fabricated number is worse than the forecast.

    The asymmetry is safe in the direction it leaves open. An over-optimistic
    PV input on a curtailed slot ends as a charge command the EDGE already
    clamps down to the measured surplus (``charge_from_surplus_only``, the load
    follower); an under-optimistic one has no catcher at all - that is the
    incident. Where the guards are asymmetric, the correction must be too.
    """
    if measured_kw is None or not forecast_kw:
        return list(forecast_kw)
    if decay_slots < 1:
        raise ValueError("decay_slots must be at least 1")
    if not math.isfinite(measured_kw) or measured_kw < 0.0:
        return list(forecast_kw)

    residual = measured_kw - forecast_kw[0]
    if raise_only and residual <= 0.0:
        return list(forecast_kw)
    out: list[float] = []
    for i, base in enumerate(forecast_kw):
        weight = max(0.0, 1.0 - i / decay_slots)
        value = max(0.0, base + residual * weight)
        if capacity_kwp is not None:
            value = min(value, capacity_kwp)
        out.append(value)
    return out

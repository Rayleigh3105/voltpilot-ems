"""Short-horizon additive load correction and bounded uncertainty reserve."""

from __future__ import annotations

import math

DEFAULT_ALPHA = 0.35
DEFAULT_DECAY_SLOTS = 8  # 2 h at 15 minutes
DEFAULT_MAX_RESIDUAL_KW = 40.0
DEFAULT_UNCERTAINTY_FRACTION = 0.05
DEFAULT_UNCERTAINTY_MAX_KW = 2.0


def ewma_residual(
    measured_kw: list[float],
    predicted_now_kw: float,
    *,
    alpha: float = DEFAULT_ALPHA,
    max_abs_kw: float = DEFAULT_MAX_RESIDUAL_KW,
) -> float | None:
    """EWMA of fresh actual-minus-plan samples, oldest to newest.

    No finite evidence yields ``None`` and therefore no correction. The clamp
    prevents a broken meter from dominating a two-hour horizon.
    """
    if not (0.0 < alpha <= 1.0) or not math.isfinite(predicted_now_kw):
        raise ValueError("invalid EWMA parameters")
    value: float | None = None
    for measured in measured_kw:
        if not math.isfinite(measured) or measured < 0.0:
            continue
        residual = max(-max_abs_kw, min(measured - predicted_now_kw, max_abs_kw))
        value = residual if value is None else alpha * residual + (1.0 - alpha) * value
    return value


def apply_load_nowcast(
    forecast_kw: list[float], residual_kw: float | None, *, decay_slots: int = DEFAULT_DECAY_SLOTS
) -> list[float]:
    """Add the latest residual to current/near slots and fade it to zero."""
    if residual_kw is None:
        return list(forecast_kw)
    if decay_slots < 1 or not math.isfinite(residual_kw):
        raise ValueError("invalid nowcast")
    return [
        max(0.0, base + residual_kw * max(0.0, 1.0 - i / decay_slots))
        for i, base in enumerate(forecast_kw)
    ]


def apply_uncertainty_reserve(
    forecast_kw: list[float],
    *,
    fraction: float = DEFAULT_UNCERTAINTY_FRACTION,
    max_kw: float = DEFAULT_UNCERTAINTY_MAX_KW,
    decay_slots: int = DEFAULT_DECAY_SLOTS,
) -> list[float]:
    """Bounded upper-load scenario near now; never changes the long horizon."""
    if not (0.0 <= fraction <= 1.0 and max_kw >= 0.0 and decay_slots >= 1):
        raise ValueError("invalid uncertainty reserve")
    out = []
    for i, base in enumerate(forecast_kw):
        weight = max(0.0, 1.0 - i / decay_slots)
        reserve = min(max(base, 0.0) * fraction, max_kw) * weight
        out.append(max(0.0, base + reserve))
    return out

"""Platform-level optimizer tunables (env-overridable, admin-UI-ready).

Every economic/behavioral constant that an operator may need to tune lives
here, resolved from the environment per optimization cycle (mirroring the
``VOLTPILOT_ACTIVE_*_MODEL`` pattern in :mod:`voltpilot_optimization.inputs`:
a restart with new env is the only deployment step a change needs). Garbage
values raise ``ValueError`` loudly instead of being silently replaced by a
default - the active-model-typo discipline.

Battery wear cost (P2 of the optimizer redesign, critique finding F2)
----------------------------------------------------------------------

``wear_cost_ct_per_kwh`` prices battery degradation per **kWh cycled** through
the battery: one kWh charged AND later discharged (AC side) costs this much
wear, implemented as half the rate on each kWh of charge and each kWh of
discharge throughput. The platform default is per-asset overridable via the
nullable ``asset.wear_cost_ct_per_kwh`` column (api migration
``V20260710000000``); NULL falls back to this default.

Default derivation (LFP-representative, no datasheet available - captain to
refine per D3): replacement cost ~250 EUR per usable kWh / ~6,000 full
equivalent cycles ~= 4.2 ct per kWh-cycle, rounded to **4.0 ct/kWh**. The
representative band is 2.5-5 ct (200-300 EUR/kWh over 6,000-8,000 cycles).
Economically this means a cycle happens only when the price spread clears the
wear on top of round-trip losses: eta^2 * p_discharge - p_charge >
wear * 5 * (1 + eta^2) [EUR/MWh] - ~38 EUR/MWh at the default and eta^2=0.92.

Telemetry freshness windows (F4 freshness half, proposal P4)
------------------------------------------------------------

The observed section-14a ``grid_limit_kw`` and the battery ``soc_pct`` are read
from the newest telemetry row - but a reading older than its freshness window
must not steer a plan: a section-14a dimming event is temporary (it re-asserts
itself in live telemetry while active), so a stale reading means "no active
limit", and a stale SoC means "we do not know" (plan from the neutral default),
never "yesterday's value still holds". Defaults: 60 min for ``grid_limit_kw``
(a small multiple of the 15-min plan/telemetry cadence), 120 min for SoC (it
drifts slowly, so a moderately old reading still beats the 50% default).
"""

from __future__ import annotations

import math
import os
from datetime import timedelta

#: Platform default battery wear cost in ct per kWh cycled (see module docstring).
DEFAULT_WEAR_COST_CT_PER_KWH = 4.0
WEAR_COST_ENV = "OPTIMIZER_WEAR_COST_CT_PER_KWH"

#: A grid_limit_kw telemetry reading older than this is treated as NO active limit.
DEFAULT_GRID_LIMIT_MAX_AGE_MINUTES = 60.0
GRID_LIMIT_MAX_AGE_ENV = "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES"

#: A soc_pct telemetry reading older than this falls back to the 50% default.
DEFAULT_SOC_MAX_AGE_MINUTES = 120.0
SOC_MAX_AGE_ENV = "OPTIMIZER_SOC_MAX_AGE_MINUTES"


def _float_env(env, name: str, default: float, minimum: float, allow_equal: bool) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        parsed = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"{name} must be finite, got {raw!r}")
    if parsed < minimum or (parsed == minimum and not allow_equal):
        bound = ">=" if allow_equal else ">"
        raise ValueError(f"{name} must be {bound} {minimum}, got {raw!r}")
    return parsed


def default_wear_cost_ct_per_kwh(env=None) -> float:
    """The platform-default wear cost (ct per kWh cycled); 0 disables wear
    pricing platform-wide (per-asset overrides still apply)."""
    env = os.environ if env is None else env
    return _float_env(
        env, WEAR_COST_ENV, DEFAULT_WEAR_COST_CT_PER_KWH, 0.0, allow_equal=True
    )


def grid_limit_max_age(env=None) -> timedelta:
    """Freshness window for the observed section-14a ``grid_limit_kw``."""
    env = os.environ if env is None else env
    minutes = _float_env(
        env,
        GRID_LIMIT_MAX_AGE_ENV,
        DEFAULT_GRID_LIMIT_MAX_AGE_MINUTES,
        0.0,
        allow_equal=False,
    )
    return timedelta(minutes=minutes)


def soc_max_age(env=None) -> timedelta:
    """Freshness window for the latest battery ``soc_pct`` reading."""
    env = os.environ if env is None else env
    minutes = _float_env(
        env, SOC_MAX_AGE_ENV, DEFAULT_SOC_MAX_AGE_MINUTES, 0.0, allow_equal=False
    )
    return timedelta(minutes=minutes)

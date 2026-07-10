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

Feste EEG-Einspeisevergütung schedule (P1 export pricing, Stage 2)
------------------------------------------------------------------

Rooftop-PV **Teileinspeisung** (Überschusseinspeisung) rates per commissioning
date and plant size - the export value of an ``eigenverbrauch`` plant (a
battery site self-consumes, so the Teileinspeisung rates apply, never the
higher Volleinspeisung ones). The remuneration is TRANCHE-wise: the first
10 kWp earn the ``le10`` rate, the next 30 kWp the ``le40`` rate, capacity
above 40 kWp the ``le100`` rate (plants > 100 kWp are obligated into
Direktvermarktung, so the feste-Vergütung path effectively never applies to
them; the ``le100`` rate is reused for any tail capacity, documented
approximation). The rate is LOCKED at commissioning for 20 years plus the
commissioning year (expiry handled in :mod:`voltpilot_optimization.pricing`).

The EEG-2023 era (2022-07-30 onward, incl. the 1%-per-6-months degression
steps from 2024-02) is encoded EXACTLY - the era virtually every
battery-equipped VoltPilot plant was commissioned in. Earlier years are
coarse ANNUAL anchor values (documented approximation, +/- ~1-2 ct: the real
schedule degressed monthly in some years); they exist so a pre-2022 plant
gets a defensible order-of-magnitude rate (7-25 ct, far above spot's negative
tail) instead of bare spot. The whole schedule is config-driven: the env
``OPTIMIZER_EEG_RATES_JSON`` replaces it wholesale (a JSON array of
``{"from": "YYYY-MM-DD", "le10": ct, "le40": ct, "le100": ct}`` objects), so
a correction never needs a code change.

Plants commissioned on/after the **Solarspitzengesetz** cutoff (in force
2025-02-25, §51a EEG) receive NO remuneration in negative-price slots; the
pricing layer zeroes their export value there. Older plants keep the fixed
rate regardless of spot (critique F6: curtailing them at negative prices
burns real revenue - with the rate as the export value, the optimizer now
gets that right on its own).
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import date, timedelta

#: Platform default battery wear cost in ct per kWh cycled (see module docstring).
DEFAULT_WEAR_COST_CT_PER_KWH = 4.0
WEAR_COST_ENV = "OPTIMIZER_WEAR_COST_CT_PER_KWH"

#: A grid_limit_kw telemetry reading older than this is treated as NO active limit.
DEFAULT_GRID_LIMIT_MAX_AGE_MINUTES = 60.0
GRID_LIMIT_MAX_AGE_ENV = "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES"

#: A soc_pct telemetry reading older than this falls back to the 50% default.
DEFAULT_SOC_MAX_AGE_MINUTES = 120.0
SOC_MAX_AGE_ENV = "OPTIMIZER_SOC_MAX_AGE_MINUTES"

#: Solarspitzengesetz (§51a EEG) entry into force: plants commissioned on/after
#: this date earn NO feste Vergütung in negative-price slots.
SOLARSPITZENGESETZ_CUTOFF = date(2025, 2, 25)

EEG_RATES_ENV = "OPTIMIZER_EEG_RATES_JSON"


@dataclass(frozen=True)
class EegRateBand:
    """One validity window of the feste-Vergütung schedule (see module
    docstring): tranche rates in ct/kWh for commissioning dates >= ``valid_from``
    (until the next band starts)."""

    valid_from: date
    le10_ct: float   # first 10 kWp
    le40_ct: float   # next 30 kWp (10 < kWp <= 40)
    le100_ct: float  # capacity above 40 kWp

    def __post_init__(self) -> None:
        for name in ("le10_ct", "le40_ct", "le100_ct"):
            v = getattr(self, name)
            if not (math.isfinite(v) and v >= 0.0):
                raise ValueError(f"EEG rate {name} must be finite and >= 0, got {v!r}")


#: Feste Teileinspeisung rates by commissioning date (see module docstring for
#: provenance and the approximation notes on the pre-2022 anchors). Ascending
#: by valid_from; the lookup takes the last band whose valid_from <= the
#: commissioning date, and dates before the first band use the first band.
DEFAULT_EEG_RATE_SCHEDULE: tuple[EegRateBand, ...] = (
    # Coarse annual anchors (approximation - the real degression was monthly).
    EegRateBand(date(2012, 1, 1), 24.4, 23.2, 21.9),
    EegRateBand(date(2013, 1, 1), 17.0, 16.1, 14.4),
    EegRateBand(date(2014, 1, 1), 13.7, 13.0, 11.6),
    EegRateBand(date(2015, 1, 1), 12.6, 12.2, 10.9),
    EegRateBand(date(2016, 1, 1), 12.3, 12.0, 10.7),
    EegRateBand(date(2017, 1, 1), 12.3, 12.0, 10.7),
    EegRateBand(date(2018, 1, 1), 12.2, 11.9, 10.6),
    EegRateBand(date(2019, 1, 1), 11.5, 11.2, 10.0),
    EegRateBand(date(2020, 1, 1), 9.9, 9.6, 7.6),
    EegRateBand(date(2021, 1, 1), 8.2, 8.0, 6.3),
    EegRateBand(date(2022, 1, 1), 6.9, 6.7, 5.3),
    # EEG 2023 (exact): fixed 2022-07-30 .. 2024-01-31, then 1% every 6 months.
    EegRateBand(date(2022, 7, 30), 8.2, 7.1, 5.8),
    EegRateBand(date(2024, 2, 1), 8.11, 7.03, 5.74),
    EegRateBand(date(2024, 8, 1), 8.03, 6.95, 5.68),
    EegRateBand(date(2025, 2, 1), 7.94, 6.88, 5.62),
    EegRateBand(date(2025, 8, 1), 7.86, 6.80, 5.56),
    EegRateBand(date(2026, 2, 1), 7.78, 6.73, 5.51),
)


def eeg_rate_schedule(env=None) -> tuple[EegRateBand, ...]:
    """The feste-Vergütung schedule, wholesale-replaceable via
    ``OPTIMIZER_EEG_RATES_JSON`` (see module docstring for the JSON shape).
    Garbage JSON raises loudly (the active-model-typo discipline)."""
    env = os.environ if env is None else env
    raw = env.get(EEG_RATES_ENV)
    if raw is None or raw.strip() == "":
        return DEFAULT_EEG_RATE_SCHEDULE
    try:
        parsed = json.loads(raw)
        bands = tuple(
            sorted(
                (
                    EegRateBand(
                        valid_from=date.fromisoformat(item["from"]),
                        le10_ct=float(item["le10"]),
                        le40_ct=float(item["le40"]),
                        le100_ct=float(item["le100"]),
                    )
                    for item in parsed
                ),
                key=lambda band: band.valid_from,
            )
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(
            f"{EEG_RATES_ENV} must be a JSON array of "
            '{"from": "YYYY-MM-DD", "le10": ct, "le40": ct, "le100": ct} '
            f"objects: {exc}"
        ) from exc
    if not bands:
        raise ValueError(f"{EEG_RATES_ENV} must contain at least one rate band")
    return bands


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

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

Terminal energy value (P3, optimizer-redesign Stage 3, critique finding F3)
----------------------------------------------------------------------------

The hard terminal floor ``soc_T >= soc_0`` froze an EEG battery on every
low-PV day (no surplus to charge from means no discharge was allowed at all -
critique F3) and forced merchant plans into uneconomic end-of-horizon
buy-backs. It is replaced by a terminal VALUE: the objective credits
``V_end * (soc_T - soc_0)``, so stored energy left at the horizon end is worth
money instead of being contractually pinned.

``V_end`` (EUR per stored kWh) is derived per plan from the horizon's own
prices unless overridden: ``eta * (P_q - wear)`` where ``P_q`` is a
conservative low quantile (default the 30th percentile,
``OPTIMIZER_TERMINAL_VALUE_QUANTILE``) of the per-slot BEST-USE price
``max(import_price_t, export_value_t)``, ``eta`` the one-way efficiency (a
stored kWh delivers only ``eta`` AC kWh) and ``wear`` the pending discharge
wear - floored at 0 (a fully negative-priced horizon values storage at
nothing, never below). Because the same ``eta``/``wear`` appear in the
in-horizon discharge economics, "discharge at exactly ``P_q``" is an EXACT
tie, broken toward holding by the epsilon tie-breaks - so a flat price curve
still plans an idle battery (zero savings on flat, by construction), while
any slot priced above the anchor genuinely beats holding and any slot below
it (a trough, an end-of-horizon tail) does not - no more dump-to-earn.
The quantile is deliberately BELOW the median: the estimate must stay under
typical in-horizon discharge opportunities (or the plan defers real
consumption value to "tomorrow", the F3 freeze in miniature) while staying
above trough prices (or the plan dumps at the tail). The rolling 15-min MPC
re-plan makes the estimate self-correcting.

``OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH`` overrides the derivation with a fixed
platform value (ct per stored kWh); ``0`` disables the terminal value
entirely (stored energy at the horizon end is worth nothing - the plan then
realizes any stored energy at any positive value, useful only for analysis).

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

Peak shaving / Lastspitzenkappung (PS-1/PS-2, scout vp-battery-models-b9 Teil 3)
--------------------------------------------------------------------------------

RLM-metered sites pay a **Leistungspreis** (EUR per kW per billing period) on
the highest 15-min mean grid IMPORT of the period (``site.leistungspreis_eur_kw``,
NULL = module off; ``site.abrechnung_leistung`` = ``jahr``/``monat``). The
solver prices it ECONOMICALLY via a standard epigraph over the horizon's
import plus the billing period's ``peak_so_far`` anchor - never a hard cap,
so no new infeasibility path exists (see solver.py).

``PEAK_RATCHET_FRACTION`` + ``PEAK_RATCHET_CAP_EUR_PER_KW`` form the
*Shave-Target-Ratchet* (report (c)2): the marginal incentive under
``peak_so_far`` is genuinely zero for the period (nothing left to save
there), but the product must keep shaving after a torn peak / at period
start - a torn peak may be a measurement artifact, the monthly system
resets, and the customer SEES the shaving as the promise. So a weak
secondary term prices the plain horizon peak too:
``min(PEAK_RATCHET_FRACTION * Leistungspreis, PEAK_RATCHET_CAP_EUR_PER_KW)``
per kW of horizon peak, per plan. The report's binding requirements are
"groß genug, dass die Batterie in Form bleibt" (must beat the wear cost of
shaving an ordinary spike: ~0.02-0.08 EUR per kW-hour shaved) and "klein
genug, um echte Arbitrage nie zu dominieren" - the ~3% fraction (the
report's "z. B." value) satisfies both at MONATS-Leistungspreis scale
(10-17 EUR/kW -> 0.30-0.51 EUR/kW), but applied uncapped to a JAHRES-LP of
100-200 EUR/kW it would be 3-6 EUR per kW of horizon peak and PROVABLY
dominate real arbitrage (a 400-EUR/MWh spread over a 2h window earns only
~0.6 EUR per kW of charge power - the solver would burn the spread to
flatten ordinary load below the anchor, verified in an early
test_peak_shaving run). Hence the absolute cap at wear scale: 0.30 EUR/kW
beats the wear of shaving (the battery stays in form on flat days), while
any genuine price opportunity beyond ~0.3 EUR/kWh rolls over it. The FULL
Leistungspreis term above the anchor is exact and deliberately uncapped.

``PEAK_SPIKE_FACTOR`` guards ``peak_so_far`` against poisoning (report (a)):
old edge builds shipped unfiltered telemetry spikes, and ONE garbage 15-min
bucket must not anchor the whole year's peak term. The 15-min rollup
averaging already damps single-sample spikes strongly; on top, when the
period's highest bucket exceeds this factor times the second-highest, the
second-highest is used instead (logged). A real recurring peak produces
similar top buckets and always survives; only an isolated outlier is dropped.
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

#: Quantile of the horizon's best-use prices anchoring the derived terminal
#: energy value (see the P3 section of the module docstring).
DEFAULT_TERMINAL_VALUE_QUANTILE = 0.3
TERMINAL_VALUE_QUANTILE_ENV = "OPTIMIZER_TERMINAL_VALUE_QUANTILE"

#: Fixed platform override of the terminal energy value (ct per stored kWh);
#: unset/blank = derive from the horizon's prices.
TERMINAL_VALUE_OVERRIDE_ENV = "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH"

#: Per-slot "Warum" extraction (Fahrplan-Warum): the post-hoc fixed-binary LP
#: re-solve that computes slot roles, binding flags and the shadow-price
#: economics (see :mod:`voltpilot_optimization.explain`). Purely additive to
#: the plan (~30 ms per cycle) and fail-soft; this flag is the instant
#: off-switch. Default ON.
EXPLAIN_ENABLED_ENV = "OPTIMIZER_EXPLAIN_ENABLED"


def explain_enabled(env=None) -> bool:
    """Whether the per-slot why-extraction runs after each solve. Garbage
    values raise loudly (the active-model-typo discipline); the solver calls
    this inside its fail-soft wrapper, so a bad value drops the why-layer with
    a warning instead of sinking plans."""
    env = os.environ if env is None else env
    raw = env.get(EXPLAIN_ENABLED_ENV)
    if raw is None or raw.strip() == "":
        return True
    v = raw.strip().lower()
    if v in ("true", "1", "yes", "on"):
        return True
    if v in ("false", "0", "no", "off"):
        return False
    raise ValueError(f"{EXPLAIN_ENABLED_ENV} must be a boolean, got {raw!r}")


#: Shave-Target-Ratchet: fraction of the Leistungspreis priced on the plain
#: horizon peak (below the peak_so_far anchor too) - see module docstring.
PEAK_RATCHET_FRACTION = 0.03

#: Absolute cap on the ratchet weight (EUR per kW of horizon peak, per plan):
#: keeps a Jahres-Leistungspreis ratchet from dominating real arbitrage while
#: staying well above the wear cost of shaving - see module docstring.
PEAK_RATCHET_CAP_EUR_PER_KW = 0.30


def peak_ratchet_eur_per_kw(leistungspreis_eur_kw: float) -> float:
    """The shave-target-ratchet weight for a site's Leistungspreis (EUR per
    kW of horizon peak, per plan): the fraction of the LP, capped at wear
    scale (see module docstring)."""
    return min(
        PEAK_RATCHET_FRACTION * leistungspreis_eur_kw, PEAK_RATCHET_CAP_EUR_PER_KW
    )

#: peak_so_far plausibility gate: the period's top 15-min import bucket is
#: discarded (second-highest used) when it exceeds this factor times the
#: second-highest - see module docstring.
PEAK_SPIKE_FACTOR = 3.0

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


def terminal_value_quantile(env=None) -> float:
    """The quantile of the horizon's best-use prices anchoring the derived
    terminal energy value (0..1; see the P3 module-docstring section)."""
    env = os.environ if env is None else env
    q = _float_env(
        env,
        TERMINAL_VALUE_QUANTILE_ENV,
        DEFAULT_TERMINAL_VALUE_QUANTILE,
        0.0,
        allow_equal=True,
    )
    if q > 1.0:
        raise ValueError(
            f"{TERMINAL_VALUE_QUANTILE_ENV} must be within [0, 1], got {q!r}"
        )
    return q


def terminal_value_override_eur_per_kwh(env=None) -> float | None:
    """The fixed platform terminal-value override in EUR per stored kWh, or
    ``None`` when unset (derive from the horizon's prices). ``0`` is a valid
    explicit value ("stored energy is worth nothing at the horizon end")."""
    env = os.environ if env is None else env
    raw = env.get(TERMINAL_VALUE_OVERRIDE_ENV)
    if raw is None or raw.strip() == "":
        return None
    ct = _float_env(env, TERMINAL_VALUE_OVERRIDE_ENV, 0.0, 0.0, allow_equal=True)
    return ct / 100.0


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


# ---------------------------------------------------------------------------
# v2 plan shadow publishing (E4-Basis / E13a).
#
# Which sites additionally get their plan co-optimized and published per
# mqtt-schedule 2.0 on the retained v2 topic (ems/.../v2/plan). An ENV FLIP,
# not a DB column, deliberately (the VOLTPILOT_ACTIVE_*_MODEL promotion
# pattern): no migration, default empty = no site is v2-flagged, and rollback
# is unsetting the variable. The v1 publish path is UNTOUCHED for every site -
# flagged sites dual-publish (E13a shadow: v2 publishes, v1 controls).
# ---------------------------------------------------------------------------

V2_PLAN_SITES_ENV = "VOLTPILOT_V2_PLAN_SITES"


def v2_plan_site_ids(env=None) -> frozenset:
    """Site UUIDs flagged for v2 plan shadow publishing (comma-separated in
    ``VOLTPILOT_V2_PLAN_SITES``; empty/unset = none). A malformed entry fails
    loudly - a typo must never silently un-flag a site."""
    from uuid import UUID

    env = os.environ if env is None else env
    raw = env.get(V2_PLAN_SITES_ENV)
    if raw is None or raw.strip() == "":
        return frozenset()
    ids = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(UUID(part))
        except ValueError as exc:
            raise ValueError(
                f"{V2_PLAN_SITES_ENV} must be comma-separated site UUIDs, "
                f"got {part!r}"
            ) from exc
    return frozenset(ids)

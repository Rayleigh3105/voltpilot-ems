"""Monatsmarktwert Solar: domain model, source port and the provisional value.

The German EEG Marktpraemie for a direct-marketed plant is NOT a fixed premium:
fixed is the plant's ANZULEGENDER WERT (its EEG reference rate); the premium in
month M is the difference ``max(0, anzulegender_wert - monatsmarktwert(M))``,
where the Monatsmarktwert is the technology-specific, generation-weighted
average day-ahead price of that month, published by the four German TSOs on
netztransparenz.de at the beginning of the following month (Anlage 1 (zu
paragraph 23a EEG) Nr. 5.2; legally by the 10th working day).

This module holds

  * :class:`MonthlyMarketValue` - the provider-agnostic value type,
  * :class:`MarketValueSource` - the anti-corruption port (netztransparenz is
    today's adapter, a commercial provider would be a drop-in),
  * :func:`provisional_solar_market_value` - the value used for months whose
    official number is NOT yet published (always at least the running month,
    and typically the previous month during its first ~10 working days).

The provisional value applies the OFFICIAL formula
--------------------------------------------------
Anlage 1 Nr. 2.2 EEG 2023 defines the monthly market value of solar as the
generation-weighted average day-ahead price::

    MW(M) = sum_i (p_i * E_i) / sum_i E_i

over the intervals ``i`` of the German calendar month ``M`` - ``p_i`` the DE/LU
day-ahead price, ``E_i`` the Germany-wide actual solar generation of that
interval. Since the day-ahead switch both series are QUARTER-HOURLY (96 values
per day); historical hourly data is tolerated (see the join rule below).

We compute exactly that from our stored day-ahead prices plus a fetched
generation series - the legally relevant one being the ÜNB *Online-Hochrechnung
der tatsächlichen Erzeugung* (netztransparenz.de -> EEG -> Transparenz-
anforderungen -> Marktprämie), see
:mod:`voltpilot_market_data.netztransparenz_generation`.

Join rule (price interval <-> generation interval)
    A generation sample belongs to the price slot that contains its MIDPOINT,
    and a price slot's weight is the SUM of its samples' energy
    (``power_mw * hours``). At today's aligned quarter hours that is a plain
    1:1 join; it also stays correct when a legacy hourly price slot meets four
    quarter-hourly generation samples (the hour then carries four times the
    weight of a quarter, which is exactly its share of the month's energy).
    A price slot with no generation sample carries NO weight - it is left out
    rather than filled in.

Fallback chain (never fabricate, ``None`` stays ``None``)
    1. ÜNB Online-Hochrechnung  -> the official quantity (primary),
    2. energy-charts public_power -> keyless substitute, slightly different,
    3. clear-sky solar shape (:func:`solar_shape_weight`) -> when NO generation
       data is available at all: the sine of the sun's elevation over the
       geographic centre of Germany (51.16 N, 10.45 E), clamped at zero. It
       reproduces the diurnal/seasonal envelope but is weather-blind, so it
       lands noticeably closer to the plain average price,
    4. no priced daylight slot at all -> ``None``.
    Steps 1/2 are chosen by the caller (see
    :class:`~voltpilot_market_data.solar_generation.FallbackSolarGenerationSource`);
    step 3 happens inside :func:`provisional_solar_market_value`.

Accuracy, and why the value STAYS flagged provisional
    Measured on June 2026 against the official 6.190 ct/kWh: ÜNB-weighted
    **6.1897**, energy-charts-weighted 6.372, clear-sky 6.966 (plain average
    10.954). So the ÜNB path already reproduces the published number to well
    inside a tenth of a cent - but it is NOT the published number: the
    Online-Hochrechnung is itself provisional and is revised, the TSOs use
    their own final data, and small deviations in the tenth-of-a-cent range
    remain. The row therefore keeps ``provisional=True`` until the official
    monthly value replaces it (published-beats-provisional, see the repository).

Convergence, and what a part-month value is NOT
    Computed mid-month, the value covers only the days that already exist. It
    is a running average that CONVERGES toward the final one as the month fills
    up - it is neither a month value nor a forecast, and nothing here models
    the remaining days (deliberately out of scope). An early-month value can
    therefore move materially; a late-month one barely does.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime
from math import cos, pi, radians, sin
from typing import Iterable
from zoneinfo import ZoneInfo

from voltpilot_market_data.model import PricePoint
from voltpilot_market_data.solar_generation import SolarGenerationSeries

logger = logging.getLogger("voltpilot.market_data.market_value")

# Marktwert months are German calendar months.
MARKET_TZ = ZoneInfo("Europe/Berlin")

TECHNOLOGY_SOLAR = "solar"

# Name reported when the fallback chain degraded to the weather-blind shape.
CLEAR_SKY_WEIGHTING = "clear-sky"

# Geographic centre of Germany - the fleet-independent anchor for the
# clear-sky solar shape used by the provisional value.
_CENTER_LAT_DEG = 51.16
_CENTER_LON_DEG = 10.45


class MarketValueSourceError(RuntimeError):
    """Adapter-level failure (network, parsing) fetching market values."""


class MarketValueSourceUnavailable(MarketValueSourceError):
    """The upstream could not be reached / returned no usable data."""


@dataclass(frozen=True)
class MonthlyMarketValue:
    """One technology's Monatsmarktwert for one German calendar month.

    ``month`` is the first day of the month. ``value_ct_kwh`` uses the unit the
    TSOs publish (ct/kWh). ``provisional`` marks a Voltpilot-computed
    approximation for a month whose official value is not yet published; the
    official row overwrites it.
    """

    month: date
    technology: str
    value_ct_kwh: float
    provisional: bool
    source: str

    def __post_init__(self) -> None:
        if self.month.day != 1:
            raise ValueError("MonthlyMarketValue month must be the 1st of a month")


class MarketValueSource(ABC):
    """Provider-agnostic source of published monthly market values."""

    @abstractmethod
    def fetch_monthly_market_values(self, year: int) -> tuple[MonthlyMarketValue, ...]:
        """Return every PUBLISHED solar market value of ``year``.

        Months without a published value are simply absent. Raise
        :class:`MarketValueSourceUnavailable` when the upstream is
        unreachable/empty and :class:`MarketValueSourceError` for other faults.
        """
        raise NotImplementedError


def solar_shape_weight(moment: datetime) -> float:
    """Normalized clear-sky solar weight for a UTC moment (0 at night).

    ``sin(solar elevation)`` over the geographic centre of Germany, clamped at
    zero - the standard declination + hour-angle approximation (NOAA-style,
    accurate to well under a degree, far more than this weighting needs).
    """
    if moment.tzinfo is None:
        raise ValueError("solar_shape_weight needs a timezone-aware moment")
    utc = moment.astimezone(ZoneInfo("UTC"))
    day_of_year = utc.timetuple().tm_yday
    declination = radians(-23.44) * cos(2.0 * pi / 365.0 * (day_of_year + 10))
    solar_hours = utc.hour + utc.minute / 60.0 + utc.second / 3600.0 + _CENTER_LON_DEG / 15.0
    hour_angle = radians(15.0 * (solar_hours - 12.0))
    lat = radians(_CENTER_LAT_DEG)
    sin_elevation = sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(hour_angle)
    return max(0.0, sin_elevation)


def _in_month(point: PricePoint, month: date) -> bool:
    """Does the slot START fall into the German calendar ``month``?"""
    local_start = point.start.astimezone(MARKET_TZ)
    return (local_start.year, local_start.month) == (month.year, month.month)


def _weighted_average_ct_kwh(
    weighted_eur_mwh: float, weights: float
) -> float | None:
    if weights <= 0.0:
        return None
    # EUR/MWh -> ct/kWh (the unit the TSOs publish): 10 EUR/MWh = 1 ct/kWh.
    return weighted_eur_mwh / weights / 10.0


def generation_weights_by_slot(
    points: Iterable[PricePoint], generation: SolarGenerationSeries
) -> dict[datetime, float]:
    """Energy (MWh) attributable to each price slot, per the module's join rule.

    A generation sample is assigned to the price slot containing its MIDPOINT;
    a slot's weight is the sum of those samples' energy. Slots without a sample
    are simply absent from the result (no zero weight is invented).
    """
    slots = sorted(points, key=lambda p: p.start)
    weights: dict[datetime, float] = {}
    index = 0
    for sample in generation.points:
        midpoint = sample.midpoint
        # Both sequences are sorted, so one forward walk suffices.
        while index < len(slots) and slots[index].end <= midpoint:
            index += 1
        if index >= len(slots):
            break
        slot = slots[index]
        if slot.start <= midpoint < slot.end:
            weights[slot.start] = weights.get(slot.start, 0.0) + sample.energy_mwh
    return weights


def generation_weighted_solar_market_value(
    points: Iterable[PricePoint],
    generation: SolarGenerationSeries,
    month: date,
) -> float | None:
    """The OFFICIAL formula: ``sum(p_i * E_i) / sum(E_i)`` in ct/kWh.

    Only price slots starting inside ``month`` (Europe/Berlin) contribute, each
    weighted by the solar energy fed in during it (see the module docstring for
    the join rule and the fallback chain). Slots the generation series does not
    cover carry no weight, so a partially covered month yields the running
    average of its covered part - which converges toward the final value.
    Returns ``None`` when nothing carries weight (no overlap, or a fleet that
    generated nothing) so the caller can fall back rather than fabricate.
    """
    month_points = [point for point in points if _in_month(point, month)]
    weights = generation_weights_by_slot(month_points, generation)
    weighted = 0.0
    total = 0.0
    for point in month_points:
        weight = weights.get(point.start, 0.0)
        if weight <= 0.0:
            continue
        weighted += point.price_eur_mwh * weight
        total += weight
    return _weighted_average_ct_kwh(weighted, total)


def clear_sky_weighted_solar_market_value(
    points: Iterable[PricePoint], month: date
) -> float | None:
    """Clear-sky-shape weighted average price of ``month``'s slots, in ct/kWh.

    The weather-blind LAST RESORT of the fallback chain (step 3 in the module
    docstring), used only when no generation data is available at all. Each
    in-month slot is weighted by the clear-sky solar shape at its midpoint.
    Returns ``None`` when nothing carries weight (no data, or night slots only).
    """
    weighted = 0.0
    weights = 0.0
    for point in points:
        if not _in_month(point, month):
            continue
        midpoint = point.start + (point.end - point.start) / 2
        weight = solar_shape_weight(midpoint)
        if weight <= 0.0:
            continue
        weighted += point.price_eur_mwh * weight
        weights += weight
    return _weighted_average_ct_kwh(weighted, weights)


def provisional_solar_market_value_weighted_by(
    points: Iterable[PricePoint],
    month: date,
    generation: SolarGenerationSeries | None = None,
) -> tuple[float | None, str]:
    """The provisional value PLUS the name of the quantity that weighted it.

    The second element is the generation adapter's source tag, or
    :data:`CLEAR_SKY_WEIGHTING` when the chain degraded to the weather-blind
    shape - so callers can say HOW exact today's number is instead of guessing.
    """
    points = list(points)
    if generation is not None and generation.points:
        value = generation_weighted_solar_market_value(points, generation, month)
        if value is not None:
            return value, generation.source
        logger.warning(
            "market_value.provisional.generation_unusable",
            extra={
                "context": {
                    "month": month.isoformat(),
                    "generation_source": generation.source,
                    "generation_points": len(generation),
                }
            },
        )
    return clear_sky_weighted_solar_market_value(points, month), CLEAR_SKY_WEIGHTING


def provisional_solar_market_value(
    points: Iterable[PricePoint],
    month: date,
    generation: SolarGenerationSeries | None = None,
) -> float | None:
    """The provisional Monatsmarktwert Solar of ``month``, in ct/kWh.

    Applies the official generation weighting when a ``generation`` series is
    supplied and overlaps the month, and degrades to the clear-sky shape
    otherwise - the fallback chain documented in the module docstring. Returns
    ``None`` when even that carries no weight; callers must not fabricate a
    value then.
    """
    return provisional_solar_market_value_weighted_by(points, month, generation)[0]

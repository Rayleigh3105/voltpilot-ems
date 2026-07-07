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
  * :func:`provisional_solar_market_value` - the documented approximation used
    for months whose official value is NOT yet published (always at least the
    running month, and typically the previous month during its first ~10
    working days).

Provisional approximation (documented, deliberately simple):
    The official MW Solar weights each slot's spot price by Germany's ACTUAL
    solar feed-in. We do not have that fleet series, so the provisional value
    weights the stored day-ahead prices by a NORMALIZED CLEAR-SKY SOLAR SHAPE:
    the sine of the sun's elevation over the geographic centre of Germany
    (51.16 N, 10.45 E), clamped at zero. That reproduces the diurnal/seasonal
    envelope (night = 0, noon = max, longer summer days) but ignores clouds -
    overcast noon slots weigh as much as sunny ones, so the provisional value
    is typically a little closer to the plain average price than the official
    number. Good enough for a value the API clearly labels "vorlaeufig" and
    which the official publication overwrites within days.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime
from math import cos, pi, radians, sin
from typing import Iterable
from zoneinfo import ZoneInfo

from voltpilot_market_data.model import PricePoint

# Marktwert months are German calendar months.
MARKET_TZ = ZoneInfo("Europe/Berlin")

TECHNOLOGY_SOLAR = "solar"

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


def provisional_solar_market_value(
    points: Iterable[PricePoint], month: date
) -> float | None:
    """Solar-shape-weighted average price of ``month``'s slots, in ct/kWh.

    Only points whose slot start falls in ``month`` (Europe/Berlin) contribute;
    each is weighted by the clear-sky solar shape at its slot midpoint (see the
    module docstring for the approximation and its bias). Returns ``None`` when
    no point carries weight (no data, or a data set of night slots only) -
    callers must not fabricate a value then.
    """
    weighted = 0.0
    weights = 0.0
    for point in points:
        local_start = point.start.astimezone(MARKET_TZ)
        if (local_start.year, local_start.month) != (month.year, month.month):
            continue
        midpoint = point.start + (point.end - point.start) / 2
        weight = solar_shape_weight(midpoint)
        if weight <= 0.0:
            continue
        weighted += point.price_eur_mwh * weight
        weights += weight
    if weights <= 0.0:
        return None
    # EUR/MWh -> ct/kWh (the unit the TSOs publish): 10 EUR/MWh = 1 ct/kWh.
    return weighted / weights / 10.0

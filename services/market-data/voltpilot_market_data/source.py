"""The anti-corruption port: :class:`DayAheadPriceSource`.

Every caller (the optimizer, a backfill job, the persistence writer) depends on
this abstraction, never on a concrete provider. ENTSO-E is today's
implementation; a commercial provider is a drop-in replacement (architecture
section 13: "generischer Adapter zuerst ... kommerzieller Anbieter later
andockbar").
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from voltpilot_market_data.model import PriceSeries


class PriceSourceError(RuntimeError):
    """Base class for adapter-level failures (network, auth, parsing)."""


class PriceSourceUnavailable(PriceSourceError):
    """The upstream could not be reached / returned no usable data.

    Distinct from :class:`PriceSourceError` so the resilience layer can decide
    to fall back to cached values on *availability* failures specifically.
    """


class DayAheadPriceSource(ABC):
    """Provider-agnostic source of day-ahead spot prices for a bidding zone."""

    @abstractmethod
    def fetch_day_ahead_prices(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries:
        """Return the day-ahead price series for ``zone`` over ``[start, end)``.

        ``start``/``end`` are timezone-aware. Implementations must return prices
        in the internal :class:`~voltpilot_market_data.model.PriceSeries` shape
        (EUR/MWh, UTC slot boundaries). Raise :class:`PriceSourceUnavailable`
        when the upstream is unreachable/empty and :class:`PriceSourceError` for
        other adapter faults.
        """
        raise NotImplementedError

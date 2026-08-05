"""Germany-wide solar generation series: domain model, port and fallback chain.

This is the MENGENGROESSE of the Monatsmarktwert formula. Anlage 1 Nr. 2.2
EEG 2023 defines the monthly market value of solar as

    MW(M) = sum_i (p_i * E_i) / sum_i E_i

over the (today quarter-hourly) intervals ``i`` of the German calendar month
``M``, where ``p_i`` is the DE/LU day-ahead price of interval ``i`` and ``E_i``
is the **bundesweite Erzeugungsmenge** of the technology in that interval. The
legally relevant ``E`` is the ÜNB **Online-Hochrechnung der tatsächlichen
Erzeugung**, which the four German TSOs publish on netztransparenz.de - hence
:class:`~voltpilot_market_data.netztransparenz_generation.NetztransparenzSolarGenerationSource`
is the PRIMARY adapter and the energy-charts one is only a fallback (see
:class:`FallbackSolarGenerationSource`).

Like the price side, this module keeps a vendor-free internal type
(:class:`SolarGenerationSeries`) so a different quantity provider is a drop-in.

The series is deliberately NOT persisted: it is read once per refresh cycle,
consumed immediately by the provisional market-value computation and thrown
away. Persisting it would add a hypertable + migration for data no other
consumer reads, while the refresh job already runs periodically and the
official monthly value overwrites the provisional row within days.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger("voltpilot.market_data.solar_generation")

# Technology tag mirroring market_value.TECHNOLOGY_SOLAR; kept local so this
# module does not import the market-value layer (the dependency runs the other
# way round).
TECHNOLOGY_SOLAR = "solar"


class SolarGenerationSourceError(RuntimeError):
    """Adapter-level failure (network, parsing) fetching a generation series."""


class SolarGenerationSourceUnavailable(SolarGenerationSourceError):
    """The upstream could not be reached / returned no usable data."""


@dataclass(frozen=True)
class GenerationPoint:
    """Average generation power over the half-open interval ``[start, end)``.

    ``power_mw`` is the Germany-wide fleet power in MW (the unit both the ÜNB
    Online-Hochrechnung and energy-charts publish). Negative values are not
    physical for solar and are rejected by the adapters rather than silently
    weighted.
    """

    start: datetime
    end: datetime
    power_mw: float

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("GenerationPoint timestamps must be timezone-aware")
        if self.end <= self.start:
            raise ValueError("GenerationPoint end must be after start")

    @property
    def midpoint(self) -> datetime:
        return self.start + (self.end - self.start) / 2

    @property
    def energy_mwh(self) -> float:
        """Energy fed in during the interval - the actual weight ``E_i``.

        Using ENERGY rather than raw MW keeps the weighting correct even if a
        series mixes interval lengths (e.g. historical hourly data next to
        today's quarter hours).
        """
        return self.power_mw * (self.end - self.start).total_seconds() / 3600.0


@dataclass(frozen=True)
class SolarGenerationSeries:
    """An ordered Germany-wide solar generation series."""

    points: tuple[GenerationPoint, ...]
    source: str

    def __post_init__(self) -> None:
        prev: GenerationPoint | None = None
        for point in self.points:
            if prev is not None and point.start < prev.start:
                raise ValueError("SolarGenerationSeries points must be sorted by start")
            prev = point

    def __len__(self) -> int:
        return len(self.points)

    @property
    def resolution(self) -> timedelta | None:
        """Interval length of the first point (diagnostics only)."""
        if not self.points:
            return None
        return self.points[0].end - self.points[0].start


class SolarGenerationSource(ABC):
    """Provider-agnostic source of Germany-wide solar generation."""

    @abstractmethod
    def fetch_solar_generation(
        self, start: datetime, end: datetime
    ) -> SolarGenerationSeries:
        """Return the series covering ``[start, end)``.

        Raise :class:`SolarGenerationSourceUnavailable` when the upstream is
        unreachable/empty and :class:`SolarGenerationSourceError` for other
        faults. A partially covered window is NOT an error - the caller weights
        what exists (see the module docstring of ``market_value``).
        """
        raise NotImplementedError


class FallbackSolarGenerationSource(SolarGenerationSource):
    """Tries sources in order and returns the first usable series.

    The order encodes the captain's ranking: the ÜNB Online-Hochrechnung is the
    legally relevant quantity, everything else (energy-charts/SMARD) is a
    substitute that deviates slightly - measured on June 2026, the ÜNB weighting
    reproduced the official value to 0.0003 ct/kWh while energy-charts landed
    0.18 ct/kWh off. So a fallback hit is logged at WARNING: the value stays
    honest but is a notch less exact.
    """

    def __init__(self, *sources: SolarGenerationSource) -> None:
        if not sources:
            raise ValueError("FallbackSolarGenerationSource needs at least one source")
        self._sources = sources

    def fetch_solar_generation(
        self, start: datetime, end: datetime
    ) -> SolarGenerationSeries:
        last_error: Exception | None = None
        for index, source in enumerate(self._sources):
            try:
                series = source.fetch_solar_generation(start, end)
            except SolarGenerationSourceError as exc:
                last_error = exc
                logger.warning(
                    "solar_generation.source_failed",
                    extra={
                        "context": {
                            "source": type(source).__name__,
                            "rank": index,
                            "error": str(exc),
                        }
                    },
                )
                continue
            if index > 0:
                logger.warning(
                    "solar_generation.fallback_used",
                    extra={
                        "context": {"source": series.source, "rank": index},
                    },
                )
            return series
        raise SolarGenerationSourceUnavailable(
            f"no solar generation source answered: {last_error}"
        )

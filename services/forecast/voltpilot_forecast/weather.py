"""Weather input as an anti-corruption layer (architecture section 12).

The PV model needs irradiance over the horizon. Where that irradiance comes from
is a swappable detail: a v1 analytic clear-sky model now, a real EU-hosted weather
API later (DSGVO/EU-sovereignty rules out US providers in the data plane -
architecture section 2). Callers depend only on :class:`WeatherProvider`, so a
new provider drops in without touching the PV forecaster.

An :class:`IrradianceSample` may carry beam/diffuse components (``dni``/``dhi``);
when a provider supplies only GHI, the transposition falls back to a modelled
diffuse split. This keeps the interface honest about what a richer API can offer
without forcing the clear-sky default to fabricate components it cannot know.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.solar import clear_sky_ghi, solar_position


@dataclass(frozen=True)
class IrradianceSample:
    """Irradiance at one instant. ``ghi`` is required; ``dni``/``dhi`` optional.

    All values are W/m². A clear-sky default leaves ``dni``/``dhi`` as ``None``;
    a measurement-based API can populate them for a better POA transposition.
    """

    ghi_w_m2: float
    dni_w_m2: float | None = None
    dhi_w_m2: float | None = None


class WeatherProvider(ABC):
    """Adapter interface: irradiance for a location over a set of timestamps.

    Implementations are the *only* place that knows about an external weather
    source. Batch-shaped (``irradiance``) so a real HTTP provider can fetch a
    whole horizon in one call.
    """

    name: str = "weather"

    @abstractmethod
    def irradiance(
        self, location: GeoLocation, timestamps: Sequence[datetime]
    ) -> list[IrradianceSample]:
        """Return one :class:`IrradianceSample` per input timestamp, in order."""
        raise NotImplementedError


class ClearSkyWeatherProvider(WeatherProvider):
    """Default provider: analytic clear-sky GHI from solar geometry only.

    Deterministic and dependency-free - no network, no key - so the PV forecast
    runs offline and in tests. It intentionally models the clear-sky envelope
    (fair-weather upper bound); cloud attenuation arrives with a real provider.
    """

    name = "clear_sky"

    def irradiance(
        self, location: GeoLocation, timestamps: Sequence[datetime]
    ) -> list[IrradianceSample]:
        samples: list[IrradianceSample] = []
        for ts in timestamps:
            position = solar_position(location, ts)
            samples.append(IrradianceSample(ghi_w_m2=clear_sky_ghi(position)))
        return samples

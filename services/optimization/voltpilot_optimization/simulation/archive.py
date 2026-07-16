"""Open-Meteo ARCHIVE weather for the simulation year (keyless, one call/year).

The simulation replays a real historical year, so PV must come from the REAL
irradiance of that year at the site's location - PV yield and prices are
correlated (sunny hours are cheap hours), and clear-sky PV against real
prices would put the midday export into the wrong price hours (design report
section 4). The Open-Meteo archive API (``archive-api.open-meteo.com``) serves a
full year of hourly GHI/DNI/DHI in one keyless call.

``ArchiveWeatherProvider`` adapts the fetched year into the physical PV
model's :class:`~voltpilot_forecast.weather.WeatherProvider` (the
OpenMeteoWeatherProvider hour-floor idiom), so
:meth:`PhysicalPvForecaster.power_series` consumes measured irradiance for
historical timestamps unchanged. Results are cached in-memory per
(lat, lon rounded to 0.1 deg, year) - repeated jobs for the same area re-use
the fetch.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Sequence

from voltpilot_forecast.domain import GeoLocation, ensure_utc
from voltpilot_forecast.http import HttpClient, RequestsHttpClient
from voltpilot_forecast.weather import IrradianceSample, WeatherProvider

logger = logging.getLogger("voltpilot.simulation.archive")

DEFAULT_BASE_URL = "https://archive-api.open-meteo.com"

_HOURLY_VARIABLES = (
    "shortwave_radiation",
    "direct_radiation",
    "diffuse_radiation",
)


class ArchiveWeatherError(RuntimeError):
    """The archive fetch failed or returned an unusable body."""


def cache_key(latitude: float, longitude: float, year: int) -> tuple:
    """Coordinates rounded to 0.1 deg (~11 km) - weather-identical for PV
    purposes, so nearby sites share one archive fetch."""
    return (round(latitude, 1), round(longitude, 1), year)


def parse_archive_response(body: str) -> dict[datetime, IrradianceSample]:
    """Hour (UTC, floored) -> irradiance sample, from an archive JSON body."""
    try:
        doc = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ArchiveWeatherError(f"invalid Open-Meteo archive JSON: {exc}") from exc
    hourly = doc.get("hourly")
    if not isinstance(hourly, dict):
        raise ArchiveWeatherError("Open-Meteo archive response missing 'hourly'")
    times = hourly.get("time")
    if not isinstance(times, list) or not times:
        raise ArchiveWeatherError("Open-Meteo archive 'hourly.time' empty/missing")
    ghi = hourly.get("shortwave_radiation", [])
    dni = hourly.get("direct_radiation", [])
    dhi = hourly.get("diffuse_radiation", [])

    def _at(seq, i):
        v = seq[i] if i < len(seq) else None
        return None if v is None else float(v)

    index: dict[datetime, IrradianceSample] = {}
    for i, t in enumerate(times):
        ts = datetime.fromisoformat(t)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        g = _at(ghi, i)
        if g is None:
            # A missing hour (archive lag at year edges) contributes no PV -
            # honest absence, never a fabricated value.
            continue
        index[ts.astimezone(timezone.utc)] = IrradianceSample(
            ghi_w_m2=g, dni_w_m2=_at(dni, i), dhi_w_m2=_at(dhi, i)
        )
    if not index:
        raise ArchiveWeatherError("Open-Meteo archive returned no usable hours")
    return index


class ArchiveWeatherSource:
    """Fetches one location-year of hourly irradiance from the archive API."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        http_client: HttpClient | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self._base_url = base_url
        self._http = http_client or RequestsHttpClient()
        self._timeout = timeout_seconds
        self._cache: dict[tuple, dict[datetime, IrradianceSample]] = {}
        self._lock = threading.Lock()

    def hourly_irradiance(
        self, latitude: float, longitude: float, year: int
    ) -> dict[datetime, IrradianceSample]:
        key = cache_key(latitude, longitude, year)
        with self._lock:
            cached = self._cache.get(key)
        if cached is not None:
            return cached
        params = {
            "latitude": f"{key[0]:.1f}",
            "longitude": f"{key[1]:.1f}",
            "start_date": date(year, 1, 1).isoformat(),
            "end_date": date(year, 12, 31).isoformat(),
            "hourly": ",".join(_HOURLY_VARIABLES),
            "timezone": "UTC",
        }
        url = f"{self._base_url.rstrip('/')}/v1/archive"
        logger.info(
            "archive.fetch.start",
            extra={"context": {"lat": params["latitude"], "lon": params["longitude"], "year": year}},
        )
        try:
            resp = self._http.get(url, params, self._timeout)
        except Exception as exc:  # network / DNS / TLS
            raise ArchiveWeatherError(
                f"Open-Meteo archive request failed: {exc}"
            ) from exc
        if resp.status_code != 200:
            raise ArchiveWeatherError(
                f"Open-Meteo archive returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        index = parse_archive_response(resp.text)
        with self._lock:
            self._cache[key] = index
        logger.info(
            "archive.fetch.ok", extra={"context": {"hours": len(index), "year": year}}
        )
        return index


@dataclass
class ArchiveWeatherProvider(WeatherProvider):
    """WeatherProvider over a fetched archive year (hour-floor lookup, the
    OpenMeteoWeatherProvider idiom). Timestamps outside the fetched year get
    0 W/m2 - only relevant for the cyclic lookahead wrap at the year end,
    where a conservative zero is honest."""

    name = "open_meteo_archive"

    index: dict[datetime, IrradianceSample] = field(default_factory=dict)

    def irradiance(
        self, location: GeoLocation, timestamps: Sequence[datetime]
    ) -> list[IrradianceSample]:
        samples: list[IrradianceSample] = []
        for ts in timestamps:
            hour = ensure_utc(ts).replace(minute=0, second=0, microsecond=0)
            sample = self.index.get(hour)
            samples.append(sample if sample is not None else IrradianceSample(0.0))
        return samples

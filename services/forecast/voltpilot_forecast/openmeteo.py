"""Open-Meteo weather-forecast adapter (KEYLESS, EU-hosted).

Open-Meteo (``https://api.open-meteo.com``) is a free, **no-API-key** weather API
whose data plane is EU-hosted - which fits the DSGVO / EU-sovereignty constraint
the architecture places on the weather anti-corruption layer (section 2/12). This
adapter fetches a site's hourly forecast (temperature, cloud cover and the
shortwave/direct/diffuse radiation useful for PV) for the coming days and maps it
into two internal shapes:

  * :class:`WeatherForecast` - the persisted record (one :class:`WeatherPoint`
    per hour), stored in the ``weather_forecast`` hypertable and surfaced in the
    portal;
  * an :class:`~voltpilot_forecast.weather.IrradianceSample` per timestamp via
    :class:`OpenMeteoWeatherProvider`, so the existing physical PV forecaster can
    consume *real* irradiance instead of the clear-sky envelope - a drop-in
    :class:`~voltpilot_forecast.weather.WeatherProvider` (no PV-model change).

Keyless by construction: there is no token field anywhere, so real weather flows
with no captain-provided secret.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Sequence

from voltpilot_forecast.domain import GeoLocation, ensure_utc
from voltpilot_forecast.http import HttpClient, HttpResponse, RequestsHttpClient
from voltpilot_forecast.weather import IrradianceSample, WeatherProvider

logger = logging.getLogger("voltpilot.forecast.openmeteo")

DEFAULT_BASE_URL = "https://api.open-meteo.com"

# The hourly variables we request. shortwave_radiation is GHI (W/m2); the
# direct/diffuse split lets the POA transposition avoid a modelled diffuse guess.
_HOURLY_VARIABLES = (
    "temperature_2m",
    "cloud_cover",
    "shortwave_radiation",
    "direct_radiation",
    "diffuse_radiation",
)


class WeatherSourceError(RuntimeError):
    """The Open-Meteo response was unreachable, non-200 or unparseable."""


@dataclass(frozen=True)
class WeatherPoint:
    """A single hourly forecast slot, all values at ``timestamp`` (UTC).

    ``ghi_w_m2`` is global horizontal irradiance (shortwave); ``dni``/``dhi`` are
    the direct/diffuse components. Any field may be ``None`` if the provider omits
    it for that hour (e.g. radiation at night is 0, not null, but we stay tolerant).
    """

    timestamp: datetime
    temperature_c: float | None
    cloud_cover_pct: float | None
    ghi_w_m2: float | None
    dni_w_m2: float | None = None
    dhi_w_m2: float | None = None


@dataclass(frozen=True)
class WeatherForecast:
    """An ordered weather forecast for one site, tagged with provenance."""

    tenant_id: str
    site_id: str
    latitude: float
    longitude: float
    run_at: datetime
    points: tuple[WeatherPoint, ...]
    source: str = "open-meteo"

    def __len__(self) -> int:
        return len(self.points)

    @property
    def start(self) -> datetime | None:
        return self.points[0].timestamp if self.points else None


@dataclass(frozen=True)
class OpenMeteoConfig:
    """Open-Meteo adapter configuration; keyless by design (no token field)."""

    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0
    forecast_days: int = 3


def _to_float(value) -> float | None:
    return None if value is None else float(value)


def parse_forecast_response(
    body: str,
    tenant_id: str,
    site_id: str,
    run_at: datetime,
) -> WeatherForecast:
    """Translate an Open-Meteo ``/v1/forecast`` JSON body into a WeatherForecast.

    Expects ``timezone=UTC`` so the ``hourly.time`` ISO strings are UTC wall-clock
    (no offset); they are made timezone-aware here.
    """
    try:
        doc = json.loads(body)
    except json.JSONDecodeError as exc:
        raise WeatherSourceError(f"invalid Open-Meteo JSON: {exc}") from exc

    hourly = doc.get("hourly")
    if not isinstance(hourly, dict):
        raise WeatherSourceError("Open-Meteo response missing 'hourly' block")
    times = hourly.get("time")
    if not isinstance(times, list) or not times:
        raise WeatherSourceError("Open-Meteo 'hourly.time' is empty or missing")

    temps = hourly.get("temperature_2m", [])
    clouds = hourly.get("cloud_cover", [])
    ghi = hourly.get("shortwave_radiation", [])
    dni = hourly.get("direct_radiation", [])
    dhi = hourly.get("diffuse_radiation", [])

    def _at(seq, i):
        return seq[i] if i < len(seq) else None

    points: list[WeatherPoint] = []
    for i, t in enumerate(times):
        # Open-Meteo times with timezone=UTC look like "2026-07-01T00:00".
        ts = datetime.fromisoformat(t)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        points.append(
            WeatherPoint(
                timestamp=ts.astimezone(timezone.utc),
                temperature_c=_to_float(_at(temps, i)),
                cloud_cover_pct=_to_float(_at(clouds, i)),
                ghi_w_m2=_to_float(_at(ghi, i)),
                dni_w_m2=_to_float(_at(dni, i)),
                dhi_w_m2=_to_float(_at(dhi, i)),
            )
        )

    latitude = float(doc.get("latitude", 0.0))
    longitude = float(doc.get("longitude", 0.0))
    return WeatherForecast(
        tenant_id=tenant_id,
        site_id=site_id,
        latitude=latitude,
        longitude=longitude,
        run_at=ensure_utc(run_at),
        points=tuple(points),
        source="open-meteo",
    )


class OpenMeteoWeatherSource:
    """Fetches a site's hourly weather forecast from the keyless Open-Meteo API."""

    def __init__(
        self,
        config: OpenMeteoConfig | None = None,
        http_client: HttpClient | None = None,
    ) -> None:
        self._config = config or OpenMeteoConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch(
        self,
        location: GeoLocation,
        tenant_id: str,
        site_id: str,
        run_at: datetime,
    ) -> WeatherForecast:
        params = {
            "latitude": f"{location.latitude:.6f}",
            "longitude": f"{location.longitude:.6f}",
            "hourly": ",".join(_HOURLY_VARIABLES),
            "forecast_days": str(self._config.forecast_days),
            "timezone": "UTC",
        }
        url = f"{self._config.base_url.rstrip('/')}/v1/forecast"
        log_ctx = {"site_id": site_id, "lat": params["latitude"], "lon": params["longitude"]}
        logger.info("openmeteo.fetch.start", extra={"context": log_ctx})

        try:
            resp: HttpResponse = self._http.get(
                url, params, self._config.timeout_seconds
            )
        except Exception as exc:  # network / DNS / TLS
            raise WeatherSourceError(f"Open-Meteo request failed: {exc}") from exc

        if resp.status_code != 200:
            raise WeatherSourceError(
                f"Open-Meteo returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        forecast = parse_forecast_response(resp.text, tenant_id, site_id, run_at)
        logger.info(
            "openmeteo.fetch.ok",
            extra={"context": {**log_ctx, "points": len(forecast)}},
        )
        return forecast


@dataclass
class OpenMeteoWeatherProvider(WeatherProvider):
    """Adapts a fetched :class:`WeatherForecast` into the PV model's irradiance.

    Constructed from an already-fetched forecast (the collector fetches once, then
    hands the samples to both the store and the PV forecaster). For each requested
    timestamp it returns the nearest hourly sample's GHI/DNI/DHI, so the physical
    PV forecaster gets measured-cloud irradiance instead of the clear-sky envelope.
    A timestamp outside the forecast horizon falls back to 0 W/m2 (night/no data).
    """

    name = "open_meteo"

    forecast: WeatherForecast

    _index: dict[datetime, WeatherPoint] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self._index = {
            p.timestamp.replace(minute=0, second=0, microsecond=0): p
            for p in self.forecast.points
        }

    def irradiance(
        self, location: GeoLocation, timestamps: Sequence[datetime]
    ) -> list[IrradianceSample]:
        samples: list[IrradianceSample] = []
        for ts in timestamps:
            hour = ensure_utc(ts).replace(minute=0, second=0, microsecond=0)
            point = self._index.get(hour)
            if point is None or point.ghi_w_m2 is None:
                samples.append(IrradianceSample(ghi_w_m2=0.0))
                continue
            samples.append(
                IrradianceSample(
                    ghi_w_m2=point.ghi_w_m2,
                    dni_w_m2=point.dni_w_m2,
                    dhi_w_m2=point.dhi_w_m2,
                )
            )
        return samples

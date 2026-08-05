"""energy-charts.info day-ahead price adapter (the KEYLESS default provider).

Implements :class:`~voltpilot_market_data.source.DayAheadPriceSource` against the
Fraunhofer ISE *energy-charts.info* public API
(``GET https://api.energy-charts.info/price?bzn=DE-LU``). Unlike ENTSO-E it needs
**no API key / security token**, so real day-ahead spot prices flow with zero
captain-provided secret - which is why this is the default source (the ENTSO-E
adapter stays available as an alternative / future primary via ``--source entsoe``).

It

  1. maps the Voltpilot bidding zone to an energy-charts ``bzn`` code
     (:mod:`zones`),
  2. issues one GET for the delivery-day window (``start``/``end`` as UNIX
     seconds),
  3. translates the JSON (``unix_seconds`` slot starts + ``price`` array,
     ``unit`` "EUR/MWh") into an internal
     :class:`~voltpilot_market_data.model.PriceSeries`.

The German day-ahead market moved to a 15-minute MTU in October 2025, so the API
now returns quarter-hourly slots (900 s spacing); the resolution is *derived from
the data* (900 s -> ``PT15M``, 3600 s -> ``PT60M``) rather than assumed, so both
granularities parse correctly across the transition.

The same host also serves Germany-wide generation
(``GET /public_power?country=de``), consumed here by
:class:`EnergyChartsSolarGenerationSource` as the **fallback** quantity for the
provisional Monatsmarktwert - the official quantity is the ÜNB
Online-Hochrechnung (see :mod:`voltpilot_market_data.netztransparenz_generation`).

Config comes from the environment (``ENERGY_CHARTS_BASE_URL``); no token exists.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from voltpilot_market_data.http import HttpClient, RequestsHttpClient
from voltpilot_market_data.model import (
    RESOLUTION_PT15M,
    RESOLUTION_PT60M,
    PricePoint,
    PriceSeries,
)
from voltpilot_market_data.solar_generation import (
    GenerationPoint,
    SolarGenerationSeries,
    SolarGenerationSource,
    SolarGenerationSourceError,
    SolarGenerationSourceUnavailable,
)
from voltpilot_market_data.source import (
    DayAheadPriceSource,
    PriceSourceError,
    PriceSourceUnavailable,
)
from voltpilot_market_data.zones import energy_charts_bzn_for_zone

logger = logging.getLogger("voltpilot.market_data.energy_charts")

DEFAULT_BASE_URL = "https://api.energy-charts.info"

# Slot spacing (seconds) -> ISO-8601 resolution code we persist.
_SECONDS_TO_RESOLUTION = {
    900: RESOLUTION_PT15M,
    3600: RESOLUTION_PT60M,
}

# energy-charts' name for the solar production type inside /public_power.
_SOLAR_PRODUCTION_TYPE = "Solar"
_GENERATION_SOURCE_TAG = "energy-charts-public-power"
_DEFAULT_GENERATION_INTERVAL = timedelta(minutes=15)


@dataclass(frozen=True)
class EnergyChartsConfig:
    """energy-charts adapter configuration, normally built from the environment.

    There is deliberately no token field: the API is keyless.
    """

    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "EnergyChartsConfig":
        env = os.environ if env is None else env
        return cls(
            base_url=env.get("ENERGY_CHARTS_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            timeout_seconds=float(env.get("ENERGY_CHARTS_TIMEOUT_SECONDS", "30")),
        )


def _infer_resolution(unix_seconds: list[int]) -> tuple[str, timedelta]:
    """Derive the slot resolution from consecutive slot-start spacings.

    energy-charts returns dense, evenly-spaced slots. We read the spacing from the
    data instead of assuming 15 vs 60 min, so the adapter follows the market's
    Oct-2025 shift to a quarter-hour MTU automatically. A single-point series
    can't reveal a spacing, so it defaults to the current 15-minute standard.
    """
    if len(unix_seconds) < 2:
        return RESOLUTION_PT15M, timedelta(minutes=15)
    spacing = unix_seconds[1] - unix_seconds[0]
    resolution = _SECONDS_TO_RESOLUTION.get(spacing)
    if resolution is None:
        raise PriceSourceError(
            f"unsupported energy-charts slot spacing: {spacing}s "
            "(expected 900s=PT15M or 3600s=PT60M)"
        )
    return resolution, timedelta(seconds=spacing)


def parse_price_response(
    body: str,
    zone: str,
    start: datetime | None = None,
    end: datetime | None = None,
) -> PriceSeries:
    """Translate an energy-charts ``/price`` JSON body into a dense series.

    When ``start``/``end`` are given the series is clipped to the half-open
    ``[start, end)`` window (the API may return a slightly wider range around the
    requested bounds). Prices carry through in the API's native EUR/MWh.
    """
    try:
        doc = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PriceSourceError(f"invalid energy-charts JSON: {exc}") from exc

    unix_seconds = doc.get("unix_seconds")
    prices = doc.get("price")
    if not isinstance(unix_seconds, list) or not isinstance(prices, list):
        raise PriceSourceError(
            "energy-charts response missing 'unix_seconds'/'price' arrays"
        )
    if len(unix_seconds) != len(prices):
        raise PriceSourceError(
            "energy-charts 'unix_seconds' and 'price' arrays differ in length"
        )
    if not unix_seconds:
        raise PriceSourceUnavailable("energy-charts returned an empty price series")

    unit = (doc.get("unit") or "EUR/MWh").strip()
    currency = unit.split("/", 1)[0].strip() or "EUR"

    resolution, slot = _infer_resolution([int(s) for s in unix_seconds])

    points: list[PricePoint] = []
    for epoch, price in zip(unix_seconds, prices):
        if price is None:
            # energy-charts occasionally publishes a null before a slot settles;
            # skip it rather than fabricate a price (the series stays sorted).
            continue
        slot_start = datetime.fromtimestamp(int(epoch), tz=timezone.utc)
        if start is not None and slot_start < start:
            continue
        if end is not None and slot_start >= end:
            continue
        points.append(
            PricePoint(
                start=slot_start,
                end=slot_start + slot,
                price_eur_mwh=float(price),
            )
        )

    if not points:
        raise PriceSourceUnavailable(
            "energy-charts returned no price points within the requested window"
        )

    points.sort(key=lambda p: p.start)
    return PriceSeries(
        zone=zone,
        resolution=resolution,
        currency=currency,
        points=tuple(points),
        source="energy-charts",
    )


class EnergyChartsDayAheadPriceSource(DayAheadPriceSource):
    """Day-ahead price source backed by the keyless energy-charts.info API."""

    def __init__(
        self,
        config: EnergyChartsConfig | None = None,
        http_client: HttpClient | None = None,
    ) -> None:
        self._config = config or EnergyChartsConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch_day_ahead_prices(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries:
        bzn = energy_charts_bzn_for_zone(zone)
        params = {
            "bzn": bzn,
            "start": str(int(start.astimezone(timezone.utc).timestamp())),
            "end": str(int(end.astimezone(timezone.utc).timestamp())),
        }
        url = f"{self._config.base_url.rstrip('/')}/price"
        log_ctx = {
            "zone": zone,
            "bzn": bzn,
            "start": params["start"],
            "end": params["end"],
        }
        logger.info("energy_charts.fetch.start", extra={"context": log_ctx})

        try:
            resp = self._http.get(url, params, self._config.timeout_seconds)
        except Exception as exc:  # network / DNS / TLS
            logger.warning(
                "energy_charts.fetch.transport_error",
                extra={"context": {**log_ctx, "error": str(exc)}},
            )
            raise PriceSourceUnavailable(
                f"energy-charts request failed: {exc}"
            ) from exc

        if resp.status_code >= 500:
            raise PriceSourceUnavailable(
                f"energy-charts server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise PriceSourceError(
                f"energy-charts returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        series = parse_price_response(resp.text, zone, start, end)
        logger.info(
            "energy_charts.fetch.ok",
            extra={"context": {**log_ctx, "points": len(series),
                               "resolution": series.resolution}},
        )
        return series


# ---------------------------------------------------------------------------
# Germany-wide solar generation (/public_power) - the FALLBACK quantity for the
# provisional Monatsmarktwert. See netztransparenz_generation for the official
# one and why it wins.
# ---------------------------------------------------------------------------


def parse_public_power_response(
    body: str, start: datetime | None = None, end: datetime | None = None
) -> SolarGenerationSeries:
    """Translate an energy-charts ``/public_power`` body into a solar series.

    The document carries ``unix_seconds`` (interval starts) plus one entry per
    ``production_types``; the ``Solar`` entry is located BY NAME, so an upstream
    reordering fails loudly instead of silently weighting wind. ``null`` samples
    (a not-yet-settled interval) are skipped, never read as zero. When
    ``start``/``end`` are given the series is clipped to ``[start, end)``.
    """
    try:
        doc = json.loads(body)
    except json.JSONDecodeError as exc:
        raise SolarGenerationSourceError(
            f"invalid energy-charts public_power JSON: {exc}"
        ) from exc

    unix_seconds = doc.get("unix_seconds")
    production_types = doc.get("production_types")
    if not isinstance(unix_seconds, list) or not isinstance(production_types, list):
        raise SolarGenerationSourceError(
            "energy-charts public_power response missing "
            "'unix_seconds'/'production_types'"
        )
    if not unix_seconds:
        raise SolarGenerationSourceUnavailable(
            "energy-charts public_power returned an empty series"
        )

    solar = next(
        (
            entry
            for entry in production_types
            if isinstance(entry, dict)
            and str(entry.get("name", "")).strip() == _SOLAR_PRODUCTION_TYPE
        ),
        None,
    )
    if solar is None:
        names = [str(e.get("name")) for e in production_types if isinstance(e, dict)]
        raise SolarGenerationSourceError(
            f"energy-charts public_power has no '{_SOLAR_PRODUCTION_TYPE}' "
            f"production type (got: {names!r})"
        )
    data = solar.get("data")
    if not isinstance(data, list) or len(data) != len(unix_seconds):
        raise SolarGenerationSourceError(
            "energy-charts public_power solar data length does not match "
            "'unix_seconds'"
        )

    epochs = [int(second) for second in unix_seconds]
    interval = (
        timedelta(seconds=epochs[1] - epochs[0])
        if len(epochs) >= 2 and epochs[1] > epochs[0]
        else _DEFAULT_GENERATION_INTERVAL
    )

    points: list[GenerationPoint] = []
    for epoch, value in zip(epochs, data):
        if value is None:
            continue
        power_mw = float(value)
        if power_mw < 0.0:
            raise SolarGenerationSourceError(
                f"energy-charts public_power solar value is negative: {power_mw}"
            )
        interval_start = datetime.fromtimestamp(epoch, tz=timezone.utc)
        if start is not None and interval_start < start:
            continue
        if end is not None and interval_start >= end:
            continue
        points.append(
            GenerationPoint(
                start=interval_start,
                end=interval_start + interval,
                power_mw=power_mw,
            )
        )

    if not points:
        raise SolarGenerationSourceUnavailable(
            "energy-charts public_power returned no solar samples in the window"
        )

    points.sort(key=lambda p: p.start)
    return SolarGenerationSeries(points=tuple(points), source=_GENERATION_SOURCE_TAG)


class EnergyChartsSolarGenerationSource(SolarGenerationSource):
    """Germany-wide solar generation from the keyless energy-charts API.

    A FALLBACK: it reports the transparency-platform generation, which is close
    to but not identical with the ÜNB Online-Hochrechnung the EEG formula uses
    (measured on June 2026: 6.372 vs the official 6.190 ct/kWh, where the ÜNB
    series reproduced 6.1897).
    """

    def __init__(
        self,
        config: EnergyChartsConfig | None = None,
        http_client: HttpClient | None = None,
        country: str = "de",
    ) -> None:
        self._config = config or EnergyChartsConfig()
        self._http = http_client or RequestsHttpClient()
        self._country = country

    def fetch_solar_generation(
        self, start: datetime, end: datetime
    ) -> SolarGenerationSeries:
        params = {
            "country": self._country,
            "start": str(int(start.astimezone(timezone.utc).timestamp())),
            "end": str(int(end.astimezone(timezone.utc).timestamp())),
        }
        url = f"{self._config.base_url.rstrip('/')}/public_power"
        log_ctx = {"country": self._country, **params}
        logger.info("energy_charts.generation.fetch.start", extra={"context": log_ctx})

        try:
            resp = self._http.get(url, params, self._config.timeout_seconds)
        except Exception as exc:  # network / DNS / TLS
            logger.warning(
                "energy_charts.generation.fetch.transport_error",
                extra={"context": {**log_ctx, "error": str(exc)}},
            )
            raise SolarGenerationSourceUnavailable(
                f"energy-charts public_power request failed: {exc}"
            ) from exc

        if resp.status_code >= 500:
            raise SolarGenerationSourceUnavailable(
                f"energy-charts server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise SolarGenerationSourceError(
                f"energy-charts returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        series = parse_public_power_response(resp.text, start, end)
        logger.info(
            "energy_charts.generation.fetch.ok",
            extra={"context": {**log_ctx, "points": len(series)}},
        )
        return series

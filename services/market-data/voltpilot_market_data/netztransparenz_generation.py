"""ÜNB Online-Hochrechnung Solar adapter (KEYLESS) - the OFFICIAL quantity.

Implements :class:`~voltpilot_market_data.solar_generation.SolarGenerationSource`
against the endpoint that feeds netztransparenz.de's own chart
*"Online-Hochrechnung der tatsächlichen Erzeugung von Strom aus Solarenergie"*
(EEG -> Transparenzanforderungen -> Marktprämie)::

    POST https://www.netztransparenz.de/DesktopModules/LotesCharts/Services/
         HighchartService.asmx/GetChartData
    Content-Type: application/json
    {"dateFromCet": "<local ISO>", "dateToCet": "<local ISO>",
     "dataType": "4", "productId": "42145141", ...}

This is the SAME ASMX service the existing market-value adapter already uses
(:mod:`voltpilot_market_data.netztransparenz`), just a different method +
``dataType``/``productId`` pair - i.e. no new trust surface, no key, no cookie
(verified live 2026-08-05, data back to 2012).

**Why this source and not energy-charts/SMARD:** Anlage 1 Nr. 2.2 EEG 2023
weights the day-ahead prices with the *bundesweite tatsächliche Erzeugung*, and
the ÜNB Online-Hochrechnung published here IS that quantity. Measured on June
2026 the weighting built on it reproduced the official Monatsmarktwert Solar of
6.190 ct/kWh as **6.1897** ct/kWh, whereas energy-charts' public_power series
gave 6.372 and the old clear-sky shape 6.966. energy-charts therefore stays as a
FALLBACK only (see
:class:`~voltpilot_market_data.solar_generation.FallbackSolarGenerationSource`).

**Request/response facts worth knowing**

* ``dateFromCet``/``dateToCet`` are **German local** wall-clock timestamps
  (the ``timezone: "CET"`` field), which is exactly the boundary a German
  calendar month needs - so one request covers one month.
* The response is the same ASMX envelope ``{"d": "<json string>"}`` whose
  ``chartData`` is a semicolon-CSV, here one row per interval::

      Zeit;50Hertz;Amprion;TenneT TSO;TransnetBW
      1781474400000;0;0;0;0

  ``Zeit`` is the UTC epoch (ms) of the interval START; the four TSO columns are
  MW. Germany-wide generation is their SUM - the columns are located by HEADER
  NAME, so an upstream reshuffle fails loudly instead of silently dropping a
  control area.
* Resolution is quarter-hourly (900 s) since the day-ahead switch; older data is
  hourly. The interval length is *derived from the data* (like the price
  adapter's resolution inference), so both parse.
* A row whose TSO cells are still empty (the newest, not-yet-computed intervals)
  is SKIPPED - never read as a zero, which would drag the weighted average
  toward the unweighted one.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite
from zoneinfo import ZoneInfo

from voltpilot_market_data.http import HttpPostClient, RequestsHttpClient
from voltpilot_market_data.solar_generation import (
    GenerationPoint,
    SolarGenerationSeries,
    SolarGenerationSource,
    SolarGenerationSourceError,
    SolarGenerationSourceUnavailable,
)

logger = logging.getLogger("voltpilot.market_data.netztransparenz_generation")

DEFAULT_BASE_URL = "https://www.netztransparenz.de"
SOURCE_TAG = "netztransparenz-online-hochrechnung"

_SERVICE_PATH = (
    "/DesktopModules/LotesCharts/Services/HighchartService.asmx/GetChartData"
)
# The page's own chart parameters (read off the live page 2026-08-05).
_DATA_TYPE_ONLINE_HOCHRECHNUNG = "4"
_PRODUCT_ID_SOLAR = "42145141"

_REQUEST_TZ = ZoneInfo("Europe/Berlin")
_TIME_COLUMN = "Zeit"
# The four German TSO control areas; their sum is the Germany-wide fleet.
_TSO_COLUMNS = ("50Hertz", "Amprion", "TenneT TSO", "TransnetBW")

_DEFAULT_INTERVAL = timedelta(minutes=15)


@dataclass(frozen=True)
class NetztransparenzGenerationConfig:
    """Adapter configuration; keyless, so only base URL + timeout exist."""

    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 60.0

    @classmethod
    def from_env(
        cls, env: dict[str, str] | None = None
    ) -> "NetztransparenzGenerationConfig":
        env = os.environ if env is None else env
        return cls(
            base_url=env.get("NETZTRANSPARENZ_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            # A whole month of quarter hours is ~300 KB, so this needs a longer
            # timeout than the tiny market-value table.
            timeout_seconds=float(
                env.get("NETZTRANSPARENZ_GENERATION_TIMEOUT_SECONDS", "60")
            ),
        )


def _infer_interval(epochs_ms: list[int]) -> timedelta:
    """Interval length from consecutive row spacings (15 min today, 60 older)."""
    if len(epochs_ms) < 2:
        return _DEFAULT_INTERVAL
    spacing_seconds = (epochs_ms[1] - epochs_ms[0]) / 1000.0
    if spacing_seconds <= 0:
        raise SolarGenerationSourceError(
            f"netztransparenz generation rows are not increasing in time "
            f"(spacing {spacing_seconds}s)"
        )
    return timedelta(seconds=spacing_seconds)


def parse_online_hochrechnung_response(body: str) -> SolarGenerationSeries:
    """Translate a ``GetChartData`` body into a Germany-wide solar series.

    Rows whose TSO cells are still empty are skipped (see the module docstring);
    a malformed envelope/row raises rather than writing a wrong weight.
    """
    try:
        envelope = json.loads(body)
        inner = json.loads(envelope["d"])
        chart_data = inner["chartData"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SolarGenerationSourceError(
            f"invalid netztransparenz generation response: {exc}"
        ) from exc

    lines = [line for line in chart_data.split("\r\n") if line.strip()]
    if not lines:
        raise SolarGenerationSourceUnavailable(
            "netztransparenz returned an empty generation table"
        )

    header = [cell.strip() for cell in lines[0].split(";")]
    if header[:1] != [_TIME_COLUMN]:
        raise SolarGenerationSourceError(
            f"netztransparenz generation table has no leading '{_TIME_COLUMN}' "
            f"column (header: {header!r})"
        )
    try:
        tso_indexes = [header.index(column) for column in _TSO_COLUMNS]
    except ValueError as exc:
        raise SolarGenerationSourceError(
            "netztransparenz generation table is missing a TSO column "
            f"(expected {list(_TSO_COLUMNS)!r}, header: {header!r})"
        ) from exc

    rows: list[tuple[int, float]] = []
    for line in lines[1:]:
        cells = [cell.strip() for cell in line.split(";")]
        if len(cells) <= max(tso_indexes):
            raise SolarGenerationSourceError(
                f"netztransparenz generation row too short: {line!r}"
            )
        try:
            epoch_ms = int(cells[0])
        except ValueError as exc:
            raise SolarGenerationSourceError(
                f"netztransparenz generation time key {cells[0]!r} is not an epoch"
            ) from exc
        raw = [cells[i] for i in tso_indexes]
        if any(not cell for cell in raw):
            # Newest intervals are published with a lag; an empty cell means
            # "not computed yet", never zero generation.
            continue
        try:
            # The service emits dot decimals; tolerate a comma just in case a
            # culture switch ever flips it, rather than raising on real data.
            power_mw = sum(float(cell.replace(",", ".")) for cell in raw)
        except ValueError as exc:
            raise SolarGenerationSourceError(
                f"netztransparenz generation row has a non-numeric value: {line!r}"
            ) from exc
        if not isfinite(power_mw) or power_mw < 0.0:
            raise SolarGenerationSourceError(
                f"netztransparenz generation row has an implausible total "
                f"({power_mw} MW): {line!r}"
            )
        rows.append((epoch_ms, power_mw))

    if not rows:
        raise SolarGenerationSourceUnavailable(
            "netztransparenz generation table carries no computed intervals yet"
        )

    interval = _infer_interval([epoch for epoch, _ in rows])
    points = [
        GenerationPoint(
            start=datetime.fromtimestamp(epoch / 1000.0, tz=timezone.utc),
            end=datetime.fromtimestamp(epoch / 1000.0, tz=timezone.utc) + interval,
            power_mw=power_mw,
        )
        for epoch, power_mw in rows
    ]
    points.sort(key=lambda p: p.start)
    return SolarGenerationSeries(points=tuple(points), source=SOURCE_TAG)


class NetztransparenzSolarGenerationSource(SolarGenerationSource):
    """Germany-wide solar generation from the keyless ÜNB Online-Hochrechnung."""

    def __init__(
        self,
        config: NetztransparenzGenerationConfig | None = None,
        http_client: HttpPostClient | None = None,
    ) -> None:
        self._config = config or NetztransparenzGenerationConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch_solar_generation(
        self, start: datetime, end: datetime
    ) -> SolarGenerationSeries:
        url = f"{self._config.base_url.rstrip('/')}{_SERVICE_PATH}"
        body = json.dumps(
            {
                "dateFromCet": _as_local_iso(start),
                "dateToCet": _as_local_iso(end),
                "dataType": _DATA_TYPE_ONLINE_HOCHRECHNUNG,
                "productId": _PRODUCT_ID_SOLAR,
                "asImage": False,
                "diagramType": "column stacked",
                "highChartType": "2",
                "columnColors": None,
                "template": "",
                "title": "",
                "timezone": "CET",
            }
        )
        log_ctx = {"start": start.isoformat(), "end": end.isoformat()}
        logger.info("netztransparenz_generation.fetch.start", extra={"context": log_ctx})

        try:
            resp = self._http.post_json(url, body, self._config.timeout_seconds)
        except Exception as exc:  # network / DNS / TLS
            logger.warning(
                "netztransparenz_generation.fetch.transport_error",
                extra={"context": {**log_ctx, "error": str(exc)}},
            )
            raise SolarGenerationSourceUnavailable(
                f"netztransparenz generation request failed: {exc}"
            ) from exc

        if resp.status_code >= 500:
            raise SolarGenerationSourceUnavailable(
                f"netztransparenz server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise SolarGenerationSourceError(
                f"netztransparenz returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        series = parse_online_hochrechnung_response(resp.text)
        logger.info(
            "netztransparenz_generation.fetch.ok",
            extra={"context": {**log_ctx, "points": len(series)}},
        )
        return series


def _as_local_iso(moment: datetime) -> str:
    """German wall-clock ISO string (no offset) - the service's date format."""
    return moment.astimezone(_REQUEST_TZ).strftime("%Y-%m-%dT%H:%M:%S")

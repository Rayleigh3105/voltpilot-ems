"""netztransparenz.de Monatsmarktwert adapter (KEYLESS).

Implements :class:`~voltpilot_market_data.market_value.MarketValueSource`
against the endpoint that feeds the "Marktwertuebersicht" chart on
netztransparenz.de itself:

    POST https://www.netztransparenz.de/DesktopModules/LotesCharts/Services/
         HighchartService.asmx/GetMarketpremiumData
    Content-Type: application/json
    {"dateFrom": "<year>-01-01T00:00:00", ...}

Verified live (2026-07-07): no API key, no cookie/session, plain JSON in and
out, data back to 2012. This was chosen deliberately over the alternatives:

  * the OFFICIAL netztransparenz WebAPI (ds.netztransparenz.de) requires a
    registered OAuth2 client (extranet account + client credentials) - not
    keyless, so it fails the "no captain secret" bar (it remains the obvious
    upgrade path if this endpoint ever goes away);
  * energy-charts.info has NO market-value endpoint (checked in its OpenAPI);
  * scraping the HTML page would be genuinely fragile - this is NOT that: the
    ASMX service returns structured JSON and is the page's own data backend.

Honest trade-off: the endpoint is the site's internal chart service, not a
documented public API, so a site relaunch could move it. The blast radius is
small by design - values are MONTHLY, every fetched value is persisted, and a
broken fetch only delays the swap of a clearly-labeled provisional value for
the official one. Parse failures raise loudly (never fabricate a value).

Response shape (see tests/fixtures/netztransparenz_marketpremium_*.json,
recorded verbatim from the live endpoint on 2026-07-07): the ASMX envelope
``{"d": "<json string>"}`` wraps a document whose ``chartData`` is a
semicolon-CSV with one row per month::

    Monat;Spotmarktpreis;MW Wind an Land;MW Wind auf See;MW Solar;MW
    1767225600000;11.009;9.536;10.519;11.019;11.009

``Monat`` is the UTC epoch (ms) of the month start; values are ct/kWh with dot
decimals; unpublished months have empty cells. Only the ``MW Solar`` column is
consumed today (Voltpilot optimizes PV plants); the column is located by
HEADER NAME, never by position, so upstream column reshuffles fail loudly
instead of silently reading wind values.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

from voltpilot_market_data.http import HttpPostClient, RequestsHttpClient
from voltpilot_market_data.market_value import (
    TECHNOLOGY_SOLAR,
    MarketValueSource,
    MarketValueSourceError,
    MarketValueSourceUnavailable,
    MonthlyMarketValue,
)

logger = logging.getLogger("voltpilot.market_data.netztransparenz")

DEFAULT_BASE_URL = "https://www.netztransparenz.de"
SOURCE_TAG = "netztransparenz"

_SERVICE_PATH = (
    "/DesktopModules/LotesCharts/Services/HighchartService.asmx/GetMarketpremiumData"
)
_SOLAR_COLUMN = "MW Solar"


@dataclass(frozen=True)
class NetztransparenzConfig:
    """Adapter configuration; keyless, so only base URL + timeout exist."""

    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "NetztransparenzConfig":
        env = os.environ if env is None else env
        return cls(
            base_url=env.get("NETZTRANSPARENZ_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            timeout_seconds=float(env.get("NETZTRANSPARENZ_TIMEOUT_SECONDS", "30")),
        )


def parse_market_value_response(
    body: str, year: int
) -> tuple[MonthlyMarketValue, ...]:
    """Translate a ``GetMarketpremiumData`` body into published solar values.

    Empty cells (months not yet published) are skipped. Every kept row is
    validated: the month key must be a first-of-month inside ``year`` and the
    value must be a finite number - anything else raises
    :class:`MarketValueSourceError` (a malformed feed must never write rows).
    """
    try:
        envelope = json.loads(body)
        inner = json.loads(envelope["d"])
        chart_data = inner["chartData"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise MarketValueSourceError(
            f"invalid netztransparenz market-value response: {exc}"
        ) from exc

    lines = [line for line in chart_data.split("\r\n") if line.strip()]
    if not lines:
        raise MarketValueSourceUnavailable(
            "netztransparenz returned an empty market-value table"
        )

    header = [cell.strip() for cell in lines[0].split(";")]
    try:
        solar_index = header.index(_SOLAR_COLUMN)
    except ValueError as exc:
        raise MarketValueSourceError(
            f"netztransparenz market-value table has no '{_SOLAR_COLUMN}' column "
            f"(header: {header!r})"
        ) from exc

    values: list[MonthlyMarketValue] = []
    for line in lines[1:]:
        cells = line.split(";")
        if len(cells) <= solar_index:
            raise MarketValueSourceError(
                f"netztransparenz market-value row too short: {line!r}"
            )
        month_start = datetime.fromtimestamp(int(cells[0]) / 1000.0, tz=timezone.utc)
        if (
            month_start.day != 1
            or month_start.hour or month_start.minute or month_start.second
            or month_start.year != year
        ):
            raise MarketValueSourceError(
                f"netztransparenz month key {cells[0]!r} is not a month start "
                f"of {year}"
            )
        cell = cells[solar_index].strip()
        if not cell:
            continue  # month not yet published - the normal early-month state
        try:
            value = float(cell)
        except ValueError as exc:
            raise MarketValueSourceError(
                f"netztransparenz solar value {cell!r} is not a number"
            ) from exc
        values.append(
            MonthlyMarketValue(
                month=month_start.date(),
                technology=TECHNOLOGY_SOLAR,
                value_ct_kwh=value,
                provisional=False,
                source=SOURCE_TAG,
            )
        )

    return tuple(values)


class NetztransparenzMarketValueSource(MarketValueSource):
    """Monatsmarktwert source backed by the keyless netztransparenz endpoint."""

    def __init__(
        self,
        config: NetztransparenzConfig | None = None,
        http_client: HttpPostClient | None = None,
    ) -> None:
        self._config = config or NetztransparenzConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch_monthly_market_values(self, year: int) -> tuple[MonthlyMarketValue, ...]:
        url = f"{self._config.base_url.rstrip('/')}{_SERVICE_PATH}"
        body = json.dumps(
            {
                "dateFrom": f"{year:04d}-01-01T00:00:00",
                "asImage": False,
                "diagramType": "line",
                "highChartType": "2",
                "columnColors": None,
                "template": "",
                "title": "",
                "timezone": "CET",
            }
        )
        logger.info(
            "netztransparenz.fetch.start", extra={"context": {"year": year}}
        )
        try:
            resp = self._http.post_json(url, body, self._config.timeout_seconds)
        except Exception as exc:  # network / DNS / TLS
            logger.warning(
                "netztransparenz.fetch.transport_error",
                extra={"context": {"year": year, "error": str(exc)}},
            )
            raise MarketValueSourceUnavailable(
                f"netztransparenz request failed: {exc}"
            ) from exc

        if resp.status_code >= 500:
            raise MarketValueSourceUnavailable(
                f"netztransparenz server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise MarketValueSourceError(
                f"netztransparenz returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        values = parse_market_value_response(resp.text, year)
        logger.info(
            "netztransparenz.fetch.ok",
            extra={"context": {"year": year, "months": len(values)}},
        )
        return values

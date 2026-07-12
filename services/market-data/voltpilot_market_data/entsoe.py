"""ENTSO-E Transparency day-ahead price adapter (the first concrete provider).

Implements :class:`~voltpilot_market_data.source.DayAheadPriceSource` against the
ENTSO-E Transparency REST API (document type ``A44`` - Price Document). It

  1. maps the Voltpilot bidding zone to an EIC area code (:mod:`zones`),
  2. issues one GET with the required query params,
  3. translates the ``Publication_MarketDocument`` XML into an internal
     :class:`~voltpilot_market_data.model.PriceSeries`.

Config comes from the environment (``ENTSOE_SECURITY_TOKEN``, ``ENTSOE_BASE_URL``).
The security token is a captain-provided secret and is NOT required to import,
construct, or test this module - only to perform a real live fetch.

References: ENTSO-E Transparency RESTful API, 4.2.10 "Day-ahead Prices".
"""

from __future__ import annotations

import logging
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from voltpilot_market_data.http import HttpClient, RequestsHttpClient
from voltpilot_market_data.model import (
    PricePoint,
    PriceSeries,
    resolution_minutes,
)
from voltpilot_market_data.source import (
    DayAheadPriceSource,
    PriceSourceError,
    PriceSourceUnavailable,
)
from voltpilot_market_data.zones import eic_for_zone

logger = logging.getLogger("voltpilot.market_data.entsoe")

DEFAULT_BASE_URL = "https://web-api.tp.entsoe.eu/api"
# ENTSO-E "Price Document"; A62 is the day-ahead business type.
_DOCUMENT_TYPE_PRICE = "A44"
_ENTSOE_TIME_FORMAT = "%Y%m%d%H%M"

# The securityToken rides in the URL query string, and requests/urllib3
# transport errors embed the FULL request URL in their message ("Max retries
# exceeded with url: /api?securityToken=...&documentType=..."). Strip any query
# string outright, plus a belt-and-braces pass for a token that appears outside
# a URL context.
_QUERY_STRING_RE = re.compile(r"\?[^\s'\")\]>]*")
_SECURITY_TOKEN_RE = re.compile(r"securityToken=[^&\s'\")\]>]*", re.IGNORECASE)


def redact(exc: object) -> str:
    """``str(exc)`` with URL query strings / securityToken values removed.

    Must be applied to transport-error text BOTH before logging and before
    embedding it in a raised exception message, so the captain's long-lived
    API token never leaks into collector logs on a network/DNS/TLS failure.
    """
    text = _QUERY_STRING_RE.sub("?<redacted>", str(exc))
    return _SECURITY_TOKEN_RE.sub("securityToken=<redacted>", text)


@dataclass(frozen=True)
class EntsoeConfig:
    """ENTSO-E adapter configuration, normally built from the environment."""

    security_token: str
    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "EntsoeConfig":
        env = os.environ if env is None else env
        token = env.get("ENTSOE_SECURITY_TOKEN", "").strip()
        if not token:
            raise PriceSourceError(
                "ENTSOE_SECURITY_TOKEN is not set. It is a captain-provided "
                "secret; register at the ENTSO-E Transparency Platform, request "
                "API access, and set it in .env (see .env.example / AGENTS.md)."
            )
        return cls(
            security_token=token,
            base_url=env.get("ENTSOE_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            timeout_seconds=float(env.get("ENTSOE_TIMEOUT_SECONDS", "30")),
        )


def _entsoe_stamp(moment: datetime) -> str:
    """Format an instant as ENTSO-E's UTC ``yyyyMMddHHmm`` period bound."""
    return moment.astimezone(timezone.utc).strftime(_ENTSOE_TIME_FORMAT)


def _localname(tag: str) -> str:
    """Strip the ``{namespace}`` prefix ElementTree prepends to tags."""
    return tag.rsplit("}", 1)[-1]


def _find(elem: ET.Element, name: str) -> ET.Element | None:
    for child in elem:
        if _localname(child.tag) == name:
            return child
    return None


def _findall(elem: ET.Element, name: str) -> list[ET.Element]:
    return [c for c in elem if _localname(c.tag) == name]


def _text(elem: ET.Element | None) -> str | None:
    return elem.text.strip() if elem is not None and elem.text else None


def _parse_entsoe_stamp(text: str) -> datetime:
    # ENTSO-E stamps are UTC, e.g. "2026-07-01T22:00Z".
    return datetime.strptime(text, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)


def _parse_interval(period: ET.Element) -> tuple[datetime, datetime]:
    interval = _find(period, "timeInterval")
    start_txt = _text(_find(interval, "start")) if interval is not None else None
    end_txt = _text(_find(interval, "end")) if interval is not None else None
    if not start_txt or not end_txt:
        raise PriceSourceError("ENTSO-E Period is missing timeInterval start/end")
    return _parse_entsoe_stamp(start_txt), _parse_entsoe_stamp(end_txt)


def parse_price_document(xml_text: str, zone: str) -> PriceSeries:
    """Translate an ENTSO-E A44 ``Publication_MarketDocument`` into a series.

    Robust to ENTSO-E's quirk of omitting ``Point`` entries whose price repeats
    the previous slot: missing positions carry the last known price forward so
    the returned series is dense (one point per slot over the interval).
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise PriceSourceError(f"invalid ENTSO-E XML: {exc}") from exc

    root_name = _localname(root.tag)
    if root_name == "Acknowledgement_MarketDocument":
        reason = _extract_reason(root)
        raise PriceSourceUnavailable(f"ENTSO-E acknowledgement (no data): {reason}")
    if root_name != "Publication_MarketDocument":
        raise PriceSourceError(f"unexpected ENTSO-E root element: {root_name}")

    all_points: list[PricePoint] = []
    resolution: str | None = None
    currency = "EUR"

    time_series = _findall(root, "TimeSeries")
    if not time_series:
        raise PriceSourceUnavailable("ENTSO-E document contained no TimeSeries")

    for ts in time_series:
        currency = _text(_find(ts, "currency_Unit.name")) or currency
        for period in _findall(ts, "Period"):
            res = _text(_find(period, "resolution"))
            if res is None:
                raise PriceSourceError("ENTSO-E Period is missing resolution")
            resolution = res
            try:
                slot = timedelta(minutes=resolution_minutes(res))
            except ValueError as exc:
                raise PriceSourceError(str(exc)) from exc
            interval_start, interval_end = _parse_interval(period)

            # The Period's timeInterval defines the true slot count. ENTSO-E's
            # variable-block curves omit trailing (and interior) Points whose
            # price repeats the previous slot, so the length is derived from the
            # interval, never from the last explicit position.
            slot_count = round((interval_end - interval_start) / slot)
            if slot_count <= 0:
                raise PriceSourceError(
                    "ENTSO-E Period timeInterval is shorter than one slot"
                )

            # Collect explicit points by position, then densify by carry-forward
            # over the whole interval (interior gaps AND omitted trailing slots).
            by_position: dict[int, float] = {}
            for point in _findall(period, "Point"):
                pos = int(_text(_find(point, "position")) or "0")
                amount = _text(_find(point, "price.amount"))
                if pos <= 0 or amount is None:
                    raise PriceSourceError("malformed ENTSO-E Point")
                by_position[pos] = float(amount)

            if max(by_position, default=0) > slot_count:
                raise PriceSourceError(
                    "ENTSO-E Point position exceeds the Period timeInterval length"
                )

            last_price: float | None = None
            for pos in range(1, slot_count + 1):
                if pos in by_position:
                    last_price = by_position[pos]
                if last_price is None:
                    raise PriceSourceError(
                        "ENTSO-E Point position 1 missing; cannot seed series"
                    )
                start = interval_start + slot * (pos - 1)
                all_points.append(
                    PricePoint(
                        start=start,
                        end=start + slot,
                        price_eur_mwh=last_price,
                    )
                )

    if not all_points:
        raise PriceSourceUnavailable("ENTSO-E document yielded no price points")

    all_points.sort(key=lambda p: p.start)
    return PriceSeries(
        zone=zone,
        resolution=resolution or "",
        currency=currency,
        points=tuple(all_points),
        source="entsoe",
    )


def _extract_reason(ack: ET.Element) -> str:
    reason = _find(ack, "Reason")
    if reason is None:
        return "unknown reason"
    code = _text(_find(reason, "code")) or "?"
    text = _text(_find(reason, "text")) or ""
    return f"{code} {text}".strip()


class EntsoeDayAheadPriceSource(DayAheadPriceSource):
    """Day-ahead price source backed by the ENTSO-E Transparency API."""

    def __init__(
        self,
        config: EntsoeConfig,
        http_client: HttpClient | None = None,
    ) -> None:
        self._config = config
        self._http = http_client or RequestsHttpClient()

    def fetch_day_ahead_prices(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries:
        eic = eic_for_zone(zone)
        params = {
            "securityToken": self._config.security_token,
            "documentType": _DOCUMENT_TYPE_PRICE,
            "in_Domain": eic,
            "out_Domain": eic,
            "periodStart": _entsoe_stamp(start),
            "periodEnd": _entsoe_stamp(end),
        }
        # Structured log WITHOUT the security token.
        log_ctx = {
            "zone": zone,
            "eic": eic,
            "period_start": params["periodStart"],
            "period_end": params["periodEnd"],
        }
        logger.info("entsoe.fetch.start", extra={"context": log_ctx})

        try:
            resp = self._http.get(
                self._config.base_url, params, self._config.timeout_seconds
            )
        except Exception as exc:  # network / DNS / TLS
            # The raw exception text can embed the request URL incl. the
            # securityToken - redact it, and raise `from None` so an uncaught
            # traceback never prints the token-bearing cause chain either.
            safe = f"{type(exc).__name__}: {redact(exc)}"
            logger.warning(
                "entsoe.fetch.transport_error",
                extra={"context": {**log_ctx, "error": safe}},
            )
            raise PriceSourceUnavailable(
                f"ENTSO-E request failed: {safe}"
            ) from None

        if resp.status_code == 401:
            raise PriceSourceError("ENTSO-E rejected the security token (401)")
        if resp.status_code >= 500:
            raise PriceSourceUnavailable(
                f"ENTSO-E server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise PriceSourceError(
                f"ENTSO-E returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        series = parse_price_document(resp.text, zone)
        logger.info(
            "entsoe.fetch.ok",
            extra={"context": {**log_ctx, "points": len(series),
                               "resolution": series.resolution}},
        )
        return series

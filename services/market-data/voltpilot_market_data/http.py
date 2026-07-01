"""Minimal HTTP seam so the ENTSO-E adapter is testable without a network.

The adapter depends on the tiny :class:`HttpClient` protocol, never on
``requests`` directly. Production wires :class:`RequestsHttpClient`; tests inject
a fake that replays a recorded fixture. ``requests`` is imported lazily so the
package (and its tests) import cleanly even where it isn't installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    text: str


class HttpClient(Protocol):
    """Just enough of an HTTP client for the adapter's one GET call."""

    def get(
        self, url: str, params: Mapping[str, str], timeout: float
    ) -> HttpResponse:
        ...


class RequestsHttpClient:
    """Default :class:`HttpClient` backed by the ``requests`` library."""

    def get(
        self, url: str, params: Mapping[str, str], timeout: float
    ) -> HttpResponse:
        import requests  # lazy: keeps import-time/test-time dependency-free

        resp = requests.get(url, params=dict(params), timeout=timeout)
        return HttpResponse(status_code=resp.status_code, text=resp.text)

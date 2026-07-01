"""Shared test helpers: fixture loading and an offline fake HTTP client.

No test in this suite touches the live ENTSO-E API - parsing/mapping run off the
recorded XML fixtures under ``tests/fixtures``, and the resilience tests use
in-memory fakes. That is a hard requirement (no live calls in CI).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

import pytest

from voltpilot_market_data.http import HttpResponse

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture
def pt60m_xml() -> str:
    return load_fixture("entsoe_de_lu_pt60m.xml")


@pytest.fixture
def pt15m_xml() -> str:
    return load_fixture("entsoe_de_lu_pt15m.xml")


@pytest.fixture
def gaps_xml() -> str:
    return load_fixture("entsoe_de_lu_gaps.xml")


@pytest.fixture
def trailing_xml() -> str:
    return load_fixture("entsoe_de_lu_trailing.xml")


@pytest.fixture
def ack_xml() -> str:
    return load_fixture("entsoe_ack_no_data.xml")


@dataclass
class FakeHttpClient:
    """Records the last request and replays a canned response or raises."""

    response: HttpResponse | None = None
    error: Exception | None = None
    calls: list[dict] = field(default_factory=list)

    def get(
        self, url: str, params: Mapping[str, str], timeout: float
    ) -> HttpResponse:
        self.calls.append({"url": url, "params": dict(params), "timeout": timeout})
        if self.error is not None:
            raise self.error
        assert self.response is not None, "FakeHttpClient has no response set"
        return self.response

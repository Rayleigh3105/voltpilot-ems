"""Parsing tests against recorded ENTSO-E fixtures (no network)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from voltpilot_market_data.entsoe import parse_price_document
from voltpilot_market_data.model import RESOLUTION_PT15M, RESOLUTION_PT60M
from voltpilot_market_data.source import PriceSourceError, PriceSourceUnavailable


def test_parse_pt60m_yields_24_hourly_points(pt60m_xml):
    series = parse_price_document(pt60m_xml, "DE-LU")

    assert series.zone == "DE-LU"
    assert series.resolution == RESOLUTION_PT60M
    assert series.currency == "EUR"
    assert series.source == "entsoe"
    assert len(series) == 24

    first = series.points[0]
    assert first.start == datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    assert first.end == datetime(2026, 7, 1, 23, 0, tzinfo=timezone.utc)
    assert first.price_eur_mwh == pytest.approx(85.12)

    # Hourly spacing, contiguous.
    for prev, nxt in zip(series.points, series.points[1:]):
        assert nxt.start == prev.end
    assert series.points[-1].end == datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc)


def test_parse_pt15m_spacing(pt15m_xml):
    series = parse_price_document(pt15m_xml, "DE-LU")

    assert series.resolution == RESOLUTION_PT15M
    assert len(series) == 8
    assert (series.points[1].start - series.points[0].start).total_seconds() == 900
    assert series.prices()[0] == pytest.approx(88.10)


def test_parse_carries_missing_positions_forward(gaps_xml):
    # Positions present: 1(50.0) 2(45.5) 5(60.25) 8(70.0); interval spans 8h.
    series = parse_price_document(gaps_xml, "DE-LU")

    prices = series.prices()
    assert len(prices) == 8
    # 3,4 carry 45.5 (from pos 2); 6,7 carry 60.25 (from pos 5).
    assert prices == pytest.approx(
        [50.0, 45.5, 45.5, 45.5, 60.25, 60.25, 60.25, 70.0]
    )


def test_parse_fills_omitted_trailing_points_to_interval_length(trailing_xml):
    # Interval spans 8h (PT60M) but only positions 1-3 are explicit; ENTSO-E
    # omits trailing points whose price repeats. The last price must carry
    # forward to the full interval length rather than truncating at position 3.
    series = parse_price_document(trailing_xml, "DE-LU")

    prices = series.prices()
    assert len(prices) == 8
    assert prices == pytest.approx([50.0, 55.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0])
    assert series.points[-1].end == datetime(2026, 7, 2, 6, 0, tzinfo=timezone.utc)


def test_parse_unsupported_resolution_raises_price_source_error(pt60m_xml):
    # A valid-but-unsupported ENTSO-E resolution must surface as a
    # PriceSourceError so the resilience layer can degrade to cache.
    doc = pt60m_xml.replace("<resolution>PT60M</resolution>", "<resolution>PT30M</resolution>")
    with pytest.raises(PriceSourceError):
        parse_price_document(doc, "DE-LU")


def test_acknowledgement_document_is_unavailable(ack_xml):
    with pytest.raises(PriceSourceUnavailable):
        parse_price_document(ack_xml, "DE-LU")


def test_invalid_xml_raises_price_source_error():
    with pytest.raises(PriceSourceError):
        parse_price_document("<not-valid", "DE-LU")


def test_at_moment_lookup(pt60m_xml):
    series = parse_price_document(pt60m_xml, "DE-LU")
    moment = datetime(2026, 7, 1, 22, 30, tzinfo=timezone.utc)
    assert series.at(moment) == pytest.approx(85.12)
    assert series.at(datetime(2020, 1, 1, tzinfo=timezone.utc)) is None

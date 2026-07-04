"""TimescaleDayAheadPriceRepository.latest_series row reconstruction (offline).

Uses a tiny fake psycopg so no DB is needed: we only exercise the pure
row -> PriceSeries mapping, in particular the mixed-resolution handling (M1).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from voltpilot_market_data.persistence import TimescaleDayAheadPriceRepository

UTC = timezone.utc


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *_args, **_kwargs):
        pass

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor(self._rows)


def _install_fake_psycopg(monkeypatch, rows):
    fake = SimpleNamespace(connect=lambda _dsn: _FakeConn(rows))
    monkeypatch.setitem(sys.modules, "psycopg", fake)


def test_latest_series_single_resolution(monkeypatch):
    t0 = datetime(2026, 7, 1, 0, 0, tzinfo=UTC)
    rows = [
        (t0 + timedelta(minutes=15 * i), "PT15M", 10.0 + i, "EUR", "energy-charts")
        for i in range(4)
    ]
    _install_fake_psycopg(monkeypatch, rows)

    repo = TimescaleDayAheadPriceRepository("postgresql://fake")
    series = repo.latest_series("DE-LU", t0, t0 + timedelta(hours=1))

    assert series is not None
    assert series.resolution == "PT15M"
    assert len(series) == 4
    # Each 15-min slot ends exactly one width later; no overlaps.
    assert series.points[0].end == series.points[1].start


def test_latest_series_segments_out_mixed_resolutions(monkeypatch):
    # A window straddling the MTU switch holds both PT60M (older) and PT15M
    # (newest) rows. The reconstruction must NOT stamp one width on the other
    # (which would make PT60M slots overlap the PT15M ones); it keeps only the
    # newest resolution.
    t0 = datetime(2026, 7, 1, 0, 0, tzinfo=UTC)
    rows = [
        (t0, "PT60M", 50.0, "EUR", "entsoe"),
        (t0 + timedelta(hours=1), "PT15M", 20.0, "EUR", "energy-charts"),
        (t0 + timedelta(hours=1, minutes=15), "PT15M", 21.0, "EUR", "energy-charts"),
    ]
    _install_fake_psycopg(monkeypatch, rows)

    repo = TimescaleDayAheadPriceRepository("postgresql://fake")
    series = repo.latest_series("DE-LU", t0, t0 + timedelta(hours=2))

    assert series is not None
    assert series.resolution == "PT15M"  # newest row's resolution wins
    # The PT60M row is dropped; only the two PT15M slots remain, each 15 min wide.
    assert len(series) == 2
    for p in series.points:
        assert p.end - p.start == timedelta(minutes=15)

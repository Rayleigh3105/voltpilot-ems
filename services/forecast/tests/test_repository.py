"""Tests for the persistence seam.

The in-memory repository is covered end-to-end in test_service.py. Here we verify
the TimescaleForecastRepository's row mapping and SQL shape against a fake DB-API
connection, so the write path is checked without requiring psycopg or a live
TimescaleDB.
"""

from __future__ import annotations

from datetime import datetime, timezone

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
)
from voltpilot_forecast.repository import TimescaleForecastRepository


class _FakeCursor:
    def __init__(self, sink: dict, live: bool) -> None:
        self._sink = sink
        self._live = live

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        # The area lock (voltpilot_forecast.kundenbereich) before the upsert.
        self._sink["sperre"] = (sql, params)

    def fetchone(self):
        return (1,) if self._live else None

    def executemany(self, sql, rows):
        self._sink["sql"] = sql
        self._sink["rows"] = list(rows)


class _FakeConnection:
    def __init__(self, live: bool = True) -> None:
        self.sink: dict = {}
        self.commits = 0
        self._live = live

    def cursor(self):
        return _FakeCursor(self.sink, self._live)

    def commit(self):
        self.commits += 1


def _series() -> ForecastSeries:
    run_at = datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc)
    return ForecastSeries(
        kind=ForecastKind.PV,
        site_id="site-1",
        tenant_id="tenant-1",
        run_at=run_at,
        method="clear_sky_v1:clear_sky",
        points=[
            ForecastPoint(datetime(2026, 6, 21, 5, 15, tzinfo=timezone.utc), 1.5),
            ForecastPoint(datetime(2026, 6, 21, 5, 30, tzinfo=timezone.utc), 2.5),
        ],
    )


def test_save_builds_one_row_per_point_with_lead_time():
    conn = _FakeConnection()
    TimescaleForecastRepository(conn).save(_series())

    rows = conn.sink["rows"]
    assert len(rows) == 2
    assert conn.commits == 1
    assert "INSERT INTO forecast" in conn.sink["sql"]

    first = rows[0]
    # (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min,
    #  method, sv)
    assert first[1] == "tenant-1"
    assert first[2] == "site-1"
    assert first[3] == "pv"
    assert first[4] == "pv-physical"  # untagged series defaults to the baseline id
    assert first[5] == 1.5
    assert first[7] == 15   # 5:15 is 15 min after run_at 5:00
    assert rows[1][7] == 30  # 5:30 is 30 min after run_at
    assert first[8] == "clear_sky_v1:clear_sky"
    assert first[9] == 1     # schema_version


def test_save_empty_series_is_a_noop():
    conn = _FakeConnection()
    empty = ForecastSeries(
        kind=ForecastKind.LOAD,
        site_id="s",
        tenant_id="t",
        run_at=datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc),
        method="persistence",
        points=[],
    )
    TimescaleForecastRepository(conn).save(empty)
    assert conn.sink == {}
    assert conn.commits == 0


def test_save_takes_the_area_lock_first_and_writes_nothing_without_it():
    """UEMS AP-20 E10 = A: an area that is "beendet", deleted or locked by the
    Löschzug gets no forecast row - the transaction still ends (commit)."""
    conn = _FakeConnection(live=False)
    TimescaleForecastRepository(conn).save(_series())
    sql, params = conn.sink["sperre"]
    assert "FOR KEY SHARE OF t SKIP LOCKED" in sql
    assert params == ("tenant-1",)
    assert "rows" not in conn.sink
    assert conn.commits == 1

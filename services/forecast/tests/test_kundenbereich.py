"""UEMS AP-20 E10 = A: every forecast writer leaves a "beendet" area alone.

Shape checks against fake DB-API objects, so CI (no psycopg, no Docker) runs
them: every site list joins ``tenant t`` and filters ``beendet_am``, every
Timescale writer takes the area lock before its upsert and writes nothing
without it. The lock semantics against the Löschzug run against a real
Postgres in ``test_kundenbereich_db.py``.
"""

from __future__ import annotations

import sys
import types
from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_forecast import evaluate, weather_collect
from voltpilot_forecast.forecast_collect import load_sites
from voltpilot_forecast.kundenbereich import NICHT_BEENDET, lebenden_bereich_sperren
from voltpilot_forecast.openmeteo import WeatherForecast, WeatherPoint
from voltpilot_forecast.quality_repository import (
    AccuracyRecord,
    ModelState,
    PlanAccuracyRecord,
    TimescaleQualityRepository,
)
from voltpilot_forecast.weather_repository import TimescaleWeatherForecastRepository

T0 = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)


class _Cursor:
    def __init__(self, conn) -> None:
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._conn.statements.append(sql)

    def executemany(self, sql, rows):
        self._conn.statements.append(sql)

    def fetchone(self):
        return (1,) if self._conn.live else None

    def fetchall(self):
        return []


class _Conn:
    def __init__(self, live: bool = True) -> None:
        self.live = live
        self.statements: list[str] = []
        self.commits = 0

    def cursor(self):
        return _Cursor(self)

    def commit(self):
        self.commits += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_the_lock_is_a_key_share_on_a_live_tenant_row_that_never_waits():
    conn = _Conn(live=False)
    with conn.cursor() as cur:
        assert lebenden_bereich_sperren(cur, "t-1") is False
    (sql,) = conn.statements
    assert "FROM tenant t WHERE t.id = %s" in sql
    assert NICHT_BEENDET in sql
    assert sql.rstrip().endswith("FOR KEY SHARE OF t SKIP LOCKED")


def _writes(conn: _Conn) -> None:
    quality = TimescaleQualityRepository(conn)
    quality.upsert_model_state(ModelState("t-1", "s-1", "load-persistence", "load", "ready", T0))
    quality.upsert_accuracy(AccuracyRecord(date(2026, 9, 24), "t-1", "s-1", "m", "load", 0.1, 96))
    quality.upsert_plan_accuracy(PlanAccuracyRecord(date(2026, 9, 24), "t-1", "s-1", 96))
    TimescaleWeatherForecastRepository(conn).save(WeatherForecast(
        tenant_id="t-1", site_id="s-1", latitude=52.5, longitude=13.4, run_at=T0,
        points=(WeatherPoint(T0 + timedelta(hours=1), 18.0, 40.0, 300.0),),
    ))


@pytest.mark.parametrize("live", [True, False])
def test_quality_and_weather_writers_upsert_only_after_the_lock(live):
    conn = _Conn(live=live)
    _writes(conn)
    sperren = [s for s in conn.statements if "FOR KEY SHARE" in s]
    upserts = [s for s in conn.statements if "INSERT INTO" in s]
    assert len(sperren) == 4
    assert len(upserts) == (4 if live else 0)
    if live:  # the lock comes first in each transaction
        assert all("FOR KEY SHARE" in conn.statements[i] for i in (0, 2, 4, 6))
    assert conn.commits == 4  # every transaction ends, written or not


def test_every_site_list_a_cycle_writes_from_filters_ended_areas(monkeypatch):
    conn = _Conn()
    load_sites(conn)
    with conn.cursor() as cur:
        evaluate._sites(cur)

    fake_psycopg = types.ModuleType("psycopg")
    fake_psycopg.connect = lambda dsn: conn
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)
    weather_collect.load_sites_with_coordinates("dsn")

    assert len(conn.statements) == 3
    for sql in conn.statements:
        assert "JOIN tenant t ON t.id = s.tenant_id" in sql
        assert NICHT_BEENDET in sql

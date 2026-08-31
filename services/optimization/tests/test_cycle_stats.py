"""The cycle-duration monitoring write (§6.3): pure row shape, the psycopg
upsert, and the CLI wiring that records ONE stat per cycle - best-effort.

No database and no MQTT: the psycopg driver is faked, the engine cycle is
stubbed. What is proven is (a) the bind tuple, (b) that the repository upserts
and commits, and (c) that ``cli._run_one`` records the last cycle when
persistence is on, skips it under ``--no-persist``, and NEVER lets a monitoring
write failure sink the cycle.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from voltpilot_optimization import cli
from voltpilot_optimization.cycle_stats import (
    CycleStat,
    InMemoryCycleStatsRepository,
    TimescaleCycleStatsRepository,
    _UPSERT_SQL,
    stat_row,
)

FINISHED = datetime(2026, 8, 31, 12, 15, 0, tzinfo=timezone.utc)


def _stat(horizon: int | None = 192) -> CycleStat:
    return CycleStat(
        finished_at=FINISHED,
        duration_seconds=41.5,
        sites_planned=57,
        sites_skipped=3,
        horizon_slots=horizon,
    )


def test_stat_row_matches_the_upsert_placeholders():
    row = stat_row(_stat())
    # Five binds, in the order of the VALUES list (id is the literal 1).
    assert row == (FINISHED, 41.5, 57, 3, 192)
    assert _UPSERT_SQL.count("%s") == len(row)


def test_stat_row_keeps_an_unknown_horizon_as_null_never_zero():
    # A pre-feature optimizer run reports no horizon; the column must be NULL,
    # not a fabricated 0.
    assert stat_row(_stat(horizon=None))[4] is None


def test_stat_row_coerces_types_so_a_float_count_cannot_slip_through():
    stat = CycleStat(FINISHED, duration_seconds=1, sites_planned=2, sites_skipped=0)
    row = stat_row(stat)
    assert isinstance(row[1], float) and row[1] == 1.0
    assert isinstance(row[2], int) and isinstance(row[3], int)


def test_in_memory_repository_keeps_only_the_last():
    repo = InMemoryCycleStatsRepository()
    assert repo.last is None
    repo.record(_stat())
    later = CycleStat(FINISHED, 99.0, 60, 0, 96)
    repo.record(later)
    assert repo.last is later


class _FakeCursor:
    def __init__(self, log: list) -> None:
        self._log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self._log.append(("execute", " ".join(sql.split()), params))


class _FakeConnection:
    def __init__(self, log: list) -> None:
        self._log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor(self._log)

    def commit(self):
        self._log.append(("commit",))


def test_timescale_repository_upserts_and_commits(monkeypatch):
    log: list = []
    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _FakeConnection(log))
    )

    TimescaleCycleStatsRepository("postgresql://x").record(_stat())

    kinds = [entry[0] for entry in log]
    assert kinds == ["execute", "commit"]  # write THEN commit, exactly once
    _, sql, params = log[0]
    assert "INSERT INTO optimizer_cycle_stat" in sql
    assert "ON CONFLICT (id) DO UPDATE" in sql
    assert params == stat_row(_stat())


# --- CLI wiring: one stat per cycle, gated + best-effort -------------------


def _args(no_persist: bool) -> argparse.Namespace:
    return argparse.Namespace(
        no_persist=no_persist, no_publish=True, horizon_hours=None, log_level="INFO"
    )


@pytest.fixture()
def stub_cycle(monkeypatch):
    """A cycle that plans a few sites and skips one, without a DB or broker."""
    summary = SimpleNamespace(
        planned=[object(), object()],
        skipped=[(object(), "reason")],
        line=lambda: "stub",
    )
    monkeypatch.setattr(cli, "run_cycle", lambda *a, **k: summary)
    # The plan repository is constructed but never used (run_cycle is stubbed).
    monkeypatch.setattr(cli, "TimescaleScheduleRepository", lambda dsn: object())
    return summary


def test_run_one_records_exactly_one_cycle_stat_when_persisting(monkeypatch, stub_cycle):
    recorder = InMemoryCycleStatsRepository()
    monkeypatch.setattr(cli, "TimescaleCycleStatsRepository", lambda dsn: recorder)

    cli._run_one(_args(no_persist=False), {"POSTGRES_HOST": "h"})

    assert recorder.last is not None
    assert recorder.last.sites_planned == 2
    assert recorder.last.sites_skipped == 1
    assert recorder.last.horizon_slots == cli._resolve_horizon_slots(
        _args(no_persist=False), {}
    )
    assert recorder.last.duration_seconds >= 0.0


def test_no_persist_writes_no_cycle_stat(monkeypatch, stub_cycle):
    built = []
    monkeypatch.setattr(
        cli, "TimescaleCycleStatsRepository", lambda dsn: built.append(dsn)
    )

    cli._run_one(_args(no_persist=True), {"POSTGRES_HOST": "h"})

    # Under --no-persist the repository is never even constructed.
    assert built == []


def test_a_failing_cycle_stat_write_never_sinks_the_cycle(monkeypatch, stub_cycle):
    class _Boom:
        def record(self, stat):
            raise RuntimeError("db down")

    monkeypatch.setattr(cli, "TimescaleCycleStatsRepository", lambda dsn: _Boom())

    # Must NOT raise: a monitoring write is best-effort.
    cli._run_one(_args(no_persist=False), {"POSTGRES_HOST": "h"})

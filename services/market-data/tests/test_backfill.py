"""The backfill subcommand (the Ersparnis-Simulation's reference-year
prerequisite): chunked windows tile the range exactly, rows land in the
repository, re-running is a pure overwrite (idempotent upsert), and the CLI
wiring accepts --year / --from/--to. Fully offline against a window-aware
fake energy-charts."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_market_data import cli
from voltpilot_market_data.energy_charts import (
    EnergyChartsConfig,
    EnergyChartsDayAheadPriceSource,
)
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.persistence import InMemoryPriceRepository
from voltpilot_market_data.service import (
    BACKFILL_CHUNK_DAYS,
    backfill_range,
    delivery_day_window,
)


class WindowedFakeHttp:
    """Answers each energy-charts /price call with hourly slots covering
    exactly the requested [start, end) window."""

    def __init__(self):
        self.windows: list[tuple[datetime, datetime]] = []

    def get(self, url, params, timeout) -> HttpResponse:
        start = datetime.fromtimestamp(int(params["start"]), tz=timezone.utc)
        end = datetime.fromtimestamp(int(params["end"]), tz=timezone.utc)
        self.windows.append((start, end))
        seconds = []
        prices = []
        t = start
        while t < end:
            seconds.append(int(t.timestamp()))
            prices.append(80.0)
            t += timedelta(hours=1)
        body = json.dumps(
            {"unix_seconds": seconds, "price": prices, "unit": "EUR/MWh"}
        )
        return HttpResponse(200, body)


def make_source(http: WindowedFakeHttp) -> EnergyChartsDayAheadPriceSource:
    return EnergyChartsDayAheadPriceSource(EnergyChartsConfig(), http_client=http)


def test_backfill_year_tiles_the_range_without_overlap():
    http = WindowedFakeHttp()
    repo = InMemoryPriceRepository()
    results = backfill_range(
        make_source(http), "DE-LU", date(2025, 1, 1), date(2025, 12, 31), repo
    )
    # 365 days in 92-day chunks = 4 windows.
    assert len(results) == 4
    assert len(http.windows) == 4
    # Windows tile the local year exactly: each chunk starts where the
    # previous ended, first at Jan 1 00:00 local, last ends Jan 1 next year.
    year_start, _ = delivery_day_window(date(2025, 1, 1))
    _, year_end = delivery_day_window(date(2025, 12, 31))
    assert http.windows[0][0] == year_start
    assert http.windows[-1][1] == year_end
    for (prev_start, prev_end), (next_start, next_end) in zip(
        http.windows, http.windows[1:]
    ):
        assert next_start == prev_end
    # Every hour of the year written exactly once (8760 = no overlap, no hole).
    assert sum(r.rows_written for r in results) == 8760
    timestamps = [ts for _zone, _res, ts, _price in repo.rows]
    assert len(set(timestamps)) == 8760


def test_backfill_rerun_is_idempotent_upsert():
    http = WindowedFakeHttp()
    repo = InMemoryPriceRepository()
    backfill_range(make_source(http), "DE-LU", date(2025, 6, 1), date(2025, 6, 30), repo)
    first_keys = {(z, r, ts) for z, r, ts, _p in repo.rows}
    backfill_range(make_source(http), "DE-LU", date(2025, 6, 1), date(2025, 6, 30), repo)
    # The same (zone, resolution, ts) keys land again - the SQL layer's
    # ON CONFLICT upsert makes the rerun a pure overwrite.
    second_keys = {(z, r, ts) for z, r, ts, _p in repo.rows}
    assert second_keys == first_keys
    assert len(repo.rows) == 2 * len(first_keys)


def test_backfill_short_range_is_a_single_chunk():
    http = WindowedFakeHttp()
    results = backfill_range(
        make_source(http), "DE-LU", date(2025, 3, 1), date(2025, 3, 2), None
    )
    assert len(results) == 1
    assert results[0].rows_written == 0  # no repository = dry run
    assert BACKFILL_CHUNK_DAYS >= 2


def test_backfill_rejects_empty_range():
    http = WindowedFakeHttp()
    with pytest.raises(ValueError, match="empty"):
        backfill_range(make_source(http), "DE-LU", date(2025, 2, 1), date(2025, 1, 1), None)


def test_cli_backfill_year(monkeypatch, capsys):
    http = WindowedFakeHttp()
    monkeypatch.setattr(
        cli,
        "_build_source",
        lambda env, name: make_source(http),
    )
    assert cli.main(["backfill", "--zone", "DE-LU", "--year", "2025"]) == 0
    out = capsys.readouterr().out
    assert "backfill DE-LU 2025-01-01..2025-12-31" in out
    assert "4 chunks" in out


def test_cli_backfill_needs_a_range(monkeypatch):
    with pytest.raises(SystemExit, match="--year"):
        cli.main(["backfill", "--zone", "DE-LU"])

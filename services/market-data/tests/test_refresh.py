"""Coverage-aware refresh scheduling (fake clock, offline).

The captain-observed flaw: tomorrow's prices publish ~12:45 market time but the
serve loop refreshed on a fixed 6-h cadence, so an unlucky phase (12:50 ->
18:50) left the optimizer's horizon truncated at today's midnight for hours.
These tests pin the fix: fast-polling after the publication threshold until
tomorrow's coverage lands, bounded at midnight, baseline otherwise.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from voltpilot_market_data import cli
from voltpilot_market_data.model import (
    RESOLUTION_PT15M,
    PricePoint,
    PriceSeries,
)
from voltpilot_market_data.refresh import (
    CoverageAwareScheduler,
    RefreshPolicy,
    covered_slot_count,
    day_fully_covered,
)
from voltpilot_market_data.service import delivery_day_window
from voltpilot_market_data.source import PriceSourceUnavailable

BERLIN = ZoneInfo("Europe/Berlin")
BASELINE = 21600
FAST = 900


def berlin(y: int, m: int, d: int, hh: int, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=BERLIN)


def full_day_series(day: date, zone: str = "DE-LU") -> PriceSeries:
    """Dense PT15M series covering the whole market-local delivery day."""
    start, end = delivery_day_window(day)
    # Step in UTC: same-tzinfo aware arithmetic is wall-clock, which would
    # skip/duplicate the DST fold hour.
    start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    points = []
    slot_start = start
    while slot_start < end:
        points.append(
            PricePoint(
                start=slot_start,
                end=slot_start + timedelta(minutes=15),
                price_eur_mwh=80.0,
            )
        )
        slot_start += timedelta(minutes=15)
    return PriceSeries(
        zone=zone,
        resolution=RESOLUTION_PT15M,
        currency="EUR",
        points=tuple(points),
        source="test",
    )


def partial_series(day: date, keep: int) -> PriceSeries:
    full = full_day_series(day)
    return PriceSeries(
        zone=full.zone,
        resolution=full.resolution,
        currency=full.currency,
        points=full.points[:keep],
        source=full.source,
    )


def scheduler(**overrides) -> CoverageAwareScheduler:
    policy = RefreshPolicy(
        baseline_seconds=overrides.pop("baseline_seconds", BASELINE),
        fast_seconds=overrides.pop("fast_seconds", FAST),
        publication_hour=overrides.pop("publication_hour", 12.75),
    )
    return CoverageAwareScheduler(policy=policy, zone=overrides.pop("zone", "DE-LU"))


# ---------------------------------------------------------------- coverage --


def test_full_day_is_covered_and_counts_96_slots():
    day = date(2026, 7, 18)
    start, end = delivery_day_window(day)
    series = full_day_series(day)
    assert covered_slot_count(series, start, end) == 96
    assert day_fully_covered(series, start, end)


def test_partial_day_is_not_covered():
    day = date(2026, 7, 18)
    start, end = delivery_day_window(day)
    series = partial_series(day, keep=48)
    assert covered_slot_count(series, start, end) == 48
    assert not day_fully_covered(series, start, end)


def test_missing_series_is_not_covered():
    start, end = delivery_day_window(date(2026, 7, 18))
    assert covered_slot_count(None, start, end) == 0
    assert not day_fully_covered(None, start, end)


def test_coverage_is_window_scoped_so_another_days_slots_never_count():
    # A stored/cached series for TODAY must not read as coverage of tomorrow.
    today, tomorrow = date(2026, 7, 17), date(2026, 7, 18)
    start, end = delivery_day_window(tomorrow)
    assert covered_slot_count(full_day_series(today), start, end) == 0
    assert not day_fully_covered(full_day_series(today), start, end)


def test_dst_end_day_needs_100_slots():
    # 2026-10-25 is the EU clock change: a 25-hour Berlin day = 100 PT15M slots.
    day = date(2026, 10, 25)
    start, end = delivery_day_window(day)
    assert day_fully_covered(full_day_series(day), start, end)
    assert covered_slot_count(full_day_series(day), start, end) == 100
    assert not day_fully_covered(partial_series(day, keep=96), start, end)


# --------------------------------------------------------------- scheduler --


def test_unlucky_phase_converges_within_the_fast_interval(caplog):
    # The captain's case: refresh at 12:50 just missed the ~12:45 publication.
    sched = scheduler()
    with caplog.at_level(logging.INFO, logger="voltpilot.market_data.refresh"):
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 17, 12, 50), covered=False)
            == FAST
        )
        # 15 minutes later the prices are there -> back to baseline.
        assert (
            sched.next_delay_seconds(
                berlin(2026, 7, 17, 13, 5), covered=True, slots=96
            )
            == BASELINE
        )
    messages = [r.getMessage() for r in caplog.records]
    assert messages.count("refresh.fast_poll_start") == 1
    landed = [
        r for r in caplog.records if r.getMessage() == "refresh.coverage_landed"
    ]
    assert len(landed) == 1
    assert landed[0].context["slots"] == 96


def test_fast_poll_start_is_logged_once_across_repeated_fast_cycles(caplog):
    sched = scheduler()
    with caplog.at_level(logging.INFO, logger="voltpilot.market_data.refresh"):
        assert sched.next_delay_seconds(berlin(2026, 7, 17, 12, 50), covered=False) == FAST
        assert sched.next_delay_seconds(berlin(2026, 7, 17, 13, 5), covered=False) == FAST
    starts = [
        r for r in caplog.records if r.getMessage() == "refresh.fast_poll_start"
    ]
    assert len(starts) == 1


def test_already_covered_day_never_fast_polls(caplog):
    sched = scheduler()
    with caplog.at_level(logging.INFO, logger="voltpilot.market_data.refresh"):
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 17, 13, 5), covered=True)
            == BASELINE
        )
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 17, 19, 5), covered=True)
            == BASELINE
        )
    assert not caplog.records


def test_before_threshold_stays_on_baseline_when_far_out():
    # 06:00 -> the threshold is ~6h45m away, farther than the baseline: sleep
    # the full baseline.
    assert (
        scheduler().next_delay_seconds(berlin(2026, 7, 17, 6, 0), covered=False)
        == BASELINE
    )


def test_uncovered_pre_threshold_cycle_wakes_at_the_threshold():
    # The re-phased unlucky case: a 12:10 cycle must NOT sleep to 18:10; it
    # sleeps ~35 min so the next wake-up sits at the 12:45 threshold.
    delay = scheduler().next_delay_seconds(berlin(2026, 7, 17, 12, 10), covered=False)
    assert 35 * 60 <= delay <= 35 * 60 + 2


def test_midnight_bound_warns_once_and_falls_back_to_baseline(caplog):
    sched = scheduler()
    with caplog.at_level(logging.INFO, logger="voltpilot.market_data.refresh"):
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 17, 13, 0), covered=False)
            == FAST
        )
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 17, 23, 50), covered=False)
            == FAST
        )
        # Day rolls over without coverage: ONE loud warning, back to baseline.
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 18, 0, 5), covered=False)
            == BASELINE
        )
        # Later pre-threshold cycles never repeat the warning and never
        # fast-poll before the next day's threshold.
        next_delay = sched.next_delay_seconds(
            berlin(2026, 7, 18, 6, 5), covered=False
        )
        assert next_delay == BASELINE
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert warnings[0].getMessage() == "refresh.fast_poll_expired"


def test_fast_poll_resumes_after_the_next_days_threshold(caplog):
    sched = scheduler()
    with caplog.at_level(logging.INFO, logger="voltpilot.market_data.refresh"):
        sched.next_delay_seconds(berlin(2026, 7, 17, 13, 0), covered=False)
        sched.next_delay_seconds(berlin(2026, 7, 18, 0, 5), covered=False)
        # The NEXT day's publication window opens a fresh fast-poll run.
        assert (
            sched.next_delay_seconds(berlin(2026, 7, 18, 12, 50), covered=False)
            == FAST
        )
    starts = [
        r for r in caplog.records if r.getMessage() == "refresh.fast_poll_start"
    ]
    assert len(starts) == 2


# ------------------------------------------------------------------ config --


def test_policy_env_defaults_and_overrides():
    policy = RefreshPolicy.from_env({}, baseline_seconds=BASELINE)
    assert policy.fast_seconds == 900
    assert policy.publication_hour == 12.75
    policy = RefreshPolicy.from_env(
        {
            "MARKET_DATA_FAST_REFRESH_SECONDS": "300",
            "MARKET_DATA_PUBLICATION_HOUR": "13.5",
        },
        baseline_seconds=BASELINE,
    )
    assert policy.fast_seconds == 300
    assert policy.publication_hour == 13.5


@pytest.mark.parametrize(
    "env",
    [
        {"MARKET_DATA_FAST_REFRESH_SECONDS": "garbage"},
        {"MARKET_DATA_FAST_REFRESH_SECONDS": "0"},
        {"MARKET_DATA_PUBLICATION_HOUR": "24.5"},
        {"MARKET_DATA_PUBLICATION_HOUR": "later"},
    ],
)
def test_policy_env_garbage_fails_loudly(env):
    with pytest.raises(ValueError):
        RefreshPolicy.from_env(env, baseline_seconds=BASELINE)


# -------------------------------------------------------- serve loop (cli) --


class PublicationClockSource:
    """Fake source: tomorrow's window is only served once the fake clock
    passes ``publish_at``; every other window is always available."""

    def __init__(self, clock, publish_at: datetime) -> None:
        self._clock = clock
        self._publish_at = publish_at
        self.zones_fetched: list[str] = []

    def fetch_day_ahead_prices(self, zone, start, end):
        self.zones_fetched.append(zone)
        day = start.astimezone(BERLIN).date()
        today = self._clock().astimezone(BERLIN).date()
        if day > today and self._clock() < self._publish_at:
            raise PriceSourceUnavailable("tomorrow not yet published")
        series = full_day_series(day, zone=zone)
        return series


def _run_serve(monkeypatch, start_utc: datetime, publish_at: datetime, cycles: int):
    now = {"t": start_utc}
    delays: list[int] = []

    def fake_sleep(seconds):
        delays.append(seconds)
        now["t"] += timedelta(seconds=seconds)

    source = PublicationClockSource(lambda: now["t"], publish_at)
    for var in ("MARKET_DATA_PUBLICATION_HOUR", "MARKET_DATA_FAST_REFRESH_SECONDS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(cli, "_now_utc", lambda: now["t"])
    monkeypatch.setattr(cli.time, "sleep", fake_sleep)
    monkeypatch.setattr(cli, "_build_source", lambda env, name: source)
    rc = cli.main(
        [
            "serve",
            "--zone",
            "DE-LU",
            "--interval-seconds",
            str(BASELINE),
            "--max-cycles",
            str(cycles),
        ]
    )
    assert rc == 0
    return delays, source


def test_serve_fast_polls_until_tomorrow_lands(monkeypatch, capsys):
    # 12:50 Berlin (CEST = UTC+2) start; publication at 13:00 Berlin. The
    # unlucky phase that used to wait until 18:50 now converges at 13:05.
    delays, source = _run_serve(
        monkeypatch,
        start_utc=datetime(2026, 7, 17, 10, 50, tzinfo=timezone.utc),
        publish_at=datetime(2026, 7, 17, 11, 0, tzinfo=timezone.utc),
        cycles=2,
    )
    assert delays == [FAST]
    out = capsys.readouterr().out
    # Cycle 2 (13:05 Berlin) printed tomorrow's freshly published day.
    assert "2026-07-18 96 slots" in out
    assert all(zone == "DE-LU" for zone in source.zones_fetched)


def test_serve_stays_on_baseline_when_tomorrow_is_already_covered(monkeypatch):
    delays, _ = _run_serve(
        monkeypatch,
        start_utc=datetime(2026, 7, 17, 12, 30, tzinfo=timezone.utc),  # 14:30 local
        publish_at=datetime(2026, 7, 17, 10, 45, tzinfo=timezone.utc),
        cycles=2,
    )
    assert delays == [BASELINE]

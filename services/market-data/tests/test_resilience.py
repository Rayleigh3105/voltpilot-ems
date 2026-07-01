"""Retry / circuit-breaker / cache behaviour with deterministic fakes.

Clock and sleep are injected so there is zero real waiting and no wall-clock
flakiness. No network, no live ENTSO-E.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from voltpilot_market_data.model import PricePoint, PriceSeries
from voltpilot_market_data.resilience import (
    CircuitBreakerPolicy,
    ResilientPriceSource,
    RetryPolicy,
)
from voltpilot_market_data.source import (
    DayAheadPriceSource,
    PriceSourceError,
    PriceSourceUnavailable,
)

WINDOW = (
    datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc),
    datetime(2026, 7, 2, 22, 0, tzinfo=timezone.utc),
)


def _series(zone: str, price: float) -> PriceSeries:
    start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    return PriceSeries(
        zone=zone,
        resolution="PT60M",
        currency="EUR",
        points=(
            PricePoint(start, start.replace(hour=23), price),
        ),
    )


class ScriptedSource(DayAheadPriceSource):
    """Returns/raises according to a scripted list, one item per call."""

    def __init__(self, script):
        self._script = list(script)
        self.calls = 0

    def fetch_day_ahead_prices(self, zone, start, end):
        self.calls += 1
        outcome = self._script.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


def _wrap(source, clock, **kw):
    return ResilientPriceSource(
        delegate=source, clock=clock.now, sleep=clock.sleep, **kw
    )


def test_success_populates_cache():
    clock = FakeClock()
    src = ScriptedSource([_series("DE-LU", 100.0)])
    res = _wrap(src, clock)

    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [100.0]
    assert res.cached("DE-LU", WINDOW[0]).prices() == [100.0]


def test_retry_with_backoff_then_success():
    clock = FakeClock()
    src = ScriptedSource(
        [PriceSourceUnavailable("x"), PriceSourceUnavailable("x"), _series("DE-LU", 50.0)]
    )
    res = _wrap(
        src, clock,
        retry=RetryPolicy(max_attempts=3, base_delay_seconds=1.0),
        breaker=CircuitBreakerPolicy(failure_threshold=5),
    )

    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [50.0]
    assert src.calls == 3
    # Exponential backoff between the three attempts: 1s then 2s.
    assert clock.sleeps == [1.0, 2.0]


def test_falls_back_to_cache_on_failure():
    clock = FakeClock()
    src = ScriptedSource([_series("DE-LU", 77.0), PriceSourceUnavailable("down")])
    res = _wrap(
        src, clock,
        retry=RetryPolicy(max_attempts=1),
        breaker=CircuitBreakerPolicy(failure_threshold=5),
    )

    first = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert first.prices() == [77.0]
    # Second call fails upstream but returns the last-good cached series.
    second = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert second.prices() == [77.0]


def test_failure_without_cache_raises():
    clock = FakeClock()
    src = ScriptedSource([PriceSourceUnavailable("down")])
    res = _wrap(src, clock, retry=RetryPolicy(max_attempts=1))
    with pytest.raises(PriceSourceUnavailable):
        res.fetch_day_ahead_prices("DE-LU", *WINDOW)


def test_circuit_breaker_opens_and_short_circuits():
    clock = FakeClock()
    # Prime cache, then a run of failures to trip the breaker.
    src = ScriptedSource(
        [
            _series("DE-LU", 60.0),
            PriceSourceUnavailable("f1"),
            PriceSourceUnavailable("f2"),
            PriceSourceUnavailable("f3"),
        ]
    )
    res = _wrap(
        src, clock,
        retry=RetryPolicy(max_attempts=1),
        breaker=CircuitBreakerPolicy(failure_threshold=3, cooldown_seconds=60),
    )

    res.fetch_day_ahead_prices("DE-LU", *WINDOW)  # success, primes cache
    for _ in range(3):
        res.fetch_day_ahead_prices("DE-LU", *WINDOW)  # 3 failures -> open

    calls_before = src.calls
    # Breaker now open: this call must NOT hit the delegate, serve cache instead.
    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [60.0]
    assert src.calls == calls_before  # short-circuited


def test_circuit_breaker_half_opens_after_cooldown():
    clock = FakeClock()
    src = ScriptedSource(
        [
            PriceSourceUnavailable("f1"),
            PriceSourceUnavailable("f2"),
            _series("DE-LU", 42.0),  # recovery after cooldown
        ]
    )
    res = _wrap(
        src, clock,
        retry=RetryPolicy(max_attempts=1),
        breaker=CircuitBreakerPolicy(failure_threshold=2, cooldown_seconds=60),
    )

    # Two failures, no cache -> raise, and breaker opens.
    for _ in range(2):
        with pytest.raises(PriceSourceUnavailable):
            res.fetch_day_ahead_prices("DE-LU", *WINDOW)

    # Advance past cooldown; breaker half-opens and the trial call succeeds.
    clock.t += 61
    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [42.0]


def test_non_retryable_error_does_not_retry_but_uses_cache():
    clock = FakeClock()
    src = ScriptedSource([_series("DE-LU", 30.0), PriceSourceError("bad token")])
    res = _wrap(
        src, clock,
        retry=RetryPolicy(max_attempts=3),
        breaker=CircuitBreakerPolicy(failure_threshold=5),
    )
    res.fetch_day_ahead_prices("DE-LU", *WINDOW)  # prime cache
    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)  # error -> cache
    assert out.prices() == [30.0]
    # Non-retryable: only one extra delegate call, no backoff sleeps.
    assert src.calls == 2
    assert clock.sleeps == []


def test_prime_cache_seeds_from_external_source():
    clock = FakeClock()
    src = ScriptedSource([PriceSourceUnavailable("cold start")])
    res = _wrap(src, clock, retry=RetryPolicy(max_attempts=1))
    res.prime_cache(_series("DE-LU", 12.5))  # e.g. last-good row from the DB
    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [12.5]


def _series_for(zone: str, start: datetime, price: float) -> PriceSeries:
    return PriceSeries(
        zone=zone,
        resolution="PT60M",
        currency="EUR",
        points=(PricePoint(start, start + timedelta(hours=1), price),),
    )


def test_cache_key_is_window_scoped_never_serves_another_day():
    clock = FakeClock()
    # Cache holds only the previous day's window; today's fetch fails upstream.
    src = ScriptedSource([PriceSourceUnavailable("down")])
    res = _wrap(src, clock, retry=RetryPolicy(max_attempts=1))

    other_day_start = datetime(2026, 6, 30, 22, 0, tzinfo=timezone.utc)
    res.prime_cache(_series_for("DE-LU", other_day_start, 99.0))

    # A primed entry for a different day must NOT satisfy today's window.
    with pytest.raises(PriceSourceUnavailable):
        res.fetch_day_ahead_prices("DE-LU", *WINDOW)


def test_cache_key_serves_same_window_after_priming():
    clock = FakeClock()
    src = ScriptedSource([PriceSourceUnavailable("down")])
    res = _wrap(src, clock, retry=RetryPolicy(max_attempts=1))

    # Primed with the exact window we then request -> served from cache.
    res.prime_cache(_series_for("DE-LU", WINDOW[0], 88.0))
    out = res.fetch_day_ahead_prices("DE-LU", *WINDOW)
    assert out.prices() == [88.0]


def test_cache_hit_across_utc_and_market_local_offset_representations():
    clock = FakeClock()
    src = ScriptedSource([PriceSourceUnavailable("down")])
    res = _wrap(src, clock, retry=RetryPolicy(max_attempts=1))

    # Priming path: the DB reconstructs series.start in UTC (timestamptz).
    utc_start = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
    res.prime_cache(_series_for("DE-LU", utc_start, 55.0))

    # Fetch path: the market-local delivery-day window carries a +02:00 offset
    # for the *same instant*. It must resolve to the same primed entry.
    market_local_start = datetime(
        2026, 7, 2, 0, 0, tzinfo=timezone(timedelta(hours=2))
    )
    market_local_end = market_local_start + timedelta(hours=24)
    assert market_local_start == utc_start  # same instant, different offset

    out = res.fetch_day_ahead_prices("DE-LU", market_local_start, market_local_end)
    assert out.prices() == [55.0]

"""Resilience wrapper the optimizer actually depends on.

``ResilientPriceSource`` decorates any :class:`DayAheadPriceSource` with:

- **Retry with exponential backoff** on availability failures.
- A **circuit breaker**: after N consecutive failures the circuit opens and
  calls short-circuit to the cache for a cooldown window, sparing the upstream.
- A **last-good cache** per (zone, delivery-day window): on failure (or while
  the breaker is open) the last successful series for *that same window* is
  returned so the optimizer always gets a usable cost vector (architecture
  section 13: "Caching, Retry/Circuit-Breaker") without ever serving a
  different day's prices.

Time and sleep are injected (``clock``/``sleep``) so backoff and breaker
timing are deterministic under test - no real waiting, no wall-clock flakiness.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from voltpilot_market_data.model import PriceSeries
from voltpilot_market_data.source import (
    DayAheadPriceSource,
    PriceSourceError,
    PriceSourceUnavailable,
)

logger = logging.getLogger("voltpilot.market_data.resilience")


@dataclass
class RetryPolicy:
    max_attempts: int = 3
    base_delay_seconds: float = 1.0
    max_delay_seconds: float = 30.0

    def delay_for(self, attempt: int) -> float:
        """Exponential backoff for a 1-based attempt number."""
        delay = self.base_delay_seconds * (2 ** (attempt - 1))
        return min(delay, self.max_delay_seconds)


@dataclass
class CircuitBreakerPolicy:
    failure_threshold: int = 3
    cooldown_seconds: float = 60.0


@dataclass
class _CachedEntry:
    series: PriceSeries
    stored_at: float


@dataclass
class _BreakerState:
    consecutive_failures: int = 0
    opened_at: float | None = None


@dataclass
class ResilientPriceSource(DayAheadPriceSource):
    """Cache + retry + circuit-breaker decorator over a delegate source."""

    delegate: DayAheadPriceSource
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    breaker: CircuitBreakerPolicy = field(default_factory=CircuitBreakerPolicy)
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep

    _cache: dict[str, _CachedEntry] = field(default_factory=dict, init=False)
    _breaker_state: _BreakerState = field(
        default_factory=_BreakerState, init=False
    )

    # -- cache key ---------------------------------------------------------
    @staticmethod
    def _key(zone: str, start: datetime) -> str:
        # Window-aware: the delivery-day start distinguishes days so a primed
        # entry can never serve a different day's prices. Normalized to UTC so the
        # same instant keys identically regardless of the offset it carries.
        if start.tzinfo is not None:
            start = start.astimezone(timezone.utc)
        return f"{zone}|{start.isoformat()}"

    def cached(self, zone: str, start: datetime) -> PriceSeries | None:
        entry = self._cache.get(self._key(zone, start))
        return entry.series if entry else None

    def prime_cache(self, series: PriceSeries) -> None:
        """Seed the cache (e.g. from the DB's last-good row on startup)."""
        if series.start is None:
            return
        self._cache[self._key(series.zone, series.start)] = _CachedEntry(
            series=series, stored_at=self.clock()
        )

    # -- breaker -----------------------------------------------------------
    def _breaker_open(self) -> bool:
        state = self._breaker_state
        if state.opened_at is None:
            return False
        if self.clock() - state.opened_at >= self.breaker.cooldown_seconds:
            # Cooldown elapsed -> half-open: allow one trial call.
            logger.info("breaker.half_open")
            state.opened_at = None
            state.consecutive_failures = 0
            return False
        return True

    def _record_success(self) -> None:
        self._breaker_state = _BreakerState()

    def _record_failure(self) -> None:
        state = self._breaker_state
        state.consecutive_failures += 1
        if (
            state.opened_at is None
            and state.consecutive_failures >= self.breaker.failure_threshold
        ):
            state.opened_at = self.clock()
            logger.warning(
                "breaker.open",
                extra={"context": {"failures": state.consecutive_failures}},
            )

    # -- main --------------------------------------------------------------
    def fetch_day_ahead_prices(
        self, zone: str, start: datetime, end: datetime
    ) -> PriceSeries:
        if self._breaker_open():
            cached = self.cached(zone, start)
            logger.warning(
                "breaker.short_circuit",
                extra={"context": {"zone": zone, "served_from_cache": bool(cached)}},
            )
            if cached is not None:
                return cached
            raise PriceSourceUnavailable(
                f"circuit open for {zone} and no cached price series available"
            )

        last_error: Exception | None = None
        for attempt in range(1, self.retry.max_attempts + 1):
            try:
                series = self.delegate.fetch_day_ahead_prices(zone, start, end)
            except PriceSourceUnavailable as exc:
                last_error = exc
                self._record_failure()
                logger.warning(
                    "fetch.attempt_failed",
                    extra={"context": {
                        "zone": zone,
                        "attempt": attempt,
                        "max_attempts": self.retry.max_attempts,
                        "error": str(exc),
                    }},
                )
                if attempt < self.retry.max_attempts and not self._breaker_open():
                    self.sleep(self.retry.delay_for(attempt))
                    continue
                break
            except PriceSourceError as exc:
                # Non-availability errors (e.g. bad token, malformed doc) are not
                # retryable and count toward the breaker; fall through to cache.
                last_error = exc
                self._record_failure()
                logger.error(
                    "fetch.non_retryable",
                    extra={"context": {"zone": zone, "error": str(exc)}},
                )
                break
            else:
                self._record_success()
                self._cache[self._key(zone, start)] = _CachedEntry(
                    series=series, stored_at=self.clock()
                )
                return series

        # Every path exhausted - serve last-good if we have it.
        cached = self.cached(zone, start)
        if cached is not None:
            logger.warning(
                "fetch.served_stale_cache",
                extra={"context": {"zone": zone, "error": str(last_error)}},
            )
            return cached
        assert last_error is not None
        raise last_error

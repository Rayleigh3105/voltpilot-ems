"""Coverage-aware refresh scheduling for the ``serve`` loop.

The flaw this fixes (captain-observed 2026-07-17): tomorrow's day-ahead prices
publish ~12:45 market time, but ``serve`` refreshed on a FIXED cadence
(``MARKET_DATA_REFRESH_SECONDS``, default 6 h). An unlucky phase (refresh at
12:50 -> next at 18:50) missed the publication by hours, and every 15-min
optimizer replan in between truncated its horizon at the priced-coverage end
(today 24:00) - the Fahrplan ended at midnight although tomorrow's prices had
long been public. The optimizer needs no change (it replans every 15 min and
extends automatically once prices exist); the fix is entirely in WHEN the serve
loop refreshes.

Policy implemented by :class:`CoverageAwareScheduler` (pure decision logic, fake
clock under test - the ``now`` an aware datetime the caller passes in):

- Baseline cadence stays the configured interval (6 h default).
- When TOMORROW's market-local (Europe/Berlin) delivery day is NOT fully
  covered for the served zone and local time is past the publication threshold
  (``MARKET_DATA_PUBLICATION_HOUR``, default 12.75 = 12:45), poll every
  ``MARKET_DATA_FAST_REFRESH_SECONDS`` (default 900 = 15 min) until coverage
  lands, then fall back to baseline.
- The fast polling is bounded at local midnight: if tomorrow never publishes,
  ONE loud warning is logged and the loop returns to baseline cadence (never
  hammers the source all night).
- Before the threshold an uncovered tomorrow caps the sleep so the next wake-up
  is AT the threshold (not up to 6 h past it) - otherwise the same unlucky
  phase would re-appear one baseline period later (cycle at 12:10 -> 18:10).

Coverage is count/period-based over the series the cycle just fetched for
tomorrow's window (:func:`day_fully_covered`): the serve loop fetches through
the resilient source, which serves the DB-primed last-good cache when the
upstream fails, so a covered day stays covered across restarts and outages
without a second repository query path. The check is zone-scoped by
construction - the series IS the served zone's fetch result.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from voltpilot_market_data.model import PriceSeries, resolution_minutes
from voltpilot_market_data.service import MARKET_TZ

logger = logging.getLogger("voltpilot.market_data.refresh")

# EPEX day-ahead results publish ~12:45 market time; energy-charts mirrors them
# shortly after. 12.75 = 12:45 local as a decimal hour.
DEFAULT_PUBLICATION_HOUR = 12.75
DEFAULT_FAST_REFRESH_SECONDS = 900


@dataclass(frozen=True)
class RefreshPolicy:
    """Cadence configuration for the serve loop, normally built from the env."""

    baseline_seconds: int
    fast_seconds: int = DEFAULT_FAST_REFRESH_SECONDS
    publication_hour: float = DEFAULT_PUBLICATION_HOUR
    tz: ZoneInfo = field(default_factory=lambda: MARKET_TZ)

    @classmethod
    def from_env(
        cls, env: dict[str, str] | None, baseline_seconds: int
    ) -> "RefreshPolicy":
        env = dict(os.environ) if env is None else env
        try:
            fast_seconds = int(
                env.get(
                    "MARKET_DATA_FAST_REFRESH_SECONDS",
                    str(DEFAULT_FAST_REFRESH_SECONDS),
                )
            )
            publication_hour = float(
                env.get(
                    "MARKET_DATA_PUBLICATION_HOUR", str(DEFAULT_PUBLICATION_HOUR)
                )
            )
        except ValueError as exc:
            raise ValueError(
                "invalid MARKET_DATA_FAST_REFRESH_SECONDS / "
                f"MARKET_DATA_PUBLICATION_HOUR: {exc}"
            ) from exc
        if fast_seconds <= 0:
            raise ValueError(
                f"MARKET_DATA_FAST_REFRESH_SECONDS must be > 0, got {fast_seconds}"
            )
        if not 0.0 <= publication_hour < 24.0:
            raise ValueError(
                f"MARKET_DATA_PUBLICATION_HOUR must be in [0, 24), got {publication_hour}"
            )
        return cls(
            baseline_seconds=baseline_seconds,
            fast_seconds=fast_seconds,
            publication_hour=publication_hour,
        )


def covered_slot_count(
    series: PriceSeries | None, start: datetime, end: datetime
) -> int:
    """Slots of ``series`` whose start lies within ``[start, end)``."""
    if series is None:
        return 0
    return sum(1 for point in series.points if start <= point.start < end)


def day_fully_covered(
    series: PriceSeries | None, start: datetime, end: datetime
) -> bool:
    """Whether ``series`` covers the whole ``[start, end)`` delivery window.

    Count/period-based: the in-window slot count times the series' slot width
    must span the window. Slot starts are distinct within a series, so the
    product can only reach the window length when there is no gap. DST days
    (23/25 local hours) fall out correctly because the window bounds are
    market-local midnights.
    """
    if series is None or not series.points:
        return False
    slot = timedelta(minutes=resolution_minutes(series.resolution))
    # Same-tzinfo aware subtraction is WALL-CLOCK in Python (a 25-hour DST day
    # would read as 24 h), so measure the window in UTC for the absolute span.
    window = end.astimezone(timezone.utc) - start.astimezone(timezone.utc)
    return covered_slot_count(series, start, end) * slot >= window


class CoverageAwareScheduler:
    """Decides the serve loop's next sleep from tomorrow's price coverage.

    Stateful only for honest logging + the midnight bound: it remembers the
    local day on which fast polling started so entering fast-poll mode logs
    once, coverage landing logs once (with the slot count), and a day rollover
    without coverage warns once instead of polling all night.
    """

    def __init__(self, policy: RefreshPolicy, zone: str) -> None:
        self._policy = policy
        self._zone = zone
        self._fast_since: date | None = None

    def next_delay_seconds(self, now: datetime, covered: bool, slots: int = 0) -> int:
        """Next sleep in seconds; ``now`` must be timezone-aware.

        ``covered``/``slots`` describe tomorrow's delivery window for the
        served zone (see :func:`day_fully_covered`).
        """
        local = now.astimezone(self._policy.tz)
        today = local.date()
        local_hour = local.hour + local.minute / 60 + local.second / 3600
        past_threshold = local_hour >= self._policy.publication_hour

        if self._fast_since is not None:
            if covered:
                logger.info(
                    "refresh.coverage_landed",
                    extra={
                        "context": {
                            "zone": self._zone,
                            "slots": slots,
                            "message": "tomorrow's prices landed, back to "
                            "baseline cadence",
                        }
                    },
                )
                self._fast_since = None
                return self._policy.baseline_seconds
            if today != self._fast_since:
                logger.warning(
                    "refresh.fast_poll_expired",
                    extra={
                        "context": {
                            "zone": self._zone,
                            "since": self._fast_since.isoformat(),
                            "message": "tomorrow's prices never published "
                            "before midnight; falling back to baseline cadence",
                        }
                    },
                )
                self._fast_since = None
                return self._policy.baseline_seconds
            return self._policy.fast_seconds

        if not covered:
            if past_threshold:
                self._fast_since = today
                logger.info(
                    "refresh.fast_poll_start",
                    extra={
                        "context": {
                            "zone": self._zone,
                            "publication_hour": self._policy.publication_hour,
                            "fast_seconds": self._policy.fast_seconds,
                            "message": "tomorrow not covered after the "
                            "publication threshold, polling until it lands",
                        }
                    },
                )
                return self._policy.fast_seconds
            # Uncovered but before the threshold: never sleep PAST the
            # threshold, or an unlucky baseline phase (e.g. 12:10 -> 18:10)
            # would still miss the publication by hours.
            until_threshold = int(
                (self._policy.publication_hour - local_hour) * 3600
            ) + 1
            return min(self._policy.baseline_seconds, max(until_threshold, 1))

        return self._policy.baseline_seconds

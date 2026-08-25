"""Pure schedule-cadence helpers."""

from datetime import datetime, timezone


def aligned_delay_seconds(now: datetime, interval_seconds: int) -> float:
    """For the 15-minute base cadence, sleep to the next UTC quarter-hour."""
    if interval_seconds != 900:
        return float(interval_seconds)
    timestamp = now.astimezone(timezone.utc).timestamp()
    remainder = timestamp % 900
    return 900.0 if remainder == 0 else 900.0 - remainder

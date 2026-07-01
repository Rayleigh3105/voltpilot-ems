"""Load forecast - baseline, no ML (architecture section 12).

v1 load forecasting is a persistence/profile baseline. Both methods sit behind
:class:`LoadForecaster` so the later XGBoost/LightGBM method (quantile objective
for uncertainty bands - architecture section 12.2/12.3) replaces them without any
change to the optimizer or the forecast service.

Two baselines are provided:

- :class:`SeasonalPersistenceLoadForecaster` - "the load in this slot equals the
  load in the same slot one profile-period (default 1 day) ago". The classic
  persistence baseline; strong for short horizons, needs little history.
- :class:`ProfileLoadForecaster` - a typical daily profile per weekday-type
  (weekday vs weekend), averaged over recent history. Captures the daily shape
  and generalises across the whole 24-48h horizon.

Both fall back to a flat last-value forecast when history is too sparse, so they
always return a full series.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Sequence

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    Horizon,
    Observation,
    ensure_utc,
    floor_to_slot,
)


class LoadForecaster(ABC):
    """Interface for site load forecasting over the optimization horizon.

    The single seam architecture section 12 asks for: swap the implementation
    (persistence -> profile -> future ML) and every consumer is unaffected.
    """

    method: str = "load"

    @abstractmethod
    def forecast(
        self,
        site_id: str,
        tenant_id: str,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime,
    ) -> ForecastSeries:
        raise NotImplementedError


def _sorted_history(history: Sequence[Observation]) -> list[Observation]:
    """History ascending by timestamp, so 'later obs wins' and history[-1] hold
    regardless of the order the caller supplied."""
    return sorted(history, key=lambda obs: ensure_utc(obs.timestamp))


def _slot_of_day(ts: datetime, slot_minutes: int) -> int:
    """Index of the slot within the day (0 .. slots_per_day-1), UTC-based."""
    ts = ensure_utc(ts)
    minutes = ts.hour * 60 + ts.minute
    return minutes // slot_minutes


def _is_weekend(ts: datetime) -> bool:
    return ensure_utc(ts).weekday() >= 5  # Sat=5, Sun=6


def _flat_last_value(
    site_id: str,
    tenant_id: str,
    history: Sequence[Observation],
    horizon: Horizon,
    run_at: datetime,
    method: str,
) -> ForecastSeries:
    last = history[-1].value_kw if history else 0.0
    points = [ForecastPoint(ts, round(last, 4)) for ts in horizon.slot_starts(run_at)]
    return ForecastSeries(
        kind=ForecastKind.LOAD,
        site_id=site_id,
        tenant_id=tenant_id,
        run_at=run_at,
        method=method,
        points=points,
    )


class SeasonalPersistenceLoadForecaster(LoadForecaster):
    """Persistence baseline: repeat the value from one period ago per slot.

    For each future slot the forecast is the most recent observed value at the
    same slot-of-day (default period = 1 day). This preserves the daily shape
    with the minimal assumption "tomorrow looks like the recent same time of day".
    Falls back to flat last-value when the matching slot has no history.
    """

    method = "persistence"

    def __init__(self, period: timedelta = timedelta(days=1)) -> None:
        if period <= timedelta(0):
            raise ValueError("period must be positive")
        self._period = period

    def forecast(
        self,
        site_id: str,
        tenant_id: str,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime,
    ) -> ForecastSeries:
        if not history:
            return _flat_last_value(
                site_id, tenant_id, history, horizon, run_at, self.method
            )

        history = _sorted_history(history)
        # Index history by its slot boundary for exact same-slot lookup.
        by_slot: dict[datetime, float] = {}
        for obs in history:
            key = floor_to_slot(obs.timestamp, horizon.slot_minutes)
            by_slot[key] = obs.value_kw  # later obs wins (most recent)

        earliest = min(by_slot)
        last = history[-1].value_kw
        points: list[ForecastPoint] = []
        for ts in horizon.slot_starts(run_at):
            value = None
            # Step back in whole periods until we find a matching historical slot.
            probe = ts - self._period
            while probe >= earliest:
                key = floor_to_slot(probe, horizon.slot_minutes)
                if key in by_slot:
                    value = by_slot[key]
                    break
                probe -= self._period
            if value is None:
                value = last
            points.append(ForecastPoint(ts, round(value, 4)))

        return ForecastSeries(
            kind=ForecastKind.LOAD,
            site_id=site_id,
            tenant_id=tenant_id,
            run_at=run_at,
            method=self.method,
            points=points,
        )


class ProfileLoadForecaster(LoadForecaster):
    """Historical-profile baseline: a typical daily profile per weekday-type.

    Averages recent history into a profile keyed by (weekend?, slot-of-day), then
    projects it across the horizon. Captures the recurring daily load shape and
    the weekday/weekend difference typical of C&I and residential sites. Falls
    back per-slot to the all-days average, then to flat last-value.
    """

    method = "profile"

    def forecast(
        self,
        site_id: str,
        tenant_id: str,
        history: Sequence[Observation],
        horizon: Horizon,
        run_at: datetime,
    ) -> ForecastSeries:
        if not history:
            return _flat_last_value(
                site_id, tenant_id, history, horizon, run_at, self.method
            )

        history = _sorted_history(history)
        slot_minutes = horizon.slot_minutes
        # Accumulate sums/counts per (weekend, slot) and per slot (all days).
        keyed: dict[tuple[bool, int], list[float]] = defaultdict(list)
        per_slot: dict[int, list[float]] = defaultdict(list)
        for obs in history:
            slot = _slot_of_day(obs.timestamp, slot_minutes)
            keyed[(_is_weekend(obs.timestamp), slot)].append(obs.value_kw)
            per_slot[slot].append(obs.value_kw)

        def _avg(values: list[float]) -> float | None:
            return sum(values) / len(values) if values else None

        last = history[-1].value_kw
        points: list[ForecastPoint] = []
        for ts in horizon.slot_starts(run_at):
            slot = _slot_of_day(ts, slot_minutes)
            value = _avg(keyed.get((_is_weekend(ts), slot), []))
            if value is None:
                value = _avg(per_slot.get(slot, []))
            if value is None:
                value = last
            points.append(ForecastPoint(ts, round(value, 4)))

        return ForecastSeries(
            kind=ForecastKind.LOAD,
            site_id=site_id,
            tenant_id=tenant_id,
            run_at=run_at,
            method=self.method,
            points=points,
        )

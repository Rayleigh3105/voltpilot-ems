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

Both see the raw telemetry history ONLY through
:func:`voltpilot_forecast.domain.slot_means` - a forecast slot is a quarter-hour
MEAN POWER (the quantity the optimizer plans with), never one of the ~90-180 raw
samples that fall inside it. The aggregation lives here rather than in the two
SQL queries that fetch the history (``forecast_collect._telemetry_history`` and
the optimizer's ``inputs._load_history``) for three reasons: it is ONE place that
serves BOTH consumers (the collector's baselines and the optimizer's persistence
fallback in :mod:`voltpilot_optimization.fallback`) so the two can never drift;
the slot width belongs to :class:`~voltpilot_forecast.domain.Horizon`, not to a
hard-coded ``time_bucket('15 minutes')`` in the DB; and the ML challengers
already aggregate in Python (:func:`voltpilot_forecast.features.bucket_15min`,
now the same function), so the queries must keep returning raw samples.
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
    slot_means,
)


class LoadForecaster(ABC):
    """Interface for site load forecasting over the optimization horizon.

    The single seam architecture section 12 asks for: swap the implementation
    (persistence -> profile -> future ML) and every consumer is unaffected.
    ``model_id`` is the registry-level id every persisted prediction is tagged
    with (see :mod:`voltpilot_forecast.registry`).
    """

    method: str = "load"
    model_id: str = "load-persistence"

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
    model_id: str,
) -> ForecastSeries:
    by_slot = slot_means(history, horizon.slot_minutes)
    # The most recent SLOT MEAN, not the most recent raw sample (see module docstring).
    last = by_slot[max(by_slot)] if by_slot else 0.0
    points = [ForecastPoint(ts, round(last, 4)) for ts in horizon.slot_starts(run_at)]
    return ForecastSeries(
        kind=ForecastKind.LOAD,
        site_id=site_id,
        tenant_id=tenant_id,
        run_at=run_at,
        method=method,
        points=points,
        model=model_id,
    )


class SeasonalPersistenceLoadForecaster(LoadForecaster):
    """Persistence baseline: repeat the value from one period ago per slot.

    For each future slot the forecast is the MEAN of the observed samples in the
    most recent matching slot-of-day (default period = 1 day). This preserves the
    daily shape with the minimal assumption "tomorrow looks like the recent same
    time of day". Falls back to the most recent slot mean when the matching slot
    has no history.
    """

    method = "persistence"
    model_id = "load-persistence"

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
                site_id, tenant_id, history, horizon, run_at, self.method,
                self.model_id,
            )

        # Index history by its slot boundary for exact same-slot lookup. The
        # value of a slot is the MEAN of its samples, not the last one that
        # happened to be recorded in it (see the module docstring).
        by_slot = slot_means(history, horizon.slot_minutes)

        earliest = min(by_slot)
        last = by_slot[max(by_slot)]  # the most recent slot mean
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
            model=self.model_id,
        )


class ProfileLoadForecaster(LoadForecaster):
    """Historical-profile baseline: a typical daily profile per weekday-type.

    Averages recent history into a profile keyed by (weekend?, slot-of-day), then
    projects it across the horizon. Captures the recurring daily load shape and
    the weekday/weekend difference typical of C&I and residential sites. Falls
    back per-slot to the all-days average, then to flat last-value.
    """

    method = "profile"
    model_id = "load-profile"

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
                site_id, tenant_id, history, horizon, run_at, self.method,
                self.model_id,
            )

        slot_minutes = horizon.slot_minutes
        # Aggregate to quarter-hour means FIRST (module docstring), then average
        # those per (weekend, slot-of-day). Averaging the raw samples instead
        # would weight each historical day by how many samples it happened to
        # deliver - an outage day would count less than a chatty one.
        by_slot = slot_means(history, slot_minutes)
        keyed: dict[tuple[bool, int], list[float]] = defaultdict(list)
        per_slot: dict[int, list[float]] = defaultdict(list)
        for slot_start, value in by_slot.items():
            slot = _slot_of_day(slot_start, slot_minutes)
            keyed[(_is_weekend(slot_start), slot)].append(value)
            per_slot[slot].append(value)

        def _avg(values: list[float]) -> float | None:
            return sum(values) / len(values) if values else None

        last = by_slot[max(by_slot)]  # the most recent slot mean
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
            model=self.model_id,
        )

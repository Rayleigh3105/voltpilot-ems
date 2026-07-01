"""Tests for the ForecastService façade, repository seam and domain grid."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from voltpilot_forecast.domain import (
    ForecastKind,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
    floor_to_slot,
)
from voltpilot_forecast.repository import InMemoryForecastRepository
from voltpilot_forecast.service import ForecastService

BERLIN = GeoLocation(latitude=52.52, longitude=13.405)


def _config() -> SiteForecastConfig:
    return SiteForecastConfig(
        tenant_id="tenant-1",
        site_id="site-1",
        location=BERLIN,
        plant=PlantSpec(capacity_kwp=20.0),
    )


def _history(run_at: datetime) -> list[Observation]:
    step = timedelta(minutes=15)
    out = []
    ts = run_at - timedelta(days=2)
    while ts < run_at:
        out.append(Observation(ts, 12.0))
        ts += step
    return out


def test_forecast_site_produces_both_kinds_with_shared_run_at():
    run_at = datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc)
    service = ForecastService()
    result = service.forecast_site(_config(), _history(run_at), Horizon.hours(24), run_at)

    assert set(result) == {ForecastKind.LOAD, ForecastKind.PV}
    assert result[ForecastKind.LOAD].run_at == result[ForecastKind.PV].run_at == run_at
    assert len(result[ForecastKind.LOAD]) == len(result[ForecastKind.PV]) == 96


def test_service_persists_into_repository_and_reads_latest():
    run_at = datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc)
    repo = InMemoryForecastRepository()
    service = ForecastService(repository=repo)
    service.forecast_site(_config(), _history(run_at), Horizon.hours(24), run_at)

    latest_load = repo.latest("site-1", ForecastKind.LOAD)
    latest_pv = repo.latest("site-1", ForecastKind.PV)
    assert latest_load is not None and len(latest_load) == 96
    assert latest_pv is not None and len(latest_pv) == 96
    assert repo.latest("unknown-site", ForecastKind.PV) is None


def test_repository_keeps_the_newest_run():
    repo = InMemoryForecastRepository()
    service = ForecastService(repository=repo)
    config = _config()
    older = datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc)
    newer = older + timedelta(hours=1)

    service.forecast_pv(config, Horizon.hours(24), older)
    service.forecast_pv(config, Horizon.hours(24), newer)
    latest = repo.latest("site-1", ForecastKind.PV)
    assert latest is not None
    assert latest.run_at == newer


def test_horizon_slot_starts_align_to_grid_and_are_future():
    run_at = datetime(2026, 6, 21, 5, 7, 30, tzinfo=timezone.utc)  # mid-slot
    starts = Horizon.hours(1).slot_starts(run_at)
    assert len(starts) == 4
    # First slot is the next boundary after the fl. of run_at.
    assert starts[0] == datetime(2026, 6, 21, 5, 15, tzinfo=timezone.utc)
    assert all(s > run_at for s in starts)
    # Strictly increasing by exactly one slot.
    for prev, nxt in zip(starts, starts[1:]):
        assert nxt - prev == timedelta(minutes=15)


def test_floor_to_slot_handles_naive_as_utc():
    naive = datetime(2026, 6, 21, 5, 7, 30)
    floored = floor_to_slot(naive, 15)
    assert floored.tzinfo is timezone.utc
    assert floored == datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc)


def test_horizon_validates_inputs():
    with pytest.raises(ValueError):
        Horizon(slots=0)
    with pytest.raises(ValueError):
        Horizon(slots=4, slot_minutes=0)

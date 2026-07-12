"""Slot-grid unit tests (B1 regression).

The edge activates a plan slot only once ``now >= start`` (plan.go
``ActiveSetpoint``), so the horizon MUST begin with the slot in progress at
``now`` - a grid starting at the NEXT boundary left the edge with no active
slot (self-consumption fallback) from every publish until the boundary.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from voltpilot_optimization.domain import SLOT_MINUTES, horizon_slot_starts


def test_first_slot_covers_now():
    # B1: mid-slot publish (12:03) -> the grid starts at 12:00, not 12:15.
    now = datetime(2026, 7, 1, 12, 3, 27, tzinfo=timezone.utc)
    starts = horizon_slot_starts(now, 96)
    assert starts[0] == datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    assert starts[0] <= now < starts[0] + timedelta(minutes=SLOT_MINUTES)


def test_on_boundary_now_is_its_own_first_slot():
    now = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    starts = horizon_slot_starts(now, 4)
    assert starts[0] == now


def test_grid_is_contiguous_15_min_slots():
    now = datetime(2026, 7, 1, 23, 59, 59, tzinfo=timezone.utc)
    starts = horizon_slot_starts(now, 96)
    assert len(starts) == 96
    deltas = {b - a for a, b in zip(starts, starts[1:])}
    assert deltas == {timedelta(minutes=SLOT_MINUTES)}

from datetime import datetime, timezone

import pytest

from voltpilot_optimization.cadence import aligned_delay_seconds
from voltpilot_optimization.load_nowcast import (
    apply_load_nowcast,
    apply_uncertainty_reserve,
    ewma_residual,
)


def test_twenty_kw_residual_is_additive_and_fades_to_zero_over_two_hours():
    residual = ewma_residual([30.0, 30.0, 30.0], 10.0)
    assert residual == pytest.approx(20.0)
    out = apply_load_nowcast([10.0] * 12, residual)
    assert out[0] == pytest.approx(30.0)
    assert out[4] == pytest.approx(20.0)
    assert out[8:] == [10.0] * 4


def test_no_or_invalid_evidence_never_fabricates_a_nowcast():
    assert ewma_residual([float("nan"), -1], 10) is None
    assert apply_load_nowcast([4.0, 5.0], None) == [4.0, 5.0]


def test_uncertainty_reserve_is_upward_bounded_and_expires():
    out = apply_uncertainty_reserve([100.0] * 10)
    assert out[0] == 102.0
    assert out[4] == 101.0
    assert out[8:] == [100.0, 100.0]


def test_base_cadence_aligns_to_quarter_hour_boundaries():
    now = datetime(2026, 8, 25, 10, 7, 0, tzinfo=timezone.utc)
    assert aligned_delay_seconds(now, 900) == 480
    assert aligned_delay_seconds(now, 60) == 60

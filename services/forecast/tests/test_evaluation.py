"""Evaluation math: exact metrics on hand-computed cases + idempotent upserts."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from voltpilot_forecast.evaluation import (
    berlin_day_bounds,
    forecast_metrics,
    plan_economics,
    skill_vs_baseline,
)
from voltpilot_forecast.quality_repository import (
    AccuracyRecord,
    InMemoryQualityRepository,
    ModelState,
    PlanAccuracyRecord,
)

T0 = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)


def _slots(n: int) -> list[datetime]:
    return [T0 + i * timedelta(minutes=15) for i in range(n)]


def test_forecast_metrics_exact_values():
    slots = _slots(4)
    predictions = dict(zip(slots, [2.0, 3.0, 4.0, 5.0]))
    actuals = dict(zip(slots, [1.0, 3.0, 6.0, 4.0]))
    # errors: +1, 0, -2, +1 -> MAE = 1.0, bias = 0.0
    metrics = forecast_metrics(predictions, actuals)
    assert metrics.mae_kw == 1.0
    assert metrics.bias_kw == 0.0
    assert metrics.n_slots == 4
    # mean |actual| = 3.5 -> nMAE = 1/3.5 * 100 = 28.571 %
    assert metrics.nmae_pct == 28.571


def test_forecast_metrics_only_over_common_slots_and_none_when_disjoint():
    slots = _slots(3)
    predictions = {slots[0]: 5.0, slots[1]: 5.0}
    actuals = {slots[1]: 4.0, slots[2]: 4.0}
    metrics = forecast_metrics(predictions, actuals)
    assert metrics.n_slots == 1
    assert metrics.mae_kw == 1.0
    assert forecast_metrics({slots[0]: 1.0}, {slots[1]: 1.0}) is None


def test_nmae_is_null_on_all_zero_days():
    slots = _slots(2)
    metrics = forecast_metrics(
        {s: 0.5 for s in slots}, {s: 0.0 for s in slots}
    )
    assert metrics.nmae_pct is None  # PV at night: no fake percentages
    assert metrics.mae_kw == 0.5


def test_skill_score_semantics():
    assert skill_vs_baseline(0.5, 1.0) == 0.5     # halved the error
    assert skill_vs_baseline(1.0, 1.0) == 0.0     # equal
    assert skill_vs_baseline(2.0, 1.0) == -1.0    # twice as bad
    assert skill_vs_baseline(0.5, None) is None   # no baseline that day
    assert skill_vs_baseline(0.5, 0.0) is None    # nothing to beat


def test_berlin_day_bounds_cest_and_dst_transition():
    # Summer: Berlin = UTC+2.
    start, end = berlin_day_bounds(date(2026, 6, 15))
    assert start == datetime(2026, 6, 14, 22, 0, tzinfo=timezone.utc)
    assert end == datetime(2026, 6, 15, 22, 0, tzinfo=timezone.utc)
    # The October switch day is 25 hours long.
    start, end = berlin_day_bounds(date(2026, 10, 25))
    assert (end - start) == timedelta(hours=25)


def test_plan_economics_exact_and_only_comparable_slots():
    slots = _slots(3)
    planned = {
        slots[0]: (0.06, 0.10),  # (cost, baseline-cost)
        slots[1]: (0.02, 0.05),
        slots[2]: (0.99, 0.99),  # no actual for this slot -> excluded
    }
    actual_grid_kw = {slots[0]: 2.0, slots[1]: -4.0}
    prices = {slots[0]: 100.0, slots[1]: 200.0, slots[2]: 100.0}
    economics = plan_economics(planned, actual_grid_kw, prices)
    assert economics.n_slots == 2
    assert economics.planned_cost_eur == 0.08
    assert economics.baseline_cost_eur == 0.15
    # realized: 2*0.25*0.1 + (-4)*0.25*0.2 = 0.05 - 0.20 = -0.15 (export earns)
    assert economics.realized_cost_eur == -0.15
    assert plan_economics(planned, {}, prices) is None


def test_quality_repository_upserts_are_idempotent():
    repo = InMemoryQualityRepository()
    record = AccuracyRecord(
        day=date(2026, 7, 1), tenant_id="t", site_id="s", model="load-xgb",
        kind="load", mae_kw=0.4, n_slots=96, skill_vs_baseline=0.2,
    )
    repo.upsert_accuracy(record)
    repo.upsert_accuracy(record)  # re-running a day must not duplicate
    assert len(repo.accuracy) == 1

    updated = AccuracyRecord(
        day=date(2026, 7, 1), tenant_id="t", site_id="s", model="load-xgb",
        kind="load", mae_kw=0.3, n_slots=96, skill_vs_baseline=0.4,
    )
    repo.upsert_accuracy(updated)  # late telemetry -> overwrite, same key
    assert len(repo.accuracy) == 1
    assert repo.accuracy[("s", "load-xgb", date(2026, 7, 1))].mae_kw == 0.3

    plan = PlanAccuracyRecord(
        day=date(2026, 7, 1), tenant_id="t", site_id="s", n_slots=96,
        planned_cost_eur=1.0, baseline_cost_eur=1.5, realized_cost_eur=1.1,
    )
    repo.upsert_plan_accuracy(plan)
    repo.upsert_plan_accuracy(plan)
    assert len(repo.plan_accuracy) == 1

    state = ModelState(
        tenant_id="t", site_id="s", model="load-xgb", kind="load",
        status="collecting", days_collected=3, days_required=21, updated_at=T0,
    )
    repo.upsert_model_state(state)
    repo.upsert_model_state(state)
    assert len(repo.model_states) == 1

"""Forecast-vs-actual evaluation math (pure, dependency-free).

This is the measurement core of shadow-mode forecasting: per site x model x
Berlin day, how far were the predictions from what the telemetry actually
recorded - and was the challenger better than the baseline (the *skill
score*)? All functions here are pure so the math is unit-testable to the
digit; the DB glue lives in :mod:`voltpilot_forecast.evaluate`.

Metric definitions (documented once, mirrored in the ``forecast_accuracy``
DDL and shown plainly in the portal):

* **MAE (kW)** - mean absolute error over the day's evaluated 15-min slots.
  The headline number ("Ø Abweichung"), in the customer's physical unit.
* **nMAE (%)** - MAE normalized by the mean absolute actual, so sites of
  different size are comparable. NULL on all-zero days (e.g. PV in December
  darkness) rather than a division blow-up.
* **Bias (kW)** - mean signed error (forecast - actual): shows systematic
  over-/under-forecasting that MAE alone hides.
* **Skill vs baseline** - ``1 - mae_model / mae_baseline``; positive means the
  model beat the baseline that day, 0 means equal, negative means worse. NULL
  when the baseline's MAE is ~0 (nothing to beat) or the baseline is missing.

Which prediction counts: per slot, each model's FRESHEST prediction issued at
or before the slot start (``run_at <= time``) - exactly the value the
optimizer would have consumed had that model been active. Both the baseline
and the challengers re-predict every collector cycle, so the comparison is
lead-time-fair by construction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Mapping
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")

#: Below this baseline MAE (kW) the skill quotient is meaningless noise.
_SKILL_FLOOR_KW = 1e-9


@dataclass(frozen=True)
class Metrics:
    """Per-day error metrics of one model on one site."""

    mae_kw: float
    bias_kw: float
    n_slots: int
    nmae_pct: float | None


def berlin_day_bounds(day: date) -> tuple[datetime, datetime]:
    """UTC [start, end) of a Europe/Berlin calendar day.

    Built from LOCAL midnights (not "start + 24h"), so DST-transition days are
    correctly 23 or 25 hours long - the same convention as the api's Historie.
    """
    start = datetime(day.year, day.month, day.day, tzinfo=BERLIN)
    next_day = day + timedelta(days=1)
    end = datetime(next_day.year, next_day.month, next_day.day, tzinfo=BERLIN)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def forecast_metrics(
    predictions: Mapping[datetime, float],
    actuals: Mapping[datetime, float],
) -> Metrics | None:
    """Error metrics over the slots where BOTH a prediction and an actual exist.

    Returns ``None`` when there is no overlap (no dishonest zero-row).
    """
    slots = sorted(set(predictions) & set(actuals))
    if not slots:
        return None
    errors = [predictions[ts] - actuals[ts] for ts in slots]
    mae = sum(abs(e) for e in errors) / len(errors)
    bias = sum(errors) / len(errors)
    mean_abs_actual = sum(abs(actuals[ts]) for ts in slots) / len(slots)
    nmae_pct = (mae / mean_abs_actual * 100.0) if mean_abs_actual > 1e-9 else None
    return Metrics(
        mae_kw=round(mae, 4),
        bias_kw=round(bias, 4),
        n_slots=len(slots),
        nmae_pct=None if nmae_pct is None else round(nmae_pct, 3),
    )


def skill_vs_baseline(
    model_mae_kw: float, baseline_mae_kw: float | None
) -> float | None:
    """``1 - mae_model / mae_baseline`` (positive = model better), or ``None``.

    ``None`` when the baseline is missing or its MAE is ~0 - a quotient
    against (near-)zero would only produce noise, and "the baseline was
    already perfect" is not a meaningful thing to beat.
    """
    if baseline_mae_kw is None or baseline_mae_kw <= _SKILL_FLOOR_KW:
        return None
    return round(1.0 - model_mae_kw / baseline_mae_kw, 4)


@dataclass(frozen=True)
class PlanEconomics:
    """Daily plan-vs-actual cost summary for one site.

    Sums run over exactly the slots where the plan, the actual AND the price
    all exist, so the three totals are comparable like-for-like.
    """

    planned_cost_eur: float
    baseline_cost_eur: float
    realized_cost_eur: float
    n_slots: int


def plan_economics(
    planned: Mapping[datetime, tuple[float, float]],
    actual_grid_kw: Mapping[datetime, float],
    prices_eur_mwh: Mapping[datetime, float],
    slot_hours: float = 0.25,
) -> PlanEconomics | None:
    """Realized vs planned cost over the comparable slots.

    ``planned`` maps slot -> (cost_eur, baseline_cost_eur) from the persisted
    schedule (freshest run issued at or before the slot). ``actual_grid_kw``
    is the slot-mean SIGNED grid power from telemetry (+import/-export);
    realized slot cost = power * hours * price/1000, signed exactly like the
    optimizer's projected cost (import pays, export earns - the
    Direktvermarktung MVP assumption).
    """
    slots = sorted(set(planned) & set(actual_grid_kw) & set(prices_eur_mwh))
    if not slots:
        return None
    planned_sum = sum(planned[ts][0] for ts in slots)
    baseline_sum = sum(planned[ts][1] for ts in slots)
    realized = sum(
        actual_grid_kw[ts] * slot_hours * prices_eur_mwh[ts] / 1000.0 for ts in slots
    )
    return PlanEconomics(
        planned_cost_eur=round(planned_sum, 4),
        baseline_cost_eur=round(baseline_sum, 4),
        realized_cost_eur=round(realized, 4),
        n_slots=len(slots),
    )

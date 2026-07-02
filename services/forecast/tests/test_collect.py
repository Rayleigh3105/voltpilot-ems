"""Collector cycle over a fake DB: baselines always persist model-tagged, the
challengers self-gate with an honest recorded status, and the evaluation pass
computes + upserts the expected rows end to end (all offline)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_forecast import registry
from voltpilot_forecast.domain import ForecastKind, GeoLocation
from voltpilot_forecast.evaluate import evaluate_day
from voltpilot_forecast.forecast_collect import (
    ChallengerCache,
    CollectorConfig,
    SiteRow,
    collect_site,
)
from voltpilot_forecast.quality_repository import (
    STATUS_COLLECTING,
    STATUS_READY,
    InMemoryQualityRepository,
)
from voltpilot_forecast.repository import InMemoryForecastRepository

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = SiteRow(
    tenant_id="00000000-0000-0000-0000-000000000001",
    site_id="00000000-0000-0000-0000-000000000002",
    location=GeoLocation(52.52, 13.405),
)

_HAS_ML = True
try:  # the collector runs baselines-only without the [ml] extra
    import xgboost  # noqa: F401
    import numpy  # noqa: F401
except Exception:  # pragma: no cover
    _HAS_ML = False


class _FakeCursor:
    """Serves the collector's telemetry/weather reads from an in-memory table."""

    def __init__(self, telemetry: dict[str, list], weather: list) -> None:
        self._telemetry = telemetry
        self._weather = weather
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM telemetry" in sql:
            column = "load_kw" if "load_kw" in sql else "pv_power_kw"
            site_id, since = params
            self._rows = [
                (ts, v) for ts, v in self._telemetry.get(column, []) if ts >= since
            ]
        elif "FROM weather_forecast" in sql:
            self._rows = self._weather
        else:  # pragma: no cover
            raise AssertionError(f"unhandled query: {sql}")

    def fetchall(self):
        return self._rows


class _FakeConnection:
    def __init__(self, telemetry: dict[str, list], weather: list | None = None) -> None:
        self._telemetry = telemetry
        self._weather = weather or []

    def cursor(self):
        return _FakeCursor(self._telemetry, self._weather)


def _telemetry_days(days: int, pv=3.0) -> dict[str, list]:
    """Exactly `days` full UTC telemetry days (midnight-aligned before NOW).

    The load carries a daily shape (evening peak) so the booster has real
    structure to learn - a constant target trains a splitless tree whose
    importance list is legitimately empty.
    """
    start = (NOW - timedelta(days=days)).replace(hour=0, minute=0)
    rows_load, rows_pv = [], []
    for d in range(days):
        for q in range(96):
            ts = start + timedelta(days=d, minutes=15 * q)
            rows_load.append((ts, 1.0 + (1.5 if 68 <= q < 88 else 0.0)))
            rows_pv.append((ts, pv if 8 <= ts.hour < 16 else 0.0))
    return {"load_kw": rows_load, "pv_power_kw": rows_pv}


def _collect(telemetry: dict[str, list]):
    forecasts = InMemoryForecastRepository()
    quality = InMemoryQualityRepository()
    summary = collect_site(
        _FakeConnection(telemetry),
        forecasts,
        quality,
        SITE,
        NOW,
        CollectorConfig(),
        ChallengerCache(),
        ml_available=_HAS_ML,
    )
    return forecasts, quality, summary


def test_baselines_always_persist_model_tagged_series():
    forecasts, quality, summary = _collect(_telemetry_days(3))

    load = forecasts.latest(SITE.site_id, ForecastKind.LOAD, registry.LOAD_PERSISTENCE)
    pv = forecasts.latest(SITE.site_id, ForecastKind.PV, registry.PV_PHYSICAL)
    assert load is not None and load.model == "load-persistence"
    assert pv is not None and pv.model == "pv-physical"
    assert len(load) == 96 and len(pv) == 96
    assert load.tenant_id == SITE.tenant_id  # tenant stamped for RLS

    # Baseline states are 'ready' - always live, nothing to collect.
    assert quality.model_states[(SITE.site_id, "load-persistence")].status == STATUS_READY
    assert quality.model_states[(SITE.site_id, "pv-physical")].status == STATUS_READY


@pytest.mark.skipif(not _HAS_ML, reason="optional [ml] extra not installed")
def test_challengers_below_the_gate_record_honest_status_and_no_predictions():
    forecasts, quality, summary = _collect(_telemetry_days(5))

    for model in ("load-xgb", "pv-residual-xgb"):
        assert forecasts.latest(SITE.site_id, registry.kind_of(model), model) is None
        state = quality.model_states[(SITE.site_id, model)]
        assert state.status == STATUS_COLLECTING
        assert state.days_collected == 5
        assert state.days_required == 21
        assert state.trained_at is None
    assert summary.collecting == {"load-xgb": 5, "pv-residual-xgb": 5}


@pytest.mark.skipif(not _HAS_ML, reason="optional [ml] extra not installed")
def test_challengers_above_the_gate_predict_in_shadow_with_a_training_trail():
    forecasts, quality, summary = _collect(_telemetry_days(22))

    for model in ("load-xgb", "pv-residual-xgb"):
        series = forecasts.latest(SITE.site_id, registry.kind_of(model), model)
        assert series is not None and series.model == model
        assert len(series) == 96
        state = quality.model_states[(SITE.site_id, model)]
        assert state.status == STATUS_READY
        assert state.trained_at is not None
        assert state.train_rows and state.train_rows > 0
        assert state.feature_importance  # the explainability trail
        assert all("label" in fi and "weight" in fi for fi in state.feature_importance)
    assert set(summary.saved_models) == {
        "load-persistence", "pv-physical", "load-xgb", "pv-residual-xgb",
    }


# ---- evaluation glue over a fake DB ------------------------------------------------

class _EvalCursor:
    """Serves evaluate_day's queries from in-memory tables."""

    def __init__(self, db: dict) -> None:
        self._db = db
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM site WHERE id" in sql:
            self._rows = [("DE-LU",)]
        elif "FROM site" in sql:
            self._rows = [(SITE.tenant_id, SITE.site_id)]
        elif "time_bucket" in sql and "FROM telemetry" in sql:
            column = next(c for c in ("load_kw", "pv_power_kw", "power_kw") if c in sql)
            _, start, end = params
            self._rows = [
                (ts, v) for ts, v in self._db["telemetry"].get(column, {}).items()
                if start <= ts < end
            ]
        elif "SELECT DISTINCT model FROM forecast" in sql:
            _, kind, start, end = params
            self._rows = sorted(
                {(m,) for (k, m) in self._db["forecast"] if k == kind}
            )
        elif "FROM forecast" in sql:
            _, kind, model, start, end = params
            series = self._db["forecast"].get((kind, model), {})
            self._rows = [(ts, v) for ts, v in series.items() if start <= ts < end]
        elif "FROM schedule" in sql:
            _, start, end = params
            self._rows = [
                (ts, c, b) for ts, (c, b) in self._db["schedule"].items()
                if start <= ts < end
            ]
        elif "FROM day_ahead_prices" in sql:
            self._rows = self._db["prices"]
        else:  # pragma: no cover
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _EvalConnection:
    def __init__(self, db: dict) -> None:
        self._db = db

    def cursor(self):
        return _EvalCursor(self._db)


def test_evaluate_day_computes_skill_and_plan_rows_idempotently():
    day = date(2026, 6, 15)  # CEST: 2026-06-14 22:00 UTC .. 06-15 22:00 UTC
    t0 = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)
    slots = [t0 + i * timedelta(minutes=15) for i in range(4)]

    actual_load = {ts: 2.0 for ts in slots}
    db = {
        "telemetry": {
            "load_kw": actual_load,
            "pv_power_kw": {},
            "power_kw": {ts: 2.0 for ts in slots},
        },
        "forecast": {
            # baseline off by 1.0 per slot; challenger off by 0.25 -> skill 0.75
            ("load", "load-persistence"): {ts: 3.0 for ts in slots},
            ("load", "load-xgb"): {ts: 2.25 for ts in slots},
        },
        "schedule": {ts: (0.03, 0.05) for ts in slots},
        "prices": [(t0, "PT60M", 100.0)],
    }
    repo = InMemoryQualityRepository()
    accuracy_rows, plan_rows = evaluate_day(_EvalConnection(db), repo, day)

    assert accuracy_rows == 2 and plan_rows == 1
    baseline = repo.accuracy[(SITE.site_id, "load-persistence", day)]
    challenger = repo.accuracy[(SITE.site_id, "load-xgb", day)]
    assert baseline.mae_kw == 1.0
    assert baseline.skill_vs_baseline is None  # the reference has no skill vs itself
    assert challenger.mae_kw == 0.25
    assert challenger.skill_vs_baseline == 0.75
    assert challenger.n_slots == 4

    plan = repo.plan_accuracy[(SITE.site_id, day)]
    assert plan.planned_cost_eur == 0.12          # 4 x 0.03
    assert plan.baseline_cost_eur == 0.20         # 4 x 0.05
    assert plan.realized_cost_eur == 0.20         # 4 x 2kW x 0.25h x 0.1 EUR/kWh
    assert plan.n_slots == 4

    # Idempotent: a re-run overwrites the same keys, no duplicates.
    evaluate_day(_EvalConnection(db), repo, day)
    assert len(repo.accuracy) == 2
    assert len(repo.plan_accuracy) == 1

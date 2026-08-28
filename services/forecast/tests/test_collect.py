"""Collector cycle over a fake DB: baselines always persist model-tagged, the
challengers self-gate with an honest recorded status, and the evaluation pass
computes + upserts the expected rows end to end (all offline)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_forecast import registry
from voltpilot_forecast.domain import ForecastKind, GeoLocation, PlantSpec
from voltpilot_forecast.evaluate import evaluate_day
from voltpilot_forecast.forecast_collect import (
    ChallengerCache,
    CollectorConfig,
    SiteRow,
    collect_site,
    load_sites,
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


def test_registry_plant_spec_is_preferred_over_the_peak_estimate():
    """A MaStR-linked site forecasts with its authoritative nameplate."""
    telemetry = _telemetry_days(3, pv=3.0)  # observed peak ~3 kW
    linked = SiteRow(
        tenant_id=SITE.tenant_id,
        site_id=SITE.site_id,
        location=SITE.location,
        plant=PlantSpec(capacity_kwp=12.0, azimuth_deg=180.0, tilt_deg=30.0),
    )
    forecasts = InMemoryForecastRepository()
    collect_site(
        _FakeConnection(telemetry),
        forecasts,
        InMemoryQualityRepository(),
        linked,
        NOW,
        CollectorConfig(),
        ChallengerCache(),
        ml_available=False,
    )
    with_plant = forecasts.latest(SITE.site_id, ForecastKind.PV, registry.PV_PHYSICAL)

    estimated_repo = InMemoryForecastRepository()
    collect_site(
        _FakeConnection(telemetry),
        estimated_repo,
        InMemoryQualityRepository(),
        SITE,  # no plant -> observed-peak estimate (~3.15 kWp)
        NOW,
        CollectorConfig(),
        ChallengerCache(),
        ml_available=False,
    )
    estimated = estimated_repo.latest(SITE.site_id, ForecastKind.PV, registry.PV_PHYSICAL)

    peak_linked = max(p.value_kw for p in with_plant.points)
    peak_estimated = max(p.value_kw for p in estimated.points)
    # The physical model scales with capacity: 12 kWp vs ~3.15 kWp estimate.
    assert peak_linked > 2.5 * peak_estimated > 0


class _SiteQueryConn:
    """Serves only the load_sites join with canned rows."""

    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        conn = self

        class _Cur:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params=()):
                assert "FROM site s" in sql and "type = 'pv'" in sql

            def fetchall(self):
                return conn._rows

        return _Cur()


def test_load_sites_builds_the_plant_from_the_pv_asset_row():
    rows = [
        # linked site: full geometry from the registry
        ("t1", "s1", 52.52, 13.405, 6.05, 180.0, 30.0),
        # Balkonkraftwerk: kWp known, orientation not in the registry -> defaults
        ("t1", "s2", 52.52, 13.405, 0.8, None, None),
        # unlinked site: no pv asset row
        ("t2", "s3", None, None, None, None, None),
    ]
    sites = load_sites(_SiteQueryConn(rows))

    assert sites[0].plant == PlantSpec(capacity_kwp=6.05, azimuth_deg=180.0, tilt_deg=30.0)
    assert sites[1].plant == PlantSpec(capacity_kwp=0.8, azimuth_deg=180.0, tilt_deg=30.0)
    assert sites[2].plant is None and sites[2].location is None


def test_baselines_always_persist_model_tagged_series():
    forecasts, quality, summary = _collect(_telemetry_days(3))

    load = forecasts.latest(SITE.site_id, ForecastKind.LOAD, registry.LOAD_PERSISTENCE)
    pv = forecasts.latest(SITE.site_id, ForecastKind.PV, registry.PV_PHYSICAL)
    assert load is not None and load.model == "load-persistence"
    assert pv is not None and pv.model == "pv-physical"
    # 48 h since the optimizer plans a 48 h window (Captain-Entscheid
    # 28.08.2026) and may only extend it over REAL forecasts. This fixture
    # serves no weather, so the PV model runs on clear-sky physics, which is a
    # real model at any timestamp - the horizon is therefore unclipped.
    assert len(load) == 192 and len(pv) == 192
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
        if "FROM site_forecast_model_choice" in sql:
            # The PER-PLANT switch (V20260826000000): absent by default.
            # ⚠ This branch MUST come before the plain "FROM site" one - the
            # table name contains it as a substring.
            self._rows = list(self._db.get("site_model_choice", []))
        elif "FROM forecast_model_choice" in sql:
            # The platform default (V20260825000000): absent by default, so the
            # evaluator falls back to the env exactly as before.
            self._rows = list(self._db.get("model_choice", []))
        elif "FROM site WHERE id" in sql:
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


def test_sql_column_guards_raise_instead_of_asserting():
    # S15: the f-string column interpolation in the telemetry readers is
    # guarded by a hard raise, not an assert (which python -O strips) - and
    # it fires before any cursor is opened (None passes as conn/cur).
    from voltpilot_forecast.evaluate import _actuals
    from voltpilot_forecast.forecast_collect import _telemetry_history

    with pytest.raises(ValueError, match="DROP TABLE"):
        _telemetry_history(None, "site", "load_kw; DROP TABLE t", NOW)
    with pytest.raises(ValueError, match="soc_pct"):
        _actuals(None, "site", "soc_pct", NOW, NOW)


# ---------------------------------------------------------------------------
# The 48h horizon: PV stops where real weather stops (Captain-Entscheid
# 28.08.2026). The optimizer may extend its window past 24 h only over REAL
# forecasts; ``OpenMeteoWeatherProvider`` answers a timestamp outside its
# samples with 0 W/m2, which is indistinguishable from night. At the old 24 h
# horizon that branch was unreachable (the weather feed reaches ~3 days), but a
# 48 h horizon can outrun a weather feed that has been down for a day - and a
# fabricated PV zero for tomorrow evening is exactly the synthetic value the
# extension must never rest on.
# ---------------------------------------------------------------------------

from voltpilot_forecast.domain import Horizon  # noqa: E402
from voltpilot_forecast.forecast_collect import pv_horizon  # noqa: E402
from voltpilot_forecast.openmeteo import WeatherPoint  # noqa: E402


def _weather(hours: int, *, start: datetime = NOW, ghi: float | None = 300.0):
    """Hourly samples covering ``hours`` from the hour of ``start``."""
    first = start.replace(minute=0, second=0, microsecond=0)
    return [
        WeatherPoint(
            timestamp=first + timedelta(hours=h),
            temperature_c=18.0,
            cloud_cover_pct=10.0,
            ghi_w_m2=ghi,
            dni_w_m2=None,
            dhi_w_m2=None,
        )
        for h in range(hours)
    ]


def test_pv_horizon_keeps_the_full_window_when_weather_covers_it():
    horizon = Horizon.hours(48)
    assert pv_horizon(horizon, _weather(72), NOW).slots == horizon.slots


def _covered_slots(hours: int) -> int:
    """Slots of a 48 h horizon whose HOUR a ``_weather(hours)`` feed answers.

    Derived, not hardcoded: ``Horizon.slot_starts`` begins strictly AFTER
    ``run_at`` (the collector's own convention), so a feed covering ``hours``
    full hours from 12:00 answers up to and including the 45-min slot of its
    last hour - one slot short of ``hours * 4``.
    """
    last = _weather(hours)[-1].timestamp
    return sum(
        1
        for ts in Horizon.hours(48).slot_starts(NOW)
        if ts.replace(minute=0, second=0, microsecond=0) <= last
    )


def test_pv_horizon_stops_where_the_weather_samples_stop():
    """A weather feed reaching only 30 h yields a 30 h PV series - the
    optimizer's own truncation then ends its window there."""
    clipped = pv_horizon(Horizon.hours(48), _weather(30), NOW)
    assert clipped.slots == _covered_slots(30) == 119
    assert clipped.slot_minutes == 15


def test_pv_horizon_is_a_no_op_at_the_legacy_24h_request():
    """The rollback property: with the pre-48h horizon the clip cannot fire,
    because the weather feed always reaches further than one day."""
    horizon = Horizon.hours(24)
    assert pv_horizon(horizon, _weather(72), NOW).slots == horizon.slots


def test_a_sample_without_irradiance_does_not_count_as_coverage():
    """A row that exists but carries no GHI answers nothing - the provider
    would return the same fabricated 0 as for a missing hour."""
    points = _weather(48)
    points[30] = WeatherPoint(
        timestamp=points[30].timestamp,
        temperature_c=18.0,
        cloud_cover_pct=10.0,
        ghi_w_m2=None,
        dni_w_m2=None,
        dhi_w_m2=None,
    )
    assert pv_horizon(Horizon.hours(48), points, NOW).slots == _covered_slots(30)


def test_without_any_weather_the_horizon_is_untouched():
    """No samples at all means the caller uses the CLEAR-SKY provider, which is
    a real physical model at any timestamp - clipping there would drop a
    forecast we can honestly make."""
    horizon = Horizon.hours(48)
    assert pv_horizon(horizon, [], NOW).slots == horizon.slots


def test_weather_that_starts_after_the_window_leaves_the_horizon_whole():
    """Zero coverage is not "forecast nothing": fall back to the full horizon on
    clear-sky physics rather than writing no PV forecast at all."""
    horizon = Horizon.hours(48)
    late = _weather(24, start=NOW + timedelta(days=5))
    assert pv_horizon(horizon, late, NOW).slots == horizon.slots


def test_the_collector_clips_pv_but_never_load():
    """End to end through ``collect_site``: LOAD keeps the full 48 h (its
    baseline needs telemetry, not weather), PV stops at the weather's edge."""
    forecasts = InMemoryForecastRepository()
    quality = InMemoryQualityRepository()
    rows = [
        (p.timestamp, p.temperature_c, p.cloud_cover_pct, p.ghi_w_m2, p.dni_w_m2, p.dhi_w_m2)
        for p in _weather(30)
    ]
    collect_site(
        _FakeConnection(_telemetry_days(3), weather=rows),
        forecasts,
        quality,
        SITE,
        NOW,
        CollectorConfig(),
        ChallengerCache(),
        ml_available=False,
    )
    load = forecasts.latest(SITE.site_id, ForecastKind.LOAD, registry.LOAD_PERSISTENCE)
    pv = forecasts.latest(SITE.site_id, ForecastKind.PV, registry.PV_PHYSICAL)
    assert len(load) == 192
    assert len(pv) == _covered_slots(30)

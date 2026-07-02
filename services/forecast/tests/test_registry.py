"""Registry + model-tagged persistence: the shadow-mode bookkeeping.

Every forecaster carries a stable model id, every persisted series is tagged
with it, and the active model resolves from env with baseline defaults - the
invariants the optimizer's active-model filter and the daily evaluation
depend on.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from voltpilot_forecast import registry
from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    GeoLocation,
    Horizon,
    Observation,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.load import (
    ProfileLoadForecaster,
    SeasonalPersistenceLoadForecaster,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.repository import InMemoryForecastRepository

RUN_AT = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)


def test_active_models_default_to_the_baselines():
    models = registry.active_models({})
    assert models[ForecastKind.LOAD] == "load-persistence"
    assert models[ForecastKind.PV] == "pv-physical"


def test_active_model_resolves_from_env():
    env = {
        "VOLTPILOT_ACTIVE_LOAD_MODEL": "load-xgb",
        "VOLTPILOT_ACTIVE_PV_MODEL": "pv-residual-xgb",
    }
    assert registry.active_model(ForecastKind.LOAD, env) == "load-xgb"
    assert registry.active_model(ForecastKind.PV, env) == "pv-residual-xgb"


def test_unknown_or_mismatched_active_model_fails_loudly():
    with pytest.raises(ValueError, match="not a known forecast model id"):
        registry.active_model(ForecastKind.LOAD, {"VOLTPILOT_ACTIVE_LOAD_MODEL": "typo"})
    with pytest.raises(ValueError, match="not a load model"):
        registry.active_model(
            ForecastKind.LOAD, {"VOLTPILOT_ACTIVE_LOAD_MODEL": "pv-physical"}
        )


def test_baseline_forecasters_tag_their_series_with_their_model_id():
    history = [Observation(RUN_AT, 2.0)]
    horizon = Horizon(slots=4)

    load = SeasonalPersistenceLoadForecaster().forecast("s", "t", history, horizon, RUN_AT)
    assert load.model == "load-persistence"

    profile = ProfileLoadForecaster().forecast("s", "t", history, horizon, RUN_AT)
    assert profile.model == "load-profile"

    config = SiteForecastConfig(
        tenant_id="t",
        site_id="s",
        location=GeoLocation(52.52, 13.405),
        plant=PlantSpec(capacity_kwp=10.0),
    )
    pv = PhysicalPvForecaster().forecast(config, horizon, RUN_AT)
    assert pv.model == "pv-physical"


def test_untagged_series_defaults_to_the_kind_baseline():
    series = ForecastSeries(
        kind=ForecastKind.LOAD,
        site_id="s",
        tenant_id="t",
        run_at=RUN_AT,
        method="custom",
    )
    assert series.model == "load-persistence"


def test_repository_keeps_models_separate_and_filters_latest_by_model():
    repo = InMemoryForecastRepository()

    def series(model: str, value: float) -> ForecastSeries:
        return ForecastSeries(
            kind=ForecastKind.LOAD,
            site_id="s",
            tenant_id="t",
            run_at=RUN_AT,
            method="m",
            points=[ForecastPoint(RUN_AT, value)],
            model=model,
        )

    repo.save(series("load-persistence", 1.0))
    repo.save(series("load-xgb", 9.0))

    baseline = repo.latest("s", ForecastKind.LOAD, "load-persistence")
    challenger = repo.latest("s", ForecastKind.LOAD, "load-xgb")
    assert baseline is not None and baseline.points[0].value_kw == 1.0
    assert challenger is not None and challenger.points[0].value_kw == 9.0
    # One model's newer run never shadows the other model's series.
    assert baseline.model == "load-persistence"
    assert repo.latest("s", ForecastKind.LOAD, "unknown-model") is None

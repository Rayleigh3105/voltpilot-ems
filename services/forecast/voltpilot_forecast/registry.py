"""Forecast-model registry: the traceability spine of shadow-mode forecasting.

Every forecaster carries a stable **model id** (its ``model_id`` class
attribute), every persisted prediction is tagged with that id (the ``model``
column of the ``forecast`` hypertable), and exactly ONE model per kind is
*active* - the one the optimizer consumes. Everything else runs in **shadow**:
it predicts and persists every cycle exactly like the active model, but nothing
downstream reads its rows.

Promotion is a deliberate human act, never automatic: the captain flips the
``VOLTPILOT_ACTIVE_LOAD_MODEL`` / ``VOLTPILOT_ACTIVE_PV_MODEL`` environment
variables (on the forecast collector AND the optimizer, which both default to
the baselines) after the daily evaluation (``forecast_accuracy``) proves the
challenger better. See docs/forecasting.md for the full lifecycle.

The id vocabulary is deliberately small and central so the collector, the
optimizer, the api and the portal all speak the same names.
"""

from __future__ import annotations

from collections.abc import Mapping

from voltpilot_forecast.domain import ForecastKind

# ---- model ids (stable, cross-service vocabulary) ----------------------------

#: Baseline load model: "this slot = the same slot one day ago" persistence.
LOAD_PERSISTENCE = "load-persistence"
#: Baseline PV model: physical irradiance/plant model (clear-sky or Open-Meteo).
PV_PHYSICAL = "pv-physical"
#: Challenger: gradient-boosted (XGBoost) load model on tabular features.
LOAD_XGB = "load-xgb"
#: Challenger: physical PV model + learned residual correction (XGBoost).
PV_RESIDUAL_XGB = "pv-residual-xgb"

#: The baseline per kind - the skill-score reference and the shipped default.
BASELINE_MODELS: Mapping[ForecastKind, str] = {
    ForecastKind.LOAD: LOAD_PERSISTENCE,
    ForecastKind.PV: PV_PHYSICAL,
}

#: The challengers per kind - always shadow until promoted via env.
CHALLENGER_MODELS: Mapping[ForecastKind, tuple[str, ...]] = {
    ForecastKind.LOAD: (LOAD_XGB,),
    ForecastKind.PV: (PV_RESIDUAL_XGB,),
}

KNOWN_MODELS: frozenset[str] = frozenset(
    {LOAD_PERSISTENCE, PV_PHYSICAL, LOAD_XGB, PV_RESIDUAL_XGB}
)

# ---- active-model configuration (env) -----------------------------------------

ACTIVE_LOAD_MODEL_ENV = "VOLTPILOT_ACTIVE_LOAD_MODEL"
ACTIVE_PV_MODEL_ENV = "VOLTPILOT_ACTIVE_PV_MODEL"


def active_model(kind: ForecastKind, env: Mapping[str, str]) -> str:
    """The model id whose predictions feed the optimizer for ``kind``.

    Defaults to the baseline. An unknown configured id raises immediately - a
    typo here must fail loudly at startup, not silently starve the optimizer
    (which would then quietly fall back to its own persistence baseline).
    """
    var = ACTIVE_LOAD_MODEL_ENV if kind is ForecastKind.LOAD else ACTIVE_PV_MODEL_ENV
    configured = env.get(var, "").strip() or BASELINE_MODELS[kind]
    if configured not in KNOWN_MODELS:
        raise ValueError(
            f"{var}={configured!r} is not a known forecast model id "
            f"(known: {sorted(KNOWN_MODELS)})"
        )
    if kind_of(configured) is not kind:
        raise ValueError(
            f"{var}={configured!r} is a {kind_of(configured).value} model, "
            f"not a {kind.value} model"
        )
    return configured


def active_models(env: Mapping[str, str]) -> dict[ForecastKind, str]:
    """Active model per kind, resolved from ``env`` (defaults = baselines)."""
    return {kind: active_model(kind, env) for kind in ForecastKind}


def kind_of(model_id: str) -> ForecastKind:
    """The forecast kind a model id belongs to."""
    if model_id in (LOAD_PERSISTENCE, LOAD_XGB):
        return ForecastKind.LOAD
    if model_id in (PV_PHYSICAL, PV_RESIDUAL_XGB):
        return ForecastKind.PV
    raise ValueError(f"unknown forecast model id: {model_id!r}")


def baseline_model(kind: ForecastKind) -> str:
    """The skill-score reference model for ``kind``."""
    return BASELINE_MODELS[kind]

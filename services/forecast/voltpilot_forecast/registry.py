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
#: S0 (N1, Captain 11.11.2026: "Behebe den Lesefehler") - the HISTORICAL,
#: mislabeled reading PV_PHYSICAL used until the fix: Open-Meteo's horizontal
#: ``direct_radiation`` fed straight into the beam-normal DNI parameter
#: (docs/forecasting.md). PV_PHYSICAL itself now reads the correct
#: ``direct_normal_irradiance``; this id keeps the OLD computation running
#: FOREVER as a comparison-only reference, so "alt gegen neu gegen gemessen"
#: stays measured daily per site and the pauschale 14% loss assumption can
#: later be checked against it.
#:
#: Deliberately ABSENT from KNOWN_MODELS below: unlike a real challenger it
#: must never become active - not by convention, but because
#: :func:`active_model` (env) and the api's per-site/platform model choice
#: (``model_choice.py``, mirrored in ``ForecastModels.java``) both gate on
#: membership here, so there is no path by which a human can select it. The
#: daily evaluation still measures it: ``evaluate.py`` groups by the ``kind``
#: COLUMN of the ``forecast`` table, never by this registry, so an unregistered
#: id is scored exactly like any other.
PV_PHYSICAL_LEGACY_DNI = "pv-physical-legacy-dni"

#: The baseline per kind - the skill-score reference and the shipped default.
BASELINE_MODELS: Mapping[ForecastKind, str] = {
    ForecastKind.LOAD: LOAD_PERSISTENCE,
    ForecastKind.PV: PV_PHYSICAL,
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
    """The forecast kind a model id belongs to.

    Deliberately unaware of ``PV_PHYSICAL_LEGACY_DNI`` - see its docstring:
    nothing that calls this may ever be asked to resolve it.
    """
    if model_id in (LOAD_PERSISTENCE, LOAD_XGB):
        return ForecastKind.LOAD
    if model_id in (PV_PHYSICAL, PV_RESIDUAL_XGB):
        return ForecastKind.PV
    raise ValueError(f"unknown forecast model id: {model_id!r}")

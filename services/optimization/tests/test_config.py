"""Env resolution of the platform tunables - loud failure on garbage values
(the active-model-typo discipline: a misconfigured knob must never silently
fall back while the operator believes it is set)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from voltpilot_optimization.config import (
    default_wear_cost_ct_per_kwh,
    grid_limit_max_age,
    soc_max_age,
)


def test_defaults_without_env():
    assert default_wear_cost_ct_per_kwh({}) == 4.0
    assert grid_limit_max_age({}) == timedelta(minutes=60)
    assert soc_max_age({}) == timedelta(minutes=120)


def test_env_overrides():
    env = {
        "OPTIMIZER_WEAR_COST_CT_PER_KWH": "2.5",
        "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES": "30",
        "OPTIMIZER_SOC_MAX_AGE_MINUTES": "240",
    }
    assert default_wear_cost_ct_per_kwh(env) == 2.5
    assert grid_limit_max_age(env) == timedelta(minutes=30)
    assert soc_max_age(env) == timedelta(minutes=240)


def test_wear_may_be_zero_but_never_negative_or_garbage():
    assert default_wear_cost_ct_per_kwh({"OPTIMIZER_WEAR_COST_CT_PER_KWH": "0"}) == 0.0
    with pytest.raises(ValueError):
        default_wear_cost_ct_per_kwh({"OPTIMIZER_WEAR_COST_CT_PER_KWH": "-1"})
    with pytest.raises(ValueError):
        default_wear_cost_ct_per_kwh({"OPTIMIZER_WEAR_COST_CT_PER_KWH": "cheap"})
    with pytest.raises(ValueError):
        default_wear_cost_ct_per_kwh({"OPTIMIZER_WEAR_COST_CT_PER_KWH": "inf"})


def test_freshness_windows_must_be_strictly_positive():
    for fn, name in (
        (grid_limit_max_age, "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES"),
        (soc_max_age, "OPTIMIZER_SOC_MAX_AGE_MINUTES"),
    ):
        with pytest.raises(ValueError):
            fn({name: "0"})
        with pytest.raises(ValueError):
            fn({name: "-5"})
        with pytest.raises(ValueError):
            fn({name: "soon"})


def test_blank_env_value_means_default():
    assert default_wear_cost_ct_per_kwh({"OPTIMIZER_WEAR_COST_CT_PER_KWH": ""}) == 4.0
    assert grid_limit_max_age(
        {"OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES": " "}
    ) == timedelta(minutes=60)


def test_v2_plan_site_ids_parse_and_fail_loudly():
    from uuid import UUID

    from voltpilot_optimization.config import v2_plan_site_ids

    a = "00000000-0000-0000-0000-000000000001"
    b = "00000000-0000-0000-0000-000000000002"
    assert v2_plan_site_ids({}) == frozenset()
    assert v2_plan_site_ids({"VOLTPILOT_V2_PLAN_SITES": ""}) == frozenset()
    assert v2_plan_site_ids({"VOLTPILOT_V2_PLAN_SITES": a}) == {UUID(a)}
    assert v2_plan_site_ids(
        {"VOLTPILOT_V2_PLAN_SITES": f" {a}, {b} ,"}
    ) == {UUID(a), UUID(b)}
    # A typo must never silently un-flag a site.
    with pytest.raises(ValueError):
        v2_plan_site_ids({"VOLTPILOT_V2_PLAN_SITES": "not-a-uuid"})

"""Contract test: published payloads validate against the FROZEN schedule
schema (docs/contracts/mqtt-schedule.schema.json) and carry exactly what the
Node-RED schedule-exec flow consumes. Offline - the payload builder is pure."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from voltpilot_optimization.domain import (
    BatteryParams,
    PlanSlot,
    SchedulePlan,
)
from voltpilot_optimization.publisher import (
    build_schedule_payload,
    schedule_topic,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "docs" / "contracts" / "mqtt-schedule.schema.json"

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")
DEVICE = UUID("00000000-0000-0000-0000-000000000003")


def make_plan(device=DEVICE, slots: int = 96) -> SchedulePlan:
    battery = BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5)
    plan_slots = [
        PlanSlot(
            start=T0 + i * timedelta(minutes=15),
            battery_kw=2.5 if i % 2 == 0 else -1.25,
            grid_kw=1.0,
            soc_kwh=5.0,
            load_kw=3.0,
            pv_kw=0.5,
            price_eur_mwh=87.5,
            cost_eur=0.021875,
            baseline_cost_eur=0.0546875,
        )
        for i in range(slots)
    ]
    return SchedulePlan(
        plan_id=UUID("a81bc81b-dead-4e5d-abff-90865d1e13b1"),
        tenant_id=TENANT,
        site_id=SITE,
        device_id=device,
        generated_at=T0,
        battery=battery,
        slots=plan_slots,
    )


def load_validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_payload_validates_against_frozen_contract():
    payload = build_schedule_payload(make_plan())
    validator = load_validator()
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]


def test_payload_round_trips_through_json():
    payload = build_schedule_payload(make_plan())
    validator = load_validator()
    wire = json.dumps(payload)
    errors = list(validator.iter_errors(json.loads(wire)))
    assert errors == []


def test_payload_carries_what_the_edge_flow_consumes():
    # The Node-RED schedule-exec flow reads slot_minutes and per-slot
    # start/battery_setpoint_kw with the +charge/-discharge convention.
    payload = build_schedule_payload(make_plan())
    assert payload["schema_version"] == "1.0"
    assert payload["slot_minutes"] == 15
    assert payload["horizon_slots"] == 96
    assert len(payload["slots"]) == 96
    first, second = payload["slots"][0], payload["slots"][1]
    assert first == {"start": "2026-07-01T22:00:00Z", "battery_setpoint_kw": 2.5}
    assert second["battery_setpoint_kw"] == -1.25
    # RFC 3339 UTC with Z suffix, parseable by Date.parse on the edge.
    assert first["start"].endswith("Z")


def make_curtailing_plan() -> SchedulePlan:
    """A plan whose first slot curtails 4 kW of 6 kW PV (negative price)."""
    plan = make_plan(slots=2)
    curtailed = PlanSlot(
        start=T0,
        battery_kw=0.0,
        grid_kw=1.0,
        soc_kwh=9.5,
        load_kw=3.0,
        pv_kw=6.0,
        price_eur_mwh=-45.0,
        cost_eur=-0.01125,
        baseline_cost_eur=0.03375,
        curtail_kw=4.0,
    )
    return SchedulePlan(
        plan_id=plan.plan_id,
        tenant_id=plan.tenant_id,
        site_id=plan.site_id,
        device_id=plan.device_id,
        generated_at=plan.generated_at,
        battery=plan.battery,
        slots=[curtailed, plan.slots[1]],
    )


def test_curtailing_payload_validates_and_carries_the_optional_pv_limit():
    # Phase-3 curtailment: a curtailing slot publishes pv_limit_kw (the
    # inverter cap = pv - curtail, never negative); a non-curtailing slot
    # OMITS the field so pre-Phase-3 payloads stay byte-identical.
    payload = build_schedule_payload(make_curtailing_plan())
    validator = load_validator()
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]

    first, second = payload["slots"]
    assert first["pv_limit_kw"] == 2.0
    assert first["pv_limit_kw"] >= 0
    assert "pv_limit_kw" not in second


def test_pv_limit_is_never_negative_even_when_curtailment_equals_pv():
    plan = make_curtailing_plan()
    full = PlanSlot(
        start=T0,
        battery_kw=0.0,
        grid_kw=3.0,
        soc_kwh=9.5,
        load_kw=3.0,
        pv_kw=6.0,
        price_eur_mwh=-45.0,
        cost_eur=-0.03375,
        baseline_cost_eur=0.03375,
        curtail_kw=6.0,
    )
    payload = build_schedule_payload(
        SchedulePlan(
            plan_id=plan.plan_id,
            tenant_id=plan.tenant_id,
            site_id=plan.site_id,
            device_id=plan.device_id,
            generated_at=plan.generated_at,
            battery=plan.battery,
            slots=[full],
        )
    )
    assert payload["slots"][0]["pv_limit_kw"] == 0.0
    errors = list(load_validator().iter_errors(payload))
    assert errors == []


def test_topic_matches_the_convention():
    assert schedule_topic(make_plan()) == f"ems/{TENANT}/{SITE}/{DEVICE}/schedule"


def test_payload_requires_a_device():
    with pytest.raises(ValueError):
        build_schedule_payload(make_plan(device=None))


def test_grid_charge_allowed_is_optional_additive_and_validates():
    # P5 (EEG execution gap): the site's netzladen_erlaubt rides the payload
    # as the OPTIONAL grid_charge_allowed field. None (legacy) OMITS it so
    # pre-P5 payloads stay byte-identical; both boolean values validate
    # against the frozen schema (schema_version stays 1.0).
    validator = load_validator()

    legacy = build_schedule_payload(make_plan())
    assert "grid_charge_allowed" not in legacy
    assert list(validator.iter_errors(legacy)) == []

    import dataclasses

    for allowed in (False, True):
        plan = dataclasses.replace(make_plan(), grid_charge_allowed=allowed)
        payload = build_schedule_payload(plan)
        assert payload["grid_charge_allowed"] is allowed
        errors = list(validator.iter_errors(payload))
        assert errors == [], [e.message for e in errors]

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
EXAMPLES = REPO_ROOT / "docs" / "contracts" / "examples"

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


def test_charge_from_surplus_only_is_optional_additive_and_validates():
    # Price-aware in-slot trim (2026-07-30): a slot whose planned charge must
    # NOT be topped up from the grid carries the boolean duty; every other slot
    # OMITS the field (False and None are the same duty - none), so a plan
    # without uneconomic charge slots publishes byte-identical payloads and an
    # old edge has nothing to ignore.
    import dataclasses

    validator = load_validator()
    plan = make_plan(slots=3)
    trimmed = dataclasses.replace(plan.slots[0], charge_from_surplus_only=True)
    explicit_false = dataclasses.replace(plan.slots[1], charge_from_surplus_only=False)
    payload = build_schedule_payload(
        dataclasses.replace(plan, slots=[trimmed, explicit_false, plan.slots[2]])
    )
    assert list(validator.iter_errors(payload)) == []

    first, second, third = payload["slots"]
    assert first["charge_from_surplus_only"] is True
    assert "charge_from_surplus_only" not in second
    assert "charge_from_surplus_only" not in third


def test_committed_fixtures_match_the_schema_both_ways():
    """The committed contract fixtures are executable: the two valid ones must
    validate, the invalid one must be REJECTED for its documented reason (a
    fixture that silently starts validating is a contract regression)."""
    validator = load_validator()

    for name in (
        "mqtt-schedule.valid.plain.json",
        "mqtt-schedule.valid.surplus-only-charge.json",
    ):
        payload = json.loads((EXAMPLES / name).read_text())
        errors = list(validator.iter_errors(payload))
        assert errors == [], [f"{name}: {e.message}" for e in errors]

    bad = json.loads(
        (EXAMPLES / "mqtt-schedule.invalid.surplus-only-not-boolean.json").read_text()
    )
    messages = [e.message for e in validator.iter_errors(bad)]
    assert messages, "the invalid fixture must be rejected"
    assert any("charge_from_surplus_only" in m or "boolean" in m for m in messages), messages


def test_the_surplus_only_fixture_is_what_the_publisher_actually_emits():
    """Fixture-vs-producer: the committed 'trimmed' fixture is not hand-fiction -
    the publisher builds the same slot shape from a plan carrying the duty."""
    import dataclasses

    fixture = json.loads(
        (EXAMPLES / "mqtt-schedule.valid.surplus-only-charge.json").read_text()
    )
    plan = make_plan(slots=1)
    slot = dataclasses.replace(
        plan.slots[0],
        battery_kw=10.8,
        charge_from_surplus_only=True,
        curtail_kw=0.0,
    )
    emitted = build_schedule_payload(dataclasses.replace(plan, slots=[slot]))["slots"][0]
    # Same KEYS (the fixture's trimmed slot carries no field the publisher would
    # not emit, and vice versa) and the same values for what the duty is about.
    assert set(emitted) == set(fixture["slots"][0])
    assert emitted["battery_setpoint_kw"] == fixture["slots"][0]["battery_setpoint_kw"]
    assert emitted["charge_from_surplus_only"] is True
    # The plain fixture's slots are the byte-identical legacy shape.
    plain = json.loads((EXAMPLES / "mqtt-schedule.valid.plain.json").read_text())
    assert set(plain["slots"][0]) == {"start", "battery_setpoint_kw"}

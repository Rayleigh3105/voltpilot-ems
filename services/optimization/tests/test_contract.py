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
        "mqtt-schedule.valid.cover-load.json",
        "mqtt-schedule.valid.absorb-surplus.json",
        "mqtt-schedule.valid.export-limit.json",
    ):
        payload = json.loads((EXAMPLES / name).read_text())
        errors = list(validator.iter_errors(payload))
        assert errors == [], [f"{name}: {e.message}" for e in errors]

    for name, field in (
        ("mqtt-schedule.invalid.surplus-only-not-boolean.json", "charge_from_surplus_only"),
        ("mqtt-schedule.invalid.cover-load-not-boolean.json", "cover_load_from_battery"),
        (
            "mqtt-schedule.invalid.absorb-surplus-not-boolean.json",
            "charge_surplus_to_battery",
        ),
        ("mqtt-schedule.invalid.export-limit-negative.json", "grid_export_limit_kw"),
    ):
        bad = json.loads((EXAMPLES / name).read_text())
        messages = [e.message for e in validator.iter_errors(bad)]
        assert messages, f"{name}: the invalid fixture must be rejected"
        assert any(field in m or "boolean" in m or "minimum" in m for m in messages), (
            name,
            messages,
        )


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


def test_the_cover_load_fixture_is_what_the_publisher_actually_emits():
    """Fixture-vs-producer for the discharge-side mirror: the committed
    'covering' fixture is not hand-fiction - the publisher builds the same slot
    shape from a plan carrying the load-following duty."""
    import dataclasses

    fixture = json.loads((EXAMPLES / "mqtt-schedule.valid.cover-load.json").read_text())
    plan = make_plan(slots=1)
    slot = dataclasses.replace(
        plan.slots[0],
        battery_kw=-4.332,
        cover_load_from_battery=True,
        curtail_kw=0.0,
    )
    emitted = build_schedule_payload(dataclasses.replace(plan, slots=[slot]))["slots"][0]
    assert set(emitted) == set(fixture["slots"][0])
    assert emitted["battery_setpoint_kw"] == fixture["slots"][0]["battery_setpoint_kw"]
    assert emitted["cover_load_from_battery"] is True


def test_the_cover_load_flag_is_omitted_unless_true_and_validates():
    """Same omit-unless-true discipline as the trim: False and None are the same
    duty (none) and must both keep the payload byte-identical to before, because
    the contract makes an absent field FAIL-OPEN on the edge."""
    import dataclasses

    validator = load_validator()
    plan = make_plan(slots=3)
    covering = dataclasses.replace(
        plan.slots[0], battery_kw=-4.332, cover_load_from_battery=True, curtail_kw=0.0
    )
    explicit_false = dataclasses.replace(plan.slots[1], cover_load_from_battery=False)
    payload = build_schedule_payload(
        dataclasses.replace(plan, slots=[covering, explicit_false, plan.slots[2]])
    )
    assert list(validator.iter_errors(payload)) == []

    first, second, third = payload["slots"]
    assert first["cover_load_from_battery"] is True
    assert "cover_load_from_battery" not in second
    assert "cover_load_from_battery" not in third


def test_both_in_slot_duties_can_ride_the_same_payload():
    """They are disjoint in practice (one is about a charge, the other about a
    discharge), but the SCHEMA must not forbid a payload carrying both - the edge
    composes them most-restrictive-wins."""
    import dataclasses

    validator = load_validator()
    plan = make_plan(slots=1)
    slot = dataclasses.replace(
        plan.slots[0],
        battery_kw=-4.332,
        charge_from_surplus_only=True,
        cover_load_from_battery=True,
        curtail_kw=0.0,
    )
    payload = build_schedule_payload(dataclasses.replace(plan, slots=[slot]))
    assert list(validator.iter_errors(payload)) == []
    assert payload["slots"][0]["charge_from_surplus_only"] is True
    assert payload["slots"][0]["cover_load_from_battery"] is True


def test_the_absorb_surplus_fixture_is_what_the_publisher_actually_emits():
    """Fixture-vs-producer for the charge-side counterpart that RAISES: the
    committed absorption fixture is not hand-fiction - the publisher builds the
    same slot shape from a curtailing plan slot carrying the duty (the Pilsting
    2026-08-02 morning: the plan curtails on paper and commands 0,0 kW while a
    measured surplus is exported at a negative price)."""
    import dataclasses

    fixture = json.loads((EXAMPLES / "mqtt-schedule.valid.absorb-surplus.json").read_text())
    plan = make_plan(slots=1)
    slot = dataclasses.replace(
        plan.slots[0],
        battery_kw=0.0,
        pv_kw=12.0,
        curtail_kw=12.0,  # fully curtailed -> pv_limit_kw 0.0, like the fixture
        charge_surplus_to_battery=True,
    )
    emitted = build_schedule_payload(dataclasses.replace(plan, slots=[slot]))["slots"][0]
    assert set(emitted) == set(fixture["slots"][0])
    assert emitted["battery_setpoint_kw"] == fixture["slots"][0]["battery_setpoint_kw"]
    assert emitted["pv_limit_kw"] == fixture["slots"][0]["pv_limit_kw"]
    assert emitted["charge_surplus_to_battery"] is True


def test_the_absorb_surplus_flag_is_omitted_unless_true_and_validates():
    """Same omit-unless-true discipline as its two siblings: False and None are
    the same duty (none) and must both keep the payload byte-identical to before,
    because the contract makes an absent field FAIL-OPEN on the edge."""
    import dataclasses

    validator = load_validator()
    plan = make_plan(slots=3)
    absorbing = dataclasses.replace(
        plan.slots[0], battery_kw=0.0, charge_surplus_to_battery=True, curtail_kw=0.0
    )
    explicit_false = dataclasses.replace(plan.slots[1], charge_surplus_to_battery=False)
    payload = build_schedule_payload(
        dataclasses.replace(plan, slots=[absorbing, explicit_false, plan.slots[2]])
    )
    assert list(validator.iter_errors(payload)) == []

    first, second, third = payload["slots"]
    assert first["charge_surplus_to_battery"] is True
    assert "charge_surplus_to_battery" not in second
    assert "charge_surplus_to_battery" not in third


def test_grid_export_limit_is_optional_additive_and_validates():
    """Dynamische Einspeisebegrenzung (2026-08-06): the site's feed-in limit at
    the grid connection point (site.max_feed_in_kw / FK1) rides the payload as
    the OPTIONAL grid_export_limit_kw, so the EDGE can regulate it in real time
    instead of only having it planned against every 15 minutes.

    None (no limit configured) OMITS the field, so every other payload stays
    byte-identical and an old edge has nothing to ignore - and, load-bearing,
    a limit is never invented for a site that has none.
    """
    import dataclasses

    validator = load_validator()

    legacy = build_schedule_payload(make_plan())
    assert "grid_export_limit_kw" not in legacy
    assert list(validator.iter_errors(legacy)) == []

    plan = dataclasses.replace(make_plan(), max_feed_in_kw=30.0)
    payload = build_schedule_payload(plan)
    assert payload["grid_export_limit_kw"] == 30.0
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]

    # It is a RUN-level field: it never appears on a slot (the per-slot
    # curtailment pv_limit_kw is a different, composing quantity).
    assert all("grid_export_limit_kw" not in slot for slot in payload["slots"])


def test_the_export_limit_fixture_is_what_the_publisher_actually_emits():
    """Fixture-vs-producer: the committed feed-in-limit fixture is not hand
    fiction - the publisher emits the same top-level field from a plan whose
    site carries the limit."""
    import dataclasses

    fixture = json.loads((EXAMPLES / "mqtt-schedule.valid.export-limit.json").read_text())
    plan = dataclasses.replace(make_plan(slots=1), max_feed_in_kw=30.0)
    emitted = build_schedule_payload(plan)
    assert emitted["grid_export_limit_kw"] == fixture["grid_export_limit_kw"]

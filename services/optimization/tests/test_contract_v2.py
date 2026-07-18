"""Contract test: published v2 plans validate against the BINDING
mqtt-schedule-2.0 schema (docs/contracts/v2/) and follow its rules - D-8
(charge_from_grid_allowed always explicit), the release/clearing semantics for
limits, per-entity reserve, site-level peak target, the separate v2 topic.
Also pins the schema's own fixtures (examples/) so the validator wiring
provably bites. Offline - the payload builder is pure."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from voltpilot_optimization.domain import BatteryParams
from voltpilot_optimization.entities import (
    ProducerDispatch,
    ProducerSlot,
    SitePlan,
    SiteSlot,
    StorageDispatch,
    StorageSlot,
)
from voltpilot_optimization.publisher_v2 import (
    build_plan_v2_payload,
    plan_v2_topic,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
V2_DIR = REPO_ROOT / "docs" / "contracts" / "v2"
SCHEMA_PATH = V2_DIR / "mqtt-schedule-2.0.schema.json"
EXAMPLES_DIR = V2_DIR / "examples"

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")
DEVICE = UUID("00000000-0000-0000-0000-000000000003")
BATTERY = BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5)


def load_validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def starts(n: int) -> list[datetime]:
    return [T0 + i * timedelta(minutes=15) for i in range(n)]


def storage_dispatch(
    entity_id: str = "storage-main",
    n: int = 4,
    grid_charge: bool = False,
    peak_reserve: float | None = None,
) -> StorageDispatch:
    params = (
        dataclasses.replace(BATTERY, peak_reserve_pct=peak_reserve)
        if peak_reserve is not None
        else BATTERY
    )
    return StorageDispatch(
        entity_id=entity_id,
        params=params,
        charge_from_grid_allowed=grid_charge,
        slots=[
            StorageSlot(
                start=s,
                setpoint_kw=2.5 if i % 2 == 0 else -1.25,
                soc_kwh=5.0,
                wear_cost_eur=0.0,
            )
            for i, s in enumerate(starts(n))
        ],
        terminal_value_eur_per_kwh=0.05,
    )


def producer_dispatch(
    entity_id: str = "pv-main", n: int = 4, curtail_slots: set[int] = frozenset()
) -> ProducerDispatch:
    return ProducerDispatch(
        entity_id=entity_id,
        slots=[
            ProducerSlot(
                start=s,
                generation_kw=6.0,
                curtail_kw=4.0 if i in curtail_slots else 0.0,
            )
            for i, s in enumerate(starts(n))
        ],
    )


def make_plan(
    n: int = 4,
    device: UUID | None = DEVICE,
    storages: list[StorageDispatch] | None = None,
    producers: list[ProducerDispatch] | None = None,
    peak_target_kw: float | None = None,
) -> SitePlan:
    return SitePlan(
        plan_id=UUID("a81bc81b-dead-4e5d-abff-90865d1e13b1"),
        tenant_id=TENANT,
        site_id=SITE,
        device_id=device,
        generated_at=T0,
        storages=storages if storages is not None else [storage_dispatch(n=n)],
        producers=producers if producers is not None else [],
        site_slots=[
            SiteSlot(
                start=s,
                grid_kw=1.0,
                base_load_kw=3.0,
                price_eur_mwh=87.5,
                cost_eur=0.02,
                baseline_cost_eur=0.05,
            )
            for s in starts(n)
        ],
        peak_target_kw=peak_target_kw,
    )


# ---------------------------------------------------------------------------
# The schema's own fixtures prove the validator wiring bites.
# ---------------------------------------------------------------------------


def test_contract_fixture_examples_validate_as_documented():
    validator = load_validator()
    valid = sorted(EXAMPLES_DIR.glob("mqtt-schedule-2.0.valid.*.json"))
    invalid = sorted(EXAMPLES_DIR.glob("mqtt-schedule-2.0.invalid.*.json"))
    assert valid and invalid, "contract example fixtures missing"
    for path in valid:
        errors = list(validator.iter_errors(json.loads(path.read_text())))
        assert errors == [], f"{path.name}: {[e.message for e in errors]}"
    for path in invalid:
        errors = list(validator.iter_errors(json.loads(path.read_text())))
        assert errors != [], f"{path.name} must NOT validate"


# ---------------------------------------------------------------------------
# Our published payloads validate and follow the contract rules.
# ---------------------------------------------------------------------------


def test_storage_only_payload_validates_against_the_v2_schema():
    payload = build_plan_v2_payload(make_plan())
    validator = load_validator()
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]
    wire = json.loads(json.dumps(payload))
    assert list(validator.iter_errors(wire)) == []


def test_payload_shape_carries_the_v2_vocabulary():
    payload = build_plan_v2_payload(make_plan())
    assert payload["schema_version"] == "2.0"
    assert payload["slot_minutes"] == 15
    assert payload["horizon_slots"] == 4
    (entity,) = payload["entities"]
    assert entity["entity_id"] == "storage-main"
    assert entity["kind"] == "storage"
    first, second = entity["slots"][0], entity["slots"][1]
    assert first["start"] == "2026-07-01T22:00:00Z"
    assert first["commands"] == {"setpoint_kw": 2.5}
    assert second["commands"] == {"setpoint_kw": -1.25}


def test_topic_is_the_separate_v2_subtree():
    # Decision D-1: coexistence by SEPARATE retained topic, never
    # schema_version negotiation on the frozen .../schedule topic.
    assert plan_v2_topic(make_plan()) == f"ems/{TENANT}/{SITE}/{DEVICE}/v2/plan"


def test_d8_charge_from_grid_allowed_is_always_explicit():
    # D-8: absent = NOT allowed by contract, so the publisher must emit the
    # field for every storage entity - BOTH values, never an omission.
    validator = load_validator()
    for allowed in (False, True):
        plan = make_plan(storages=[storage_dispatch(grid_charge=allowed)])
        payload = build_plan_v2_payload(plan)
        (entity,) = payload["entities"]
        assert entity["charge_from_grid_allowed"] is allowed
        assert list(validator.iter_errors(payload)) == []


def test_non_curtailing_producer_is_omitted_for_release_semantics():
    # A producer with no curtailment anywhere is OMITTED: the contract's
    # release rule (a plan omitting a known entity withdraws its desire)
    # clears any previously applied limit.
    plan = make_plan(producers=[producer_dispatch()])
    payload = build_plan_v2_payload(plan)
    assert [e["entity_id"] for e in payload["entities"]] == ["storage-main"]


def test_curtailing_producer_carries_contiguous_slots_with_explicit_no_ops():
    # A curtailing producer must keep the contiguous slot grid: curtailing
    # slots carry limit_kw (generation - curtail, never negative); the other
    # slots carry the explicit no-op limit_pct 100 (a commands object must
    # not be empty, and absent limit would ambiguously mean "cleared").
    plan = make_plan(producers=[producer_dispatch(curtail_slots={1})])
    payload = build_plan_v2_payload(plan)
    validator = load_validator()
    assert list(validator.iter_errors(payload)) == []
    pv = next(e for e in payload["entities"] if e["entity_id"] == "pv-main")
    assert pv["kind"] == "pv-generation"
    assert len(pv["slots"]) == 4
    expected_starts = [
        "2026-07-01T22:00:00Z",
        "2026-07-01T22:15:00Z",
        "2026-07-01T22:30:00Z",
        "2026-07-01T22:45:00Z",
    ]
    assert [s["start"] for s in pv["slots"]] == expected_starts
    assert pv["slots"][1]["commands"] == {"limit_kw": 2.0}
    for i in (0, 2, 3):
        assert pv["slots"][i]["commands"] == {"limit_pct": 100.0}


def test_full_curtailment_publishes_limit_zero_never_negative():
    producer = ProducerDispatch(
        entity_id="pv-main",
        slots=[
            ProducerSlot(start=starts(1)[0], generation_kw=6.0, curtail_kw=6.0)
        ],
    )
    plan = make_plan(n=1, producers=[producer])
    payload = build_plan_v2_payload(plan)
    pv = next(e for e in payload["entities"] if e["entity_id"] == "pv-main")
    assert pv["slots"][0]["commands"] == {"limit_kw": 0.0}
    assert list(load_validator().iter_errors(payload)) == []


def test_peak_module_fields_site_level_target_and_per_entity_reserve():
    # grid_import_limit_kw stays SITE-level (the billing peak belongs to the
    # connection point); the PS-2 reserve moves onto the storage ENTITY.
    plan = make_plan(
        storages=[storage_dispatch(peak_reserve=40.0)],
        peak_target_kw=42.5,
    )
    payload = build_plan_v2_payload(plan)
    assert payload["grid_import_limit_kw"] == 42.5
    (entity,) = payload["entities"]
    assert entity["reserve_soc_pct"] == 40.0
    assert list(load_validator().iter_errors(payload)) == []

    plain = build_plan_v2_payload(make_plan())
    assert "grid_import_limit_kw" not in plain
    assert "reserve_soc_pct" not in plain["entities"][0]


def test_payload_requires_a_device_and_a_commanded_entity():
    with pytest.raises(ValueError, match="device"):
        build_plan_v2_payload(make_plan(device=None))
    with pytest.raises(ValueError, match="entity"):
        # Only a non-curtailing producer -> nothing to command.
        build_plan_v2_payload(
            make_plan(storages=[], producers=[producer_dispatch()])
        )


@pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)
def test_real_co_optimized_plan_validates_end_to_end():
    # The whole chain: golden scenario input -> co_optimize -> v2 payload ->
    # schema. Uses the kitchen-sink scenario so the payload carries every
    # optional field (peak target, reserve, curtailment, D-8 false).
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from test_golden_cooptimizer import load_scenario
    finally:
        sys.path.pop(0)
    from uuid import uuid4

    from voltpilot_optimization.co_solver import co_optimize
    from voltpilot_optimization.entities import from_v1_input

    inp = load_scenario(
        Path(__file__).resolve().parent / "golden" / "kitchen-sink-all-modules.json"
    )
    site_plan = co_optimize(from_v1_input(inp), plan_id=uuid4(), generated_at=T0)
    payload = build_plan_v2_payload(site_plan)
    validator = load_validator()
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]
    (entity, *rest) = payload["entities"]
    assert entity["charge_from_grid_allowed"] is False  # EEG site, explicit
    assert entity["reserve_soc_pct"] == 35.0
    assert payload["grid_import_limit_kw"] is not None
    assert payload["horizon_slots"] == 96
    assert len(entity["slots"]) == 96

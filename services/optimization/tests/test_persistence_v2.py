"""Consumer plan persistence (Verbrauchssteuerung Inkrement 2, §9.5): the
row shapes for ``site_plan_run``/``entity_plan_slot`` and the engine's shadow
wiring - consumer policies join the co-optimization of a FLAGGED site, get
persisted + published, and an unflagged site sees none of it.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import persistence_v2
from voltpilot_optimization.entities import (
    LoadDispatch,
    LoadSlot,
    SitePlan,
)
from voltpilot_optimization.persistence_v2 import (
    InMemorySitePlanRepository,
    consumer_slot_rows,
)

T0 = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")


def plan_with_loads(loads) -> SitePlan:
    return SitePlan(
        plan_id=uuid4(),
        tenant_id=TENANT,
        site_id=SITE,
        device_id=uuid4(),
        generated_at=T0,
        loads=loads,
    )


def test_consumer_slot_rows_mirror_the_published_commands_with_kw_targets():
    """The persisted command follows the control kind exactly like the v2
    payload builder; target_value is ALWAYS the planned kW (an on/off
    consumer persists its rated power when on) - DB and MQTT can never tell
    different stories, and the Fahrplan can stack real power."""
    onoff = LoadDispatch(
        entity_id="c-onoff",
        control_kind="on_off",
        slots=[
            LoadSlot(T0, True, 3.0, "fixed_window", "req-1"),
            LoadSlot(T0, False, 0.0, None, None),
        ],
    )
    cont = LoadDispatch(
        entity_id="c-cont",
        control_kind="continuous",
        slots=[LoadSlot(T0, True, 7.4, "optimizer_selected_low_cost", "task@2026-08-10")],
    )
    rows = consumer_slot_rows(plan_with_loads([onoff, cont]))
    assert len(rows) == 3
    time, tenant, site, plan_id, generated_at, entity, cmd, target, reason, rid = rows[0]
    assert (tenant, site, entity) == (TENANT, SITE, "c-onoff")
    assert (cmd, target, reason, rid) == ("on_off", 3.0, "fixed_window", "req-1")
    assert rows[1][6:] == ("on_off", 0.0, None, None)
    assert rows[2][6:] == (
        "setpoint_kw", 7.4, "optimizer_selected_low_cost", "task@2026-08-10",
    )


def test_publication_upsert_keeps_the_first_publication_and_owns_generated_at():
    """AP-15 IP-10: the optimizer's half of plan_zustellung. The api writes
    the verdict into the same row, so both sides upsert on (device, plan)."""
    sql = persistence_v2._PUBLICATION_UPSERT_SQL
    assert "INSERT INTO plan_zustellung" in sql
    assert "ON CONFLICT (device_id, plan_id)" in sql
    assert "generated_at       = EXCLUDED.generated_at" in sql
    assert "COALESCE(plan_zustellung.veroeffentlicht_um" in sql
    for column in ("urteil", "grund", "quittiert_um", "empfangen_um"):
        assert column not in sql  # the verdict belongs to the api alone


def test_in_memory_repository_is_idempotent_per_run():
    repo = InMemorySitePlanRepository()
    plan = plan_with_loads([
        LoadDispatch("c-1", "on_off", [LoadSlot(T0, True, 3.0, None, None)]),
    ])
    assert repo.upsert_site_plan(plan) == 1
    assert repo.upsert_site_plan(plan) == 1
    assert len(repo.plans) == 1
    assert repo.latest_for_site(SITE) is plan


@pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="highspy not installed (install the [solver] extra)",
)
def test_shadow_persists_consumer_slots_only_for_the_flagged_site(monkeypatch):
    """The engine loads a flagged site's active policies, co-optimizes them
    in, persists the consumer slots and publishes the consumer entity on the
    v2 payload - while an unflagged site stays byte-for-byte untouched."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from test_engine import (  # the existing engine harness
            NOW,
            RecordingSchedulePublisher,
            make_site,
            synthetic_inputs,
        )
    finally:
        sys.path.pop(0)
    from voltpilot_optimization import engine
    from voltpilot_optimization.entities import (
        ControllableLoadEntity,
        LoadRequirement,
    )
    from voltpilot_optimization.persistence import InMemoryScheduleRepository
    from voltpilot_optimization.publisher_v2 import RecordingPlanV2Publisher

    sites = [make_site(), make_site()]
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: sites)
    monkeypatch.setattr(
        engine,
        "gather_inputs",
        lambda dsn, site, now, horizon_slots, model_choices=None, battery_claims=None: synthetic_inputs(site, now),
    )
    flagged = sites[0]
    monkeypatch.setenv("VOLTPILOT_V2_PLAN_SITES", str(flagged.site_id))
    # Inkrement 5: consumer co-optimization is now flag-gated (default OFF).
    monkeypatch.setenv("OPTIMIZER_CONTROLLABLE_LOADS_ENABLED", "true")

    heater = ControllableLoadEntity(
        entity_id="11111111-2222-4333-8444-555566667777",
        max_power_kw=3.0,
        control_kind="on_off",
        requirements=(
            LoadRequirement(
                requirement_id="noon",
                kind="fixed_window",
                window_slots=(2, 3),
                target_kw=3.0,
                enforcement="must_run",
                grid_energy_policy="allow",
            ),
        ),
    )
    calls: list = []

    def fake_loader(dsn, site_id, slot_starts, slot_minutes, spot, imp):
        calls.append(site_id)
        return (heater,) if site_id == flagged.site_id else ()

    monkeypatch.setattr(engine, "load_consumer_entities", fake_loader)

    v2_pub = RecordingPlanV2Publisher()
    v2_repo = InMemorySitePlanRepository()
    engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        RecordingSchedulePublisher(),
        now=NOW,
        v2_publisher=v2_pub,
        v2_repository=v2_repo,
    )
    # Loader consulted ONLY for the flagged site (the unflagged one never
    # reaches the shadow path at all).
    assert calls == [flagged.site_id]
    # Persisted: the run + the heater's full slot grid.
    assert len(v2_repo.plans) == 1
    stored = v2_repo.plans[0]
    assert [d.entity_id for d in stored.loads] == [heater.entity_id]
    on = [i for i, s in enumerate(stored.loads[0].slots) if s.on]
    assert on == [2, 3]
    # Published: the consumer entity rides the v2 payload with on_off commands.
    (topic, payload) = v2_pub.published[0]
    consumer = next(e for e in payload["entities"] if e["kind"] == "consumer")
    assert consumer["entity_id"] == heater.entity_id
    assert consumer["slots"][2]["commands"] == {"on_off": True}
    assert consumer["slots"][0]["commands"] == {"on_off": False}
    # AP-15 IP-10: "veröffentlicht" for exactly the box that got the plan,
    # recorded after the send - the unflagged site records nothing.
    ((device_id, plan_id, generated_at, published_at),) = v2_repo.publications
    assert device_id == flagged.device_id
    assert (plan_id, generated_at) == (stored.plan_id, stored.generated_at)
    assert published_at.tzinfo is not None

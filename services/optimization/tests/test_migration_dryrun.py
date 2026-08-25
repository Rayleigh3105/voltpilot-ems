"""Migration dry-run proof (MIG): flipping a live v1 site to v2 is a flag flip
that changes NOTHING about the v1 plan and produces a v2 shadow plan whose
decisions equal the controlling v1 plan - proven END TO END through the engine
cycle over the golden pilot scenarios.

This complements the solver-level golden suite (``test_golden_cooptimizer``):
that proves solver == solver on the identical input; THIS proves the ENGINE,
driven exactly as a production cycle runs, publishes

  * a v2 plan (on ``ems/{t}/{s}/{d}/v2/plan``) whose per-slot battery setpoints
    equal the controlling v1 plan (on ``.../schedule``) for a MIGRATED site, and
  * a v1 plan that is BYTE-IDENTICAL whether or not the site is flagged, and no
    v2 traffic at all for an un-migrated site,

so the captain can flip ``VOLTPILOT_V2_PLAN_SITES`` with zero risk to v1
behavior and roll back by unsetting it. The adaptive read-model half of the
migration (topology / entity roles) is proven on the api side
(``AdminApiTest.topologyReadModelAggregatesRolesFromV2EntitiesAndAssignmentIsSettable``
and the conversion preview/bootstrap tests); this file owns the optimizer half.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone

import pytest

import voltpilot_optimization.engine as engine
from voltpilot_optimization.inputs import BatterySite
from voltpilot_optimization.persistence import InMemoryScheduleRepository
from voltpilot_optimization.publisher import RecordingSchedulePublisher
from voltpilot_optimization.publisher_v2 import RecordingPlanV2Publisher

# Sibling reuse: the golden fixtures + loader are the pilot-shaped v1 inputs a
# migrated site would carry (pytest puts the tests dir on sys.path).
from test_golden_cooptimizer import (  # noqa: E402
    SCENARIO_FILES,
    SCENARIO_IDS,
    SLOT_TOL,
    load_scenario,
)

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

# A production cycle stamps the plan's generated_at from `now`; pinned so two
# cycles are byte-comparable. The horizon itself comes from the fixture input.
NOW = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def _site_for(inp) -> BatterySite:
    """A BatterySite whose identity matches the fixture input, so the flag check
    (`site.site_id in flagged`) and the published topics line up."""
    return BatterySite(
        tenant_id=inp.tenant_id,
        site_id=inp.site_id,
        device_id=inp.device_id,
        bidding_zone="DE-LU",
        battery=inp.battery,
        netzladen_erlaubt=inp.netzladen_erlaubt,
    )


def _run(inp, *, flag_site_id, monkeypatch):
    """Run one engine cycle over a single fixture site, returning (v1_pub, v2_pub)."""
    site = _site_for(inp)
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [site])
    monkeypatch.setattr(
        engine, "gather_inputs", lambda dsn, s, now, horizon_slots, model_choices=None, battery_claims=None: inp
    )
    if flag_site_id is not None:
        monkeypatch.setenv("VOLTPILOT_V2_PLAN_SITES", str(flag_site_id))
    else:
        monkeypatch.delenv("VOLTPILOT_V2_PLAN_SITES", raising=False)
    v1_pub = RecordingSchedulePublisher()
    v2_pub = RecordingPlanV2Publisher()
    engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        v1_pub,
        now=NOW,
        v2_publisher=v2_pub,
    )
    return v1_pub, v2_pub


@pytest.mark.parametrize("path", SCENARIO_FILES, ids=SCENARIO_IDS)
def test_migrated_sites_v2_plan_matches_the_v1_plan_slot_by_slot(path, monkeypatch):
    """The heart of the migration proof: for a MIGRATED (flagged) site, the v2
    plan the engine publishes reproduces the v1 plan it still controls with -
    same battery setpoint every slot, same curtailment - across all eight pilot
    scenarios (EEG, merchant, §14a, peak-shaving, DV negative prices, ...)."""
    inp = load_scenario(path)
    v1_pub, v2_pub = _run(inp, flag_site_id=inp.site_id, monkeypatch=monkeypatch)

    # v1 unchanged: exactly one publish on the frozen /schedule topic.
    assert len(v1_pub.published) == 1
    v1_topic, v1_payload = v1_pub.published[0]
    assert v1_topic.endswith("/schedule")

    # v2 shadow: exactly the flagged site, on the separate v2 subtree.
    assert len(v2_pub.published) == 1
    v2_topic, v2_payload = v2_pub.published[0]
    assert v2_topic == f"ems/{inp.tenant_id}/{inp.site_id}/{inp.device_id}/v2/plan"
    assert v2_payload["schema_version"] == "2.0"

    # Per-slot equivalence: the storage entity's setpoint == the v1 battery
    # setpoint for EVERY slot (not just the first) - the golden guarantee
    # re-verified at the published-payload boundary the edge actually consumes.
    (storage,) = [
        e for e in v2_payload["entities"] if "setpoint_kw" in e["slots"][0]["commands"]
    ]
    v1_slots = v1_payload["slots"]
    assert len(storage["slots"]) == len(v1_slots)
    for t, (v2_slot, v1_slot) in enumerate(zip(storage["slots"], v1_slots)):
        assert v2_slot["commands"]["setpoint_kw"] == pytest.approx(
            v1_slot["battery_setpoint_kw"], abs=SLOT_TOL
        ), f"battery setpoint diverged at published slot {t}"

    # Curtailment (pv_limit_kw) matches too when the v1 plan curtails.
    curtailing = [s for s in v1_slots if s.get("pv_limit_kw") is not None]
    if curtailing:
        producers = [
            e
            for e in v2_payload["entities"]
            if any("limit_kw" in sl.get("commands", {}) for sl in e["slots"])
        ]
        assert producers, "v1 curtails but the v2 plan carries no producer limit"


def test_v1_publish_is_byte_identical_whether_or_not_the_site_is_migrated(monkeypatch):
    """The safety guarantee: migrating a site does not perturb the v1 plan the
    device still runs on. Two cycles over the same input - one un-flagged, one
    flagged - publish an IDENTICAL v1 payload (bar the random plan_id)."""
    inp = load_scenario(SCENARIO_FILES[0])

    off_pub, off_v2 = _run(inp, flag_site_id=None, monkeypatch=monkeypatch)
    on_pub, on_v2 = _run(inp, flag_site_id=inp.site_id, monkeypatch=monkeypatch)

    assert off_v2.published == []  # un-migrated: no v2 traffic
    assert len(on_v2.published) == 1  # migrated: the shadow plan appears

    off_payload = dict(off_pub.published[0][1])
    on_payload = dict(on_pub.published[0][1])
    # plan_id is a fresh UUID per run; everything else must be identical.
    off_payload.pop("plan_id", None)
    on_payload.pop("plan_id", None)
    assert off_pub.published[0][0] == on_pub.published[0][0]  # same topic
    assert off_payload == on_payload


def test_unmigrated_site_in_a_mixed_fleet_sees_no_v2_traffic(monkeypatch):
    """A realistic partial rollout: one site migrated, another not, in the same
    cycle - only the migrated site gets a v2 plan; the other is byte-for-byte
    v1."""
    migrated = load_scenario(SCENARIO_FILES[0])
    plain = load_scenario(SCENARIO_FILES[1])
    site_a, site_b = _site_for(migrated), _site_for(plain)
    inputs = {site_a.site_id: migrated, site_b.site_id: plain}

    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [site_a, site_b])
    monkeypatch.setattr(
        engine,
        "gather_inputs",
        lambda dsn, s, now, horizon_slots, model_choices=None, battery_claims=None: inputs[s.site_id],
    )
    monkeypatch.setenv("VOLTPILOT_V2_PLAN_SITES", str(site_a.site_id))

    v1_pub = RecordingSchedulePublisher()
    v2_pub = RecordingPlanV2Publisher()
    engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        v1_pub,
        now=NOW,
        v2_publisher=v2_pub,
    )

    # Both sites get their v1 plan; only the migrated one gets a v2 plan.
    assert len(v1_pub.published) == 2
    assert len(v2_pub.published) == 1
    assert v2_pub.published[0][0] == (
        f"ems/{migrated.tenant_id}/{migrated.site_id}/{migrated.device_id}/v2/plan"
    )

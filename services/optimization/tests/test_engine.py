"""Engine orchestration tests: gather -> solve -> persist -> publish.

The DB boundary (``load_battery_sites`` / ``gather_inputs``) is monkeypatched
with synthetic inputs; persistence and publishing use the in-memory / recording
doubles, so the full cycle runs offline. Needs the HiGHS wheel (real solves)."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

import voltpilot_optimization.engine as engine
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import BatterySite, SkipSite
from voltpilot_optimization.persistence import InMemoryScheduleRepository
from voltpilot_optimization.publisher import RecordingSchedulePublisher

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

NOW = datetime(2026, 7, 1, 21, 53, 11, tzinfo=timezone.utc)
BATTERY = BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5)


def make_site(device=True) -> BatterySite:
    return BatterySite(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4() if device else None,
        bidding_zone="DE-LU",
        battery=BATTERY,
        # Merchant mode: engine orchestration is mode-agnostic; the untouched
        # assertions double as the merchant-regression proof (see test_solver).
        netzladen_erlaubt=True,
    )


def synthetic_inputs(site: BatterySite, now: datetime) -> OptimizationInput:
    n = 96
    third = n // 3
    prices = [20.0] * third + [100.0] * (n - 2 * third) + [200.0] * third
    return OptimizationInput(
        tenant_id=site.tenant_id,
        site_id=site.site_id,
        device_id=site.device_id,
        battery=site.battery,
        slot_starts=horizon_slot_starts(now, n),
        prices_eur_mwh=prices,
        load_kw=[4.0] * n,
        pv_kw=[0.0] * n,
        initial_soc_kwh=5.0,
        netzladen_erlaubt=True,
        grid_limit_kw=35.0,
    )


@pytest.fixture
def wired(monkeypatch):
    sites = [make_site(), make_site(device=False)]
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: sites)
    monkeypatch.setattr(
        engine,
        "gather_inputs",
        lambda dsn, site, now, horizon_slots, model_choices=None: synthetic_inputs(site, now),
    )
    return sites


def test_cycle_plans_persists_and_publishes(wired):
    repository = InMemoryScheduleRepository()
    publisher = RecordingSchedulePublisher()
    summary = engine.run_cycle("dsn://ignored", repository, publisher, now=NOW)

    assert len(summary.planned) == 2
    assert not summary.skipped
    # Both plans persisted, full horizon each.
    assert len(repository.plans) == 2
    assert all(len(p.slots) == 96 for p in repository.plans)
    # Published only for the site WITH a claimed device, retained topic per plan.
    assert len(publisher.published) == 1
    topic, payload = publisher.published[0]
    site_with_device = wired[0]
    assert topic == (
        f"ems/{site_with_device.tenant_id}/{site_with_device.site_id}"
        f"/{site_with_device.device_id}/schedule"
    )
    assert payload["horizon_slots"] == 96
    # B1 regression: the published plan's first slot COVERS NOW (starts at the
    # boundary at/before it, 21:45 for NOW=21:53:11), so the edge finds an
    # active slot immediately instead of falling back to self-consumption
    # until the next boundary.
    assert payload["slots"][0]["start"] == "2026-07-01T21:45:00Z"
    first_start = datetime.fromisoformat(
        payload["slots"][0]["start"].replace("Z", "+00:00")
    )
    assert first_start <= NOW


def test_published_payload_validates_against_contract(wired):
    from jsonschema import Draft202012Validator, FormatChecker

    schema = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "docs"
            / "contracts"
            / "mqtt-schedule.schema.json"
        ).read_text()
    )
    publisher = RecordingSchedulePublisher()
    engine.run_cycle("dsn://ignored", InMemoryScheduleRepository(), publisher, now=NOW)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for _topic, payload in publisher.published:
        assert list(validator.iter_errors(payload)) == []


def test_plan_carries_positive_savings_and_projected_economics(wired):
    repository = InMemoryScheduleRepository()
    engine.run_cycle("dsn://ignored", repository, None, now=NOW)
    plan = repository.plans[0]
    assert plan.savings_eur > 0.5
    assert plan.baseline_cost_eur == pytest.approx(
        sum(s.baseline_cost_eur for s in plan.slots)
    )
    # Idempotent upsert: re-running the same plan replaces, not duplicates.
    repository.upsert_plan(plan)
    assert len([p for p in repository.plans if p.site_id == plan.site_id]) == 1


def test_autolink_makes_a_previously_unpublished_site_publish(monkeypatch):
    """The publish path keys off asset.device_id, so the api's auto-link is what
    heals a site: the SAME site is not published while its battery is unlinked
    (device_id None), then published once linked (device_id set) - no optimizer
    change needed, just the DB link the api now maintains."""
    site_id, tenant_id = uuid4(), uuid4()

    def site(device):
        return BatterySite(
            tenant_id=tenant_id,
            site_id=site_id,
            device_id=uuid4() if device else None,
            bidding_zone="DE-LU",
            battery=BATTERY,
            netzladen_erlaubt=True,
        )

    monkeypatch.setattr(
        engine, "gather_inputs",
        lambda dsn, s, now, horizon_slots, model_choices=None: synthetic_inputs(s, now),
    )

    # Before the auto-link: battery unlinked -> plan persisted, nothing published.
    unlinked = site(device=False)
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [unlinked])
    repo = InMemoryScheduleRepository()
    pub = RecordingSchedulePublisher()
    engine.run_cycle("dsn://ignored", repo, pub, now=NOW)
    assert len(repo.plans) == 1
    assert pub.published == []

    # After the api auto-links the device: the very same site now publishes.
    linked = site(device=True)
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [linked])
    pub2 = RecordingSchedulePublisher()
    engine.run_cycle("dsn://ignored", InMemoryScheduleRepository(), pub2, now=NOW)
    assert len(pub2.published) == 1
    topic, _payload = pub2.published[0]
    assert topic == f"ems/{tenant_id}/{site_id}/{linked.device_id}/schedule"


def test_skip_site_does_not_sink_the_cycle(monkeypatch):
    good, bad = make_site(), make_site()

    def gather(dsn, site, now, horizon_slots, model_choices=None):
        if site is bad:
            raise SkipSite("only 3 priced slots")
        return synthetic_inputs(site, now)

    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [bad, good])
    monkeypatch.setattr(engine, "gather_inputs", gather)
    summary = engine.run_cycle(
        "dsn://ignored", InMemoryScheduleRepository(), None, now=NOW
    )
    assert [p.site_id for p in summary.planned] == [good.site_id]
    assert len(summary.skipped) == 1


def test_infeasible_grid_limit_degrades_to_unconstrained_plan(monkeypatch):
    site = make_site()

    def gather(dsn, s, now, horizon_slots, model_choices=None):
        inp = synthetic_inputs(s, now)
        # 50 kW of load against a 1 kW cap: infeasible with the limit enforced.
        return OptimizationInput(
            tenant_id=inp.tenant_id,
            site_id=inp.site_id,
            device_id=inp.device_id,
            battery=inp.battery,
            slot_starts=inp.slot_starts,
            prices_eur_mwh=inp.prices_eur_mwh,
            load_kw=[50.0] * inp.slots,
            pv_kw=inp.pv_kw,
            initial_soc_kwh=inp.initial_soc_kwh,
            netzladen_erlaubt=inp.netzladen_erlaubt,
            grid_limit_kw=1.0,
        )

    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [site])
    monkeypatch.setattr(engine, "gather_inputs", gather)
    summary = engine.run_cycle(
        "dsn://ignored", InMemoryScheduleRepository(), None, now=NOW
    )
    assert len(summary.planned) == 1  # degraded, not failed


def test_v2_shadow_publishes_only_for_flagged_sites(wired, monkeypatch):
    """E13a shadow phase: a site flagged via VOLTPILOT_V2_PLAN_SITES gets an
    ADDITIONAL co-optimized plan retained on the v2 topic; the v1 publish
    stays byte-identical for every site, and unflagged sites see no v2
    traffic at all."""
    from voltpilot_optimization.publisher_v2 import RecordingPlanV2Publisher

    flagged = wired[0]  # the site WITH a device
    monkeypatch.setenv("VOLTPILOT_V2_PLAN_SITES", str(flagged.site_id))

    v1_pub = RecordingSchedulePublisher()
    v2_pub = RecordingPlanV2Publisher()
    summary = engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        v1_pub,
        now=NOW,
        v2_publisher=v2_pub,
    )
    assert len(summary.planned) == 2
    # v1 path unchanged: still exactly one publish, same topic as ever.
    assert len(v1_pub.published) == 1
    assert v1_pub.published[0][0].endswith("/schedule")
    # v2 shadow: exactly the flagged site, on the separate v2 subtree.
    assert len(v2_pub.published) == 1
    topic, payload = v2_pub.published[0]
    assert topic == (
        f"ems/{flagged.tenant_id}/{flagged.site_id}"
        f"/{flagged.device_id}/v2/plan"
    )
    assert payload["schema_version"] == "2.0"
    # The shadow plan mirrors the v1 decisions (the golden-suite guarantee):
    # same first-slot battery setpoint on the storage entity.
    (entity,) = payload["entities"]
    v1_payload = v1_pub.published[0][1]
    assert entity["slots"][0]["commands"]["setpoint_kw"] == pytest.approx(
        v1_payload["slots"][0]["battery_setpoint_kw"], abs=1e-3
    )
    # D-8: the merchant site's permission is explicit, never implied.
    assert entity["charge_from_grid_allowed"] is True


def test_v2_shadow_stays_silent_without_the_flag(wired):
    from voltpilot_optimization.publisher_v2 import RecordingPlanV2Publisher

    v2_pub = RecordingPlanV2Publisher()
    engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        RecordingSchedulePublisher(),
        now=NOW,
        v2_publisher=v2_pub,
    )
    assert v2_pub.published == []


def test_v2_shadow_failure_never_sinks_the_v1_cycle(wired, monkeypatch):
    flagged = wired[0]
    monkeypatch.setenv("VOLTPILOT_V2_PLAN_SITES", str(flagged.site_id))

    class ExplodingV2Publisher:
        def publish(self, plan):
            raise RuntimeError("broker down")

    v1_pub = RecordingSchedulePublisher()
    summary = engine.run_cycle(
        "dsn://ignored",
        InMemoryScheduleRepository(),
        v1_pub,
        now=NOW,
        v2_publisher=ExplodingV2Publisher(),
    )
    # The v1 plan of the flagged site still planned + published.
    assert len(summary.planned) == 2
    assert not summary.skipped
    assert len(v1_pub.published) == 1

"""Steuerung Stufe 3 (§3.7 A4): the optimizer KNOWS the customer-rule claims.

Until this stage ``flow_definition`` did not appear anywhere in
``services/optimization`` - every site with a primary battery was planned,
including the ones whose battery an active customer rule holds. The plan then
banked money on a battery it would never move: the box stops injecting a plan
setpoint for a claimed component (``owner_claimed``, §3.7 A3), so the dispatch
simply never happens.

The two halves proven here:

* the LOADER (:func:`load_battery_claims`) - it reads the materialized
  ``flow_claim`` projection, keys on the battery entity TYPE (never a snapshot
  column) and is FAIL-SOFT: without the table every battery is planned exactly
  as before, never a plant left unplanned;
* the EFFECT (``OptimizationInput.battery_held``) - a claimed battery is
  planned HELD (flat SoC, no charge, no discharge, no savings claimed) while an
  unclaimed one is BYTE-IDENTICAL to every run before Stufe 3.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import (
    BatterySite,
    gather_inputs,
    load_battery_claims,
    site_battery_claim,
)
from voltpilot_optimization.solver import optimize

pytest.importorskip("highspy", reason="behavioural MILP assertions need the HiGHS wheel")

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
OTHER_SITE = UUID("00000000-0000-0000-0000-0000000000ff")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SLOTS = 16

#: rows the fake ``flow_claim`` join answers with, and every SQL it saw.
CLAIM_ROWS: list[tuple[str, str]] = []
SEEN_SQL: list[str] = []
#: set to raise from ``connect`` - the "table not there yet" deploy case.
CONNECT_RAISES: list[Exception] = []


class _FakeCursor:
    def __init__(self) -> None:
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(NOW, SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        SEEN_SQL.append(sql)
        if "FROM flow_claim" in sql:
            self._rows = list(CLAIM_ROWS)
        elif "FROM site_forecast_model_choice" in sql or "FROM forecast_model_choice" in sql:
            self._rows = []
        elif "FROM day_ahead_prices" in sql:
            # A real spread so an UNHELD battery genuinely wants to cycle.
            self._rows = [
                (ts, "PT15M", 20.0 if i < SLOTS // 2 else 400.0)
                for i, ts in enumerate(self.slot_starts)
            ]
        elif "FROM forecast" in sql:
            site_id, kind, _model, since = params
            value = 1.0 if kind == "load" else 0.0
            self._rows = (
                [(ts, value) for ts in self.slot_starts if ts >= since]
                if site_id == SITE
                else []
            )
        elif "FROM telemetry" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor()

    def rollback(self):  # pragma: no cover
        pass


@pytest.fixture()
def fake_psycopg(monkeypatch):
    CLAIM_ROWS.clear()
    SEEN_SQL.clear()
    CONNECT_RAISES.clear()

    def connect(dsn):
        if CONNECT_RAISES:
            raise CONNECT_RAISES[0]
        return _FakeConnection()

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect))


def _site() -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0,
            max_charge_kw=5.0,
            max_discharge_kw=5.0,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=True,
    )


def _input(**over) -> OptimizationInput:
    slots = horizon_slot_starts(NOW, SLOTS)
    base = dict(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        battery=BatteryParams(
            capacity_kwh=10.0,
            max_charge_kw=5.0,
            max_discharge_kw=5.0,
            roundtrip_efficiency=0.92,
        ),
        slot_starts=slots,
        prices_eur_mwh=[20.0] * (SLOTS // 2) + [400.0] * (SLOTS // 2),
        load_kw=[1.0] * SLOTS,
        pv_kw=[0.0] * SLOTS,
        initial_soc_kwh=5.0,
        netzladen_erlaubt=True,
    )
    base.update(over)
    return OptimizationInput(**base)


# --- the loader ------------------------------------------------------------


def test_the_loader_keys_on_the_battery_entity_type_not_a_snapshot(fake_psycopg):
    CLAIM_ROWS.append((str(SITE), "Speicher halten bis 18:00"))
    claims = load_battery_claims("postgresql://fake")
    assert claims == {str(SITE): "Speicher halten bis 18:00"}
    sql = next(s for s in SEEN_SQL if "FROM flow_claim" in s)
    assert "JOIN measurement_point" in sql
    assert "entity_type = 'battery-hybrid'" in sql
    # ⚠ A DELEGATED claim (a vp.strategy.* node) hands dispatch TO this
    # optimizer - reading it as "held" would make a Betriebsmodell stop the
    # very plan it exists for.
    assert "NOT fc.delegated" in sql


def test_a_missing_table_degrades_to_no_claim_instead_of_sinking_the_cycle(fake_psycopg):
    CONNECT_RAISES.append(RuntimeError('relation "flow_claim" does not exist'))
    assert load_battery_claims("postgresql://fake") == {}


def test_the_claim_is_resolved_per_site(fake_psycopg):
    claims = {str(OTHER_SITE): "fremde Regel"}
    assert site_battery_claim(claims, SITE) is None
    assert site_battery_claim(claims, OTHER_SITE) == "fremde Regel"
    assert site_battery_claim(None, SITE) is None


def test_gather_inputs_marks_the_battery_held_only_when_claimed(fake_psycopg):
    unclaimed = gather_inputs("postgresql://fake", _site(), NOW, SLOTS, battery_claims={})
    assert unclaimed.battery_held is False

    claimed = gather_inputs(
        "postgresql://fake", _site(), NOW, SLOTS,
        battery_claims={str(SITE): "Wallbox bei Überschuss"},
    )
    assert claimed.battery_held is True
    # Everything else about the run is untouched - the claim says WHO may
    # dispatch, never what the plant is.
    assert claimed.battery == unclaimed.battery
    assert claimed.prices_eur_mwh == unclaimed.prices_eur_mwh
    assert claimed.pv_kw == unclaimed.pv_kw


def test_gather_inputs_loads_the_claims_itself_when_none_is_handed_in(fake_psycopg):
    CLAIM_ROWS.append((str(SITE), "Regel"))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.battery_held is True
    assert any("FROM flow_claim" in s for s in SEEN_SQL)


# --- the effect on the plan ------------------------------------------------


def test_a_held_battery_is_planned_flat_and_claims_no_savings():
    plan = optimize(_input(battery_held=True), UUID(int=1), NOW)
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots), "a held battery never moves"
    soc = [s.soc_kwh for s in plan.slots]
    assert max(soc) - min(soc) < 1e-6, "the SoC path stays flat"
    # cost == baseline: the plan honestly earns nothing on a battery it may
    # not command (savings are baseline - cost, slot by slot).
    assert sum(s.cost_eur for s in plan.slots) == pytest.approx(
        sum(s.baseline_cost_eur for s in plan.slots), abs=1e-9
    )


def test_the_same_horizon_without_the_claim_really_does_dispatch():
    """The held assertion above must not be vacuous."""
    plan = optimize(_input(), UUID(int=2), NOW)
    assert any(s.battery_kw > 0.1 for s in plan.slots), "cheap half must charge"
    assert any(s.battery_kw < -0.1 for s in plan.slots), "expensive half must discharge"


def test_an_unclaimed_run_is_byte_identical_to_the_pre_stufe3_default():
    """`battery_held` defaults to False, so nothing about a normal run moves."""
    explicit = optimize(_input(battery_held=False), UUID(int=3), NOW)
    default = optimize(_input(), UUID(int=3), NOW)
    assert [s.battery_kw for s in explicit.slots] == [s.battery_kw for s in default.slots]
    assert [s.grid_kw for s in explicit.slots] == [s.grid_kw for s in default.slots]
    assert [s.soc_kwh for s in explicit.slots] == [s.soc_kwh for s in default.slots]


def test_a_held_battery_still_plans_everything_else(fake_psycopg):
    """The claim removes the battery from the plan, never the plan."""
    inp = _input(battery_held=True, max_feed_in_kw=3.0, pv_kw=[8.0] * SLOTS)
    plan = optimize(inp, UUID(int=4), NOW)
    assert len(plan.slots) == SLOTS
    # the feed-in cap still binds (export never above it), and curtailment is
    # still available - the plan keeps doing its non-battery job.
    assert all(s.grid_kw >= -3.0 - 1e-6 for s in plan.slots)

"""UEMS AP-20 E10 = A: the optimizer plans nothing for a "beendet" area.

Shape checks against a fake ``psycopg`` so CI runs them: the battery-site
list joins ``tenant t`` and filters ``beendet_am``, and every plan write
(schedule, run + slots, publication note, run number) takes the area lock
first and writes nothing without it. Lock semantics against the Löschzug run
against a real Postgres in ``test_kundenbereich_db.py``.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from voltpilot_forecast.kundenbereich import NICHT_BEENDET
from voltpilot_optimization import inputs, verbund
from voltpilot_optimization.domain import BatteryParams, PlanSlot, SchedulePlan
from voltpilot_optimization.entities import LoadDispatch, LoadSlot, SitePlan
from voltpilot_optimization.persistence import TimescaleScheduleRepository
from voltpilot_optimization.persistence_v2 import TimescaleSitePlanRepository

T0 = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)


class _Conn:
    def __init__(self, live: bool) -> None:
        self.live = live
        self.statements: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.statements.append(sql)

    def executemany(self, sql, rows):
        self.statements.append(sql)

    def fetchone(self):
        return (1,) if self.live else None

    def fetchall(self):
        return []

    def commit(self):
        pass


@pytest.fixture
def fake_db(monkeypatch):
    def install(live: bool) -> _Conn:
        conn = _Conn(live)
        fake = types.ModuleType("psycopg")
        fake.connect = lambda dsn: conn
        monkeypatch.setitem(sys.modules, "psycopg", fake)
        return conn

    return install


def _plans():
    tenant, site, device = uuid4(), uuid4(), uuid4()
    schedule = SchedulePlan(
        plan_id=uuid4(), tenant_id=tenant, site_id=site, device_id=device,
        generated_at=T0,
        battery=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0),
        slots=[PlanSlot(start=T0 + timedelta(minutes=15 * i), battery_kw=1.0,
                        grid_kw=0.0, soc_kwh=5.0, load_kw=1.0, pv_kw=0.0,
                        price_eur_mwh=100.0, cost_eur=0.0, baseline_cost_eur=0.0)
               for i in range(2)],
    )
    site_plan = SitePlan(
        plan_id=uuid4(), tenant_id=tenant, site_id=site, device_id=device,
        generated_at=T0,
        loads=[LoadDispatch(entity_id="wp", control_kind="on_off",
                            slots=[LoadSlot(T0, True, 3.0, "fixed_window", "r")])],
    )
    return schedule, site_plan, device


def _alle_schreibwege(conn_dsn="dsn"):
    schedule, site_plan, device = _plans()
    v1 = TimescaleScheduleRepository(conn_dsn).upsert_plan(schedule)
    v2 = TimescaleSitePlanRepository(conn_dsn)
    slots = v2.upsert_site_plan(site_plan)
    v2.record_publication(site_plan, device, T0)
    lauf_nr = v2.assign_run_number(site_plan)
    return v1, slots, lauf_nr


def test_every_plan_write_takes_the_area_lock_and_writes_nothing_without_it(fake_db):
    conn = fake_db(live=False)
    assert _alle_schreibwege() == (0, 0, None)
    assert len(conn.statements) == 4
    for sql in conn.statements:
        assert sql.rstrip().endswith("FOR KEY SHARE OF t SKIP LOCKED")


def test_a_live_area_writes_every_plan_table_after_the_lock(fake_db):
    conn = fake_db(live=True)
    v1, slots, _ = _alle_schreibwege()
    assert (v1, slots) == (2, 1)
    geschrieben = [s for s in conn.statements if "FOR KEY SHARE" not in s]
    for tabelle in ("INSERT INTO schedule", "INSERT INTO site_plan_run",
                    "INSERT INTO entity_plan_slot", "INSERT INTO plan_zustellung",
                    "UPDATE site_plan_run"):
        assert any(tabelle in s for s in geschrieben), tabelle
    # Each of the four transactions opens with its lock.
    sperren = [i for i, s in enumerate(conn.statements) if "FOR KEY SHARE" in s]
    assert len(sperren) == 4 and sperren[0] == 0


def test_the_battery_site_list_filters_ended_areas(fake_db, monkeypatch):
    conn = fake_db(live=True)
    monkeypatch.setattr(inputs, "load_grenzblaetter", lambda *a, **k: {})
    monkeypatch.setattr(inputs, "load_fuehrende_boxen", lambda *a, **k: {})
    monkeypatch.setattr(verbund, "load_verbund", lambda *a, **k: {})
    assert inputs.load_battery_sites("dsn") == []
    (sql,) = conn.statements
    assert "JOIN tenant t ON t.id = s.tenant_id" in sql
    assert NICHT_BEENDET in sql

"""FK2 persistence: the run's terminal energy value is written per slot.

The derived V_end (P3) is only known solver-side
(:meth:`OptimizationInput.effective_terminal_value_eur_per_kwh`), yet the
portal must show the banked value ``V_end * (soc_end - soc_start)`` on bank
days - so every slot row of a run carries
``schedule.terminal_value_eur_per_kwh`` (api migration V20260716010000, same
value on all slots of the run). Plans without the field (pre-FK2) write NULL,
never a fabricated number.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from voltpilot_optimization.domain import BatteryParams, PlanSlot, SchedulePlan
from voltpilot_optimization.persistence import _UPSERT_SQL, plan_rows

T0 = datetime(2026, 7, 16, 6, 0, tzinfo=timezone.utc)


def make_plan(terminal_value: float | None) -> SchedulePlan:
    battery = BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0)
    slots = [
        PlanSlot(
            start=T0 + i * timedelta(minutes=15),
            battery_kw=2.0,
            grid_kw=1.0,
            soc_kwh=5.0,
            load_kw=1.0,
            pv_kw=2.0,
            price_eur_mwh=100.0,
            cost_eur=0.025,
            baseline_cost_eur=0.03,
        )
        for i in range(2)
    ]
    return SchedulePlan(
        plan_id=uuid4(),
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        generated_at=T0,
        battery=battery,
        slots=slots,
        terminal_value_eur_per_kwh=terminal_value,
    )


def upsert_columns() -> list[str]:
    """The column list of the INSERT, parsed from the SQL itself."""
    m = re.search(r"INSERT INTO schedule\s*\(([^)]*)\)", _UPSERT_SQL)
    assert m, "upsert SQL must keep its explicit column list"
    return [c.strip() for c in m.group(1).split(",")]


def test_every_slot_row_carries_the_runs_terminal_value():
    plan = make_plan(0.18025)
    rows = plan_rows(plan)
    cols = upsert_columns()
    idx = cols.index("terminal_value_eur_per_kwh")
    assert len(rows) == 2
    for row in rows:
        assert len(row) == len(cols), "one parameter per column"
        assert row[idx] == 0.18025
    # The placeholder count matches the tuple width (executemany stays valid).
    assert _UPSERT_SQL.count("%s") == len(cols)
    # And a redelivered/re-run upsert updates the value too.
    assert "terminal_value_eur_per_kwh = EXCLUDED.terminal_value_eur_per_kwh" in _UPSERT_SQL


def test_plan_without_terminal_value_writes_null_never_a_number():
    rows = plan_rows(make_plan(None))
    idx = upsert_columns().index("terminal_value_eur_per_kwh")
    assert all(row[idx] is None for row in rows)

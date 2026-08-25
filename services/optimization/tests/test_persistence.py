"""FK2 persistence: the run's terminal energy value is written per slot.

The derived V_end (P3) is only known solver-side
(:meth:`OptimizationInput.effective_terminal_value_eur_per_kwh`), yet the
portal must show the banked value ``V_end * (soc_end - soc_start)`` on bank
days - so every slot row of a run carries
``schedule.terminal_value_eur_per_kwh`` (api migration V20260716010000, same
value on all slots of the run). Plans without the field (pre-FK2) write NULL,
never a fabricated number.

The same upsert grew two later additive families on the same discipline: the
Fahrplan-Warum slot facts (V20260723030000) and the two IN-SLOT DUTIES
(V20260802010000) that let the portal preview "folgt dem gemessenen Verbrauch"
/ "lädt nur den Solar-Überschuss" in the plan.
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


def test_why_fields_are_persisted_per_slot_with_flags_as_csv():
    # Fahrplan-Warum (migration V20260723030000): the explain layer's slot
    # facts ride the same upsert; flags serialize as a CSV, an EMPTY flag
    # tuple persists as NULL ("keine Bindung erfasst"), and the run-level
    # fallback_14a repeats per row (the terminal_value pattern).
    from dataclasses import replace

    plan = make_plan(0.18)
    slots = [
        replace(
            plan.slots[0],
            slot_role="guenstig_laden",
            slot_flags=("charge_cap", "grid_limit_14a"),
            stored_value_ct_kwh=24.2,
            grid_value_ct_kwh=10.1,
            peak_pressure_eur_kw=1.25,
        ),
        replace(plan.slots[1], slot_role="warten", slot_flags=()),
    ]
    plan = replace(plan, slots=slots, fallback_14a=False)
    rows = plan_rows(plan)
    cols = upsert_columns()
    first, second = rows
    assert first[cols.index("slot_role")] == "guenstig_laden"
    assert first[cols.index("slot_flags")] == "charge_cap,grid_limit_14a"
    assert first[cols.index("stored_value_ct_kwh")] == 24.2
    assert first[cols.index("grid_value_ct_kwh")] == 10.1
    assert first[cols.index("peak_pressure_eur_kw")] == 1.25
    assert first[cols.index("fallback_14a")] is False
    assert second[cols.index("slot_role")] == "warten"
    assert second[cols.index("slot_flags")] is None  # empty = no binding = NULL
    assert second[cols.index("fallback_14a")] is False
    for col in ("slot_role", "slot_flags", "stored_value_ct_kwh",
                "grid_value_ct_kwh", "peak_pressure_eur_kw", "fallback_14a"):
        assert re.search(rf"{col}\s+= EXCLUDED\.{col}", _UPSERT_SQL), col


def test_in_slot_duties_are_persisted_per_slot_as_a_tri_state():
    # Duty-Vorschau (api migration V20260802010000): the two per-slot duties
    # ride the SAME upsert as the why-fields, and they stay TRI-STATE - True =
    # duty, False = evaluated-and-no-duty, None = not evaluated at all. The
    # portal marks a phase only on an explicit True, so False and None both
    # render exactly today's view.
    from dataclasses import replace

    plan = make_plan(0.18)
    slots = [
        replace(plan.slots[0], cover_load_from_battery=True, charge_from_surplus_only=False,
                unplanned_load_discharge=True),
        replace(plan.slots[1], cover_load_from_battery=False, charge_from_surplus_only=True,
                unplanned_load_discharge=False),
    ]
    plan = replace(plan, slots=slots)
    rows = plan_rows(plan)
    cols = upsert_columns()
    cover = cols.index("cover_load_from_battery")
    surplus = cols.index("charge_from_surplus_only")
    unplanned = cols.index("unplanned_load_discharge")
    assert rows[0][cover] is True and rows[0][surplus] is False
    assert rows[1][cover] is False and rows[1][surplus] is True
    assert rows[0][unplanned] is True and rows[1][unplanned] is False
    # One parameter per column, and a re-run of the same slot updates them.
    assert all(len(row) == len(cols) for row in rows)
    assert _UPSERT_SQL.count("%s") == len(cols)
    for col in ("cover_load_from_battery", "charge_from_surplus_only", "unplanned_load_discharge",
                "effective_floor_soc_pct"):
        assert re.search(rf"{col} = EXCLUDED\.{col}", _UPSERT_SQL), col


def test_plan_without_duties_writes_them_null_never_false():
    # A run with the duty evaluation off (or a pre-feature plan) must not claim
    # "no duty" - the columns stay NULL so the portal cannot mark anything.
    rows = plan_rows(make_plan(0.18))
    cols = upsert_columns()
    for row in rows:
        assert row[cols.index("cover_load_from_battery")] is None
        assert row[cols.index("charge_from_surplus_only")] is None
        assert row[cols.index("unplanned_load_discharge")] is None


def test_plan_without_explanation_writes_all_why_columns_null():
    # Explain off/failed (or a pre-feature plan): every why column is NULL -
    # the api/portal degrade to today's view, never a fabricated explanation.
    rows = plan_rows(make_plan(0.18))
    cols = upsert_columns()
    for row in rows:
        for col in ("slot_role", "slot_flags", "stored_value_ct_kwh",
                    "grid_value_ct_kwh", "peak_pressure_eur_kw", "fallback_14a"):
            assert row[cols.index(col)] is None

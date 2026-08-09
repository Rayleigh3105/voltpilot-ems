"""The cloud half of the consumer policy compiler (Verbrauchssteuerung
Inkrement 2): deterministic policy -> solver-input translation.

Pure and offline - no DB, no solver. Covers the E7 time rules (DST days,
24:00 normalization, over-midnight windows, weekday filters), the D1
cloud-condition compilation (price windows; local signals are edge work and
skipped whole), per-instance flexible-task splitting on a rolling horizon,
target resolution against the control profile (E8), and the honest skips
(opportunistic, mode targets, off targets, empty windows).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization.consumer_inputs import (
    ConsumerProfileRow,
    compile_condition_slots,
    compile_consumer,
    expand_recurrence,
)
from voltpilot_optimization.entities import (
    REASON_FIXED_WINDOW,
    REASON_OPTIMIZER,
    REASON_PRICE_WINDOW,
)

BERLIN = ZoneInfo("Europe/Berlin")


def utc_slots(start: datetime, n: int) -> list[datetime]:
    return [start + timedelta(minutes=15 * i) for i in range(n)]


def local_midnight_utc(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=BERLIN).astimezone(timezone.utc)


def profile(**kwargs) -> ConsumerProfileRow:
    base = dict(entity_id="c-1", control_kind="on_off", rated_power_kw=3.0)
    base.update(kwargs)
    return ConsumerProfileRow(**base)


# ---------------------------------------------------------------------------
# Recurrence expansion (E7)
# ---------------------------------------------------------------------------


def test_daily_window_expands_to_local_wall_clock_slots():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    members = expand_recurrence(
        {"days": "daily", "from": "13:00", "to": "14:00"}, slots, "Europe/Berlin"
    )
    assert [i for i, _d in members] == [52, 53, 54, 55]  # 13:00-13:45 local
    assert {d for _i, d in members} == {"2026-08-10"}


def test_24_00_normalizes_to_end_of_day():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    members = expand_recurrence(
        {"days": "daily", "from": "22:00", "to": "24:00"}, slots, "Europe/Berlin"
    )
    assert [i for i, _d in members] == list(range(88, 96))


def test_over_midnight_window_belongs_to_the_previous_days_instance():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96 * 2)
    members = expand_recurrence(
        {"days": "daily", "from": "22:00", "to": "06:00"}, slots, "Europe/Berlin"
    )
    by_day: dict[str, list[int]] = {}
    for i, day in members:
        by_day.setdefault(day, []).append(i)
    # The morning half of Aug 10 (00:00-06:00) belongs to Aug 9's instance.
    assert by_day["2026-08-09"] == list(range(0, 24))
    # Aug 10's instance: 22:00 Aug 10 through 06:00 Aug 11.
    assert by_day["2026-08-10"] == list(range(88, 96)) + list(range(96, 120))


def test_spring_forward_swallows_the_nonexistent_hour():
    # 2026-03-29 Europe/Berlin: 02:00 -> 03:00 does not exist.
    slots = utc_slots(local_midnight_utc(2026, 3, 29), 92)  # the day has 23 h
    members = expand_recurrence(
        {"days": "daily", "from": "02:00", "to": "03:00"}, slots, "Europe/Berlin"
    )
    assert members == []
    # A 13:00-14:00 Pflichtlauf on the SAME day is still exactly 60 minutes.
    noon = expand_recurrence(
        {"days": "daily", "from": "13:00", "to": "14:00"}, slots, "Europe/Berlin"
    )
    assert len(noon) == 4


def test_fall_back_doubles_the_repeated_hour():
    # 2026-10-25 Europe/Berlin: 02:00-03:00 occurs twice (the day has 25 h).
    slots = utc_slots(local_midnight_utc(2026, 10, 25), 100)
    members = expand_recurrence(
        {"days": "daily", "from": "02:00", "to": "03:00"}, slots, "Europe/Berlin"
    )
    assert len(members) == 8  # 2 x 4 quarter hours of ELAPSED time


def test_weekday_and_weekend_filters():
    # 2026-08-10 is a Monday; expand over a full week.
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96 * 7)
    weekdays = expand_recurrence(
        {"days": "weekdays", "from": "13:00", "to": "14:00"}, slots, "Europe/Berlin"
    )
    weekend = expand_recurrence(
        {"days": "weekend", "from": "13:00", "to": "14:00"}, slots, "Europe/Berlin"
    )
    assert {d for _i, d in weekdays} == {
        "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
    }
    assert {d for _i, d in weekend} == {"2026-08-15", "2026-08-16"}


# ---------------------------------------------------------------------------
# Cloud condition compilation (D1)
# ---------------------------------------------------------------------------


def test_price_condition_compiles_to_the_true_slots():
    spot = [10.0, 4.0, 3.0, 8.0]
    window = compile_condition_slots(
        {"signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5},
        spot,
        [30.0] * 4,
    )
    assert window == (1, 2)


def test_and_or_not_trees_evaluate_per_slot():
    spot = [10.0, 4.0, 3.0, 8.0]
    imp = [35.0, 28.0, 33.0, 29.0]
    any_tree = {
        "any": [
            {"signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5},
            {"signal": "market.import_price_ct_kwh", "operator": "lt", "value": 30},
        ]
    }
    all_tree = {
        "all": [
            {"signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5},
            {"signal": "market.import_price_ct_kwh", "operator": "lt", "value": 30},
        ]
    }
    not_tree = {"not": any_tree}
    assert compile_condition_slots(any_tree, spot, imp) == (1, 2, 3)
    assert compile_condition_slots(all_tree, spot, imp) == (1,)
    assert compile_condition_slots(not_tree, spot, imp) == (0,)


def test_a_local_signal_anywhere_makes_the_tree_uncompilable():
    tree = {
        "any": [
            {"signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5},
            {"signal": "storage.soc_pct", "operator": "gt", "value": 80},
        ]
    }
    assert compile_condition_slots(tree, [1.0], [1.0]) is None


# ---------------------------------------------------------------------------
# compile_consumer
# ---------------------------------------------------------------------------


def doc(requirements: list[dict]) -> dict:
    return {
        "schema_version": "1.0",
        "entity_id": "c-1",
        "timezone": "Europe/Berlin",
        "requirements": requirements,
    }


def test_fixed_window_and_price_window_carry_their_reason_codes():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    spot = [10.0] * 96
    spot[8] = 2.0
    entity = compile_consumer(
        profile(),
        doc([
            {
                "id": "noon",
                "kind": "fixed_window",
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "13:00", "to": "14:00"},
                "target": {"kind": "on_off", "value": True},
            },
            {
                "id": "cheap",
                "kind": "reactive",
                "enforcement": "must_run",
                "condition": {
                    "signal": "market.spot_price_ct_kwh",
                    "operator": "lt",
                    "value": 5,
                },
                "target": {"kind": "on_off", "value": True},
            },
        ]),
        slots,
        15,
        spot,
        [30.0] * 96,
    )
    assert entity is not None
    by_id = {r.requirement_id: r for r in entity.requirements}
    assert by_id["noon"].reason_code == REASON_FIXED_WINDOW
    assert by_id["noon"].window_slots == (52, 53, 54, 55)
    # must_run compiles grid allow (E2) - the model never re-derives it.
    assert by_id["noon"].grid_energy_policy == "allow"
    assert by_id["cheap"].reason_code == REASON_PRICE_WINDOW
    assert by_id["cheap"].window_slots == (8,)


def test_flexible_task_splits_per_instance_on_a_rolling_horizon():
    # Horizon starts 14:00 local and covers 24 h -> TWO instances of a daily
    # 00:00-24:00 task: the rest of today and the start of tomorrow.
    start = local_midnight_utc(2026, 8, 10) + timedelta(hours=12)
    slots = utc_slots(start, 96)
    entity = compile_consumer(
        profile(rated_power_kw=2.2),
        doc([
            {
                "id": "pump-daily",
                "kind": "flexible_task",
                "enforcement": "required_by_deadline",
                "recurrence": {"days": "daily", "from": "00:00", "to": "24:00"},
                "demand": {"runtime_minutes": 60, "contiguous": True},
                "target": {"kind": "on_off", "value": True},
            },
        ]),
        slots,
        15,
        [10.0] * 96,
        [30.0] * 96,
    )
    assert entity is not None
    ids = [r.requirement_id for r in entity.requirements]
    assert ids == ["pump-daily@2026-08-10", "pump-daily@2026-08-11"]
    today, tomorrow = entity.requirements
    assert today.contiguous and tomorrow.contiguous
    assert today.required_minutes == 60
    assert today.window_slots[-1] < tomorrow.window_slots[0]
    assert today.reason_code == REASON_OPTIMIZER


def test_local_reactive_opportunistic_and_mode_targets_are_skipped_honestly():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    entity = compile_consumer(
        profile(),
        doc([
            {  # local signal -> Inkrement 4 edge work, never half-compiled
                "id": "soc",
                "kind": "reactive",
                "enforcement": "must_run",
                "condition": {
                    "signal": "storage.soc_pct",
                    "operator": "gt",
                    "value": 80,
                    "reset_value": 75,
                    "max_age_s": 30,
                },
                "target": {"kind": "on_off", "value": True},
            },
            {  # opportunistic -> later increment
                "id": "opp",
                "kind": "opportunistic",
                "enforcement": "opportunistic",
                "recurrence": {"days": "daily", "from": "00:00", "to": "24:00"},
                "target": {"kind": "on_off", "value": True},
            },
            {  # mode target -> not plannable
                "id": "eco",
                "kind": "fixed_window",
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "13:00", "to": "14:00"},
                "target": {"kind": "mode", "value": "eco"},
            },
            {  # off target -> not a run requirement
                "id": "off",
                "kind": "fixed_window",
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "13:00", "to": "14:00"},
                "target": {"kind": "on_off", "value": False},
            },
            {  # inactive
                "id": "inactive",
                "kind": "fixed_window",
                "active": False,
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "13:00", "to": "14:00"},
                "target": {"kind": "on_off", "value": True},
            },
        ]),
        slots,
        15,
        [10.0] * 96,
        [30.0] * 96,
    )
    # Nothing solver-relevant left -> honestly no entity, never a guess.
    assert entity is None


def test_targets_resolve_against_the_profile_and_never_widen_it():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    entity = compile_consumer(
        profile(control_kind="continuous", rated_power_kw=11.0, min_power_kw=1.4),
        doc([
            {
                "id": "half",
                "kind": "fixed_window",
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "13:00", "to": "14:00"},
                "target": {"kind": "percent", "value": 50},
            },
            {
                "id": "toomuch",
                "kind": "fixed_window",
                "enforcement": "must_run",
                "recurrence": {"days": "daily", "from": "15:00", "to": "16:00"},
                "target": {"kind": "kw", "value": 22.0},
            },
        ]),
        slots,
        15,
        [10.0] * 96,
        [30.0] * 96,
    )
    by_id = {r.requirement_id: r for r in entity.requirements}
    assert by_id["half"].target_kw == pytest.approx(5.5)
    # E8: a kW target above the effective rated power is clamped, never widened.
    assert by_id["toomuch"].target_kw == pytest.approx(11.0)


def test_profile_master_data_carries_into_the_entity():
    slots = utc_slots(local_midnight_utc(2026, 8, 10), 96)
    entity = compile_consumer(
        profile(
            control_kind="continuous",
            rated_power_kw=11.0,
            min_power_kw=1.4,
            power_ranges_kw=((1.4, 3.7), (4.2, 11.0)),
            storage_relation="storage_first",
            default_grid_energy_policy="avoid",
            allow_storage_discharge=True,
            min_on_seconds=1800,
            min_off_seconds=900,
            max_starts_per_day=4,
        ),
        doc([
            {
                "id": "task",
                "kind": "flexible_task",
                "enforcement": "required_by_deadline",
                "recurrence": {"days": "daily", "from": "00:00", "to": "24:00"},
                "demand": {"energy_kwh": 8.0},
                "target": {"kind": "percent", "value": 100},
            },
        ]),
        slots,
        15,
        [10.0] * 96,
        [30.0] * 96,
    )
    assert entity.power_ranges_kw == ((1.4, 3.7), (4.2, 11.0))
    assert entity.storage_relation == "storage_first"
    assert entity.grid_energy_policy == "avoid"
    assert entity.allow_storage_discharge is True
    assert entity.min_on_slots == 2  # 1800 s = 30 min = 2 slots, ceil
    assert entity.min_off_slots == 1
    assert entity.max_starts_per_horizon == 4
    assert entity.requirements[0].required_kwh == pytest.approx(8.0)

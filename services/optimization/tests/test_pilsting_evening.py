"""The economic proof of the 48h horizon: the Pilsting evening (28.08.2026).

**The observed defect.** The productive cycle planned a hard 96 slots. The plan
of 18:30 therefore ended at 18:15 the NEXT day, and the following EVENING - the
hours whose expensive import is exactly what a battery is for - was outside it.
Consequences measured on the live box ``edge-45gz7da``:

* stored energy was worth something only in the last ~90 minutes of the window,
  so the plan charged ~16 kWh and stopped;
* the negative-price midday hours were CURTAILED down to house load while the
  battery stood at 22 %, because storing that surplus had nowhere to pay off.

Tomorrow's day-ahead prices publish around 12:45 and are in the table long
before the horizon needs them. The window, not the data, was the limit.

**What this test does.** It builds that constellation as a plain
:class:`OptimizationInput` - it does not need a DB - and solves it TWICE with
the REAL solver: once over 96 slots (the old window) and once over 192 (the new
default). Everything else is byte-identical between the two runs, so every
difference is attributable to the horizon alone.

**Why the plant carries a feed-in cap** (``max_feed_in_kw``, the FK1 connection
point limit - Pilsting's real ceiling measured ~30 kW). It is not decoration:
it is what makes the surplus beyond the cap FREE to store, which drives the
terminal value's charge-side anchor to 0. And a zero terminal value is exactly
the trap a 24h window cannot escape - stored energy is then worth nothing past
the horizon, so the plan empties the battery into day-2 daytime load and has
nothing left when the evening it cannot see arrives. The 48h window does not
need the terminal value to carry that evening: the evening is IN the horizon.

Measured here (all figures over the SAME first 96 slots):

===========================  =========  =========
                                  24 h      48 h
===========================  =========  =========
SoC at the old window's end       5.0 %     95.0 %
charged                        21.2 kWh   67.6 kWh
curtailed                     202.6 kWh  156.2 kWh
===========================  =========  =========

**The honest limit, asserted as such** (``test_without_a_feed_in_cap...``):
where the cap is loose enough that the terminal value derives to a real number,
the 24h plan already fills the battery and the two runs curtail the SAME energy
- the 48h gain is then only that the plan stops dumping into the sliver of
evening its window happens to catch. The horizon fixes WHAT a plan can see, not
how big the battery is.

The numbers are asserted as RELATIONS, not as pinned digits: the point is the
direction and the order of magnitude (which is what the captain's brief asks to
be named), and pinning HiGHS output to the cent would make this a brittle
golden test that the tie-break constants already own.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.solver import optimize

pytest.importorskip("highspy", reason="behavioral MILP test needs the HiGHS wheel")

TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")
DEVICE = UUID("00000000-0000-0000-0000-000000000003")

#: 18:30 local on the observed day. The window starts here, so slot 96 lands at
#: 18:15 the next day - the old horizon's edge, an hour before the evening peak.
NOW = datetime(2026, 8, 28, 16, 30, tzinfo=timezone.utc)  # 18:30 CEST

SLOT_H = 0.25
BERLIN_OFFSET_H = 2  # CEST

#: 65 kWh usable-ish battery, 30 kW each way (the plant's class).
BATTERY = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
    wear_cost_ct_per_kwh=4.0,
)

#: The plant sat at 22 % when the 18:30 plan was made.
INITIAL_SOC_KWH = 0.22 * 65.0

#: Flat retail supply price, the plant's tariff class.
IMPORT_CT_KWH = 25.0

#: The connection point's feed-in limit (FK1). See the module docstring for why
#: it is load-bearing rather than decoration.
MAX_FEED_IN_KW = 28.0


def _local_hour(slot_index: int) -> float:
    """Local (CEST) decimal hour of a slot, from NOW."""
    ts = NOW + timedelta(minutes=15 * slot_index)
    return ((ts.hour + BERLIN_OFFSET_H) % 24) + ts.minute / 60.0


def _spot_eur_mwh(slot_index: int) -> float:
    """A believable late-August curve: negative midday, expensive evening.

    Same shape on both days, so the second day is not a special case that could
    be argued to carry the result on its own.
    """
    h = _local_hour(slot_index)
    if 10.0 <= h < 15.0:
        return -40.0  # the negative-price midday window
    if 18.0 <= h < 22.0:
        return 180.0  # the evening peak
    if 0.0 <= h < 6.0:
        return 40.0  # cheap night
    return 90.0


def _pv_kw(slot_index: int) -> float:
    """~70 kWp roof: a smooth bell between 06:00 and 20:00 local, peaking ~60 kW."""
    h = _local_hour(slot_index)
    if not 6.0 <= h <= 20.0:
        return 0.0
    x = (h - 13.0) / 7.0
    return round(max(0.0, 60.0 * (1.0 - x * x)), 3)


def _load_kw(slot_index: int) -> float:
    """~4 kW at night, 10-20 kW during working hours."""
    h = _local_hour(slot_index)
    if 8.0 <= h < 18.0:
        return 16.0
    if 18.0 <= h < 22.0:
        return 11.0
    return 4.0


def _input(slots: int, max_feed_in_kw: float | None = MAX_FEED_IN_KW) -> OptimizationInput:
    idx = range(slots)
    starts = [NOW + timedelta(minutes=15 * i) for i in idx]
    spot = [_spot_eur_mwh(i) for i in idx]
    return OptimizationInput(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=DEVICE,
        battery=BATTERY,
        slot_starts=starts,
        prices_eur_mwh=spot,
        load_kw=[_load_kw(i) for i in idx],
        pv_kw=[_pv_kw(i) for i in idx],
        initial_soc_kwh=INITIAL_SOC_KWH,
        # EEG plant: only PV may charge the battery. That is what makes the
        # midday surplus the ONLY refill channel, and therefore what makes the
        # missing second evening so expensive.
        netzladen_erlaubt=False,
        import_price_eur_mwh=[IMPORT_CT_KWH * 10.0] * slots,
        export_value_eur_mwh=list(spot),
        max_feed_in_kw=max_feed_in_kw,
    )


def _solve(slots: int, max_feed_in_kw: float | None = MAX_FEED_IN_KW):
    return optimize(_input(slots, max_feed_in_kw), uuid4(), NOW)


def _curtailed_kwh(plan, upto: int | None = None) -> float:
    return sum(s.curtail_kw for s in plan.slots[:upto]) * SLOT_H


def _charged_kwh(plan, upto: int | None = None) -> float:
    return sum(max(s.battery_kw, 0.0) for s in plan.slots[:upto]) * SLOT_H


def _soc_pct_at(plan, slot_index: int) -> float:
    return plan.slots[slot_index].soc_kwh / BATTERY.capacity_kwh * 100.0


#: The next day's evening peak (local 18:00-22:00), as slot indices. The old
#: 24 h window ends inside its SECOND quarter hour, so it catches 2 of 16 slots
#: - that is the whole point: the plan sees the peak start and none of the
#: hours the battery exists for.
NEXT_EVENING = [
    i for i in range(90, 120) if 18.0 <= _local_hour(i) < 22.0
]
#: The last slot the OLD window covered.
LAST_24H_IDX = 95


@pytest.fixture(scope="module")
def plans():
    """The SAME plant, solved over the old and the new window."""
    return {"h24": _solve(96), "h48": _solve(192)}


def test_the_24h_window_ends_inside_the_next_evening_peak(plans):
    """The premise of the whole increment, asserted rather than assumed.

    From 18:30 the old window reaches 18:15 the next day - it catches the first
    two quarter hours of that evening's four expensive hours and nothing else.
    """
    assert _local_hour(LAST_24H_IDX) == pytest.approx(18.25)
    assert plans["h24"].slots[-1].start == NOW + timedelta(minutes=15 * LAST_24H_IDX)
    inside = [i for i in NEXT_EVENING if i <= LAST_24H_IDX]
    assert len(inside) == 2 and len(NEXT_EVENING) == 16
    # the 48h plan really does reach the rest of it
    assert len(plans["h48"].slots) == 192
    assert plans["h48"].slots[NEXT_EVENING[-1]].start > plans["h24"].slots[-1].start


def test_the_24h_plan_empties_the_battery_the_48h_plan_fills_it(plans):
    """The headline, and the live symptom reproduced.

    With nothing valuable left in its window the 24h plan discharges into
    day-2 daytime load and reaches the window's end at the SoC floor; the 48h
    plan banks the free midday surplus for the evening it can see.
    """
    soc24 = _soc_pct_at(plans["h24"], LAST_24H_IDX)
    soc48 = _soc_pct_at(plans["h48"], LAST_24H_IDX)  # the SAME moment
    assert soc24 < 10.0, soc24          # at the technical floor - the defect
    assert soc48 > 90.0, soc48          # full for the evening - the fix
    assert soc48 - soc24 > 50.0, (soc24, soc48)


def test_the_48h_plan_curtails_measurably_less_of_the_negative_price_surplus(plans):
    """The second half of the defect. Measured over the SAME first 96 slots, so
    the longer plan is not credited with a second day of anything."""
    c24 = _curtailed_kwh(plans["h24"])
    c48 = _curtailed_kwh(plans["h48"], upto=96)
    assert c48 < c24, (c24, c48)
    # a real double-digit-kWh gap, not a rounding difference
    assert c24 - c48 > 40.0, (c24, c48)
    # and the difference really went into the battery
    ch24 = _charged_kwh(plans["h24"])
    ch48 = _charged_kwh(plans["h48"], upto=96)
    assert ch48 - ch24 > 40.0, (ch24, ch48)


def test_the_banked_energy_covers_the_evening_the_old_window_could_not_see(plans):
    """What the banked kWh are FOR: the 48h plan buys nothing at 25 ct during
    the next evening's peak - the hours the 24h window never reached."""
    beyond = [i for i in NEXT_EVENING if i > LAST_24H_IDX]
    imported = sum(max(plans["h48"].slots[i].grid_kw, 0.0) for i in beyond) * SLOT_H
    assert imported == pytest.approx(0.0, abs=1e-6), imported


def test_the_first_96_slots_are_a_better_plan_not_a_different_promise(plans):
    """The longer horizon must not buy its second day by degrading the first:
    over the slots BOTH plans cover it never imports more energy."""
    imp24 = sum(max(s.grid_kw, 0.0) for s in plans["h24"].slots) * SLOT_H
    imp48 = sum(max(s.grid_kw, 0.0) for s in plans["h48"].slots[:96]) * SLOT_H
    assert imp48 <= imp24 + 1e-6, (imp24, imp48)


def test_without_a_feed_in_cap_only_the_holding_changes_and_the_test_says_so():
    """⚠ The honest limit of this increment, pinned so it cannot be overclaimed.

    Loosen the connection point and the terminal value derives to a real number
    again; the 24h plan then already fills the battery, and BOTH plans curtail
    exactly the same energy - the surplus simply exceeds the usable band, and a
    horizon cannot make a battery bigger. What still improves is the HOLDING:
    the 24h plan spends part of its charge on the evening sliver its window
    happens to catch, the 48h plan keeps it for the whole evening.
    """
    p24, p48 = _solve(96, max_feed_in_kw=None), _solve(192, max_feed_in_kw=None)
    assert _curtailed_kwh(p24) == pytest.approx(_curtailed_kwh(p48, upto=96), abs=1e-6)
    assert _charged_kwh(p24) == pytest.approx(_charged_kwh(p48, upto=96), abs=1e-6)
    soc24 = _soc_pct_at(p24, LAST_24H_IDX)
    soc48 = _soc_pct_at(p48, LAST_24H_IDX)
    assert soc48 > soc24 + 15.0, (soc24, soc48)


def test_a_96_slot_request_reproduces_the_old_plan_exactly(plans):
    """The rollback lever is real: asking for 96 slots gives the 96-slot plan.

    ``OPTIMIZER_HORIZON_SLOTS`` is only a REQUEST passed into ``gather_inputs``;
    this pins that the solver itself carries no 48h-specific behaviour a
    rolled-back fleet would still be running.
    """
    again = _solve(96)
    for a, b in zip(plans["h24"].slots, again.slots):
        assert a.battery_kw == pytest.approx(b.battery_kw, abs=1e-9)
        assert a.curtail_kw == pytest.approx(b.curtail_kw, abs=1e-9)


# ---------------------------------------------------------------------------
# Runtime (brief item 7d)
# ---------------------------------------------------------------------------

#: Generous per-site p95 budget for a 192-slot solve, in the spirit of
#: ``test_consumer_runtime``: measured on Apple Silicon a 192-slot solve WITH
#: the explain LP re-solve takes ~0.25 s (0.30 s with peak shaving) against
#: ~0.12 s for 96 slots - roughly a factor 2, and far inside the 15-min cycle.
#: The budget is set an order of magnitude above the measurement so a slower CI
#: box cannot make this flaky; it exists to catch a REGIME change (an
#: accidentally quadratic term), not to police milliseconds.
BUDGET_P95_SECONDS = 3.0


def test_a_192_slot_solve_stays_far_inside_the_cycle_budget():
    import statistics
    import time

    inp = _input(192)
    optimize(inp, uuid4(), NOW)  # warm up HiGHS/Pyomo
    durations = []
    for _ in range(5):
        started = time.perf_counter()
        optimize(inp, uuid4(), NOW)
        durations.append(time.perf_counter() - started)
    durations.sort()
    p95 = durations[-1]
    print(
        f"\n192-slot solve: p50={statistics.median(durations):.3f}s "
        f"p95={p95:.3f}s max={durations[-1]:.3f}s"
    )
    assert p95 < BUDGET_P95_SECONDS, f"p95 {p95:.3f}s exceeds {BUDGET_P95_SECONDS}s"

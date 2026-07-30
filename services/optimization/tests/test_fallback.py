"""Forecast-fallback tests: the persistence baseline is REUSED from
services/forecast (predict-then-optimize - no duplicated forecasting logic
in the optimizer). Skips when the sibling package is not installed.

Also covers the PV *night floor* (:func:`night_floor_pv`), the fix for the
"Batterie lädt Solarstrom" at night bug: the persistence fallback reuses the
LOAD forecaster and has no night-zero knowledge, so on short/reset history it
smears the last observed daytime PV value across every night slot - phantom
night "Solarstrom" that mislabels a real night grid-charge and can even satisfy
the EEG solar-only-charge constraint. The night floor zeros PV wherever the sun
is below the horizon at the site's location.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

pytest.importorskip(
    "voltpilot_forecast",
    reason="sibling services/forecast not installed (pip install -e ../forecast)",
)

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.solar import solar_position

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.fallback import night_floor_pv, persistence_forecast

T0 = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)

# Berlin, Germany - a real DACH site location. In July, ~20:00 UTC (22:00 CEST)
# through ~04:00 CEST is deep night (sun well below the horizon).
BERLIN_LAT, BERLIN_LON = 52.52, 13.405

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)


def _is_night(when: datetime) -> bool:
    location = GeoLocation(latitude=BERLIN_LAT, longitude=BERLIN_LON)
    return not solar_position(location, when).is_daytime


def _short_history_ending_in_daylight(now: datetime, last_kw: float):
    """5 h of daytime PV telemetry ending at ``now`` (< the 24 h persistence
    lookback), so persistence_forecast hits its 'flat repeat of the last value'
    branch - the §4b short/reset-history scenario that fabricates night PV."""
    return [
        (now - timedelta(hours=5) + i * timedelta(minutes=15), last_kw)
        for i in range(20)
    ]


def test_repeats_yesterdays_same_slot_value():
    # Two days of 15-min history with a distinctive daily shape: value = hour.
    history = []
    for day in (2, 1):
        day_start = T0 - timedelta(days=day, hours=12)
        for quarter in range(96):
            ts = day_start + quarter * timedelta(minutes=15)
            history.append((ts, float(ts.hour)))
    slot_starts = horizon_slot_starts(T0, 96)
    values = persistence_forecast(history, slot_starts)
    assert len(values) == 96
    for start, value in zip(slot_starts, values):
        assert value == pytest.approx(float(start.hour)), start


def test_fallback_uses_the_slot_mean_not_a_single_sample():
    """The optimizer's OWN forecast path plans the quarter-hour MEAN too.

    The second consumer of the shared forecaster (the collector is the first):
    raw telemetry at a ~10 s cadence, ~90 samples per slot with an outlier at the
    slot end. Both paths must read the same quantity, else a stored run and a
    fallback run would plan two different loads for the same quarter hour.
    """
    slot_starts = horizon_slot_starts(T0, 4)
    yesterday = slot_starts[0] - timedelta(days=1)

    history = [
        (yesterday + timedelta(seconds=10 * i), 10.0) for i in range(89)
    ]
    history.append((yesterday + timedelta(seconds=890), 2.0))  # the last sample
    expected_mean = (89 * 10.0 + 2.0) / 90

    values = persistence_forecast(history, slot_starts)
    assert values[0] == pytest.approx(expected_mean, abs=1e-3)
    assert values[0] != 2.0  # never the single trailing sample


def test_empty_history_yields_zeros():
    slot_starts = horizon_slot_starts(T0, 8)
    assert persistence_forecast([], slot_starts) == [0.0] * 8


def test_empty_horizon_yields_empty():
    assert persistence_forecast([(T0, 1.0)], []) == []


# --- PV night floor ---------------------------------------------------------

# 20:00 UTC = 22:00 CEST: the horizon opens in deep night and runs into the
# next day's daylight, exactly the screenshot's 22:15 situation.
NIGHT_START = datetime(2026, 7, 10, 20, 0, tzinfo=timezone.utc)


def test_night_floor_zeros_phantom_night_pv_and_keeps_daytime():
    # Short history -> persistence smears the last daytime value (3.5 kW) across
    # the WHOLE horizon, night included (the phantom PV that reads as solar).
    history = _short_history_ending_in_daylight(NIGHT_START, 3.5)
    slot_starts = horizon_slot_starts(NIGHT_START, 96)
    phantom = persistence_forecast(history, slot_starts)
    assert phantom == [3.5] * 96  # every slot fabricated non-zero, day AND night

    floored, zeroed = night_floor_pv(phantom, slot_starts, BERLIN_LAT, BERLIN_LON)

    assert len(zeroed) > 0  # the fabrication was caught
    for start, value in zip(slot_starts, floored):
        if _is_night(start):
            assert value == 0.0, f"night slot {start} must be floored to 0"
        else:
            assert value == 3.5, f"daytime slot {start} must be preserved"
    # zeroed indices are exactly the night slots.
    assert {slot_starts[i] for i in zeroed} == {
        s for s in slot_starts if _is_night(s)
    }


def test_stored_physical_pv_is_a_noop_for_the_night_floor():
    # A trustworthy physical forecast is already 0 at night, so the defensive
    # floor (applied regardless of source) changes nothing and zeros nothing.
    slot_starts = horizon_slot_starts(NIGHT_START, 96)
    physical = [0.0 if _is_night(s) else 4.0 for s in slot_starts]

    floored, zeroed = night_floor_pv(physical, slot_starts, BERLIN_LAT, BERLIN_LON)

    assert floored == physical
    assert zeroed == []


def test_night_floor_leaves_load_fallback_untouched():
    # The night mask is PV-specific: the LOAD persistence fallback stays flat at
    # night (people consume power at night), so it must never be floored. The
    # optimizer only ever calls night_floor_pv on the PV series.
    history = _short_history_ending_in_daylight(NIGHT_START, 1.2)
    slot_starts = horizon_slot_starts(NIGHT_START, 96)
    load = persistence_forecast(history, slot_starts)
    assert load == [1.2] * 96  # persisted flat, night included - correct for load
    # Sanity: applying the mask WOULD have changed it, proving the fix's value
    # comes from NOT masking load.
    floored_if_wrongly_masked, _ = night_floor_pv(
        load, slot_starts, BERLIN_LAT, BERLIN_LON
    )
    assert any(v == 0.0 for v in floored_if_wrongly_masked)


def test_night_floor_without_coordinates_leaves_series_unclamped():
    # A site with no latitude/longitude can't run solar geometry; the series is
    # returned unchanged and the optimizer still runs (never raises).
    slot_starts = horizon_slot_starts(NIGHT_START, 96)
    phantom = [3.5] * 96
    for lat, lon in ((None, None), (BERLIN_LAT, None), (None, BERLIN_LON)):
        floored, zeroed = night_floor_pv(phantom, slot_starts, lat, lon)
        assert floored == phantom
        assert floored is not phantom  # a copy, safe to mutate
        assert zeroed == []


def test_gather_inputs_night_floor_warns_when_site_has_no_coordinates(caplog):
    # The inputs-side glue: when the PV fallback fires but the site has no
    # coordinates, it logs a distinct warning and returns the series unclamped
    # (the optimizer must still run).
    import logging

    from voltpilot_optimization.inputs import BatterySite, _night_floor_pv_input

    site = BatterySite(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0
        ),
        netzladen_erlaubt=True,
        latitude=None,
        longitude=None,
    )
    slot_starts = horizon_slot_starts(NIGHT_START, 8)
    phantom = [3.5] * 8

    with caplog.at_level(logging.WARNING, logger="voltpilot.optimization.inputs"):
        out = _night_floor_pv_input(site, slot_starts, phantom, used_fallback=True)

    assert out == phantom  # unclamped, no crash
    assert any("no_coordinates" in r.message for r in caplog.records)


def test_gather_inputs_night_floor_warns_on_fabricated_night_pv(caplog):
    import logging

    from voltpilot_optimization.inputs import BatterySite, _night_floor_pv_input

    site = BatterySite(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0
        ),
        netzladen_erlaubt=True,
        latitude=BERLIN_LAT,
        longitude=BERLIN_LON,
    )
    slot_starts = horizon_slot_starts(NIGHT_START, 8)  # all night
    phantom = [3.5] * 8

    with caplog.at_level(logging.WARNING, logger="voltpilot.optimization.inputs"):
        out = _night_floor_pv_input(site, slot_starts, phantom, used_fallback=True)

    assert out == [0.0] * 8  # every night slot floored
    assert any("night_floor_applied" in r.message for r in caplog.records)


# --- End-to-end: the floor fixes the real solved-plan symptoms (§5 repro) ----


def _phantom_and_floored(now: datetime, last_kw: float):
    history = _short_history_ending_in_daylight(now, last_kw)
    slot_starts = horizon_slot_starts(now, 96)
    phantom = persistence_forecast(history, slot_starts)
    floored, _ = night_floor_pv(phantom, slot_starts, BERLIN_LAT, BERLIN_LON)
    return slot_starts, phantom, floored


def _make_input(slot_starts, pv_kw, netzladen_erlaubt):
    # Cheap night / pricier day price curve (the arbitrage incentive to charge
    # overnight), 169 EUR/MWh at night = the screenshot's 16,9 ct/kWh.
    prices = [169.0 if _is_night(s) else 300.0 for s in slot_starts]
    battery = BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
    )
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=slot_starts,
        prices_eur_mwh=prices,
        load_kw=[1.0] * len(slot_starts),
        pv_kw=pv_kw,
        initial_soc_kwh=1.0,  # low SoC, so charging overnight is attractive
        netzladen_erlaubt=netzladen_erlaubt,
    )


DEADBAND_KW = 0.05  # frontend/portal/src/schedule.ts SLOT_DEADBAND_KW


def _night_charge_slots(plan):
    return [s for s in plan.slots if _is_night(s.start) and s.battery_kw > DEADBAND_KW]


@needs_highs
def test_solved_night_charge_persists_positive_grid_after_floor():
    from voltpilot_optimization.solver import optimize

    slot_starts, phantom, floored = _phantom_and_floored(NIGHT_START, 3.5)

    # The BUG (phantom PV): a real night charge nets against fabricated PV, so
    # its persisted grid_kw falls at/below the portal deadband -> reads solar.
    buggy = optimize(_make_input(slot_starts, phantom, True), uuid4(), NIGHT_START)
    buggy_night = _night_charge_slots(buggy)
    assert buggy_night, "phantom PV must produce at least one night charge slot"
    assert any(
        s.grid_kw <= DEADBAND_KW for s in buggy_night
    ), "the bug: a night charge whose grid_kw reads as 'solarladen'"

    # The FIX (night-floored PV): every night charge is now an honest grid
    # charge - grid_kw well above the deadband -> renders 'netzladen'.
    fixed = optimize(_make_input(slot_starts, floored, True), uuid4(), NIGHT_START)
    fixed_night = _night_charge_slots(fixed)
    assert fixed_night, "the cheap-night arbitrage charge is still planned"
    for s in fixed_night:
        assert s.pv_kw == 0.0, f"no fabricated night PV at {s.start}"
        assert s.grid_kw > DEADBAND_KW, (
            f"night charge at {s.start} must persist a positive grid_kw "
            f"(got {s.grid_kw})"
        )


@needs_highs
def test_eeg_night_charge_loophole_closed_by_floor():
    from voltpilot_optimization.solver import optimize

    slot_starts, phantom, floored = _phantom_and_floored(NIGHT_START, 3.5)

    # The BUG: phantom night "PV surplus" SATISFIES the Ausschliesslichkeits-
    # prinzip constraint, so the optimizer plans overnight "solar" charging.
    buggy = optimize(_make_input(slot_starts, phantom, False), uuid4(), NIGHT_START)
    assert _night_charge_slots(buggy), (
        "phantom PV fools the EEG solar-only constraint into planning a night "
        "charge"
    )

    # The FIX: with PV floored to 0 at night, solar_only_charge requires
    # charge <= pv - curtail = 0, so no night charge is feasible at all.
    fixed = optimize(_make_input(slot_starts, floored, False), uuid4(), NIGHT_START)
    assert not _night_charge_slots(fixed), (
        "night-floored PV leaves no phantom surplus, so the EEG constraint can "
        "no longer be satisfied at night"
    )

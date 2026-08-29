"""The running slot is answered from telemetry, not from a forecast.

Three layers, the house pattern:

- the pure RULE (:mod:`voltpilot_optimization.pv_nowcast`);
- the ``gather_inputs`` WIRING against the fake psycopg of ``test_nowcast``;
- and the incident itself through the REAL solver - measured PV 1.3 kW against
  a 2.7 kW house at Pilsting on 28.08.2026, where the plan had assumed a 3 kW
  surplus and bought 1.4 kW at 25 ct with the battery at 92 %.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import pv_nowcast
from voltpilot_optimization.config import (
    pv_nowcast_decay_slots,
    pv_nowcast_enabled,
    pv_nowcast_lookback,
    pv_nowcast_max_age,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import BatterySite, gather_inputs
from voltpilot_optimization.pricing import SiteTariff
from voltpilot_optimization.pv_nowcast import apply_pv_nowcast, window_mean

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

NOW = datetime(2026, 8, 28, 17, 37, tzinfo=timezone.utc)  # 19:37 lokal
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SLOTS = 16  # == MIN_HORIZON_SLOTS


# ---- the rule ---------------------------------------------------------------


def test_the_running_slot_becomes_the_measurement_itself():
    out = apply_pv_nowcast([5.7, 5.5, 5.0, 4.0], 1.3, decay_slots=2)
    assert out[0] == pytest.approx(1.3)


def test_the_correction_fades_linearly_and_then_leaves_the_forecast_alone():
    out = apply_pv_nowcast([5.7, 5.7, 5.7, 5.7, 5.7], 1.3, decay_slots=2)
    assert out[0] == pytest.approx(1.3)  # weight 1.0
    assert out[1] == pytest.approx(5.7 - 4.4 / 2)  # weight 0.5
    assert out[2] == pytest.approx(5.7)  # weight 0 - the model owns it again
    assert out[3:] == pytest.approx([5.7, 5.7])


def test_it_lifts_as_readily_as_it_lowers():
    """Symmetric on purpose: an under-forecast morning is the same defect."""
    out = apply_pv_nowcast([2.0, 2.0, 2.0], 9.0, decay_slots=2)
    assert out[0] == pytest.approx(9.0)
    assert out[1] > 2.0


def test_no_measurement_returns_the_forecast_byte_for_byte():
    forecast = [5.7, 5.5, 5.0]
    assert apply_pv_nowcast(forecast, None) == forecast
    assert apply_pv_nowcast([], 1.3) == []


def test_a_broken_channel_is_not_a_fact_to_plan_on():
    """A plant does not generate backwards, and NaN is not a measurement."""
    forecast = [5.7, 5.5, 5.0]
    assert apply_pv_nowcast(forecast, -2.0) == forecast
    assert apply_pv_nowcast(forecast, float("nan")) == forecast
    assert apply_pv_nowcast(forecast, float("inf")) == forecast


def test_the_result_never_goes_negative_or_past_the_nameplate():
    assert apply_pv_nowcast([1.0, 1.0], 0.0, decay_slots=4)[1] >= 0.0
    lifted = apply_pv_nowcast([1.0, 1.0], 90.0, decay_slots=2, capacity_kwp=70.0)
    assert lifted[0] == 70.0


def test_a_zero_measurement_is_evidence_not_absence():
    """The dusk case in the limit: 0 kW measured must reach the plan as 0."""
    assert apply_pv_nowcast([5.7, 5.7], 0.0, decay_slots=2)[0] == 0.0


def test_the_decay_window_must_cover_at_least_the_running_slot():
    with pytest.raises(ValueError):
        apply_pv_nowcast([1.0], 1.0, decay_slots=0)


def test_the_knobs_default_to_the_shipped_values():
    assert pv_nowcast_enabled({}) is True
    assert pv_nowcast_enabled({"OPTIMIZER_PV_NOWCAST_ENABLED": "off"}) is False
    with pytest.raises(ValueError):
        pv_nowcast_enabled({"OPTIMIZER_PV_NOWCAST_ENABLED": "maybe"})
    assert pv_nowcast_decay_slots({}) == pv_nowcast.DEFAULT_DECAY_SLOTS
    # The same 30 s freshness the load nowcast already trusts.
    assert pv_nowcast_max_age({}) == timedelta(seconds=30)
    # The window the running slot is averaged over: the 2 minutes the load
    # half already reads, and configurable for the cloud/dusk trade-off.
    assert pv_nowcast_lookback({}) == timedelta(minutes=2)
    assert pv_nowcast_lookback(
        {"OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS": "300"}
    ) == timedelta(minutes=5)
    with pytest.raises(ValueError):
        pv_nowcast_lookback({"OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS": "0"})


# ---- the window mean, on the incident's own samples ---------------------------


#: The 24 real telemetry samples of 09:58:03-09:59:58 at Herzogau on
#: 29.08.2026 - the last two minutes before the 10:00 run, ending inside a
#: six-minute cloud. Verbatim from the scout's
#: ``analyse/rohsamples-1000-und-1015.json``; the slot they speak for really
#: ran at a 31.22 kW mean.
HERZOGAU_CLOUD_PV = [
    19.538, 18.957, 22.033, 23.037, 23.037, 22.218, 24.593, 26.078,
    28.308, 23.228, 20.156, 19.786, 19.786, 14.137, 13.131, 13.401,
    11.323, 11.323, 9.678, 9.24, 9.24, 8.945, 8.876, 8.876,
]
HERZOGAU_CLOUD_LOAD = [
    15.072, 14.491, 9.5, 10.504, 10.504, 9.685, 6.823, 8.308,
    10.538, 17.217, 14.145, 8.4, 20.31, 14.661, 13.655, 16.998,
    14.92, 14.92, 15.77, 15.332, 15.332, 15.037, 15.329, 15.329,
]

#: The same two minutes before the NEXT run (10:13:03-10:14:58) - calm sun.
HERZOGAU_CALM_PV = [
    38.985, 38.99, 39.016, 39.036, 39.098, 39.098, 39.138, 39.148,
    39.697, 39.697, 39.889, 39.889, 39.886, 39.906, 39.299, 39.299,
    39.354, 39.354, 39.46, 39.564, 39.6, 39.6, 39.706, 39.746,
]


def test_the_incidents_window_reverses_the_sign_of_the_slot():
    """The single sample said DISCHARGE; the mean of the same data says charge.

    Both estimators read the identical 24 readings. The newest one fell in a
    cloud, and on 29.08.2026 the plan that came out of it commanded -7.17 kW
    while 23 kW went to the grid.
    """
    house = sum(HERZOGAU_CLOUD_LOAD) / len(HERZOGAU_CLOUD_LOAD)

    newest = HERZOGAU_CLOUD_PV[-1]
    assert newest - HERZOGAU_CLOUD_LOAD[-1] < 0.0, "the shipped bug: a deficit"

    mean = window_mean(HERZOGAU_CLOUD_PV)
    assert mean == pytest.approx(17.04, abs=0.01)
    assert mean - house > 0.0, "the window says surplus - charge, not discharge"


def test_the_mean_is_not_the_ewma_of_the_load_path():
    """Non-vacuous: an exponential weighting inherits the same coin toss.

    alpha 0.35 over the identical samples lands at 9.1 kW - still a deficit,
    still the wrong sign. That is why this half is an arithmetic mean.
    """
    ewma = None
    for v in HERZOGAU_CLOUD_PV:
        ewma = v if ewma is None else 0.35 * v + 0.65 * ewma

    assert ewma == pytest.approx(9.30, abs=0.01)
    assert ewma < HERZOGAU_CLOUD_LOAD[-1], "the EWMA would still see a deficit"
    assert window_mean(HERZOGAU_CLOUD_PV) > ewma + 5.0


def test_in_calm_sun_the_mean_costs_nothing():
    """The guard against over-correcting: where the sample was fine, it stays fine.

    Same plant, two minutes later, no cloud - newest sample and window mean
    agree to well within a kW, so the mean only ever removes the coin toss.
    """
    assert window_mean(HERZOGAU_CALM_PV) == pytest.approx(
        HERZOGAU_CALM_PV[-1], abs=0.5
    )


def test_no_samples_is_no_evidence_and_never_a_zero():
    assert window_mean([]) is None
    assert window_mean([float("nan"), float("inf")]) is None
    assert window_mean([0.0]) == 0.0  # a measured zero IS evidence


# ---- the curtailed slot (Glied 1b) -------------------------------------------


def test_a_capped_reading_may_lift_the_forecast_but_never_lower_it():
    """Our own cap is not the plant's potential - only a floor of it."""
    forecast = [30.0, 30.0, 30.0]

    # 10:45 at Herzogau: the plant was pinned AT the cap, so the reading was
    # the cap. Reading it as potential shrank the plan and the cap fell away.
    assert apply_pv_nowcast(forecast, 12.0, raise_only=True) == forecast
    # But proven output above the forecast is still proof.
    assert apply_pv_nowcast(forecast, 37.5, raise_only=True)[0] == pytest.approx(37.5)


def test_without_a_cap_the_correction_stays_two_sided():
    """Non-vacuous twin: the same reading lowers when nothing is capping."""
    forecast = [30.0, 30.0, 30.0]
    assert apply_pv_nowcast(forecast, 12.0)[0] == pytest.approx(12.0)


def test_raise_only_leaves_an_exactly_matching_forecast_byte_for_byte():
    forecast = [30.0, 20.0]
    assert apply_pv_nowcast(forecast, 30.0, raise_only=True) == forecast


# ---- the gather_inputs wiring ------------------------------------------------


class _FakeCursor:
    """Answers gather_inputs' real queries from in-memory tables."""

    def __init__(self, world) -> None:
        self._world = world
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        world = self._world
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 100.0) for ts in world.horizon]
        elif "FROM forecast" in sql and "run_at < time" in sql:
            self._rows = []
        elif "FROM forecast" in sql:
            kind = params[1]
            series = world.pv_forecast if kind == "pv" else world.load_forecast
            self._rows = [(ts, series) for ts in world.horizon]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            # _fresh_measurement: soc_pct / grid_limit_kw.
            reading = world.latest.get(_column_of(sql))
            self._rows = [reading] if reading else []
        elif "FROM telemetry" in sql and "pv_power_kw" in sql:
            # _recent_pv_samples: the window the running slot is averaged over.
            lo, hi = params[2], params[3]
            self._rows = [(ts, kw) for ts, kw in world.pv_samples if lo <= ts <= hi]
        elif "FROM telemetry" in sql:
            self._rows = []  # _recent_load_samples
        elif "FROM schedule" in sql:
            # _running_slot_curtailed: the plan in force over the running slot.
            self._rows = [(world.curtail_kw,)] if world.curtail_kw is not None else []
        elif "FROM monthly_market_value" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def _column_of(sql: str) -> str:
    for column in ("grid_limit_kw", "soc_pct"):
        if f"SELECT time, {column} FROM telemetry" in sql:
            return column
    raise AssertionError(f"unrecognised single-reading query: {sql}")


@pytest.fixture()
def world(monkeypatch):
    state = SimpleNamespace(
        horizon=horizon_slot_starts(NOW, SLOTS),
        pv_forecast=5.7,
        load_forecast=2.7,
        latest={},
        pv_samples=[],  # [(ts, kw)] - what _recent_pv_samples reads
        curtail_kw=None,  # the plan in force over the running slot
    )

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor(state)

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    for var in (
        "VOLTPILOT_ACTIVE_LOAD_MODEL",
        "VOLTPILOT_ACTIVE_PV_MODEL",
        "OPTIMIZER_PV_ANCHOR_ENABLED",
        "OPTIMIZER_PV_NOWCAST_ENABLED",
        "OPTIMIZER_PV_NOWCAST_DECAY_SLOTS",
        "OPTIMIZER_PV_NOWCAST_MAX_AGE_SECONDS",
        "OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS",
        "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH",
    ):
        monkeypatch.delenv(var, raising=False)
    return state


def _site() -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=65.0,
            max_charge_kw=30.0,
            max_discharge_kw=30.0,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=False,
        latitude=48.7,
        longitude=12.65,
        tariff=SiteTariff(pv_capacity_kwp=100.0),
    )


def _flat_samples(value: float, *, until: datetime, n: int = 12) -> list:
    """``n`` samples ending at ``until``, 5 s apart - the real telemetry rate."""
    return [(until - timedelta(seconds=5 * i), value) for i in range(n - 1, -1, -1)]


def test_a_fresh_reading_replaces_the_running_slots_forecast(world):
    """The incident's numbers: the plan stops seeing a surplus that is not there."""
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(seconds=8))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(1.3)
    assert inp.pv_kw[0] - inp.load_kw[0] < 0.0  # a deficit, not a 3 kW surplus
    # Slot 1 is half-corrected; from slot 2 the model owns the horizon again -
    # here the night floor then zeroes it, sunset being 18:05 UTC that day.
    assert inp.pv_kw[1] == pytest.approx(5.7 - 4.4 / 2)


def test_the_running_slot_is_the_MEAN_of_the_window_not_the_newest_sample(world):
    """Herzogau 29.08.2026: one sample out of ~180 decided the slot's sign.

    The window here is the real one - a cloud passing through, ending on its
    darkest sample. Averaged it is a surplus; the newest reading alone was a
    deficit, and the plan that came out of it commanded a DISCHARGE while
    23 kW went to the grid.
    """
    world.pv_forecast = 33.12  # the run's own forecast, reconstructed in §3.1
    cloud = [22.0, 24.6, 19.8, 13.1, 11.3, 9.7, 8.9]
    world.pv_samples = [
        (NOW - timedelta(seconds=5 * (len(cloud) - i)), v) for i, v in enumerate(cloud)
    ]
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    assert inp.pv_kw[0] == pytest.approx(sum(cloud) / len(cloud), abs=1e-6)
    assert inp.pv_kw[0] > cloud[-1] + 5.0, "the newest sample must not own the slot"


def test_a_stale_window_leaves_the_forecast_alone(world):
    """Older than the freshness window means the link is down, not a value.

    A WINDOW of stale readings is no more evidence than one stale reading, so
    the gate is on the NEWEST sample - the rule the load half already uses.
    """
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(minutes=20))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_no_reading_at_all_leaves_the_forecast_alone(world):
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_only_the_lookback_window_speaks_for_the_running_slot(world, monkeypatch):
    """Samples older than the lookback are outside the question being asked."""
    world.pv_samples = [
        (NOW - timedelta(minutes=9), 40.0),  # long past, must not count
        (NOW - timedelta(seconds=10), 1.3),
        (NOW - timedelta(seconds=5), 1.3),
    ]
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(1.3)

    # ... and widening the window lets the older sample back in.
    monkeypatch.setenv("OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS", "900")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx((40.0 + 1.3 + 1.3) / 3)


def test_a_curtailed_running_slot_may_only_be_LIFTED_by_the_measurement(world):
    """Glied 1b: our own cap must not be read back as the plant's potential.

    A curtailed slot holds the plant BELOW what it could make, so a reading
    under the forecast proves nothing and is refused; one ABOVE it still proves
    the plant makes at least that much and is applied.
    """
    world.curtail_kw = 8.0  # the plan in force is capping this slot
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(seconds=8))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7), "a capped reading must not lower"

    world.pv_samples = _flat_samples(9.0, until=NOW - timedelta(seconds=8))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(9.0), "proven output is still a floor"


def test_an_uncurtailed_slot_keeps_the_two_sided_correction(world):
    """Non-vacuous twin: the SAME reading lowers when no cap is in force."""
    world.curtail_kw = 0.0
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(seconds=8))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(1.3)


def test_the_kill_switch_restores_the_previous_behaviour(world, monkeypatch):
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(seconds=8))
    monkeypatch.setenv("OPTIMIZER_PV_NOWCAST_ENABLED", "false")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_a_garbage_knob_drops_the_correction_instead_of_the_plan(world, monkeypatch):
    world.pv_samples = _flat_samples(1.3, until=NOW - timedelta(seconds=8))
    monkeypatch.setenv("OPTIMIZER_PV_NOWCAST_DECAY_SLOTS", "not-a-number")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)  # fail-soft, and a plan still exists


def test_the_night_floor_still_has_the_last_word(world):
    """A measurement cannot outrank physics: after sunset the input is 0."""
    night = datetime(2026, 8, 28, 21, 30, tzinfo=timezone.utc)  # 23:30 lokal
    world.horizon = horizon_slot_starts(night, SLOTS)
    world.pv_samples = _flat_samples(1.3, until=night - timedelta(seconds=8))
    inp = gather_inputs("postgresql://fake", _site(), night, SLOTS)
    assert inp.pv_kw[0] == 0.0


# ---- through the real solver -------------------------------------------------


BATTERY = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
)


#: 16 h from 19:30 local: the two dusk quarters, the night, then the next
#: morning's sun. The shape the incident really sat in - the battery was at
#: 92 % on the evening before a sunny day, so a stored kWh is worth the ~9 ct
#: it costs to refill it, not the 25 ct of the retail tariff.
DUSK_SLOTS = 2
NIGHT_SLOTS = 46
MORNING_SLOTS = 16


def _plan(first_two_pv_kw: float, load_kw: float = 2.7):
    from voltpilot_optimization.solver import optimize

    pv = (
        [first_two_pv_kw] * DUSK_SLOTS
        + [0.0] * NIGHT_SLOTS
        + [20.0] * MORNING_SLOTS
    )
    n = len(pv)
    spot = [70.0] * n  # 7 ct/kWh feed-in - well under the retail price
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BATTERY,
        slot_starts=horizon_slot_starts(NOW, n),
        prices_eur_mwh=spot,
        load_kw=[load_kw] * n,
        pv_kw=pv,
        initial_soc_kwh=0.92 * 65.0,  # the observed 92 %
        netzladen_erlaubt=False,
        import_price_eur_mwh=[250.0] * n,  # the 25 ct that was actually paid
        export_value_eur_mwh=spot,
    )
    return optimize(inp, plan_id=uuid4(), generated_at=NOW)


@needs_highs
def test_the_measured_slot_covers_the_house_instead_of_buying_it():
    """The incident end to end: 1.3 kW of PV, a 2.7 kW house, a full battery.

    With the phantom surplus gone the plan discharges the ~1.4 kW deficit and
    marks the slot for the edge to follow the measured house - the two halves
    of "no grid purchase here" (:mod:`voltpilot_optimization.slot_trim`).
    """
    first = _plan(first_two_pv_kw=1.3).slots[0]

    assert first.battery_kw == pytest.approx(-1.4, abs=0.05)
    assert first.grid_kw == pytest.approx(0.0, abs=0.05)
    assert first.cover_load_from_battery
    assert first.slot_role == "eigenverbrauch"


@needs_highs
def test_the_phantom_surplus_would_have_planned_the_opposite():
    """Non-vacuous: the SAME plant on the OLD forecast does something else.

    5.7 kW against the same 2.7 kW house is a 3 kW surplus, so the plan stores
    or sells instead of covering, and carries no duty to follow the house.
    This is the plan the box was actually running.
    """
    first = _plan(first_two_pv_kw=5.7).slots[0]
    assert first.battery_kw > -1.0, "a surplus slot must not plan the deficit away"
    assert not first.cover_load_from_battery


# ---- Herzogau 29.08.2026, through the real solver -----------------------------


HERZOGAU_NOW = datetime(2026, 8, 29, 8, 0, tzinfo=timezone.utc)  # 10:00 lokal

#: The real DE-LU day-ahead prices of the 56 slots the 10:00 run planned
#: (energy-charts, ``prices/de-lu-2026-08-29.json``). Negative right through
#: the incident, so an exported kWh was worth nothing - the market premium is
#: suspended under section 51 at a negative spot, which is why the export value
#: below is the bare spot.
HERZOGAU_SPOT_EUR_MWH = [
    -0.01, -0.1, -0.51, -0.75, -1.1, -1.35, -1.39, -1.58,
    -1.57, -1.78, -1.88, -2.02, -1.91, -1.89, -1.69, -1.56,
    -1.53, -1.29, -1.0, -0.88, -0.08, -0.01, 0.0, 0.0,
    0.0, 1.66, 30.88, 65.78, 51.44, 100.78, 131.42, 168.33,
    146.48, 152.72, 185.46, 201.35, 183.9, 191.92, 205.57, 214.47,
    217.5, 198.94, 181.76, 180.92, 205.71, 179.29, 166.74, 158.33,
    181.9, 162.32, 158.1, 151.65, 150.77, 146.47, 145.54, 139.68,
]

#: The run's own inputs for the running slot, reconstructed from the two plan
#: payloads the box handed out (report section 3.1): PV 33.12 kW against a
#: 16.05 kW house. The reconstruction is checked by the test itself - feeding
#: the newest sample back in has to reproduce the -7.17 kW that was really
#: commanded.
HERZOGAU_PV_FORECAST_KW = 33.12
HERZOGAU_LOAD_FORECAST_KW = 16.05


def _herzogau_plan(measured_kw: float, *, raise_only: bool = False):
    """The 10:00 run with ``measured_kw`` speaking for the running slot."""
    from voltpilot_optimization.solver import optimize

    n = len(HERZOGAU_SPOT_EUR_MWH)
    # A plain sunny-day shape for the rest of the horizon; only slot 0 carries
    # the reconstructed forecast, and only slot 0 is asserted on.
    pv = [HERZOGAU_PV_FORECAST_KW] + [
        max(0.0, 50.0 * math.sin(math.pi * ((10.0 + i * 0.25) - 6.0) / 14.0))
        if 6.0 < 10.0 + i * 0.25 < 20.0
        else 0.0
        for i in range(1, n)
    ]
    pv = apply_pv_nowcast(
        pv, measured_kw, decay_slots=2, capacity_kwp=100.0, raise_only=raise_only
    )
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BatteryParams(
            capacity_kwh=65.0,
            max_charge_kw=30.0,
            max_discharge_kw=30.0,
            roundtrip_efficiency=0.92,
            wear_cost_ct_per_kwh=1.0,  # the site's override
        ),
        slot_starts=horizon_slot_starts(HERZOGAU_NOW, n),
        prices_eur_mwh=HERZOGAU_SPOT_EUR_MWH,
        load_kw=[HERZOGAU_LOAD_FORECAST_KW] * n,
        pv_kw=pv,
        initial_soc_kwh=0.19 * 65.0,  # the observed 19 %
        netzladen_erlaubt=False,
        import_price_eur_mwh=[250.0] * n,
        export_value_eur_mwh=HERZOGAU_SPOT_EUR_MWH,
    )
    return pv[0], optimize(inp, plan_id=uuid4(), generated_at=HERZOGAU_NOW).slots[0]


@needs_highs
def test_the_newest_sample_reproduces_the_commanded_discharge():
    """The control: the shipped estimator really does produce the incident.

    Without this the test below would only show that a different number gives
    a different plan. Feeding back the newest sample of the real window lands
    on -7.17 kW - the value the box was actually given, to the watt.
    """
    pv0, slot = _herzogau_plan(HERZOGAU_CLOUD_PV[-1])

    assert pv0 == pytest.approx(8.876)
    assert slot.battery_kw == pytest.approx(-7.17, abs=0.01), "the plan of 10:00"
    assert slot.battery_kw < 0.0, "a DISCHARGE while 23 kW went to the grid"


@needs_highs
def test_the_window_mean_charges_the_same_slot_instead():
    """Fix A end to end: the same run, the same 24 readings, averaged.

    The sign flips. The magnitude is small because the plan's own load
    forecast (16.05 kW) was higher than the house really drew (13.45 kW), but
    the decision - store rather than discharge - is the one that was missing.
    """
    pv0, slot = _herzogau_plan(window_mean(HERZOGAU_CLOUD_PV))

    assert pv0 == pytest.approx(17.04, abs=0.01)
    assert slot.battery_kw > 0.0, "a charge, not a discharge"
    assert slot.grid_kw == pytest.approx(0.0, abs=0.05), "and nothing bought"


@needs_highs
def test_a_capped_slot_keeps_the_forecast_and_the_full_charge():
    """Glied 1b, 10:45: the reading was our own cap, so it may not shrink the plan.

    Reading the capped 12 kW as potential is what let the cap fall away and put
    16 kW into the grid at a negative price. Refusing it leaves the forecast in
    force, and the plan charges the full reconstructed surplus.
    """
    pv0, slot = _herzogau_plan(12.0, raise_only=True)

    assert pv0 == pytest.approx(HERZOGAU_PV_FORECAST_KW)
    assert slot.battery_kw == pytest.approx(17.07, abs=0.01)


@needs_highs
def test_without_the_cap_the_same_reading_would_shrink_the_plan():
    """Non-vacuous twin of the test above: the guard is what makes the difference."""
    pv0, slot = _herzogau_plan(12.0)

    assert pv0 == pytest.approx(12.0)
    assert slot.battery_kw < 5.0, "the shrunken plan the incident really made"

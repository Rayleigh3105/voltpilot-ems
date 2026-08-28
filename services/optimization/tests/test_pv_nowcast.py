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
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import pv_nowcast
from voltpilot_optimization.config import (
    pv_nowcast_decay_slots,
    pv_nowcast_enabled,
    pv_nowcast_max_age,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import BatterySite, gather_inputs
from voltpilot_optimization.pricing import SiteTariff
from voltpilot_optimization.pv_nowcast import apply_pv_nowcast

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
            # _fresh_measurement: soc_pct / grid_limit_kw / pv_power_kw.
            reading = world.latest.get(_column_of(sql))
            self._rows = [reading] if reading else []
        elif "FROM telemetry" in sql:
            self._rows = []
        elif "FROM monthly_market_value" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def _column_of(sql: str) -> str:
    for column in ("pv_power_kw", "grid_limit_kw", "soc_pct"):
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


def test_a_fresh_reading_replaces_the_running_slots_forecast(world):
    """The incident's numbers: the plan stops seeing a surplus that is not there."""
    world.latest["pv_power_kw"] = (NOW - timedelta(seconds=8), 1.3)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(1.3)
    assert inp.pv_kw[0] - inp.load_kw[0] < 0.0  # a deficit, not a 3 kW surplus
    # Slot 1 is half-corrected; from slot 2 the model owns the horizon again -
    # here the night floor then zeroes it, sunset being 18:05 UTC that day.
    assert inp.pv_kw[1] == pytest.approx(5.7 - 4.4 / 2)


def test_a_stale_reading_leaves_the_forecast_alone(world):
    """Older than the freshness window means the link is down, not a value."""
    world.latest["pv_power_kw"] = (NOW - timedelta(minutes=20), 1.3)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_no_reading_at_all_leaves_the_forecast_alone(world):
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_the_kill_switch_restores_the_previous_behaviour(world, monkeypatch):
    world.latest["pv_power_kw"] = (NOW - timedelta(seconds=8), 1.3)
    monkeypatch.setenv("OPTIMIZER_PV_NOWCAST_ENABLED", "false")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)


def test_a_garbage_knob_drops_the_correction_instead_of_the_plan(world, monkeypatch):
    world.latest["pv_power_kw"] = (NOW - timedelta(seconds=8), 1.3)
    monkeypatch.setenv("OPTIMIZER_PV_NOWCAST_DECAY_SLOTS", "not-a-number")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(5.7)  # fail-soft, and a plan still exists


def test_the_night_floor_still_has_the_last_word(world):
    """A measurement cannot outrank physics: after sunset the input is 0."""
    night = datetime(2026, 8, 28, 21, 30, tzinfo=timezone.utc)  # 23:30 lokal
    world.horizon = horizon_slot_starts(night, SLOTS)
    world.latest["pv_power_kw"] = (night - timedelta(seconds=8), 1.3)
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

"""The PV nowcast anchor: the run's own recent error corrects its near horizon.

Pure rule tests (no DB, no solver) plus the ``gather_inputs`` wiring against the
fake psycopg of ``test_freshness``/``test_active_model``. The Herzogau 23.08.
case the mechanism exists for is replayed through the REAL solver in
``test_morning_anchor_replay.py``.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization import config, nowcast
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.inputs import BatterySite, gather_inputs
from voltpilot_optimization.pricing import SiteTariff

NOW = datetime(2026, 8, 23, 7, 36, tzinfo=timezone.utc)  # 09:36 lokal
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SLOTS = 16  # == MIN_HORIZON_SLOTS


# ---- the rule -----------------------------------------------------------------


def test_the_ratio_is_the_energy_ratio_not_the_mean_of_slot_ratios():
    # One slot the model put near zero would dominate a per-slot-ratio mean;
    # over the ENERGY the well-behaved slots keep their weight.
    ev = nowcast.anchor_evidence([20.0, 20.0, 20.0], [0.1, 10.0, 10.0])
    assert ev.established
    assert ev.raw_ratio == pytest.approx(60.0 / 20.1)
    assert ev.measured_kwh == pytest.approx(60.0)
    assert ev.predicted_kwh == pytest.approx(20.1)


def test_a_model_that_saw_no_sun_at_all_yields_the_clamp_not_a_crash():
    # The 23.08. shape in its purest form: the plant produced, the model did
    # not. An infinite raw ratio, reported honestly and clamped.
    ev = nowcast.anchor_evidence([30.0, 30.0, 30.0], [0.0, 0.0, 0.0])
    assert math.isinf(ev.raw_ratio)
    assert ev.ratio == nowcast.DEFAULT_MAX_RATIO


def test_the_clamp_is_symmetric_in_both_directions():
    up = nowcast.anchor_evidence([40.0] * 3, [2.0] * 3, max_ratio=3.0)
    down = nowcast.anchor_evidence([2.0] * 3, [40.0] * 3, max_ratio=3.0)
    assert up.ratio == 3.0
    assert down.ratio == pytest.approx(1.0 / 3.0)
    assert nowcast.DEFAULT_MAX_RATIO == 5.0  # the shipped default
    # ... and the unclamped truth stays visible for the diagnosis.
    assert up.raw_ratio == pytest.approx(20.0)
    assert down.raw_ratio == pytest.approx(0.05)


def test_a_silent_plant_establishes_nothing_instead_of_zeroing_the_forecast():
    # No telemetry row for a slot means None, not 0 - the difference between
    # "the device is quiet" and "the plant produced nothing".
    ev = nowcast.anchor_evidence([None, None, None], [20.0, 20.0, 20.0])
    assert not ev.established
    assert ev.slots_used == 0
    assert ev.reason == nowcast.REASON_NO_EVIDENCE


def test_a_model_without_a_prediction_for_a_slot_drops_that_slot():
    ev = nowcast.anchor_evidence([20.0, 20.0, 20.0, 20.0], [None, 5.0, 5.0, 5.0])
    assert ev.slots_used == 3
    assert ev.raw_ratio == pytest.approx(4.0)


def test_below_the_minimum_slot_count_nothing_is_claimed():
    ev = nowcast.anchor_evidence([20.0, 20.0], [5.0, 5.0], min_slots=3)
    assert not ev.established
    assert ev.ratio is None
    assert ev.reason == nowcast.REASON_TOO_FEW_SLOTS


def test_night_and_dawn_slots_carry_no_evidence():
    # Both sides near zero says nothing about the model's bias; sensor noise
    # there must not mint a ratio.
    ev = nowcast.anchor_evidence([0.02, 0.0, 0.05, 0.1], [0.0, 0.01, 0.0, 0.2])
    assert ev.slots_used == 0
    assert not ev.established


def test_one_side_claiming_sun_is_enough_to_count_the_slot():
    # The failure mode itself: the model says ~nothing, the plant produces.
    ev = nowcast.anchor_evidence([18.0, 22.0, 26.0], [0.1, 0.1, 0.1])
    assert ev.slots_used == 3


def test_the_factor_is_full_on_the_running_slot_and_gone_after_the_decay():
    factors = nowcast.anchor_factors(12, 3.0, decay_slots=8)
    assert factors[0] == pytest.approx(3.0)
    assert factors[4] == pytest.approx(2.0)  # halfway
    assert factors[8] == pytest.approx(1.0)
    assert factors[11] == pytest.approx(1.0)  # never overshoots past the decay


def test_without_evidence_the_series_is_passed_through_untouched():
    pv = [1.0, 5.0, 9.0]
    out, factors = nowcast.apply_anchor(pv, nowcast.NO_EVIDENCE)
    assert out == pv
    assert factors == [1.0, 1.0, 1.0]
    assert out is not pv  # a copy, never the caller's list


def test_a_night_slot_stays_zero_under_any_ratio():
    ev = nowcast.anchor_evidence([30.0] * 3, [5.0] * 3)
    out, _ = nowcast.apply_anchor([0.0, 0.0, 4.0], ev, decay_slots=8)
    assert out[0] == 0.0 and out[1] == 0.0
    assert out[2] > 4.0


def test_the_nameplate_caps_the_anchored_value():
    ev = nowcast.anchor_evidence([30.0] * 3, [10.0] * 3)  # ratio 3.0
    out, _ = nowcast.apply_anchor([30.0, 30.0], ev, decay_slots=8, capacity_kwp=45.0)
    assert out[0] == pytest.approx(45.0)


def test_a_series_already_above_the_nameplate_is_not_pushed_down_by_the_cap():
    # The anchor corrects a bias; second-guessing its input is not its job.
    ev = nowcast.anchor_evidence([5.0] * 3, [10.0] * 3)  # ratio 0.5
    out, _ = nowcast.apply_anchor([80.0], ev, decay_slots=8, capacity_kwp=45.0)
    assert out[0] == pytest.approx(40.0)
    out, _ = nowcast.apply_anchor([80.0], nowcast.NO_EVIDENCE, capacity_kwp=45.0)
    assert out[0] == pytest.approx(80.0)


def test_an_established_ratio_of_one_is_a_statement_not_an_absence():
    ev = nowcast.anchor_evidence([10.0] * 3, [10.0] * 3)
    assert ev.established and ev.ratio == pytest.approx(1.0)
    assert ev.reason == nowcast.REASON_ESTABLISHED


def test_garbage_values_never_enter_the_evidence():
    ev = nowcast.anchor_evidence(
        [float("nan"), -1.0, 20.0, 20.0, 20.0],
        [5.0, 5.0, 5.0, 5.0, 5.0],
    )
    assert ev.slots_used == 3
    assert ev.raw_ratio == pytest.approx(4.0)


# ---- the env knobs ------------------------------------------------------------


def test_the_kill_switch_defaults_on_and_rejects_garbage():
    assert config.pv_anchor_enabled({}) is True
    assert config.pv_anchor_enabled({config.PV_ANCHOR_ENABLED_ENV: "false"}) is False
    with pytest.raises(ValueError):
        config.pv_anchor_enabled({config.PV_ANCHOR_ENABLED_ENV: "vielleicht"})


def test_the_bounds_are_env_configurable():
    env = {
        config.PV_ANCHOR_LOOKBACK_MINUTES_ENV: "60",
        config.PV_ANCHOR_DECAY_SLOTS_ENV: "4",
        config.PV_ANCHOR_MIN_SLOTS_ENV: "2",
        config.PV_ANCHOR_MAX_RATIO_ENV: "2",
    }
    assert config.pv_anchor_lookback(env) == timedelta(minutes=60)
    assert config.pv_anchor_decay_slots(env) == 4
    assert config.pv_anchor_min_slots(env) == 2
    assert config.pv_anchor_max_ratio(env) == 2.0


# ---- the gather_inputs wiring -------------------------------------------------


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
            self._rows = list(world.past_predictions.items())
        elif "FROM forecast" in sql:
            kind = params[1]
            series = world.pv_forecast if kind == "pv" else world.load_forecast
            self._rows = [(ts, series) for ts in world.horizon]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            self._rows = []  # no fresh SoC / grid limit
        elif "FROM telemetry" in sql and "time < %s" in sql:
            self._rows = list(world.measured_samples)
        elif "FROM telemetry" in sql:
            self._rows = []  # no fallback history
        elif "FROM monthly_market_value" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def world(monkeypatch):
    state = SimpleNamespace(
        horizon=horizon_slot_starts(NOW, SLOTS),
        pv_forecast=5.0,
        load_forecast=6.0,
        past_predictions={},
        measured_samples=[],
    )

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor(state)

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    for var in (
        "VOLTPILOT_ACTIVE_LOAD_MODEL",
        "VOLTPILOT_ACTIVE_PV_MODEL",
        "OPTIMIZER_PV_ANCHOR_ENABLED",
        "OPTIMIZER_PV_ANCHOR_LOOKBACK_MINUTES",
        "OPTIMIZER_PV_ANCHOR_DECAY_SLOTS",
        "OPTIMIZER_PV_ANCHOR_MIN_SLOTS",
        "OPTIMIZER_PV_ANCHOR_MAX_RATIO",
        "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH",
    ):
        monkeypatch.delenv(var, raising=False)
    return state


def _site(capacity_kwp: float | None = 70.0) -> BatterySite:
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
        latitude=48.83,
        longitude=12.55,
        tariff=SiteTariff(pv_capacity_kwp=capacity_kwp),
    )


def _fill_evidence(world, *, measured_kw: float, predicted_kw: float, slots: int = 8):
    """Populate the lookback window: N completed slots, both sides present."""
    step = timedelta(minutes=15)
    first_open = world.horizon[0]
    samples, predictions = [], {}
    for i in range(slots):
        slot = first_open - step * (i + 1)
        predictions[slot] = predicted_kw
        # Several raw samples per slot - the slot MEAN is what must be used.
        for k in range(3):
            samples.append((slot + timedelta(minutes=5 * k), measured_kw))
    world.measured_samples = sorted(samples)
    world.past_predictions = dict(sorted(predictions.items()))


def test_the_anchor_lifts_the_near_horizon_and_reports_its_ratio(world):
    world.pv_forecast = 5.0
    _fill_evidence(world, measured_kw=36.0, predicted_kw=6.0)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_anchor_ratio == pytest.approx(5.0)  # 6.0 raw, clamped
    assert inp.pv_anchor_slots == 8
    assert inp.pv_kw[0] == pytest.approx(25.0)
    assert inp.pv_kw[8] == pytest.approx(5.0)  # decayed back to the forecast


def test_the_anchor_uses_the_slot_MEAN_of_the_measurements(world):
    # Two samples per slot at 10 and 30 kW -> mean 20, ratio 2 (not 3 from the
    # last sample, nor 1 from the first).
    step = timedelta(minutes=15)
    first = world.horizon[0]
    samples, predictions = [], {}
    for i in range(4):
        slot = first - step * (i + 1)
        predictions[slot] = 10.0
        samples.append((slot + timedelta(minutes=1), 10.0))
        samples.append((slot + timedelta(minutes=9), 30.0))
    world.measured_samples = sorted(samples)
    world.past_predictions = dict(sorted(predictions.items()))
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_anchor_ratio == pytest.approx(2.0)


def test_without_measurements_the_plan_is_byte_identical_to_the_unanchored_one(world):
    world.pv_forecast = 5.0
    baseline = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    _fill_evidence(world, measured_kw=36.0, predicted_kw=6.0, slots=2)  # below min
    scarce = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert baseline.pv_anchor_ratio is None
    assert scarce.pv_anchor_ratio is None
    assert scarce.pv_kw == baseline.pv_kw


def test_the_kill_switch_leaves_the_forecast_untouched(world, monkeypatch):
    _fill_evidence(world, measured_kw=36.0, predicted_kw=6.0)
    monkeypatch.setenv("OPTIMIZER_PV_ANCHOR_ENABLED", "false")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_anchor_ratio is None
    assert inp.pv_kw == [5.0] * SLOTS


def test_a_broken_env_value_drops_the_anchor_instead_of_sinking_the_plan(
    world, monkeypatch, caplog
):
    _fill_evidence(world, measured_kw=36.0, predicted_kw=6.0)
    monkeypatch.setenv("OPTIMIZER_PV_ANCHOR_MAX_RATIO", "nonsense")
    with caplog.at_level("WARNING"):
        inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_anchor_ratio is None
    assert inp.pv_kw == [5.0] * SLOTS
    assert any("pv_anchor.failed" in r.message for r in caplog.records)


def test_the_correction_works_downwards_too(world):
    # Real weather cloudier than forecast: the plan stops expecting a charge
    # that is not coming. Symmetric by construction, never a thumb on the scale.
    world.pv_forecast = 30.0
    _fill_evidence(world, measured_kw=15.0, predicted_kw=30.0)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.pv_anchor_ratio == pytest.approx(0.5)
    assert inp.pv_kw[0] == pytest.approx(15.0)


def test_the_night_floor_still_runs_after_the_anchor(world):
    # 00:00 local, four hours before sunrise: whatever the anchor scales must
    # still come out as zero.
    night = datetime(2026, 8, 22, 22, 0, tzinfo=timezone.utc)
    world.horizon = horizon_slot_starts(night, SLOTS)
    world.pv_forecast = 4.0
    _fill_evidence(world, measured_kw=20.0, predicted_kw=4.0)
    inp = gather_inputs("postgresql://fake", _site(), night, SLOTS)
    assert inp.pv_kw == [0.0] * SLOTS


def test_the_nameplate_bounds_the_anchor_end_to_end(world):
    world.pv_forecast = 30.0
    _fill_evidence(world, measured_kw=40.0, predicted_kw=15.0)  # ratio ~2.67
    inp = gather_inputs("postgresql://fake", _site(capacity_kwp=45.0), NOW, SLOTS)
    assert inp.pv_kw[0] == pytest.approx(45.0)
    # ... and a site without a maintained nameplate is not blocked by it.
    unbounded = gather_inputs("postgresql://fake", _site(capacity_kwp=None), NOW, SLOTS)
    assert unbounded.pv_kw[0] > 45.0

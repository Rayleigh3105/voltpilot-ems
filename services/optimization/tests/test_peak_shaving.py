"""Peak shaving / Lastspitzenkappung (PS-1 + PS-2, scout vp-battery-models-b9).

PS-1: an RLM site's Leistungspreis (EUR per kW per billing period on the
highest 15-min mean grid import) enters the MILP as an epigraph over the
horizon's import anchored at the period's measured ``peak_so_far`` - an
ECONOMIC term, never a hard cap, plus the weak shave-target ratchet on the
plain horizon peak. PS-2: ``peak_reserve_soc_pct`` is a hard SoC floor in the
reservation stack (technical < backup < peak-reserve).

Hand-computed scenarios in the ``test_excel_spec_day`` style; solver tests
need the HiGHS wheel, the arithmetic/structural/contract/wiring tests always
run.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.config import (
    PEAK_RATCHET_CAP_EUR_PER_KW,
    PEAK_RATCHET_FRACTION,
    PEAK_SPIKE_FACTOR,
    peak_ratchet_eur_per_kw,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    PlanSlot,
    SchedulePlan,
    horizon_slot_starts,
)
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import build_model

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)

# 10 kWh / 5 kW battery at the platform defaults: eta_rt 0.92 (one-way
# ~0.9592), technical band 0.5..9.5 kWh, wear 4 ct/kWh-cycle.
def make_battery(
    backup_reserve: float | None = None, peak_reserve: float | None = None
) -> BatteryParams:
    return BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
        backup_reserve_pct=backup_reserve,
        peak_reserve_pct=peak_reserve,
    )


def make_input(
    prices: list[float],
    load: list[float],
    battery: BatteryParams | None = None,
    soc0_kwh: float = 9.0,
    leistungspreis: float | None = None,
    peak_so_far: float = 0.0,
    pv: list[float] | None = None,
    netzladen: bool = True,
    grid_limit: float | None = None,
) -> OptimizationInput:
    n = len(prices)
    assert len(load) == n
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery if battery is not None else make_battery(),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=load,
        pv_kw=pv if pv is not None else [0.0] * n,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen,
        grid_limit_kw=grid_limit,
        leistungspreis_eur_kw=leistungspreis,
        peak_so_far_kw=peak_so_far,
    )


def solve(inp: OptimizationInput) -> SchedulePlan:
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


def max_import(plan: SchedulePlan) -> float:
    return max(max(s.grid_kw, 0.0) for s in plan.slots)


# A calm day with one expensive load spike: 2 kW baseline, 8 kW for one hour
# (slots 16..19), 8h horizon, flat 100 EUR/MWh spot.
SPIKE_LOAD = [2.0] * 16 + [8.0] * 4 + [2.0] * 12
FLAT_100 = [100.0] * 32


# ---- input validation (no solver needed) --------------------------------------


def test_leistungspreis_and_peak_so_far_are_validated():
    with pytest.raises(ValueError):
        make_input(FLAT_100, SPIKE_LOAD, leistungspreis=-1.0)
    with pytest.raises(ValueError):
        make_input(FLAT_100, SPIKE_LOAD, leistungspreis=float("nan"))
    with pytest.raises(ValueError):
        make_input(FLAT_100, SPIKE_LOAD, peak_so_far=-0.1)
    # Module off: peak_so_far defaults to 0 and the input builds fine.
    inp = make_input(FLAT_100, SPIKE_LOAD)
    assert inp.leistungspreis_eur_kw is None
    assert inp.peak_so_far_kw == 0.0


# ---- the model is structurally byte-identical without the module ---------------


def test_peak_variables_exist_only_when_the_module_is_active_and_in_both_builds():
    active = make_input(FLAT_100, SPIKE_LOAD, leistungspreis=100.0, peak_so_far=4.0)
    off = make_input(FLAT_100, SPIKE_LOAD)
    for enforce in (True, False):
        m = build_model(active, enforce_grid_limit=enforce)
        # The epigraph + anchor + ratchet variables live in BOTH builds: the
        # term is economic (can never cause infeasibility), so the §14a
        # fallback plan must keep shaving.
        assert hasattr(m, "peak")
        assert hasattr(m, "peak_anchor")
        assert hasattr(m, "peak_epigraph")
        assert hasattr(m, "peak_below")
        assert hasattr(m, "peak_below_epigraph")
        m_off = build_model(off, enforce_grid_limit=enforce)
        assert not hasattr(m_off, "peak")
        assert not hasattr(m_off, "peak_below")


# ---- PS-1 economics (hand-computed, solver) -------------------------------------


@needs_highs
def test_battery_holds_the_period_peak_when_the_leistungspreis_makes_it_worth_it():
    """The core promise: an 8 kW load spike above the period's 4 kW peak so
    far is shaved down to (at most) the anchor. Worth it by a mile:
    (8-4) kW x 100 EUR/kW = 400 EUR vs. ~0.4 EUR of wear + terminal value for
    the ~4.2 kWh discharged. Without the module the flat price leaves the
    battery idle and the spike untouched."""
    shaved = solve(
        make_input(FLAT_100, SPIKE_LOAD, leistungspreis=100.0, peak_so_far=4.0)
    )
    assert max_import(shaved) <= 4.0 + 0.01
    # The peak variable settles exactly on the anchor: the period peak cannot
    # be improved below what is already measured.
    assert shaved.peak_target_kw == pytest.approx(4.0, abs=0.01)

    control = solve(make_input(FLAT_100, SPIKE_LOAD))
    assert max_import(control) == pytest.approx(8.0, abs=0.01)
    assert control.peak_target_kw is None


@needs_highs
def test_the_peak_is_economically_broken_when_arbitrage_beats_the_leistungspreis():
    """The honest trade-off - no hard cap. Merchant site, 2h at 10 EUR/MWh
    then 400 EUR/MWh: a full charge earns ~0.32 EUR per cheap kWh (spread
    after losses and wear), i.e. ~0.64 EUR per kW of charge power over the
    2h window. At 0.50 EUR/kW Leistungspreis (+3% ratchet) breaking the 2 kW
    period peak pays; at 200 EUR/kW it never does."""
    prices = [10.0] * 8 + [400.0] * 24
    load = [2.0] * 32

    broken = solve(
        make_input(
            prices, load, soc0_kwh=0.5, leistungspreis=0.5, peak_so_far=2.0
        )
    )
    assert max_import(broken) > 2.0 + 0.5, "the cheap window is worth the breach"
    assert broken.peak_target_kw == pytest.approx(max_import(broken), abs=0.01)
    assert sum(max(s.battery_kw, 0.0) for s in broken.slots) > 0.0

    held = solve(
        make_input(
            prices, load, soc0_kwh=0.5, leistungspreis=200.0, peak_so_far=2.0
        )
    )
    # 200 EUR/kW dwarfs the arbitrage gain: no import above the anchor.
    assert max_import(held) <= 2.0 + 0.01
    assert held.peak_target_kw == pytest.approx(2.0, abs=0.01)


@needs_highs
def test_ratchet_keeps_shaving_below_peak_so_far_after_a_torn_peak():
    """Report (c)2: after a torn peak (anchor 20 kW, far above anything in
    the horizon) the marginal Leistungspreis incentive is zero - the plain
    epigraph alone would stop shaving for the rest of the period. The weak
    ratchet (3% of LP on the horizon peak) keeps the battery in form: the
    8 kW spike is still flattened, while the module-off control (flat price)
    leaves it untouched."""
    torn = solve(
        make_input(FLAT_100, SPIKE_LOAD, leistungspreis=100.0, peak_so_far=20.0)
    )
    assert max_import(torn) < 7.0, "the ratchet still shaves the spike"
    # The billing-period target stays the anchor - the ratchet never
    # fabricates a lower period peak than what is already measured.
    assert torn.peak_target_kw == pytest.approx(20.0, abs=0.01)

    control = solve(make_input(FLAT_100, SPIKE_LOAD))
    assert max_import(control) == pytest.approx(8.0, abs=0.01)


@needs_highs
def test_ratchet_never_blocks_a_real_arbitrage_cycle():
    """The ratchet is weak by design (wear-scale, capped): at a
    Leistungspreis of 12 EUR/kW the ratchet prices the horizon peak at
    min(3% x 12, 0.30) = 0.30 EUR/kW, while a 10-vs-400 spread earns
    ~0.64 EUR per kW of charge power over a 2h cheap window - the cycle
    happens, the ratchet only trims HOW it happens (the profile may flatten,
    the energy still moves)."""
    prices = [10.0] * 8 + [400.0] * 24
    load = [2.0] * 32
    inp = make_input(
        prices, load, soc0_kwh=0.5, leistungspreis=12.0, peak_so_far=20.0
    )
    plan = solve(inp)
    charged_kwh = sum(max(s.battery_kw, 0.0) for s in plan.slots) * 0.25
    control = solve(make_input(prices, load, soc0_kwh=0.5))
    control_charged = sum(max(s.battery_kw, 0.0) for s in control.slots) * 0.25
    assert control_charged > 8.0, "the control cycle fills the battery"
    assert charged_kwh > 0.9 * control_charged, (
        "the ratchet must not suppress the profitable cycle"
    )


@needs_highs
def test_period_start_flattens_toward_the_energy_feasible_minimum():
    """peak_so_far = 0 (1st of the period): the FULL Leistungspreis applies to
    every kW of import, so the plan flattens as far as the battery's energy
    allows. Flat 2 kW load over 8h = 16 kWh, usable stored energy 8.5 kWh ->
    ~8.15 kWh AC, so the floor is ~2 - 8.15/8 = ~0.98 kW - and the 1st-of-
    January 00:15 never defines the year maximum (report (c)3)."""
    load = [2.0] * 32
    plan = solve(
        make_input(FLAT_100, load, soc0_kwh=9.0, leistungspreis=100.0, peak_so_far=0.0)
    )
    assert plan.peak_target_kw == pytest.approx(0.98, abs=0.05)
    assert max_import(plan) == pytest.approx(plan.peak_target_kw, abs=0.01)
    # Every kW of import costs the full LP: charging (raising the peak) never
    # happens, the battery drains to its technical floor doing the flattening.
    assert all(s.battery_kw <= 1e-6 for s in plan.slots)
    assert plan.slots[-1].soc_kwh == pytest.approx(0.5, abs=0.05)


@needs_highs
def test_export_is_never_penalized_by_the_peak_term():
    """The Leistungspreis prices IMPORT only. An evening export burst (high
    spot, merchant discharge; ~8.15 kWh AC over the 4h window forces an
    average export of ~1.5 kW past the 0.5 kW load) coexists with a held
    import peak: the plan exports while peak_target stays at the anchor."""
    prices = [100.0] * 16 + [500.0] * 16
    load = [2.0] * 16 + [0.5] * 16
    plan = solve(
        make_input(prices, load, soc0_kwh=9.0, leistungspreis=100.0, peak_so_far=2.0)
    )
    assert max_import(plan) <= 2.0 + 0.01
    assert plan.peak_target_kw == pytest.approx(2.0, abs=0.01)
    assert any(s.grid_kw < -0.5 for s in plan.slots), "the evening export happens"


# ---- PS-2 reserve stack ---------------------------------------------------------


def test_peak_reserve_joins_the_floor_stack_highest_absolute_floor_binds():
    # Peak reserve above the backup reserve: the peak floor binds.
    assert make_battery(30.0, 60.0).soc_floor_kwh(9.0) == pytest.approx(6.0)
    # Peak reserve below the backup reserve: ineffective (max, not additive).
    assert make_battery(30.0, 20.0).soc_floor_kwh(9.0) == pytest.approx(3.0)
    # Peak reserve alone raises the technical floor.
    assert make_battery(None, 40.0).soc_floor_kwh(9.0) == pytest.approx(4.0)
    # Below the technical floor it is ineffective.
    assert make_battery(None, 2.0).soc_floor_kwh(9.0) == pytest.approx(0.5)
    # Below-floor start relaxes (never discharge further), 100% pins at max.
    assert make_battery(None, 60.0).soc_floor_kwh(2.0) == pytest.approx(2.0)
    assert make_battery(None, 100.0).soc_floor_kwh(9.5) == pytest.approx(9.5)


def test_peak_reserve_percent_is_validated():
    with pytest.raises(ValueError):
        make_battery(None, -1.0)
    with pytest.raises(ValueError):
        make_battery(None, 101.0)
    with pytest.raises(ValueError):
        make_battery(None, float("nan"))


@needs_highs
def test_peak_reserve_holds_at_any_price_and_stacks_above_the_backup_reserve():
    """The reserve is HARD (reserve = constraint, prices = preferences): a
    500 EUR/MWh evening peak cannot pull the SoC below the 60% peak reserve,
    which sits ABOVE the 30% backup reserve in the stack."""
    temptation = [100.0] * 16 + [500.0] * 16
    plan = solve(
        make_input(
            temptation,
            [2.0] * 32,
            battery=make_battery(backup_reserve=30.0, peak_reserve=60.0),
            soc0_kwh=9.0,
            leistungspreis=100.0,
            peak_so_far=2.0,
        )
    )
    assert all(s.soc_kwh >= 6.0 - 1e-6 for s in plan.slots)
    # The temptation bites exactly down to the peak-reserve floor.
    assert plan.slots[-1].soc_kwh == pytest.approx(6.0, abs=0.05)


# ---- interplay: §14a and EEG ----------------------------------------------------


@needs_highs
def test_s14a_grid_limit_composes_with_the_peak_term():
    """A hard §14a cap TIGHTER than the peak anchor: the cap wins on every
    slot (hard beats economic) while peak_target still reports the anchor."""
    plan = solve(
        make_input(
            FLAT_100,
            SPIKE_LOAD,
            soc0_kwh=9.0,
            leistungspreis=100.0,
            peak_so_far=4.0,
            grid_limit=3.0,
        )
    )
    assert max_import(plan) <= 3.0 + 1e-6
    assert plan.peak_target_kw == pytest.approx(4.0, abs=0.01)


@needs_highs
def test_fallback_build_without_s14a_still_shaves_the_peak():
    """The infeasible-§14a fallback drops ONLY the grid-limit constraint; the
    economic peak term survives (it can never cause infeasibility itself)."""
    from voltpilot_optimization.solver import optimize_ignoring_grid_limit

    inp = make_input(
        FLAT_100,
        SPIKE_LOAD,
        soc0_kwh=9.0,
        leistungspreis=100.0,
        peak_so_far=4.0,
        # A limit no battery can honor during the spike (load 8, discharge 5):
        # the primary build is infeasible, the engine falls back.
        grid_limit=0.5,
    )
    from voltpilot_optimization.solver import InfeasiblePlanError, optimize

    with pytest.raises(InfeasiblePlanError):
        optimize(inp, plan_id=uuid4(), generated_at=T0)
    plan = optimize_ignoring_grid_limit(inp, plan_id=uuid4(), generated_at=T0)
    assert max_import(plan) <= 4.0 + 0.01, "the fallback plan still shaves"
    assert plan.peak_target_kw == pytest.approx(4.0, abs=0.01)


@needs_highs
def test_eeg_site_shaves_peaks_with_discharge_but_never_grid_charges():
    """EEG mode (netzladen_erlaubt=false) + peak shaving: DISCHARGE against
    the spike is unrestricted, while the solar-only-charge bound keeps every
    charge within produced PV (here: none) - shaving never opens a
    grid-charging loophole."""
    plan = solve(
        make_input(
            FLAT_100,
            SPIKE_LOAD,
            soc0_kwh=9.0,
            leistungspreis=100.0,
            peak_so_far=4.0,
            netzladen=False,
        )
    )
    assert max_import(plan) <= 4.0 + 0.01
    assert all(s.battery_kw <= 1e-6 for s in plan.slots), "no PV = no charge at all"


# ---- contract: the additive payload fields --------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "docs" / "contracts" / "mqtt-schedule.schema.json"


def load_validator():
    from jsonschema import Draft202012Validator, FormatChecker

    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def make_plan(
    peak_target: float | None, peak_reserve: float | None = None
) -> SchedulePlan:
    battery = BatteryParams(
        capacity_kwh=10,
        max_charge_kw=5,
        max_discharge_kw=5,
        peak_reserve_pct=peak_reserve,
    )
    slots = [
        PlanSlot(
            start=T0 + i * timedelta(minutes=15),
            battery_kw=-2.0,
            grid_kw=2.0,
            soc_kwh=5.0,
            load_kw=4.0,
            pv_kw=0.0,
            price_eur_mwh=100.0,
            cost_eur=0.05,
            baseline_cost_eur=0.1,
        )
        for i in range(4)
    ]
    return SchedulePlan(
        plan_id=UUID("a81bc81b-dead-4e5d-abff-90865d1e13b1"),
        tenant_id=UUID("00000000-0000-0000-0000-000000000001"),
        site_id=UUID("00000000-0000-0000-0000-000000000002"),
        device_id=UUID("00000000-0000-0000-0000-000000000003"),
        generated_at=T0,
        battery=battery,
        slots=slots,
        peak_target_kw=peak_target,
    )


def test_payload_carries_the_optional_peak_fields_and_validates():
    validator = load_validator()
    payload = build_schedule_payload(make_plan(62.5, peak_reserve=40.0))
    assert payload["grid_import_limit_kw"] == 62.5
    assert payload["peak_reserve_soc_pct"] == 40.0
    errors = list(validator.iter_errors(payload))
    assert errors == [], [e.message for e in errors]


def test_payload_omits_the_peak_fields_when_the_module_is_off():
    # Module off (peak_target None): BOTH fields absent, byte-identical to a
    # pre-PS-1 payload - even when a reserve happens to be configured.
    payload = build_schedule_payload(make_plan(None, peak_reserve=40.0))
    assert "grid_import_limit_kw" not in payload
    assert "peak_reserve_soc_pct" not in payload
    assert list(load_validator().iter_errors(payload)) == []


def test_payload_omits_the_reserve_when_none_is_configured():
    payload = build_schedule_payload(make_plan(10.0, peak_reserve=None))
    assert payload["grid_import_limit_kw"] == 10.0
    assert "peak_reserve_soc_pct" not in payload
    assert list(load_validator().iter_errors(payload)) == []


# ---- inputs: billing period, plausibility gate, gather wiring --------------------


def test_billing_period_start_uses_berlin_calendar_periods():
    from voltpilot_optimization.inputs import billing_period_start

    # 2026-07-01 00:30 Berlin (= 2026-06-30 22:30 UTC): still June for
    # 'monat' pre-midnight UTC would be wrong - Berlin says July.
    now = datetime(2026, 6, 30, 22, 30, tzinfo=timezone.utc)
    assert billing_period_start(now, "monat") == datetime(
        2026, 6, 30, 22, 0, tzinfo=timezone.utc
    )
    # 'jahr': Berlin new year = 2025-12-31 23:00 UTC.
    assert billing_period_start(now, "jahr") == datetime(
        2025, 12, 31, 23, 0, tzinfo=timezone.utc
    )
    # Winter time (CET, UTC+1): March 10th, month start = Feb 28 23:00 UTC.
    winter = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
    assert billing_period_start(winter, "monat") == datetime(
        2026, 2, 28, 23, 0, tzinfo=timezone.utc
    )
    # Unexpected value falls back to 'jahr' (the conservative period).
    assert billing_period_start(now, "quartal") == billing_period_start(now, "jahr")


def test_plausible_peak_discards_a_lone_spike_bucket_but_keeps_real_peaks():
    from voltpilot_optimization.inputs import plausible_peak

    assert plausible_peak([]) == (0.0, False)
    assert plausible_peak([30.0]) == (30.0, False)
    # Two similar top buckets = a real recurring peak: kept.
    assert plausible_peak([30.0, 12.0]) == (30.0, False)
    # A lone outlier (>PEAK_SPIKE_FACTOR x the runner-up) is discarded.
    assert plausible_peak([100.0, 12.0]) == (12.0, True)
    assert PEAK_SPIKE_FACTOR == 3.0
    # Boundary: exactly at the factor is still plausible.
    assert plausible_peak([36.0, 12.0]) == (36.0, False)


NOW = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
SLOTS = 16


class _FakeCursor:
    """Minimal psycopg stand-in (the test_pricing pattern) serving prices,
    forecasts, and the two peak_so_far queries."""

    captured_rollup_since: list[datetime] = []

    def __init__(self) -> None:
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(NOW, SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 100.0) for ts in self.slot_starts]
        elif "FROM forecast" in sql:
            self._rows = [(ts, 1.0) for ts in self.slot_starts]
        elif "FROM telemetry_rollup_15m" in sql:
            _FakeCursor.captured_rollup_since.append(params[1])
            # Descending import buckets: a lone 80-kW spike over a real
            # 15-kW peak - the gate must pick 15.
            self._rows = [(80.0,), (15.0,)]
        elif "avg(greatest(power_kw, 0))" in sql:
            # The running quarter hour's mean import: 17 kW - higher than the
            # gated rollup peak, so the blend must surface it.
            self._rows = [(17.0,)]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            self._rows = []
        elif "FROM telemetry" in sql:
            self._rows = []
        else:  # pragma: no cover
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def fake_psycopg(monkeypatch):
    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor()

    _FakeCursor.captured_rollup_since = []
    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)


def _fake_site(leistungspreis, abrechnung="jahr"):
    from voltpilot_optimization.inputs import BatterySite

    return BatterySite(
        tenant_id=UUID("00000000-0000-0000-0000-000000000001"),
        site_id=UUID("00000000-0000-0000-0000-000000000002"),
        device_id=None,
        bidding_zone="DE-LU",
        battery=make_battery(),
        netzladen_erlaubt=True,
        leistungspreis_eur_kw=leistungspreis,
        abrechnung_leistung=abrechnung,
    )


def test_gather_inputs_computes_the_gated_blended_peak_so_far(fake_psycopg):
    from voltpilot_optimization.inputs import billing_period_start, gather_inputs

    inp = gather_inputs("postgresql://fake", _fake_site(120.0), NOW, SLOTS)
    assert inp.leistungspreis_eur_kw == 120.0
    # Rollup peak: the 80-kW spike bucket is discarded (gate), leaving 15 kW;
    # the running quarter hour reads 17 kW -> the blend takes the max.
    assert inp.peak_so_far_kw == pytest.approx(17.0)
    # The rollup window starts at the Berlin YEAR start ('jahr' billing).
    assert _FakeCursor.captured_rollup_since == [
        billing_period_start(NOW, "jahr")
    ]


def test_gather_inputs_skips_the_peak_queries_when_the_module_is_off(fake_psycopg):
    from voltpilot_optimization.inputs import gather_inputs

    inp = gather_inputs("postgresql://fake", _fake_site(None), NOW, SLOTS)
    assert inp.leistungspreis_eur_kw is None
    assert inp.peak_so_far_kw == 0.0
    assert _FakeCursor.captured_rollup_since == [], "no rollup query fired"


def test_gather_inputs_monthly_billing_uses_the_berlin_month_start(fake_psycopg):
    from voltpilot_optimization.inputs import billing_period_start, gather_inputs

    gather_inputs(
        "postgresql://fake", _fake_site(120.0, abrechnung="monat"), NOW, SLOTS
    )
    assert _FakeCursor.captured_rollup_since == [
        billing_period_start(NOW, "monat")
    ]


# ---- persisted run fact ----------------------------------------------------------


def test_plan_rows_carry_the_run_peak_target():
    import re

    from voltpilot_optimization.persistence import _UPSERT_SQL, plan_rows

    m = re.search(r"INSERT INTO schedule\s*\(([^)]*)\)", _UPSERT_SQL)
    assert m, "upsert SQL must keep its explicit column list"
    cols = [c.strip() for c in m.group(1).split(",")]
    idx = cols.index("peak_target_kw")
    rows = plan_rows(make_plan(62.5))
    assert all(row[idx] == 62.5 for row in rows)
    rows_off = plan_rows(make_plan(None))
    assert all(row[idx] is None for row in rows_off)
    assert re.search(r"peak_target_kw\s+= EXCLUDED\.peak_target_kw", _UPSERT_SQL)


# ---- ratchet constant discipline -------------------------------------------------


def test_ratchet_weight_is_wear_scale_capped_never_arbitrage_scale():
    """The ratchet must be strong enough to beat wear on a typical shave
    (report (c)2: 2-5% of LP, "Größenordnung wie Wear, NICHT ε-Skala") and -
    the report's other binding requirement - weak enough to never dominate
    real arbitrage: uncapped 3% of a Jahres-LP (100-200 EUR/kW -> 3-6 EUR/kW
    per plan) provably overrides a 400-EUR/MWh spread, so the weight is
    capped at an absolute wear-scale constant."""
    assert 0.02 <= PEAK_RATCHET_FRACTION <= 0.05
    # Monats-LP scale: the plain fraction applies.
    assert peak_ratchet_eur_per_kw(10.0) == pytest.approx(0.30)
    assert peak_ratchet_eur_per_kw(5.0) == pytest.approx(0.15)
    # Jahres-LP scale: the cap holds the weight at wear scale.
    assert peak_ratchet_eur_per_kw(100.0) == PEAK_RATCHET_CAP_EUR_PER_KW
    assert peak_ratchet_eur_per_kw(200.0) == PEAK_RATCHET_CAP_EUR_PER_KW
    # Well above the wear cost of shaving a 1h spike (~0.02-0.08 EUR/kW)...
    assert PEAK_RATCHET_CAP_EUR_PER_KW >= 0.1
    # ...and below a genuine price opportunity (>= ~0.3 EUR/kWh spreads win).
    assert PEAK_RATCHET_CAP_EUR_PER_KW <= 0.5

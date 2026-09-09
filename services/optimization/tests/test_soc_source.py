"""P7: ohne echten Ladestand plant der Optimierer keinen Speicher.

Scout-Report ``data/vp-deye-diybms-luecke-l5`` §3.3 / Paket P7,
Captain-Entscheid E4=b.

Der Zustand VOR P7: fehlte die frische ``soc_pct``-Messung, sprang
``gather_inputs`` auf ``DEFAULT_SOC_PCT`` (50 %) und plante daraus einen
vollen Speicher-Fahrplan - Entladungen aus einem Stand, den niemand kannte,
eine SoC-Bahn, die niemand gemessen hatte, und die geplante Ersparnis, die aus
beidem folgte. An einer Anlage, die gar keinen echten Ladestand liefern KANN
(ein Deye im Spannungsmodus ohne BMS-SoC), war jede dieser Zahlen eine
Erfindung - und ``plannedSavingsTodayEur`` trug sie bis auf die Kundenflaeche.

Bewiesen wird hier BEIDES, denn eine Regel ohne ihren Gegenbeweis ist wertlos:

* die neue Ehrlichkeit - kein Ladestand => ``soc_source = unbekannt``,
  Speicher-Terme aus, RUHE-Plan, keine SoC-Bahn, keine Ersparnis, keine
  In-Slot-Vollmacht fuer die Box;
* die UNVERAENDERTE Normalitaet - eine Anlage mit frischer echter Messung
  plant, entlaedt und weist aus wie vor P7, byte-identisch.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.domain import (
    SOC_SOURCE_BERECHNET,
    SOC_SOURCE_GEMESSEN,
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import BatterySite, gather_inputs
from voltpilot_optimization.persistence import plan_rows
from voltpilot_optimization.solver import optimize

pytest.importorskip("highspy", reason="behavioural MILP assertions need the HiGHS wheel")

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SLOTS = 16  # == MIN_HORIZON_SLOTS

#: newest telemetry reading per column, as ``(observed_at, value)``.
READINGS: dict[str, tuple[datetime, float]] = {}


class _FakeCursor:
    """Answers gather_inputs' real queries (the test_freshness pattern)."""

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
            # A real spread, so a SIGHTED battery genuinely wants to cycle -
            # without it the "no dispatch" assertions below would be vacuous.
            self._rows = [
                (ts, "PT15M", 20.0 if i < SLOTS // 2 else 400.0)
                for i, ts in enumerate(self.slot_starts)
            ]
        elif "FROM flow_claim" in sql:
            self._rows = []
        elif "FROM site_forecast_model_choice" in sql or "FROM forecast_model_choice" in sql:
            self._rows = []
        elif "FROM forecast" in sql:
            _site_id, kind, _model, since = params
            value = 1.0 if kind == "load" else 0.0
            self._rows = [(ts, value) for ts in self.slot_starts if ts >= since]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            column = sql.split("SELECT time, ")[1].split(" FROM")[0]
            reading = READINGS.get(column)
            self._rows = [reading] if reading else []
        elif "FROM telemetry" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor()

    def rollback(self):  # pragma: no cover
        pass


@pytest.fixture()
def readings(monkeypatch):
    READINGS.clear()
    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _FakeConnection())
    )
    return READINGS


def _site() -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0,
            max_charge_kw=5.0,
            max_discharge_kw=5.0,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=True,
    )


def _input(**over) -> OptimizationInput:
    base = dict(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        battery=BatteryParams(
            capacity_kwh=10.0,
            max_charge_kw=5.0,
            max_discharge_kw=5.0,
            roundtrip_efficiency=0.92,
        ),
        slot_starts=horizon_slot_starts(NOW, SLOTS),
        prices_eur_mwh=[20.0] * (SLOTS // 2) + [400.0] * (SLOTS // 2),
        load_kw=[1.0] * SLOTS,
        pv_kw=[0.0] * SLOTS,
        initial_soc_kwh=5.0,
        netzladen_erlaubt=True,
    )
    base.update(over)
    return OptimizationInput(**base)


# --- the input side: what a missing reading now means ----------------------


def test_a_fresh_real_reading_is_gemessen_and_unchanged(readings):
    readings["soc_pct"] = (NOW - timedelta(minutes=30), 80.0)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.soc_source == SOC_SOURCE_GEMESSEN
    assert inp.soc_unbekannt is False
    assert inp.initial_soc_kwh == pytest.approx(8.0)  # 80 % of 10 kWh


def test_no_reading_at_all_is_unbekannt_never_the_invented_fifty_percent(readings):
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.soc_source == SOC_SOURCE_UNBEKANNT
    assert inp.soc_unbekannt is True
    # The regression guard proper: 50 % of 10 kWh = 5.0 was the invented value.
    assert inp.initial_soc_kwh != pytest.approx(5.0)


def test_a_stale_reading_is_unbekannt_and_says_so(readings, caplog):
    # 3 h old against the 120-min default window: yesterday's value is not a
    # Ladestand, and the discard is FLAGGED with its reason, not silent.
    readings["soc_pct"] = (NOW - timedelta(hours=3), 80.0)
    with caplog.at_level("WARNING"):
        inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.soc_source == SOC_SOURCE_UNBEKANNT
    assert any("stale_reading_ignored" in r.message for r in caplog.records)
    assert any("soc.missing_no_battery_planning" in r.message for r in caplog.records)


def test_the_escape_hatch_restores_the_documented_pre_p7_fiction(readings, monkeypatch):
    monkeypatch.setenv("OPTIMIZER_REQUIRE_MEASURED_SOC", "false")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.soc_source == SOC_SOURCE_GEMESSEN
    assert inp.initial_soc_kwh == pytest.approx(5.0)  # DEFAULT_SOC_PCT again


def test_a_garbage_switch_value_raises_instead_of_guessing(readings, monkeypatch):
    monkeypatch.setenv("OPTIMIZER_REQUIRE_MEASURED_SOC", "vielleicht")
    with pytest.raises(ValueError, match="must be a boolean"):
        gather_inputs("postgresql://fake", _site(), NOW, SLOTS)


def test_soc_source_is_a_closed_vocabulary():
    """A word outside the vocabulary is DISCARDED, never resolved to a default
    (the Hausregel) - a silent fallback to `gemessen` would be the very
    invention P7 removes."""
    with pytest.raises(ValueError, match="soc_source must be one of"):
        _input(soc_source="geschaetzt")


# --- the effect on the plan ------------------------------------------------


def test_without_a_ladestand_the_plan_is_ruhe():
    plan = optimize(_input(soc_source=SOC_SOURCE_UNBEKANNT), UUID(int=1), NOW)
    assert len(plan.slots) == SLOTS, "the site is planned, only its battery is not"
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert plan.soc_source == SOC_SOURCE_UNBEKANNT


def test_the_same_horizon_with_a_ladestand_really_does_dispatch():
    """The RUHE assertion above must not be vacuous: these prices are a 20x
    spread, so a battery that MAY move certainly does."""
    plan = optimize(_input(), UUID(int=2), NOW)
    assert any(s.battery_kw > 0.1 for s in plan.slots), "cheap half must charge"
    assert any(s.battery_kw < -0.1 for s in plan.slots), "expensive half must discharge"


def test_without_a_ladestand_no_saving_is_claimed():
    plan = optimize(_input(soc_source=SOC_SOURCE_UNBEKANNT), UUID(int=3), NOW)
    # Not 0.00 EUR - NONE. A zero would claim "planned and worth nothing".
    assert plan.savings_eur is None
    assert plan.baseline_cost_eur is None
    assert all(s.baseline_cost_eur is None for s in plan.slots)
    # The Messlatte rests on a start SoC too, so it is absent for the same
    # reason - which nulls the api's steuerungPlannedEur through the existing
    # "one missing slot nulls the window" rule.
    assert plan.stur_cost_eur is None
    assert plan.steuerung_savings_eur is None


def test_a_sighted_run_still_reports_both_numbers():
    plan = optimize(_input(), UUID(int=4), NOW)
    assert plan.savings_eur is not None
    assert plan.baseline_cost_eur is not None
    assert all(s.baseline_cost_eur is not None for s in plan.slots)


def test_without_a_ladestand_no_soc_trajectory_is_published():
    plan = optimize(_input(soc_source=SOC_SOURCE_UNBEKANNT), UUID(int=5), NOW)
    assert all(plan.soc_pct(s) is None for s in plan.slots)
    sighted = optimize(_input(), UUID(int=6), NOW)
    assert all(sighted.soc_pct(s) is not None for s in sighted.slots)


def test_the_persisted_row_carries_null_soc_and_the_reason():
    plan = optimize(_input(soc_source=SOC_SOURCE_UNBEKANNT), UUID(int=7), NOW)
    rows = plan_rows(plan)
    assert len(rows) == SLOTS
    # Column order mirrors _UPSERT_SQL: ... soc_pct is index 8, soc_source last.
    assert all(row[8] is None for row in rows), "no invented SoC reaches the table"
    assert all(row[-1] == SOC_SOURCE_UNBEKANNT for row in rows), "the reason travels"
    sighted = plan_rows(optimize(_input(), UUID(int=8), NOW))
    assert all(row[8] is not None for row in sighted)
    assert all(row[-1] == SOC_SOURCE_GEMESSEN for row in sighted)


def test_without_a_ladestand_the_box_gets_no_in_slot_authority():
    """The point at which "Ruhe" would otherwise not BE Ruhe.

    The five in-slot fields are AUTHORITIES, not setpoints: they let the box
    deviate from the 0 kW setpoint against MEASURED values, and
    ``unplanned_load_discharge`` deliberately targets a RESTING slot. A run
    that does not know the state of charge must not hand them out."""
    plan = optimize(_input(soc_source=SOC_SOURCE_UNBEKANNT), UUID(int=9), NOW)
    for s in plan.slots:
        assert not s.cover_load_from_battery
        assert not s.unplanned_load_discharge
        assert not s.charge_surplus_to_battery
        assert not s.limit_discharge_to_load
        assert not s.charge_from_surplus_only


def test_a_berechneter_ladestand_plans_exactly_like_a_measured_one():
    """Prepared for the generic SoC building block: a DERIVED state of charge
    may feed planning - it is only LABELLED as derived, so a surface can name
    the weaker origin. It must therefore change nothing about the dispatch."""
    berechnet = optimize(_input(soc_source=SOC_SOURCE_BERECHNET), UUID(int=10), NOW)
    gemessen = optimize(_input(), UUID(int=10), NOW)
    assert [s.battery_kw for s in berechnet.slots] == [s.battery_kw for s in gemessen.slots]
    assert [s.soc_kwh for s in berechnet.slots] == [s.soc_kwh for s in gemessen.slots]
    assert berechnet.savings_eur == gemessen.savings_eur
    assert berechnet.soc_source == SOC_SOURCE_BERECHNET
    # ... and it DOES publish a trajectory - it is a state of charge, not a gap.
    assert all(berechnet.soc_pct(s) is not None for s in berechnet.slots)


def test_a_run_with_a_ladestand_is_byte_identical_to_the_pre_p7_default():
    """`soc_source` defaults to `gemessen`, so every caller that builds its own
    inputs (What-if, Ersparnis-Simulation, golden suite) is untouched."""
    explicit = optimize(_input(soc_source=SOC_SOURCE_GEMESSEN), UUID(int=11), NOW)
    default = optimize(_input(), UUID(int=11), NOW)
    assert [s.battery_kw for s in explicit.slots] == [s.battery_kw for s in default.slots]
    assert [s.grid_kw for s in explicit.slots] == [s.grid_kw for s in default.slots]
    assert [s.soc_kwh for s in explicit.slots] == [s.soc_kwh for s in default.slots]
    assert [s.cost_eur for s in explicit.slots] == [s.cost_eur for s in default.slots]


def test_a_ruhe_plan_still_does_its_non_battery_job():
    """The missing Ladestand removes the BATTERY from the plan, never the plan:
    the connection-point feed-in cap still binds and curtailment still works."""
    inp = _input(
        soc_source=SOC_SOURCE_UNBEKANNT, max_feed_in_kw=3.0, pv_kw=[8.0] * SLOTS
    )
    plan = optimize(inp, UUID(int=12), NOW)
    assert len(plan.slots) == SLOTS
    assert all(s.grid_kw >= -3.0 - 1e-6 for s in plan.slots)
    assert any(s.curtail_kw > 0.1 for s in plan.slots)

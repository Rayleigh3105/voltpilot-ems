"""Vorsichtige Lade-Last (Paket P1, Captain-Entscheid HZ-1 A vom 14.10.2026).

Der Anlass ist Herzogau am 13.10.2026: der Plan ließ die Vormittagssonne ins
Netz und wollte erst ab 12:30 Uhr zum Tiefpreis laden; um 12:40 Uhr nahm ein
Verbraucher mit rund 37 kW den Überschuss, der Speicher kam auf 49 statt 95 %.
Die Lastprognose rechnete mittags mit 8 bis 13 kW, der Vortag hatte dort 25
bis 36 kW gezeigt.

Bewiesen wird beides, die Regel UND ihr Gegenbeweis:

* mit dem Muster des 13.10. lädt der Plan ohne die Regel erst mittags und mit
  ihr schon vormittags (der Regressionstest des Pakets);
* reicht der vorsichtig gerechnete Überschuss der billigen Stunden, bleibt das
  späte Laden unverändert - und ohne Messwerte, mit Schalter AUS, mit Netzladen
  oder für einen nicht gesteuerten Speicher ist der Plan byte-identisch.
"""

from __future__ import annotations

import math
import sys
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization import inputs
from voltpilot_optimization.config import (
    VORSICHTIGE_LADELAST_AUS_ENV,
    VORSICHTIGE_LADELAST_ENV,
    vorsichtige_ladelast_enabled,
)
from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.explain import KNOWN_CONSTRAINTS
from voltpilot_optimization.inputs import BatterySite
from voltpilot_optimization.solver import build_model
from voltpilot_optimization.vorsichtige_ladelast import (
    hoechste_last_der_tageszeit,
    laufendes_sonnenfenster,
    vorsichtige_ladelast,
)

BERLIN = ZoneInfo("Europe/Berlin")
UTC = timezone.utc
SITE = UUID("063012ff-4be7-4c1f-85c4-498bf555bd12")
TENANT = UUID("e09aa026-9a21-48ee-a117-84f2f9552d74")
Q = timedelta(minutes=15)


def _lokal(tag: int, stunde: int, minute: int = 0, monat: int = 10) -> datetime:
    return datetime(2026, monat, tag, stunde, minute, tzinfo=BERLIN).astimezone(UTC)


# --- die reine Regel ---------------------------------------------------------


def test_highest_load_of_the_time_of_day_over_seven_days_with_one_slot_tolerance():
    jetzt = _lokal(13, 8)
    gemessen = {
        _lokal(12, 12, 30): 30.0,  # Vortag, dieselbe Tageszeit
        _lokal(10, 12, 45): 36.0,  # drei Tage zurück, ein Slot daneben
        _lokal(12, 13, 0): 50.0,  # zwei Slots daneben - zählt für 12:30 nicht
        _lokal(5, 12, 30): 90.0,  # acht Tage zurück - außerhalb des Fensters
    }
    (h,) = hoechste_last_der_tageszeit(gemessen, [_lokal(13, 12, 30)], jetzt)
    assert h == 36.0


def test_a_slot_without_any_measurement_of_its_time_of_day_is_none():
    jetzt = _lokal(13, 8)
    gemessen = {_lokal(12, 12, 30): 30.0}
    assert hoechste_last_der_tageszeit(gemessen, [_lokal(13, 9, 0)], jetzt) == [None]


def test_a_quarter_hour_still_running_at_now_is_no_measurement():
    jetzt = _lokal(13, 12, 40)
    gemessen = {_lokal(13, 12, 30): 80.0, _lokal(12, 12, 30): 30.0}
    (h,) = hoechste_last_der_tageszeit(gemessen, [_lokal(14, 12, 30)], jetzt)
    assert h == 30.0


def test_the_time_of_day_is_the_berlin_wall_clock_across_the_clock_change():
    # 24.10. 12:00 Sommerzeit (10:00 UTC) ist dieselbe Tageszeit wie 26.10.
    # 12:00 Winterzeit (11:00 UTC) - nicht 26.10. 11:00.
    jetzt = _lokal(26, 8)
    gemessen = {_lokal(24, 12): 40.0}
    mittag, elf = hoechste_last_der_tageszeit(
        gemessen, [_lokal(26, 12), _lokal(26, 11)], jetzt
    )
    assert (mittag, elf) == (40.0, None)


def test_non_finite_measurements_are_ignored():
    jetzt = _lokal(13, 8)
    gemessen = {_lokal(12, 12): math.nan, _lokal(11, 12): 20.0}
    assert hoechste_last_der_tageszeit(gemessen, [_lokal(13, 12)], jetzt) == [20.0]


def test_the_cautious_load_is_the_max_and_the_running_slot_stays_the_measurement():
    assert vorsichtige_ladelast([3.0, 10.0, 40.0, 5.0], [30.0, 36.0, 20.0, None]) == [
        3.0,  # Slot 0 bleibt die Messung
        36.0,
        40.0,  # die Prognose liegt schon darüber
        5.0,  # ohne Messwert gilt die Prognose
    ]


def test_with_pv_only_the_running_sun_window_is_raised():
    # Slots 0-2 Sonne, ab Slot 3 Abend: der Rest des Horizonts (die Nacht und
    # der nächste Mittag) bleibt bei der Prognose.
    last = [3.0, 10.0, 10.0, 5.0, 5.0, 10.0]
    hoechste = [30.0, 36.0, 36.0, 20.0, 20.0, 36.0]
    pv = [20.0, 45.0, 30.0, 0.0, 0.0, 45.0]
    assert laufendes_sonnenfenster(pv) == 3
    assert vorsichtige_ladelast(last, hoechste, pv) == [3.0, 36.0, 36.0, 5.0, 5.0, 10.0]


def test_at_night_nothing_is_raised():
    pv = [0.0, 0.0, 30.0]
    assert laufendes_sonnenfenster(pv) == 0
    assert vorsichtige_ladelast([3.0, 3.0, 10.0], [30.0, 30.0, 36.0], pv) is None


def test_nothing_raised_means_no_cautious_load_at_all():
    assert vorsichtige_ladelast([3.0, 10.0], [50.0, 9.0]) is None
    assert vorsichtige_ladelast([3.0, 10.0], [None, None]) is None


def test_mismatched_lengths_raise():
    with pytest.raises(ValueError):
        vorsichtige_ladelast([1.0, 2.0], [1.0])


# --- der Schalter je Anlage --------------------------------------------------


def test_the_switch_defaults_on():
    assert vorsichtige_ladelast_enabled(SITE, env={}) is True
    assert vorsichtige_ladelast_enabled(SITE, env={VORSICHTIGE_LADELAST_ENV: " "}) is True


def test_the_global_switch_turns_it_off_everywhere():
    assert vorsichtige_ladelast_enabled(SITE, env={VORSICHTIGE_LADELAST_ENV: "false"}) is False


def test_the_exception_list_turns_one_site_off():
    env = {VORSICHTIGE_LADELAST_AUS_ENV: f"00000000-0000-0000-0000-000000000009, {SITE}"}
    assert vorsichtige_ladelast_enabled(SITE, env=env) is False
    assert vorsichtige_ladelast_enabled(UUID(int=1), env=env) is True


@pytest.mark.parametrize(
    "env",
    [
        {VORSICHTIGE_LADELAST_ENV: "vielleicht"},
        {VORSICHTIGE_LADELAST_AUS_ENV: f"{SITE},herzogau"},
    ],
)
def test_a_garbage_switch_value_raises_instead_of_guessing(env):
    with pytest.raises(ValueError):
        vorsichtige_ladelast_enabled(SITE, env=env)


# --- die Nebenbedingung im Solver --------------------------------------------


def _eingabe(**over) -> OptimizationInput:
    n = 8
    base = dict(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        battery=BatteryParams(capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0),
        slot_starts=[_lokal(13, 12) + i * Q for i in range(n)],
        prices_eur_mwh=[100.0] * n,
        load_kw=[10.0, 10.0, 10.0, 10.0, 40.0, 10.0, 10.0, 10.0],
        pv_kw=[45.0, 45.0, 45.0, 45.0, 30.0, 45.0, 45.0, 45.0],
        initial_soc_kwh=5.0,
        netzladen_erlaubt=False,
        charge_load_kw=[36.0, 36.0, 10.0, 50.0, 45.0, 36.0, 36.0, 36.0],
    )
    base.update(over)
    return OptimizationInput(**base)


def _gekappt(model) -> dict[int, float]:
    if not hasattr(model, "vorsichtige_ladelast"):
        return {}
    return {t: model.vorsichtige_ladelast[t].upper for t in model.vorsichtige_ladelast}


def test_the_constraint_caps_only_future_surplus_slots_that_are_raised():
    model = build_model(_eingabe())
    assert _gekappt(model) == {
        0: pytest.approx(9.0),  # die Eingabe hebt Slot 0 selbst - der Solver kappt, was er bekommt
        1: pytest.approx(9.0),
        # 2: nicht gehoben; 4: Defizit-Slot (FK3 bleibt frei)
        3: pytest.approx(0.0),  # vorsichtig kein Überschuss mehr
        5: pytest.approx(9.0),
        6: pytest.approx(9.0),
        7: pytest.approx(9.0),
    }
    assert "vorsichtige_ladelast" in KNOWN_CONSTRAINTS


@pytest.mark.parametrize(
    "over",
    [
        {"charge_load_kw": None},  # keine Messwerte / Schalter AUS / eigene Eingaben
        {"netzladen_erlaubt": True},  # Netzladen: der Überschuss ist keine Grenze
        {"battery_held": True},  # Kundenregel hält den Speicher
        {"battery_observed": True},  # nicht gesteuert: fester Eigenverbrauchs-Pfad
    ],
)
def test_no_constraint_where_the_rule_does_not_apply(over):
    assert not hasattr(build_model(_eingabe(**over)), "vorsichtige_ladelast")


def test_forced_charge_slots_win_over_the_cautious_cap():
    model = build_model(_eingabe(forced_charge_slots=2, forced_charge_kw=20.0))
    assert set(_gekappt(model)) == {3, 5, 6, 7}


# --- der Regressionstest: das Muster des 13.10.2026 --------------------------

@pytest.fixture()
def optimize():
    pytest.importorskip("highspy", reason="behavioural MILP assertions need the HiGHS wheel")
    from voltpilot_optimization.solver import optimize as solve

    return solve


def _sonne(stunde: float) -> float:
    return max(0.0, 48.0 * math.sin(math.pi * (stunde - 7.0) / 11.0)) if 7.0 < stunde < 18.0 else 0.0


def _einspeisewert_ct(stunde: float) -> float:
    if stunde < 8:
        return 18.0
    if stunde < 10:
        return 16.0
    if stunde < 12:
        return 13.0
    if stunde < 15:
        return 10.0
    if stunde < 17:
        return 14.0
    if stunde < 21:
        return 24.0
    return 19.0


def _prognose_kw(stunde: float) -> float:
    if 12.0 <= stunde < 15.0:
        return 10.0  # die Persistenz-Prognose: 8 bis 13 kW
    if 17.0 <= stunde < 22.0:
        return 6.0
    return 4.0


def _vortag_kw(stunde: float) -> float:
    return 34.0 if 12.0 <= stunde < 16.5 else 4.0  # Vortag mittags 25 bis 36 kW


def _herzogau_lauf(charge_load: bool) -> tuple[OptimizationInput, list[float]]:
    jetzt = _lokal(13, 8)
    slots = [jetzt + i * Q for i in range(96)]
    stunden = [(s.astimezone(BERLIN).hour + s.astimezone(BERLIN).minute / 60.0) for s in slots]
    last = [_prognose_kw(h) for h in stunden]
    vortag = {
        _lokal(12, 0) + i * Q: _vortag_kw(i / 4.0) for i in range(96)
    }
    hoechste = hoechste_last_der_tageszeit(vortag, slots, jetzt)
    pv = [_sonne(h) for h in stunden]
    inp = OptimizationInput(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        battery=BatteryParams(
            capacity_kwh=65.0,
            max_charge_kw=30.0,
            max_discharge_kw=30.0,
            soc_min_fraction=0.05,
            soc_max_fraction=0.95,
            wear_cost_ct_per_kwh=1.0,
        ),
        slot_starts=slots,
        prices_eur_mwh=[_einspeisewert_ct(h) * 10.0 for h in stunden],
        load_kw=last,
        pv_kw=pv,
        initial_soc_kwh=0.05 * 65.0,
        netzladen_erlaubt=False,
        max_feed_in_kw=75.0,
        import_price_eur_mwh=[250.0] * len(slots),
        export_value_eur_mwh=[_einspeisewert_ct(h) * 10.0 for h in stunden],
        grid_charge_hurdle_ct_kwh=2.0,
        charge_load_kw=vorsichtige_ladelast(last, hoechste, pv) if charge_load else None,
    )
    return inp, stunden


def _geladen_kwh(plan, stunden, von: float, bis: float) -> float:
    return sum(
        max(s.battery_kw, 0.0) * 0.25
        for s, h in zip(plan.slots, stunden)
        if von <= h < bis
    )


def test_herzogau_pattern_without_the_rule_waits_for_noon_with_it_charges_in_the_morning(optimize):
    ohne, stunden = _herzogau_lauf(charge_load=False)
    mit, _ = _herzogau_lauf(charge_load=True)
    plan_ohne = optimize(ohne, UUID(int=1), ohne.slot_starts[0])
    plan_mit = optimize(mit, UUID(int=2), mit.slot_starts[0])

    # Ohne die Regel: der Vormittag geht ins Netz, geladen wird ab Mittag.
    erstes = next(h for s, h in zip(plan_ohne.slots, stunden) if s.battery_kw > 0.5)
    assert erstes >= 12.0
    assert _geladen_kwh(plan_ohne, stunden, 8.0, 12.0) < 0.5

    # Mit der Regel: der Plan rechnet mittags mit 34 kW und lädt vormittags.
    assert _geladen_kwh(plan_mit, stunden, 8.0, 12.0) > 15.0
    # ... und bleibt dabei ein Preisplan: was der vorsichtige Mittag hergibt,
    # lädt er weiter zum Tiefpreis.
    assert _geladen_kwh(plan_mit, stunden, 12.0, 15.0) > 5.0
    # Beide Pläne füllen den Speicher bis zum Ende des Sonnenfensters.
    for plan in (plan_ohne, plan_mit):
        voll = max(s.soc_kwh for s in plan.slots)
        assert voll == pytest.approx(0.95 * 65.0, abs=0.5)


def test_when_the_cautious_noon_still_fills_the_battery_late_charging_stays(optimize):
    # Vortag mittags nur 12 kW: vorsichtig bleiben mehr als 30 kW Überschuss -
    # die Kappung bindet nie, das späte Laden bleibt Viertelstunde für
    # Viertelstunde.
    ohne, stunden = _herzogau_lauf(charge_load=False)
    hoechste = [None] + [12.0 if 12.0 <= h < 16.5 else None for h in stunden[1:]]
    mit = replace(ohne, charge_load_kw=vorsichtige_ladelast(ohne.load_kw, hoechste, ohne.pv_kw))
    assert mit.charge_load_kw is not None
    plan_ohne = optimize(ohne, UUID(int=1), ohne.slot_starts[0])
    plan_mit = optimize(mit, UUID(int=2), mit.slot_starts[0])
    assert [s.battery_kw for s in plan_mit.slots] == pytest.approx(
        [s.battery_kw for s in plan_ohne.slots], abs=1e-6
    )


# --- das Einlesen in gather_inputs ---------------------------------------------


def _anlage(netzladen: bool = False) -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0),
        netzladen_erlaubt=netzladen,
    )


class _Rollup:
    """Antwortet die eine Rollup-Abfrage der Last (dieselbe wie die der
    Nacht-Fehlerverteilung) mit ``zeilen``."""

    def __init__(self, zeilen, fehler: Exception | None = None):
        self.zeilen = zeilen
        self.fehler = fehler
        self.abfragen: list[tuple] = []

    def connect(self, dsn):
        return self

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if self.fehler is not None:
            raise self.fehler
        assert "FROM telemetry_rollup_15m" in sql and "load_kwh" in sql
        self.abfragen.append(params)

    def fetchall(self):
        return self.zeilen


def _einlesen(monkeypatch, rollup, *, netzladen=False, pv=(5.0, 20.0, 40.0, 45.0)):
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=rollup.connect))
    jetzt = _lokal(13, 8)
    slots = [jetzt + i * Q for i in range(4)]
    return inputs._charge_load_input(
        "postgresql://fake", _anlage(netzladen), slots, [3.0, 3.0, 10.0, 10.0], list(pv), jetzt
    )


def test_gather_inputs_reads_the_rollup_and_raises_the_noon_slots(monkeypatch, caplog):
    vortag = _lokal(12, 8)
    rollup = _Rollup([(vortag + i * Q, 34.0 if i >= 2 else 4.0) for i in range(4)])
    with caplog.at_level("INFO"):
        last = _einlesen(monkeypatch, rollup)
    # Slot 0 bleibt die Messung; 08:15 sieht die 34 kW von 08:30 über die
    # Toleranz von einem Slot.
    assert last == [3.0, 34.0, 34.0, 34.0]
    (site_id, seit, bis) = rollup.abfragen[0]
    assert (site_id, bis - seit) == (SITE, timedelta(days=7))
    assert any("vorsichtige_ladelast.gehoben" in r.message for r in caplog.records)


def test_at_night_the_plan_is_the_one_of_before(monkeypatch):
    vortag = _lokal(12, 8)
    rollup = _Rollup([(vortag + i * Q, 34.0) for i in range(4)])
    assert _einlesen(monkeypatch, rollup, pv=(0.0, 0.0, 40.0, 45.0)) is None
    assert rollup.abfragen == []  # nachts wird nichts gelesen


def test_without_measurements_the_normal_forecast_applies_with_a_log_line(monkeypatch, caplog):
    with caplog.at_level("INFO"):
        assert _einlesen(monkeypatch, _Rollup([])) is None
    assert any("vorsichtige_ladelast.keine_messwerte" in r.message for r in caplog.records)


def test_an_unreadable_rollup_costs_the_term_never_the_plan(monkeypatch, caplog):
    with caplog.at_level("WARNING"):
        assert _einlesen(monkeypatch, _Rollup([], fehler=RuntimeError("db down"))) is None
    assert any("vorsichtige_ladelast.unavailable" in r.message for r in caplog.records)


def test_switched_off_or_grid_charging_sites_read_nothing(monkeypatch):
    rollup = _Rollup([])
    monkeypatch.setenv(VORSICHTIGE_LADELAST_AUS_ENV, str(SITE))
    assert _einlesen(monkeypatch, rollup) is None
    monkeypatch.delenv(VORSICHTIGE_LADELAST_AUS_ENV)
    assert _einlesen(monkeypatch, rollup, netzladen=True) is None
    assert rollup.abfragen == []

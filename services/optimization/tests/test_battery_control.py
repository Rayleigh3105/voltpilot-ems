"""Steuerstand (07.10.2026): ein Speicher, den VoltPilot nicht steuert, wird
auch nicht so geplant, als würde er gesteuert.

Die Box meldet in jedem Herzschlag ``battery_control`` (gesteuert, beobachtet,
Not-Aus), die api legt es in ``device_battery_control`` ab, der Optimierer
liest es je Speicher über ``asset.device_id`` mit Frische-Regel. Belegt hier:

* die FRISCHE-REGEL gegen die geteilten Vektoren
  (``docs/contracts/speicher-steuerstand-vectors.json``, ``optimierer``) und
  der LESEPFAD (fail-soft: ohne Tabelle ist jeder Speicher gesteuert);
* der PLAN: ein nicht gesteuerter Speicher fährt seine Eigenverbrauchsregelung
  (die Regel des sturen Speichers) - nie aus dem Netz laden, nie ins Netz
  entladen, keine Vollmachten; ein gesteuerter bleibt byte-identisch;
* das SZENARIO des Auftrags: nachts bei dynamischem Tarif bekommt der
  beobachtete Speicher eine Untergrenze und eine Freigabe, wo der gesteuerte
  Plan Netzladen und Verkauf plant und deshalb keine trägt.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.config import (
    DEFAULT_BATTERY_CONTROL_MAX_AGE_MINUTES,
    battery_control_enabled,
    battery_control_max_age,
)
from voltpilot_optimization.domain import BatteryParams, OptimizationInput, horizon_slot_starts
from voltpilot_optimization.inputs import (
    BATTERY_CONTROL_NOT_COMMANDED,
    BatteryControl,
    battery_observed,
    gather_inputs,
    load_battery_controls,
)
from voltpilot_optimization.storage_release import (
    GRUND_NACHT_UEBER_KAPAZITAET,
    plan_storage_release,
    release_slot,
)
from voltpilot_optimization.stur import eigenverbrauch_dispatch

VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "docs" / "contracts"
     / "speicher-steuerstand-vectors.json").read_text(encoding="utf-8")
)

TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")
DEVICE = UUID("00000000-0000-0000-0000-000000000003")
NOW = datetime(2026, 10, 7, 18, 0, tzinfo=timezone.utc)  # 20:00 in Berlin


# --- Frische-Regel und Lesepfad ---------------------------------------------


def test_the_words_are_the_shared_vocabulary():
    assert VECTORS["states"] == ["gesteuert", "beobachtet", "not_aus"]
    assert BATTERY_CONTROL_NOT_COMMANDED == {"beobachtet", "not_aus"}


def test_the_default_freshness_is_the_contract_value():
    assert DEFAULT_BATTERY_CONTROL_MAX_AGE_MINUTES == VECTORS["optimierer"]["max_alter_minuten"]
    assert battery_control_max_age({}) == timedelta(
        minutes=VECTORS["optimierer"]["max_alter_minuten"]
    )


@pytest.mark.parametrize(
    "case", VECTORS["optimierer"]["faelle"], ids=lambda c: c["name"]
)
def test_the_freshness_rule_follows_the_shared_vectors(case):
    max_age = timedelta(minutes=VECTORS["optimierer"]["max_alter_minuten"])
    row = case["zeile"]
    controls = {}
    if row is not None:
        controls[str(DEVICE)] = BatteryControl(
            state=row["state"],
            reported_at=NOW - timedelta(minutes=row["alter_minuten"]),
        )
    assert battery_observed(controls, DEVICE, NOW, max_age) is case["beobachtet"]


def test_a_battery_without_a_linked_box_is_commanded():
    controls = {str(DEVICE): BatteryControl(state="beobachtet", reported_at=NOW)}
    assert battery_observed(controls, None, NOW, timedelta(minutes=10)) is False
    assert battery_observed(controls, UUID(int=9), NOW, timedelta(minutes=10)) is False
    assert battery_observed(None, DEVICE, NOW, timedelta(minutes=10)) is False


ROWS: list[tuple] = []
SEEN_SQL: list[str] = []
CONNECT_RAISES: list[Exception] = []


class _Cursor:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        SEEN_SQL.append(" ".join(sql.split()))

    def fetchall(self):
        return list(ROWS)


class _Connection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _Cursor()


@pytest.fixture()
def fake_controls_db(monkeypatch):
    ROWS.clear()
    SEEN_SQL.clear()
    CONNECT_RAISES.clear()

    def connect(dsn):
        if CONNECT_RAISES:
            raise CONNECT_RAISES[0]
        return _Connection()

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect))


def test_the_loader_reads_one_row_per_box(fake_controls_db):
    stamp = datetime(2026, 10, 7, 17, 59, tzinfo=timezone.utc)
    ROWS.append((str(DEVICE), "beobachtet", stamp))
    ROWS.append((str(UUID(int=7)), "gesteuert", stamp))
    controls = load_battery_controls("postgresql://fake", env={})
    assert controls[str(DEVICE)] == BatteryControl(state="beobachtet", reported_at=stamp)
    assert controls[str(UUID(int=7))].state == "gesteuert"
    assert any("FROM device_battery_control" in s for s in SEEN_SQL)


def test_a_missing_table_reads_as_commanded(fake_controls_db):
    """Optimierer vor der api-Migration: kein Steuerstand, jeder Speicher
    gesteuert - nie eine Anlage ohne Plan."""
    CONNECT_RAISES.append(RuntimeError('relation "device_battery_control" does not exist'))
    assert load_battery_controls("postgresql://fake", env={}) == {}


def test_the_switch_turns_the_whole_reading_off(fake_controls_db):
    ROWS.append((str(DEVICE), "beobachtet", NOW))
    env = {"OPTIMIZER_BATTERY_CONTROL_ENABLED": "false"}
    assert battery_control_enabled(env) is False
    assert load_battery_controls("postgresql://fake", env=env) == {}
    assert SEEN_SQL == [], "with the switch off the table is not even read"
    with pytest.raises(ValueError):
        battery_control_enabled({"OPTIMIZER_BATTERY_CONTROL_ENABLED": "vielleicht"})


# Die Fake-DB der Regel-Claims beantwortet alle Lesungen von gather_inputs.
from test_flow_claim import NOW as CLAIM_NOW  # noqa: E402
from test_flow_claim import SLOTS as CLAIM_SLOTS  # noqa: E402
from test_flow_claim import _site as claim_site  # noqa: E402
from test_flow_claim import fake_psycopg  # noqa: E402,F401  (fixture)


def test_gather_inputs_marks_only_a_freshly_reported_observed_battery(fake_psycopg):
    site = replace(claim_site(), device_id=DEVICE)

    def inputs(controls):
        return gather_inputs("postgresql://fake", site, CLAIM_NOW, CLAIM_SLOTS,
                             battery_claims={}, battery_controls=controls)

    def row(state, age):
        return {str(DEVICE): BatteryControl(state=state, reported_at=CLAIM_NOW - age)}

    assert inputs(row("beobachtet", timedelta(minutes=1))).battery_observed is True
    assert inputs(row("not_aus", timedelta(minutes=1))).battery_observed is True
    assert inputs(row("gesteuert", timedelta(minutes=1))).battery_observed is False
    assert inputs(row("beobachtet", timedelta(hours=1))).battery_observed is False
    assert inputs({}).battery_observed is False


def test_gather_inputs_reads_the_states_itself_when_none_are_handed_in(fake_psycopg):
    """Der Einzel-Lauf (Replan, What-if) liest selbst - fail-soft: die
    Fake-DB kennt die Tabelle nicht, also gesteuert."""
    site = replace(claim_site(), device_id=DEVICE)
    inp = gather_inputs("postgresql://fake", site, CLAIM_NOW, CLAIM_SLOTS, battery_claims={})
    assert inp.battery_observed is False


# --- Der Plan ----------------------------------------------------------------

highspy = pytest.importorskip("highspy", reason="behavioural MILP assertions need the HiGHS wheel")

from voltpilot_optimization.solver import optimize  # noqa: E402

N = 96  # 20:00 bis 20:00 am Folgetag
BATTERY = BatteryParams(
    capacity_kwh=15.0, max_charge_kw=5.0, max_discharge_kw=5.0, roundtrip_efficiency=0.9,
)
SLOT_STARTS = horizon_slot_starts(NOW, N)


def _local_hour(ts: datetime) -> float:
    local = ts + timedelta(hours=2)  # Oktober: Sommerzeit
    return local.hour + local.minute / 60.0


def _pv(h: float) -> float:
    if h < 8.0 or h > 18.0:
        return 0.0
    return 6.0 * math.sin(math.pi * (h - 8.0) / 10.0) ** 2


def _load(h: float) -> float:
    if 22.0 <= h or h < 6.0:
        return 0.3
    if 6.0 <= h < 9.0:
        return 0.8
    return 0.6


def _spot(h: float) -> float:
    """Ein dynamischer Day-Ahead-Tag [EUR/MWh]: teurer Abend, tiefes Nachttal,
    Morgenspitze vor der Sonne, billiger Mittag."""
    if 2.0 <= h < 5.0:
        return 10.0
    if 7.0 <= h < 9.0:
        return 380.0
    if 9.0 <= h < 16.0:
        return 60.0
    if h >= 18.0 or h < 2.0:
        return 280.0 if h >= 18.0 else 150.0
    return 200.0


def night_input(**over) -> OptimizationInput:
    hours = [_local_hour(ts) for ts in SLOT_STARTS]
    spot = [_spot(h) for h in hours]
    base = dict(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=DEVICE,
        battery=BATTERY,
        slot_starts=SLOT_STARTS,
        prices_eur_mwh=spot,
        load_kw=[_load(h) for h in hours],
        pv_kw=[_pv(h) for h in hours],
        initial_soc_kwh=12.0,  # 80 %
        netzladen_erlaubt=True,
        # Dynamischer Tarif: Bezug = Börse + 15 ct Umlagen; Einspeisung zum
        # Börsenwert (Direktvermarktung) - der Plan handelt.
        import_price_eur_mwh=[p + 150.0 for p in spot],
        export_value_eur_mwh=list(spot),
    )
    base.update(over)
    return OptimizationInput(**base)


def release(plan):
    return plan_storage_release(
        plan, reserve_kwh=None, night_errors=None, pv_errors=None,
        forecasts_fresh=True, battery_observed=plan.battery_observed,
    )


def _night(ts: datetime) -> bool:
    h = _local_hour(ts)
    return h >= 22.0 or h < 6.0


def test_an_observed_battery_follows_its_own_self_consumption():
    plan = optimize(night_input(battery_observed=True), UUID(int=1), NOW)
    assert plan.battery_observed is True
    own = eigenverbrauch_dispatch(night_input())
    assert [s.battery_kw for s in plan.slots] == pytest.approx(own.battery_kw, abs=1e-3)
    for s in plan.slots:
        surplus = max(s.pv_kw - s.load_kw, 0.0)
        deficit = max(s.load_kw - s.pv_kw, 0.0)
        # Nie aus dem Netz laden, nie ins Netz entladen: keine Handels-Viertelstunde.
        assert s.battery_kw <= surplus + 1e-4
        assert -s.battery_kw <= deficit + 1e-4


def test_an_observed_battery_gets_no_in_slot_authority_and_no_night_value():
    plan = optimize(night_input(battery_observed=True), UUID(int=2), NOW)
    for s in plan.slots:
        assert s.charge_from_surplus_only is None
        assert s.cover_load_from_battery is None
        assert s.unplanned_load_discharge is None
        assert s.limit_discharge_to_load is None
        assert s.charge_surplus_to_battery is None
    assert plan.why_night_reserve is None


def test_a_commanded_battery_is_byte_identical():
    default = optimize(night_input(), UUID(int=3), NOW)
    explicit = optimize(night_input(battery_observed=False), UUID(int=3), NOW)
    assert explicit == default
    assert default.battery_observed is False
    assert release(explicit) == release(default)


def test_a_rule_or_an_unknown_soc_still_rests_the_battery():
    """Ein Ruhe-Grund geht vor: eine Kundenregel hält den Speicher."""
    plan = optimize(night_input(battery_observed=True, battery_held=True), UUID(int=4), NOW)
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert plan.battery_observed is False


def test_an_observed_battery_at_night_on_a_dynamic_tariff_gets_a_floor_and_a_release():
    """Das Szenario des Auftrags (offener Punkt aus #1449).

    Gesteuert plant der Optimierer im Nachttal Netzladen und an Abend- und
    Morgenspitze Verkauf. In den Netzlade-Viertelstunden gibt es keine
    Untergrenze (``plan_handelt``), und die geplanten Verkäufe zählen als
    Entnahme: hier heben sie den Bedarf über die Kapazität, und der ganze Lauf
    gibt nichts frei. Ein beobachteter Speicher führt diesen Plan nie aus: er
    bekommt den Eigenverbrauchs-Plan, eine Untergrenze in JEDER
    Nacht-Viertelstunde und darüber eine Freigabe.
    """
    commanded = optimize(night_input(), UUID(int=5), NOW)
    observed = optimize(night_input(battery_observed=True), UUID(int=5), NOW)

    # Nicht leer: der gesteuerte Plan handelt wirklich - nachts aus dem Netz
    # laden, Speicherenergie verkaufen.
    night_charge = [s for s in commanded.slots
                    if _night(s.start) and s.battery_kw > 0.1 and s.grid_kw > 0.1]
    assert night_charge, "the commanded plan must grid-charge in the night valley"
    assert any(s.battery_kw < -0.1 and s.grid_kw < -0.1 for s in commanded.slots), \
        "the commanded plan must sell from the battery"

    rc, ro = release(commanded), release(observed)

    # Gesteuert unverändert (der Stand vor dem Steuerstand): keine Untergrenze
    # in den Netzlade-Viertelstunden, und die geplanten Verkäufe heben den
    # Bedarf hier über die Kapazität - die ganze Nacht keine Freigabe.
    for s in night_charge:
        assert rc.floor_soc_pct[commanded.slots.index(s)] is None
    assert rc.grund == GRUND_NACHT_UEBER_KAPAZITAET
    assert ro.grund is None

    # Beobachtet: jede Nacht-Viertelstunde trägt eine Untergrenze ...
    night_idx = [i for i, s in enumerate(observed.slots) if _night(s.start)]
    assert night_idx
    assert all(ro.floor_soc_pct[i] is not None for i in night_idx)
    # ... und die Box gibt darüber frei: der Ladestand liegt mehr als die
    # Start-Hysterese (2 Punkte) über der Untergrenze - jetzt um 20:00 und
    # mitten in der Nacht, wo der gesteuerte Plan Netz lädt.
    assert ro.floor_soc_pct[0] + 2.0 < 80.0
    for s in night_charge:
        i = observed.slots.index(next(o for o in observed.slots if o.start == s.start))
        soc_pct = observed.slots[i - 1].soc_kwh / BATTERY.capacity_kwh * 100.0
        assert ro.floor_soc_pct[i] + 2.0 < soc_pct

    # Kein geplanter Verkauf hebt sie: dieselbe Rechnung wie für einen Plan,
    # der den Speicher nur Eigenverbrauch fahren lässt.
    assert ro.floor_kwh == release(optimize(
        night_input(battery_observed=True, export_value_eur_mwh=[0.0] * N), UUID(int=5), NOW
    )).floor_kwh


def test_after_a_switch_either_plan_is_safe_for_either_box():
    """Die Minuten nach einem Wechsel: die Box entscheidet sofort nach ihrem
    eigenen Stand, der Plan folgt mit dem nächsten Lauf.

    * beobachtet -> gesteuert: die Box führt den Eigenverbrauchs-Plan aus. Er
      lädt nie aus dem Netz und verkauft nie, also steht keine Untergrenze in
      einem Slot, in dem der Plan handelt.
    * gesteuert -> beobachtet: die Box hält den gesteuerten Plan. In seinen
      Handels-Viertelstunden fehlt die Untergrenze - zu wenig Freigabe, nie zu
      viel.
    """
    observed = optimize(night_input(battery_observed=True), UUID(int=6), NOW)
    for s in observed.slots:
        trades = s.battery_kw > max(s.pv_kw - s.load_kw, 0.0) + 1e-4 or (
            s.battery_kw < 0.0 and s.grid_kw < -1e-4)
        assert not trades
    commanded = optimize(night_input(), UUID(int=6), NOW)
    rc = release(commanded)
    for i, s in enumerate(commanded.slots):
        if not release_slot(s.battery_kw, s.grid_kw, s.load_kw, s.pv_kw):
            assert rc.floor_soc_pct[i] is None


def test_the_cycle_reads_the_states_once_and_releases_at_the_observed_site(monkeypatch):
    """Durch den Takt: EIN Lesen des Steuerstands, der Plan als Eigenverbrauch,
    die Untergrenze ohne Handelsprüfung, und das Log sagt es."""
    import voltpilot_optimization.engine as engine
    from voltpilot_optimization.inputs import BatterySite
    from voltpilot_optimization.persistence import InMemoryScheduleRepository
    from voltpilot_optimization.publisher import RecordingSchedulePublisher
    from voltpilot_optimization.storage_release import ReleaseForecast, ReleaseSetting

    site = BatterySite(
        tenant_id=TENANT, site_id=SITE, device_id=DEVICE, bidding_zone="DE-LU",
        battery=BATTERY, netzladen_erlaubt=True,
    )
    reads: list[str] = []

    def load_controls(dsn):
        reads.append(dsn)
        return {str(DEVICE): BatteryControl(state="beobachtet", reported_at=NOW)}

    def gather(dsn, s, now, horizon_slots, model_choices=None, battery_claims=None,
               battery_controls=None):
        return night_input(battery_observed=battery_observed(battery_controls, s.device_id, now))

    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: [site])
    monkeypatch.setattr(engine, "load_battery_controls", load_controls)
    monkeypatch.setattr(engine, "gather_inputs", gather)
    monkeypatch.setattr(
        engine, "load_release_settings",
        lambda dsn: {str(SITE): ReleaseSetting(reserve_kwh=None)},
    )
    monkeypatch.setattr(engine, "load_model_choices", lambda dsn: None)
    monkeypatch.setattr(engine, "load_battery_claims", lambda dsn: {})
    monkeypatch.setattr(engine, "release_forecast", lambda *a, **k: ReleaseForecast(fresh=True))
    monkeypatch.setattr(engine, "pv_day_error_quantiles", lambda *a, **k: None)
    monkeypatch.setattr(engine, "night_error_quantiles", lambda *a, **k: None)

    publisher = RecordingSchedulePublisher()
    summary = engine.run_cycle("dsn://ignored", InMemoryScheduleRepository(), publisher, now=NOW)
    assert reads == ["dsn://ignored"]
    plan = summary.planned[0]
    assert plan.battery_observed is True
    rel = plan.storage_release
    assert rel.grund is None
    assert all(rel.floor_soc_pct[i] is not None
               for i, s in enumerate(plan.slots) if _night(s.start))
    _, payload = publisher.published[0]
    assert "ev_release_floor_soc_pct" in payload["slots"][0]
    assert "EIGENVERBRAUCH" in summary.line()

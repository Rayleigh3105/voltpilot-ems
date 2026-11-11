"""NS-5 B: der Morgenüberschuss in Ruhe-Slots (Herzogau/Pilsting, Captain-
Entscheid 15.10.2026, Untersuchung vp-herzogau-nie-schlechter-k5 §7.5).

An einer eingeschalteten Anlage bekommt jeder Ruhe-Slot vom Tagesanfang bis zum
ersten Lade-Slot des Tages die Freigabe ``charge_surplus_to_battery`` - auch
dort, wo der Plan den Überschuss bewusst ins Netz lässt, um mittags billiger zu
laden. Danach gilt die ökonomische Regel wie bisher. Bewiesen in drei Lagen:

- die reine Regel (:func:`voltpilot_optimization.slot_trim.morgen_ueberschuss_slots`)
  an handgebauten Reihen;
- der Schalter je Anlage und der gelesene Tageszustand (``inputs``);
- die Regel im echten gelösten Plan: vormittags Freigabe und Grund, ab dem
  ersten Lade-Slot derselbe Plan wie ohne Schalter, Sollwerte unverändert.

Zwischenlösung bis NS-3 B, danach je Anlage abschalten.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization.config import morgen_ueberschuss_enabled
from voltpilot_optimization.domain import (
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.slot_trim import (
    PLANNED_IDLE_DEADBAND_KW,
    SLOT_FLAG_MORGEN_UEBERSCHUSS,
    SOC_HEADROOM_DEADBAND_KWH,
    morgen_ueberschuss_slots,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

BERLIN = ZoneInfo("Europe/Berlin")
#: 13.10.2026, 06:00 Berlin - der Tag, an dem der Großverbraucher den Mittag nahm.
T0 = datetime(2026, 10, 13, 4, 0, tzinfo=timezone.utc)


# ---- die Regel ---------------------------------------------------------------

RUHE, LADEN, ENTLADEN = 0.0, 12.0, -4.0


def _regel(battery, pv=None, soc=None, *, start=T0, soc_max=50.0, heute_geladen=False):
    n = len(battery)
    return morgen_ueberschuss_slots(
        slot_starts=horizon_slot_starts(start, n),
        battery_kw=battery,
        pv_kw=pv if pv is not None else [10.0] * n,
        soc_kwh=soc if soc is not None else [5.0] * n,
        soc_max_kwh=soc_max,
        heute_geladen=heute_geladen,
    )


def test_ruhe_vor_dem_ersten_lade_slot_bekommt_die_freigabe_danach_nicht():
    """Das Fenster endet VOR dem ersten Lade-Slot; ein Entlade-Slot davor bleibt,
    wie er ist, und beendet es nicht. Nach dem Laden - Ruhe zwischen Laden und
    Verkauf, Verkauf, Abend - bekommt die Morgenregel nichts mehr."""
    plan = [RUHE, RUHE, ENTLADEN, RUHE, LADEN, RUHE, ENTLADEN, RUHE, LADEN, RUHE]
    assert _regel(plan) == [True, True, False, True, False, False, False, False, False, False]


def test_die_ruhe_totzone_ist_die_der_anderen_vollmachten():
    knapp = PLANNED_IDLE_DEADBAND_KW
    plan = [knapp, -knapp, knapp + 0.01, RUHE]
    assert _regel(plan) == [True, True, False, False]


def test_ohne_lade_slot_gilt_die_freigabe_bis_zum_letzten_sonnenslot():
    """Ein Tag ohne Lade-Slot: kein späterer, billigerer Ladezeitpunkt, auf den
    das Warten setzen könnte - die Freigabe reicht bis zum letzten Sonnenslot.
    Danach gibt es keinen Überschuss mehr und der Grund erklärte nichts."""
    plan = [RUHE] * 8
    pv = [0.0, 0.0, 6.0, 9.0, 0.0, 4.0, 0.0, 0.0]  # Wolke um Slot 4 zählt nicht als Ende
    assert _regel(plan, pv) == [True, True, True, True, True, True, False, False]


def test_ein_tag_ohne_lade_slot_und_ohne_sonne_bekommt_keine_freigabe():
    plan = [RUHE] * 6
    assert _regel(plan, [0.0] * 6) == [False] * 6
    assert _regel(plan, [0.05] * 6) == [False] * 6  # Totzone, keine Sonne


def test_heute_schon_geladen_beendet_das_fenster_bis_zum_naechsten_tag():
    """Lief heute schon ein Lade-Slot (vor dem Horizont), ist der erste
    Lade-Slot dieses Tages vorbei: kein neues Morgenfenster am Nachmittag.
    Der nächste Berliner Tag beginnt wieder bei 0 Uhr."""
    start = datetime(2026, 10, 13, 8, 0, tzinfo=timezone.utc)  # 10:00 Berlin
    # 13.10. 10:00-23:45 ruht (Sonne bis 16:00), 14.10. 00:00-00:45 lädt um 00:30.
    plan = [RUHE] * 56 + [RUHE, RUHE, LADEN, RUHE]
    pv = [10.0] * 24 + [0.0] * 36
    morgen = [True, True, False, False]
    assert _regel(plan, pv, start=start, heute_geladen=True) == [False] * 56 + morgen
    # Ohne Ladung heute: der 13. hat keinen Lade-Slot mehr, also bis 16:00.
    assert _regel(plan, pv, start=start, heute_geladen=False) == (
        [True] * 24 + [False] * 32 + morgen
    )


def test_der_tag_ist_der_berliner_tag():
    """Um 22:00 UTC beginnt im Oktober (MESZ) der neue Berliner Tag - dort
    beginnt das Fenster neu, auch wenn um 23:30 Berlin schon geladen war. Nach
    dem UTC-Tag lägen alle vier Slots am 13. hinter dem Lade-Slot."""
    start = datetime(2026, 10, 13, 21, 30, tzinfo=timezone.utc)  # 23:30 Berlin
    plan = [LADEN, RUHE, RUHE, RUHE]  # 23:30, 23:45 | 00:00, 00:15
    assert _regel(plan, start=start) == [False, False, True, True]
    # Winterzeit: 23:00 UTC ist 00:00 Berlin.
    winter = datetime(2026, 12, 1, 22, 30, tzinfo=timezone.utc)  # 23:30 Berlin
    assert _regel(plan, start=winter) == [False, False, True, True]


def test_ohne_platz_in_der_soc_bahn_keine_freigabe():
    """Wie Bedingung 3 der ökonomischen Regel: eine Pflicht, die der Speicher
    nicht erfüllen kann, wird nie veröffentlicht. Das Slot-ENDE zählt."""
    voll = 50.0 - SOC_HEADROOM_DEADBAND_KWH
    plan = [RUHE, RUHE, RUHE]
    assert _regel(plan, soc=[voll - 0.01, voll, 50.0]) == [True, False, False]


def test_kaputte_zahlen_geben_keine_freigabe():
    nan = math.nan
    # Ein nicht endlicher Sollwert beendet das Fenster des Tages ...
    assert _regel([RUHE, nan, RUHE]) == [True, False, False]
    # ... ein nicht endlicher Ladestand nimmt nur diesem Slot die Freigabe.
    assert _regel([RUHE, RUHE, RUHE], soc=[5.0, nan, 5.0]) == [True, False, True]
    assert _regel([RUHE, RUHE], soc_max=nan) == [False, False]
    assert _regel([]) == []


# ---- der Schalter je Anlage ----------------------------------------------------

HERZOGAU = UUID("063012ff-4be7-4c1f-85c4-498bf555bd12")
TENANT = UUID("e09aa026-9a21-48ee-a117-84f2f9552d74")
BOX = UUID("00000000-0000-0000-0000-0000000000b0")


def test_der_schalter_ist_je_anlage_und_vorgabe_aus():
    env = "OPTIMIZER_MORGEN_UEBERSCHUSS_ANLAGEN"
    assert morgen_ueberschuss_enabled(HERZOGAU, {}) is False
    assert morgen_ueberschuss_enabled(HERZOGAU, {env: ""}) is False
    assert morgen_ueberschuss_enabled(HERZOGAU, {env: f" {HERZOGAU} ,"}) is True
    assert morgen_ueberschuss_enabled(str(HERZOGAU), {env: f"{uuid4()},{HERZOGAU}"}) is True
    assert morgen_ueberschuss_enabled(uuid4(), {env: str(HERZOGAU)}) is False
    with pytest.raises(ValueError):
        morgen_ueberschuss_enabled(HERZOGAU, {env: "herzogau"})


# ---- der gelesene Tageszustand ---------------------------------------------------


class _Cur:
    def __init__(self, seen):
        self.seen = seen

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.seen["sql"] = " ".join(sql.split())
        self.seen["params"] = params

    def fetchone(self):
        if isinstance(self.seen.get("row"), Exception):
            raise self.seen["row"]
        return self.seen.get("row")


def _fake_psycopg(monkeypatch, seen):
    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cur(seen)

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )


def test_der_lauf_liest_ob_heute_schon_ein_geplanter_lade_slot_lief(monkeypatch):
    """Gezählt wird je vergangenem Slot der Plan, der ihn ausgeführt hat: die
    Zeile eines Laufs, der in diesem Slot entstand. Ein Lesefehler heißt
    „nicht lesbar“ (None), nie „nicht geladen“."""
    from voltpilot_optimization.inputs import _heute_geplant_geladen

    seen: dict = {}
    _fake_psycopg(monkeypatch, seen)
    site = uuid4()
    jetzt = datetime(2026, 10, 13, 10, 0, tzinfo=timezone.utc)  # 12:00 Berlin

    seen["row"] = (True,)
    assert _heute_geplant_geladen("dsn", site, jetzt) is True
    anlage, von, bis, slot, totzone = seen["params"]
    assert anlage == site
    assert von == datetime(2026, 10, 13, tzinfo=BERLIN)  # 0 Uhr Berlin
    assert bis == jetzt
    assert slot == timedelta(minutes=15)
    assert totzone == PLANNED_IDLE_DEADBAND_KW
    assert "FROM schedule" in seen["sql"]
    assert "generated_at >= time AND generated_at < time +" in seen["sql"]
    assert "battery_kw >" in seen["sql"]

    seen["row"] = (False,)
    assert _heute_geplant_geladen("dsn", site, jetzt) is False
    seen["row"] = RuntimeError("Datenbank weg")
    assert _heute_geplant_geladen("dsn", site, jetzt) is None

    # Um 0 Uhr Berlin liegt nichts von heute vor dem Horizont - keine Abfrage.
    seen.clear()
    mitternacht = datetime(2026, 10, 13, tzinfo=BERLIN).astimezone(timezone.utc)
    assert _heute_geplant_geladen("dsn", site, mitternacht) is False
    assert "sql" not in seen


# ---- im echten gelösten Plan -------------------------------------------------------

BATTERY = BatteryParams(
    capacity_kwh=60.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
)


def _stunde(st: int) -> tuple[float, float, float, float]:
    """Herzogau im Kleinen, je Berliner Stunde: (PV, Last, Einspeisewert ct,
    Bezug ct). Vormittags Überschuss zu 12 ct, mittags 1 ct (dort will der
    Plan laden), nachmittags hoher Einspeisewert (Verkauf), abends Last."""
    if 8 <= st < 11:
        return 20.0, 5.0, 12.0, 30.0
    if 11 <= st < 14:
        return 25.0, 5.0, 1.0 + 0.1 * (st - 11), 30.0
    if 14 <= st < 17:
        return 10.0, 5.0, 31.0, 34.0
    if 17 <= st < 21:
        return 0.0, 3.0, 20.0, 34.0
    return 0.0, 1.0, 10.0, 30.0


def herzogau_tage(tage: int = 2, **over) -> OptimizationInput:
    """Zwei Tage ab 13.10. 06:00 Berlin, Speicher leer (3 kWh)."""
    pv, last, einspeisung, bezug = [], [], [], []
    for h in range(24 * tage):
        p, l, e, b = _stunde((6 + h) % 24)
        for _ in range(4):
            pv.append(p)
            last.append(l)
            einspeisung.append(e * 10.0)
            bezug.append(b * 10.0)
    n = len(pv)
    base = dict(
        tenant_id=TENANT,
        site_id=HERZOGAU,
        device_id=BOX,
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=list(einspeisung),
        load_kw=last,
        pv_kw=pv,
        initial_soc_kwh=3.0,
        netzladen_erlaubt=False,  # EEG-Anlage
        import_price_eur_mwh=bezug,
        export_value_eur_mwh=einspeisung,
    )
    base.update(over)
    return OptimizationInput(**base)


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


def _berlin(slot) -> datetime:
    return slot.start.astimezone(BERLIN)


def _erster_lade_slot(plan, tag: int) -> int:
    return next(
        i
        for i, s in enumerate(plan.slots)
        if _berlin(s).day == tag and s.battery_kw > PLANNED_IDLE_DEADBAND_KW
    )


def _ist_ruhe(slot) -> bool:
    return abs(slot.battery_kw) <= PLANNED_IDLE_DEADBAND_KW


@needs_highs
def test_der_vormittag_laedt_den_ueberschuss_bis_zum_ersten_lade_slot():
    """Der Fall des 13.10.: vormittags ruht der Plan und lässt den Überschuss
    zu 12 ct ins Netz, weil er mittags zu 1 ct laden will. Mit Schalter tragen
    genau diese Slots die Freigabe und den Grund. Nicht leer: ohne Schalter
    verweigert die ökonomische Regel sie (geplanter Export)."""
    aus = solve(herzogau_tage())
    an = solve(herzogau_tage(morgen_ueberschuss=True))

    erster = _erster_lade_slot(aus, 13)
    vormittag = [
        i for i in range(erster) if aus.slots[i].pv_kw > aus.slots[i].load_kw
    ]
    assert len(vormittag) == 12, "08:00-11:00 ruhen mit Überschuss"
    for i in vormittag:
        assert _ist_ruhe(aus.slots[i]) and aus.slots[i].grid_kw < -10.0
        assert not aus.slots[i].charge_surplus_to_battery
        assert an.slots[i].charge_surplus_to_battery is True
        assert SLOT_FLAG_MORGEN_UEBERSCHUSS in an.slots[i].slot_flags
    # Vor dem ersten Lade-Slot ist jeder Ruhe-Slot frei - auch die Nacht davor,
    # wo die ökonomische Regel ohnehin frei gab (dort steht kein Grund).
    assert all(an.slots[i].charge_surplus_to_battery for i in range(erster))
    for i in range(erster):
        hat_grund = SLOT_FLAG_MORGEN_UEBERSCHUSS in an.slots[i].slot_flags
        assert hat_grund == (not aus.slots[i].charge_surplus_to_battery)


@needs_highs
def test_ab_dem_ersten_lade_slot_bleibt_der_tag_wie_heute():
    """Laden, Verkauf, die Ruhe zwischen Verkauf und Abend, der Abend: dieselben
    Freigaben und Gründe wie ohne Schalter. Nicht leer: am Nachmittag ruht der
    Plan mit Platz im Speicher und Überschuss - dort gäbe die Morgenregel
    sonst frei."""
    aus = solve(herzogau_tage())
    an = solve(herzogau_tage(morgen_ueberschuss=True))

    erster = _erster_lade_slot(aus, 13)
    naechster_tag = next(i for i, s in enumerate(aus.slots) if _berlin(s).day == 14)
    nachmittag = [
        i
        for i in range(erster, naechster_tag)
        if _ist_ruhe(aus.slots[i])
        and aus.slots[i].pv_kw > aus.slots[i].load_kw
        and aus.slots[i].soc_kwh < BATTERY.soc_max_kwh - 1.0
    ]
    assert nachmittag, "das Szenario muss nach dem Laden mit Platz ruhen"
    assert not any(aus.slots[i].charge_surplus_to_battery for i in nachmittag)
    assert any(aus.slots[i].slot_role == "verkaufen" for i in range(erster, naechster_tag))
    for i in range(erster, naechster_tag):
        a, b = aus.slots[i], an.slots[i]
        assert (b.charge_surplus_to_battery, b.slot_flags) == (
            a.charge_surplus_to_battery,
            a.slot_flags,
        )
        assert b.unplanned_load_discharge == a.unplanned_load_discharge


@needs_highs
def test_jeder_tag_beginnt_ein_neues_fenster_ausser_heute_war_schon_geladen():
    an = solve(herzogau_tage(morgen_ueberschuss=True))
    geladen = solve(
        herzogau_tage(morgen_ueberschuss=True, morgen_ueberschuss_heute_geladen=True)
    )
    aus = solve(herzogau_tage())

    def vormittag(plan, tag):
        return [
            s
            for s in plan.slots
            if _berlin(s).day == tag and 8 <= _berlin(s).hour < 11
        ]

    assert all(s.charge_surplus_to_battery for s in vormittag(an, 14))
    # Heute lief schon ein Lade-Slot: der 13. bleibt wie ohne Schalter, der
    # 14. bekommt sein Fenster.
    for a, g in zip(vormittag(aus, 13), vormittag(geladen, 13)):
        assert (g.charge_surplus_to_battery, g.slot_flags) == (
            a.charge_surplus_to_battery,
            a.slot_flags,
        )
    assert all(s.charge_surplus_to_battery for s in vormittag(geladen, 14))


@needs_highs
def test_die_sollwerte_bleiben_unveraendert():
    """Die Regel stempelt nach dem Lösen wie die Freigabe selbst: dieselben
    Sollwerte, dieselbe SoC-Bahn. Die Box hebt den Sollwert 0 erst gegen den
    GEMESSENEN Überschuss."""
    aus = solve(herzogau_tage())
    an = solve(herzogau_tage(morgen_ueberschuss=True))
    for a, b in zip(aus.slots, an.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw) == (
            b.battery_kw,
            b.grid_kw,
            b.soc_kwh,
            b.curtail_kw,
        )


@needs_highs
def test_schalter_aus_laesst_den_plan_unveraendert():
    """Aus heißt aus - auch mit einem gelesenen Tageszustand: dieselbe
    MQTT-Nachricht und dieselben Gründe wie eine Anlage ohne das Feld."""
    from voltpilot_optimization.publisher import build_schedule_payload

    ohne = solve(herzogau_tage())
    aus = solve(herzogau_tage(morgen_ueberschuss_heute_geladen=True))

    def ohne_kennung(payload):
        return {k: v for k, v in payload.items() if k not in ("plan_id",)}

    assert ohne_kennung(build_schedule_payload(aus)) == ohne_kennung(
        build_schedule_payload(ohne)
    )
    assert [s.slot_flags for s in aus.slots] == [s.slot_flags for s in ohne.slots]
    assert not any(
        SLOT_FLAG_MORGEN_UEBERSCHUSS in s.slot_flags for s in aus.slots
    )


@needs_highs
def test_nie_beide_vollmachten_in_einem_ruhe_slot():
    """Die Morgenregel IST die Überschuss-Freigabe, also gilt die Regel „nie
    beide Vollmachten“: wo sie frei gibt, entfällt unplanned_load_discharge.
    Ein Defizit deckt die Box in Ruhe dann selbst (deficit_cover). Nicht leer:
    ohne Schalter trugen die Vormittags-Slots unplanned_load_discharge."""
    aus = solve(herzogau_tage())
    an = solve(herzogau_tage(morgen_ueberschuss=True))

    gewechselt = [
        i
        for i, s in enumerate(an.slots)
        if SLOT_FLAG_MORGEN_UEBERSCHUSS in s.slot_flags
    ]
    assert any(aus.slots[i].unplanned_load_discharge for i in gewechselt)
    assert not any(
        s.charge_surplus_to_battery and s.unplanned_load_discharge for s in an.slots
    )


@needs_highs
def test_der_kill_switch_der_freigabe_und_jede_sperre_gelten_mit(monkeypatch):
    """``OPTIMIZER_SURPLUS_CHARGE_ENABLED=false`` schaltet die Morgenregel mit
    ab; ohne Ladestand und an einem nicht gesteuerten Speicher entfällt sie wie
    jede andere Vollmacht. Hält eine Kundenregel den Speicher, ruht der Plan
    nur, weil er ihn nicht führt - auch dann kein Morgenfenster."""
    monkeypatch.setenv("OPTIMIZER_SURPLUS_CHARGE_ENABLED", "false")
    aus = solve(herzogau_tage(morgen_ueberschuss=True))
    assert all(s.charge_surplus_to_battery is None for s in aus.slots)
    assert not any(SLOT_FLAG_MORGEN_UEBERSCHUSS in s.slot_flags for s in aus.slots)
    monkeypatch.delenv("OPTIMIZER_SURPLUS_CHARGE_ENABLED")

    for gesperrt in (
        herzogau_tage(morgen_ueberschuss=True, soc_source=SOC_SOURCE_UNBEKANNT),
        herzogau_tage(morgen_ueberschuss=True, battery_observed=True),
    ):
        plan = solve(gesperrt)
        assert not any(s.charge_surplus_to_battery for s in plan.slots)
        assert not any(
            SLOT_FLAG_MORGEN_UEBERSCHUSS in s.slot_flags for s in plan.slots
        )

    # Am gehaltenen Speicher bleibt die ökonomische Freigabe, wie sie war.
    gehalten = solve(herzogau_tage(morgen_ueberschuss=True, battery_held=True))
    ohne = solve(herzogau_tage(battery_held=True))
    assert [(s.charge_surplus_to_battery, s.slot_flags) for s in gehalten.slots] == [
        (s.charge_surplus_to_battery, s.slot_flags) for s in ohne.slots
    ]


@needs_highs
def test_ein_tag_ohne_lade_slot_gibt_bis_zum_letzten_sonnenslot_frei():
    """Ist der Speicher schon voll genug, lädt der Plan an diesem Tag nicht: die
    Freigabe reicht bis zum letzten Sonnenslot, nie in den Abend."""
    hoch = [300.0] * 96  # 30 ct Einspeisung den ganzen Tag: Laden lohnt nie
    inp = herzogau_tage(
        tage=1,
        morgen_ueberschuss=True,
        prices_eur_mwh=hoch,
        export_value_eur_mwh=hoch,
        import_price_eur_mwh=[310.0] * 96,
    )
    plan = solve(inp)
    assert not any(s.battery_kw > PLANNED_IDLE_DEADBAND_KW for s in plan.slots), (
        "das Szenario muss einen Tag ohne Lade-Slot planen"
    )
    letzte_sonne = max(i for i, s in enumerate(plan.slots) if s.pv_kw > 0.05)
    for i, s in enumerate(plan.slots):
        if i > letzte_sonne:
            assert SLOT_FLAG_MORGEN_UEBERSCHUSS not in s.slot_flags
    mit_ueberschuss = [
        s for s in plan.slots if s.pv_kw > s.load_kw and _ist_ruhe(s)
    ]
    assert mit_ueberschuss
    assert all(s.charge_surplus_to_battery for s in mit_ueberschuss)


def test_gather_inputs_liest_den_tageszustand_nur_bei_eingeschalteter_anlage(
    monkeypatch,
):
    """Der Weg vom Schalter in die Eingabe: aus = kein Lesen, an = Lesen, und
    ein Lesefehler kostet diesen Lauf die Regel, nie den Plan."""
    from voltpilot_optimization import inputs

    gelesen: list = []

    def lesen(dsn, site_id, horizont_start):
        gelesen.append((site_id, horizont_start))
        return antwort["wert"]

    antwort = {"wert": True}
    monkeypatch.setattr(inputs, "_heute_geplant_geladen", lesen)
    env = "OPTIMIZER_MORGEN_UEBERSCHUSS_ANLAGEN"

    monkeypatch.delenv(env, raising=False)
    assert _gather(monkeypatch).morgen_ueberschuss is False
    assert gelesen == []

    monkeypatch.setenv(env, str(HERZOGAU))
    inp = _gather(monkeypatch)
    assert (inp.morgen_ueberschuss, inp.morgen_ueberschuss_heute_geladen) == (True, True)
    assert gelesen == [(HERZOGAU, inp.slot_starts[0])]

    antwort["wert"] = None  # nicht lesbar
    inp = _gather(monkeypatch)
    assert (inp.morgen_ueberschuss, inp.morgen_ueberschuss_heute_geladen) == (
        False,
        False,
    )


_NOW = datetime(2026, 10, 13, 8, 5, tzinfo=timezone.utc)
_SLOTS = 16


class _GatherCursor:
    """Beantwortet die Abfragen von gather_inputs (das test_soc_source-Muster)."""

    def __init__(self) -> None:
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(_NOW, _SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 50.0) for ts in self.slot_starts]
        elif "FROM forecast" in sql and "model_choice" not in sql:
            _site_id, kind, _model, since = params
            value = 5.0 if kind == "load" else 20.0
            self._rows = [(ts, value) for ts in self.slot_starts if ts >= since]
        elif "LIMIT 1" in sql and "soc_pct" in sql:
            self._rows = [(_NOW - timedelta(minutes=1), 40.0)]
        else:
            self._rows = []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def _gather(monkeypatch) -> OptimizationInput:
    from voltpilot_optimization.inputs import BatterySite, gather_inputs

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _GatherCursor()

        def rollback(self):  # pragma: no cover
            pass

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    site = BatterySite(
        tenant_id=uuid4(),
        site_id=HERZOGAU,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BATTERY,
        netzladen_erlaubt=False,
    )
    return gather_inputs("postgresql://fake", site, _NOW, _SLOTS)


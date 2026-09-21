"""Planlauf mit Anteilen (AP-15 IP-14, Regeln P4, B5, Y4, Entscheid E7 = A, Lesart LA1).

Der Anteil jeder Box, die den Netzanschluss nicht sieht, ist Nebenbedingung des
Laufs: kein Kommando an ihre Entitaeten ueberschreitet ihn in irgendeinem Slot
- Einspeisung: PV-Grenze (+ Entladung, wenn der geplante Speicher an ihr haengt),
Bezug: Ladepark-Deckel und steuerbare Verbraucher. Die fuehrende Box bekommt
keine Anteils-Nebenbedingung.

Zahlen aus den Referenzfaellen (Ahrenberg 1.5, Anlage AN-1 an NA-1, Box Halle 1
E-1 fuehrt und traegt den Speicher, Box Verwaltung E-4 steuert mit): R1
Einspeisegrenze 100 kW, Anteile 40/60 kW; R2 Grenze 70 kW, Anteile 40/30 kW,
Halbsinus 06:00-20:00 mit 57 kW Spitze -> 160,2 kWh; R3 Bezugs-Anteil 77 kW,
sechs Ladepunkte wollen 132 kW; R7 Box Verwaltung stumm.

Beide Rechenwege laufen mit dem ECHTEN Solver: der v1-Solver (sein Plan faehrt
heute) und der Co-Optimierer (je Entitaet - daraus schneidet IP-15 die
Dokumente je Box).
"""

from __future__ import annotations

import dataclasses
import math
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import (
    ControllableLoadEntity,
    LoadRequirement,
    from_v1_input,
)
from voltpilot_optimization.solver import build_model
from voltpilot_optimization.verbund import (
    BoxAnteil,
    MitsteuerndeBox,
    VerbundStand,
    erzeuger_id,
    fuer_lauf,
    ist_stumm,
    load_verbund,
    planer_anteil,
)

pytest.importorskip("highspy")

T0 = datetime(2027, 6, 13, 11, 0, tzinfo=timezone.utc)  # Sonntag 13:00 (R1)
TENANT = UUID("00000000-0000-0000-0000-00000000a001")
SITE = UUID("00000000-0000-0000-0000-00000000a1a1")  # AN-1
E_1 = UUID("00000000-0000-0000-0000-0000000000e1")  # Box Halle 1, fuehrt
E_4 = UUID("00000000-0000-0000-0000-0000000000e4")  # Box Verwaltung, steuert mit
TOL = 1e-6

SPEICHER = BatteryParams(
    capacity_kwh=200.0, max_charge_kw=100.0, max_discharge_kw=100.0
)


def _eingang(
    *,
    pv_e1: list[float],
    pv_e4: list[float],
    last: float,
    verbund: tuple = (),
    max_feed_in_kw: float | None = None,
    grid_limit_kw: float | None = None,
    soc_voll: bool = True,
    preise: list[float] | None = None,
    device_id: UUID = E_1,
    netzladen: bool = False,
    battery: BatteryParams = SPEICHER,
) -> OptimizationInput:
    n = len(pv_e1)
    soc0 = battery.soc_max_kwh if soc_voll else battery.soc_min_kwh
    return OptimizationInput(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=device_id,
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=preise if preise is not None else [100.0] * n,
        load_kw=[last] * n,
        pv_kw=[a + b for a, b in zip(pv_e1, pv_e4)],
        initial_soc_kwh=soc0,
        netzladen_erlaubt=netzladen,
        max_feed_in_kw=max_feed_in_kw,
        grid_limit_kw=grid_limit_kw,
        verbund=verbund,
    )


def _v1_modell(inp: OptimizationInput):
    """Den v1-Solver loesen und das Modell zurueckgeben (je Box die Abregelung)."""
    from voltpilot_optimization.solver import _solve

    model = build_model(inp)
    _solve(model)
    return model


def _wert(var) -> float:
    return float(var.value or 0.0)


def _co(inp: OptimizationInput, loads: tuple = ()):
    from voltpilot_optimization.co_solver import co_optimize

    co_inp = dataclasses.replace(from_v1_input(inp), controllable_loads=loads)
    return co_optimize(co_inp, uuid4(), T0)


def _erzeuger(plan, entity_id: str):
    return next(p for p in plan.producers if p.entity_id == entity_id)


# ---------------------------------------------------------------------------
# R1: Einspeisung - kein Kommando ueber dem Anteil, der Rest an der fuehrenden Box
# ---------------------------------------------------------------------------

R1_E4 = [55.0, 57.0, 65.0, 70.0]  # R1: 55 kW; darueber der Anteil 60 kW bindet
R1_E1 = [95.0] * 4
R1_VERBUND = (BoxAnteil(E_4, 60.0, 77.0, pv_kw=tuple(R1_E4)),)


def test_r1_v1_pv_verwaltung_nie_ueber_60_kw_und_anschluss_nie_ueber_100_kw():
    inp = _eingang(
        pv_e1=R1_E1, pv_e4=R1_E4, last=40.0, max_feed_in_kw=100.0, verbund=R1_VERBUND
    )
    m = _v1_modell(inp)
    for t in range(4):
        pv_e4 = R1_E4[t] - _wert(m.curtail_box[0, t])
        assert pv_e4 <= 60.0 + TOL, (t, pv_e4)
        assert _wert(m.grid_export[t]) <= 100.0 + TOL
    # 55 kW liegt unter dem Anteil: die Box Verwaltung regelt nichts ab (R1 Schritt 3).
    assert _wert(m.curtail_box[0, 0]) == pytest.approx(0.0, abs=TOL)
    # Den Rest ueber der Grenze (95 + 55 - 40 = 110 kW) nimmt Halle 1 (R1 Schritt 2).
    assert _wert(m.curtail_rest[0]) == pytest.approx(10.0, abs=1e-4)
    # 70 kW an der Box Verwaltung: genau bis auf ihren Anteil.
    assert R1_E4[3] - _wert(m.curtail_box[0, 3]) == pytest.approx(60.0, abs=1e-4)


def test_r1_co_optimierer_je_entitaet_pv_grenze_der_verwaltung_hoechstens_ihr_anteil():
    inp = _eingang(
        pv_e1=R1_E1, pv_e4=R1_E4, last=40.0, max_feed_in_kw=100.0, verbund=R1_VERBUND
    )
    plan = _co(inp)
    verwaltung = _erzeuger(plan, erzeuger_id(E_4))
    halle = _erzeuger(plan, "pv-main")
    for t, slot in enumerate(verwaltung.slots):
        assert slot.generation_kw == pytest.approx(R1_E4[t])
        assert slot.generation_kw - slot.curtail_kw <= 60.0 + TOL
    assert halle.slots[0].curtail_kw == pytest.approx(10.0, abs=1e-4)
    assert verwaltung.slots[0].curtail_kw == pytest.approx(0.0, abs=TOL)


def test_fuehrende_box_bekommt_keine_anteils_nebenbedingung():
    # Halle 1 (40 kW Anteil) speist mit Messung gegen das Ganze: 95 kW PV,
    # keine Last, Grenze 100 - ihr eigener Anteil begrenzt sie im Plan nicht.
    inp = _eingang(
        pv_e1=[95.0], pv_e4=[0.0], last=0.0, max_feed_in_kw=100.0,
        verbund=(BoxAnteil(E_4, 60.0, 77.0, pv_kw=(0.0,)),),
    )
    m = _v1_modell(inp)
    assert _wert(m.grid_export[0]) == pytest.approx(95.0, abs=1e-4)
    assert _wert(m.curtail_rest[0]) == pytest.approx(0.0, abs=TOL)


# ---------------------------------------------------------------------------
# R2: Abregeln nach Wert - nur, was der Anteil verlangt, nur an der Box Verwaltung
# ---------------------------------------------------------------------------


def _halbsinus(spitze: float) -> list[float]:
    return [
        spitze * math.sin(math.pi * ((q + 0.5) * 0.25) / 14.0) for q in range(56)
    ]


def test_r2_abregeln_trifft_nur_die_erzeugung_ueber_dem_anteil_160_2_kwh():
    pv_e4 = _halbsinus(57.0)
    pv_e1 = _halbsinus(95.0)
    inp = _eingang(
        pv_e1=pv_e1,
        pv_e4=pv_e4,
        last=300.0,  # Halle 1 zieht 300 kW - am Anschluss wird nie eingespeist
        max_feed_in_kw=70.0,
        soc_voll=False,
        verbund=(BoxAnteil(E_4, 30.0, 77.0, pv_kw=tuple(pv_e4)),),
    )
    m = _v1_modell(inp)
    abgeregelt_e4 = sum(_wert(m.curtail_box[0, t]) for t in range(56)) * 0.25
    abgeregelt_e1 = sum(_wert(m.curtail_rest[t]) for t in range(56)) * 0.25
    assert round(abgeregelt_e4, 1) == 160.2
    # Jede kWh, die Halle 1 selbst verbraucht, ist den Arbeitspreis wert: keine
    # andere Erzeugung wird abgeregelt, und keine ueber das Noetige hinaus.
    assert abgeregelt_e1 == pytest.approx(0.0, abs=1e-4)
    for t in range(56):
        assert pv_e4[t] - _wert(m.curtail_box[0, t]) <= 30.0 + TOL
        assert _wert(m.curtail_box[0, t]) == pytest.approx(
            max(pv_e4[t] - 30.0, 0.0), abs=1e-4
        )


def test_abregeln_nach_wert_bei_negativem_preis_regelt_ab_was_weniger_als_nichts_wert_ist():
    # Negative Verguetung, voller Speicher, 130 kW PV bei 40 kW Last: jede
    # eingespeiste kWh kostet, jede selbst verbrauchte spart den Arbeitspreis -
    # abgeregelt werden genau die 90 kW Ueberschuss, zuerst an der fuehrenden
    # Box (80 kW); die Box Verwaltung nur um den Rest (10 kW).
    inp = dataclasses.replace(
        _eingang(
            pv_e1=[80.0], pv_e4=[50.0], last=40.0,
            verbund=(BoxAnteil(E_4, 60.0, 77.0, pv_kw=(50.0,)),),
        ),
        import_price_eur_mwh=[300.0],
        export_value_eur_mwh=[-50.0],
    )
    m = _v1_modell(inp)
    assert _wert(m.grid_export[0]) == pytest.approx(0.0, abs=1e-4)
    assert _wert(m.curtail_rest[0]) == pytest.approx(80.0, abs=1e-4)
    assert _wert(m.curtail_box[0, 0]) == pytest.approx(10.0, abs=1e-4)


# ---------------------------------------------------------------------------
# R3: Bezug - der Ladepark der Box Verwaltung bekommt hoechstens 77 kW
# ---------------------------------------------------------------------------


def _ladepunkte(n: int) -> tuple[ControllableLoadEntity, ...]:
    return tuple(
        ControllableLoadEntity(
            entity_id=f"ahr-lp-0{i}",
            max_power_kw=22.0,
            control_kind="continuous",
            requirements=(
                LoadRequirement(
                    requirement_id=f"laden-0{i}",
                    kind="fixed_window",
                    window_slots=tuple(range(n)),
                    target_kw=22.0,
                ),
            ),
        )
        for i in range(2, 8)
    )


def test_r3_ladepark_verwaltung_nie_ueber_77_kw_in_keinem_slot():
    n = 4
    loads = _ladepunkte(n)
    verbund = (
        BoxAnteil(
            E_4, 60.0, 77.0, pv_kw=(0.0,) * n,
            verbraucher=tuple(c.entity_id for c in loads),
        ),
    )
    inp = _eingang(
        pv_e1=[120.0] * n, pv_e4=[0.0] * n, last=410.0, soc_voll=False, verbund=verbund
    )
    plan = _co(inp, loads)
    for t in range(n):
        laden = sum(ld.slots[t].power_kw for ld in plan.loads)
        # Sechs Fahrzeuge wollen 132 kW; der Anteil gibt 77 kW - und die voll.
        assert laden <= 77.0 + TOL, (t, laden)
        assert laden == pytest.approx(77.0, abs=1e-3)


def test_r3_ohne_verbund_laedt_der_ladepark_voll_gegenprobe():
    n = 2
    loads = _ladepunkte(n)
    inp = _eingang(pv_e1=[120.0] * n, pv_e4=[0.0] * n, last=410.0, soc_voll=False)
    plan = _co(inp, loads)
    assert sum(ld.slots[0].power_kw for ld in plan.loads) == pytest.approx(132.0, abs=1e-3)


# ---------------------------------------------------------------------------
# R7: stumme Box - voller Anteil belegt, kein Mehr fuer die andere
# ---------------------------------------------------------------------------


def test_r7_stumme_box_ihr_ungenutzter_anteil_geht_an_niemanden():
    # Box Verwaltung ist stumm (Switch im Buero-Netz aus): der Planer rechnet
    # ihre 60 kW Einspeisung als belegt. Ihre PV traegt 20 kW bei; die 40 kW,
    # die sie nicht nutzt, bekommt Halle 1 NICHT: Einspeisung hoechstens 60 kW.
    inp = _eingang(
        pv_e1=[95.0], pv_e4=[20.0], last=40.0, max_feed_in_kw=100.0,
        verbund=(BoxAnteil(E_4, 60.0, 77.0, pv_kw=(20.0,), stumm=True),),
    )
    m = _v1_modell(inp)
    assert _wert(m.grid_export[0]) <= 60.0 + TOL
    # Ohne Plan regelt die stumme Box nichts nach Plan ab ...
    assert _wert(m.curtail_box[0, 0]) == pytest.approx(0.0, abs=TOL)
    # ... also regelt Halle 1: 95 + 20 - 40 - 60 = 15 kW.
    assert _wert(m.curtail_rest[0]) == pytest.approx(15.0, abs=1e-4)


def test_r7_gegenprobe_dieselbe_box_verbunden_gibt_halle_1_die_luft():
    inp = _eingang(
        pv_e1=[95.0], pv_e4=[20.0], last=40.0, max_feed_in_kw=100.0,
        verbund=(BoxAnteil(E_4, 60.0, 77.0, pv_kw=(20.0,)),),
    )
    m = _v1_modell(inp)
    assert _wert(m.grid_export[0]) == pytest.approx(75.0, abs=1e-4)


def test_r7_stumme_box_verbraucher_bekommen_nichts_und_bezug_ist_reserviert():
    n = 2
    loads = _ladepunkte(n)
    verbund = (
        BoxAnteil(
            E_4, 60.0, 77.0, pv_kw=(0.0,) * n, stumm=True,
            verbraucher=tuple(c.entity_id for c in loads),
        ),
    )
    inp = _eingang(
        pv_e1=[0.0] * n, pv_e4=[0.0] * n, last=100.0, soc_voll=False,
        grid_limit_kw=200.0, netzladen=True, preise=[10.0] * n, verbund=verbund,
    )
    plan = _co(inp, loads)
    for t in range(n):
        assert sum(ld.slots[t].power_kw for ld in plan.loads) == pytest.approx(0.0, abs=TOL)
        # 200 kW Grenze - 77 kW belegt: Netzladen des Speichers hoechstens 23 kW.
        assert plan.site_slots[t].grid_kw <= 123.0 + 1e-4


# ---------------------------------------------------------------------------
# E7 = A / LA1: ein Speicher; haengt er an der mitsteuernden Box, bleibt er im Anteil
# ---------------------------------------------------------------------------


def test_la1_speicher_an_der_mitsteuernden_box_bleibt_im_anteil_ihrer_box():
    # Konstruiert (kein Referenzfall haengt an LA1): der EINE Speicher haengt an
    # E-4 mit 40 kW Einspeise- und 0 kW Bezugs-Anteil. Teure Slots locken die
    # Entladung, billige das Netzladen - beides nur im Anteil.
    n = 4
    pv_e4 = [10.0, 10.0, 30.0, 30.0]
    inp = _eingang(
        pv_e1=[0.0] * n, pv_e4=pv_e4, last=20.0, soc_voll=False,
        preise=[5.0, 5.0, 400.0, 400.0], netzladen=True, device_id=E_4,
        battery=BatteryParams(capacity_kwh=200.0, max_charge_kw=100.0, max_discharge_kw=100.0),
        verbund=(BoxAnteil(E_4, 40.0, 0.0, pv_kw=tuple(pv_e4)),),
    )
    m = _v1_modell(inp)
    for t in range(n):
        pv_out = pv_e4[t] - _wert(m.curtail_box[0, t])
        assert pv_out + _wert(m.discharge[t]) <= 40.0 + TOL
        assert _wert(m.charge[t]) - pv_out <= 0.0 + TOL
    assert _wert(m.charge[0]) == pytest.approx(10.0, abs=1e-4)  # nur aus eigener PV
    assert _wert(m.discharge[2]) == pytest.approx(10.0, abs=1e-4)  # 40 - 30 PV
    co = _co(inp)
    for t, slot in enumerate(co.storages[0].slots):
        pv_out = pv_e4[t] - _erzeuger(co, erzeuger_id(E_4)).slots[t].curtail_kw
        assert max(-slot.setpoint_kw, 0.0) + pv_out <= 40.0 + TOL
        assert max(slot.setpoint_kw, 0.0) - pv_out <= 0.0 + TOL


def test_la1_speicher_an_der_fuehrenden_box_bekommt_keine_nebenbedingung():
    inp = dataclasses.replace(
        _eingang(
            pv_e1=[0.0], pv_e4=[0.0], last=20.0, soc_voll=True, preise=[400.0],
            verbund=(BoxAnteil(E_4, 60.0, 0.0, pv_kw=(0.0,)),),
        ),
        terminal_value_eur_per_kwh=0.0,
    )
    m = _v1_modell(inp)
    assert not hasattr(m, "verbund_bezug")
    # Der Speicher an Halle 1 entlaedt voll (100 kW > ihr eigener Anteil 40 kW):
    # die fuehrende Box regelt mit Messung gegen das Ganze, ihr Anteil zaehlt nur blind.
    assert _wert(m.discharge[0]) == pytest.approx(100.0, abs=1e-4)


# ---------------------------------------------------------------------------
# Ein-Box-Ergebnis identisch; v1 und Co-Optimierer rechnen dasselbe
# ---------------------------------------------------------------------------


def test_ohne_verbund_kommt_nichts_ins_modell():
    inp = _eingang(pv_e1=R1_E1, pv_e4=R1_E4, last=40.0, max_feed_in_kw=100.0)
    m = build_model(inp)
    namen = {c.local_name for c in m.component_objects()}
    assert not {n for n in namen if n.startswith("verbund") or n.startswith("curtail_")}
    co = from_v1_input(inp)
    assert [p.entity_id for p in co.producers] == ["pv-main"]
    assert co.verbund == ()


def test_mit_verbund_rechnen_v1_und_co_optimierer_dasselbe():
    from voltpilot_optimization.co_solver import build_co_model, _lexicographic_solve

    inp = _eingang(
        pv_e1=R1_E1, pv_e4=R1_E4, last=40.0, max_feed_in_kw=100.0, soc_voll=False,
        preise=[30.0, 250.0, -10.0, 90.0], verbund=R1_VERBUND,
    )
    m1 = _v1_modell(inp)
    m2 = build_co_model(from_v1_input(inp))
    _lexicographic_solve(m2)
    from pyomo.environ import value

    assert value(m1.total_cost) == pytest.approx(value(m2.total_cost), abs=1e-6)


# ---------------------------------------------------------------------------
# Eingang: welcher Anteil gilt, wer ist stumm, was fehlt
# ---------------------------------------------------------------------------


def test_uebergang_der_kleinere_wert_gilt():
    # R12-artig: quittiert 60 kW, der Uebergang (10 kW) ist gesendet - bis zur
    # Quittung haelt die Box vielleicht noch 60, bekommt aber gleich 10: 10 gilt.
    assert planer_anteil(60.0, 10.0) == 10.0
    # Uebergang quittiert (10), Zielstand (60) gesendet: noch haelt sie 10.
    assert planer_anteil(10.0, 60.0) == 10.0
    # Vor der ersten Quittung: der gesendete Stand (= ihr Rueckfall im ersten Uebergang).
    assert planer_anteil(None, 24.6) == 24.6
    # Kein Dokument nennt die Box: unbekannt, nicht null.
    assert planer_anteil(None, None) is None


def test_y4_nach_90_s_ohne_herzschlag_stumm():
    jetzt = T0
    assert not ist_stumm(jetzt - timedelta(seconds=90), jetzt)
    assert ist_stumm(jetzt - timedelta(seconds=91), jetzt)
    assert ist_stumm(None, jetzt)


def test_b5_box_ohne_bekannten_anteil_wird_stumm_und_ohne_kommando_geplant():
    stand = VerbundStand(
        mitsteuernde=(MitsteuerndeBox(E_4, None, 77.0, stumm=False, pv_kwp=60.0),),
        pv_kwp_gesamt=160.0,
    )
    (box,) = fuer_lauf(stand, [80.0, 0.0])
    assert box.stumm
    assert box.einspeisung_kw == 0.0
    assert box.pv_kw == pytest.approx((30.0, 0.0))


def test_pv_der_box_ist_ihr_teil_der_nennleistung_und_nie_mehr_als_die_prognose():
    stand = VerbundStand(
        mitsteuernde=(MitsteuerndeBox(E_4, 60.0, 77.0, stumm=False, pv_kwp=60.0),),
        pv_kwp_gesamt=160.0,
    )
    (box,) = fuer_lauf(stand, [160.0, -1.0])
    assert box.pv_kw == pytest.approx((60.0, 0.0))
    ohne_pv = VerbundStand(
        mitsteuernde=(MitsteuerndeBox(E_4, 60.0, 77.0, stumm=False),),
        pv_kwp_gesamt=100.0,
    )
    assert fuer_lauf(ohne_pv, [50.0])[0].pv_kw == (0.0,)
    assert fuer_lauf(None, [50.0]) == ()


class _Cursor:
    """Die vier Abfragen von ``load_verbund``; Zeilen wie aus psycopg."""

    def __init__(self, mitglieder, pv=(), verbraucher=(), fuehrende=()):
        self._antworten = {
            "FROM steuerungsverbund v": list(mitglieder),
            "FROM asset": list(pv),
            "FROM steuerungsverbund_geraet g": list(verbraucher),
            "FROM steuerungsverbund_mitglied f": list(fuehrende),
        }
        self.abfragen: list[str] = []
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        flat = " ".join(sql.split())
        self.abfragen.append(flat)
        for marke, rows in self._antworten.items():
            if marke in flat:
                self._rows = rows
                return
        raise AssertionError(flat)

    def fetchall(self):
        return self._rows


def _psycopg(monkeypatch, cursor=None, fehlt=False):
    class UndefinedTable(Exception):
        pass

    class _Conn:
        def __enter__(self):
            if fehlt:
                raise UndefinedTable("relation steuerungsverbund does not exist")
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return cursor

    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(
            connect=lambda dsn: _Conn(),
            errors=SimpleNamespace(UndefinedTable=UndefinedTable),
        ),
    )


def test_load_verbund_liest_den_planwert_je_richtung_und_die_stummen(monkeypatch):
    jetzt = T0
    quittiert = {"einspeisung": {str(E_1): 40.0, str(E_4): 60.0},
                 "bezug": {str(E_1): 0.0, str(E_4): 77.0}}
    uebergang = '{"einspeisung": {"%s": 40.0, "%s": 30.0}, "bezug": {"%s": 0.0, "%s": 77.0}}' % (
        E_1, E_4, E_1, E_4
    )
    e_5 = UUID("00000000-0000-0000-0000-0000000000e5")
    e_6 = UUID("00000000-0000-0000-0000-0000000000e6")
    cursor = _Cursor(
        mitglieder=[
            (SITE, E_4, quittiert, uebergang, jetzt - timedelta(seconds=10), jetzt, True),
            (SITE, e_5, None, quittiert, jetzt - timedelta(seconds=120), jetzt, True),
            (SITE, e_6, None, None, jetzt, None, True),
        ],
        pv=[(SITE, E_1, 100.0), (SITE, E_4, 60.0), (SITE, None, 0.0)],
        verbraucher=[(SITE, E_4, "ahr-lp-02"), (SITE, E_4, "ahr-lp-03")],
        fuehrende=[(SITE, E_1)],
    )
    _psycopg(monkeypatch, cursor)
    stand = load_verbund("dsn", jetzt)[SITE]
    e4, e5, e6 = stand.mitsteuernde
    assert (e4.einspeisung_kw, e4.bezug_kw, e4.stumm) == (30.0, 77.0, False)
    assert e4.pv_kwp == 60.0 and stand.pv_kwp_gesamt == 160.0
    assert e4.verbraucher == ("ahr-lp-02", "ahr-lp-03")
    assert e5.stumm  # 120 s ohne Herzschlag (Y4)
    assert e5.einspeisung_kw is None  # E-5 steht in keinem Dokument
    assert e6.stumm  # nach dem Box-Tausch noch nicht bestaetigt (R17)
    assert stand.fuehrende == E_1  # IP-15: Empfaenger von allem ohne mitsteuernde Box
    assert (e4.bekommt_plan, e5.bekommt_plan, e6.bekommt_plan) == (True, False, False)
    assert "v.stufe = 'anteile_aktiv'" in cursor.abfragen[0]
    assert "m.rolle = 'steuert_mit'" in cursor.abfragen[0]


def test_load_verbund_ohne_scharfe_anlage_liest_sonst_nichts(monkeypatch):
    cursor = _Cursor(mitglieder=[])
    _psycopg(monkeypatch, cursor)
    assert load_verbund("dsn", T0) == {}
    assert len(cursor.abfragen) == 1


def test_load_verbund_vor_der_api_migration_ist_kein_verbund(monkeypatch):
    _psycopg(monkeypatch, fehlt=True)
    assert load_verbund("dsn", T0) == {}


def test_der_ganze_v1_lauf_mit_verbund_liefert_einen_erklaerten_plan():
    """``optimize`` (mit Fahrplan-Warum) verweigert kein Modell mit Anteilen:
    jede neue Nebenbedingung steht in ``explain.KNOWN_CONSTRAINTS``."""
    from voltpilot_optimization.solver import optimize

    inp = _eingang(
        pv_e1=R1_E1, pv_e4=R1_E4, last=40.0, max_feed_in_kw=100.0, soc_voll=False,
        verbund=(BoxAnteil(E_4, 60.0, 77.0, pv_kw=tuple(R1_E4)),
                 BoxAnteil(UUID(int=5), 10.0, 5.0, pv_kw=(0.0,) * 4, stumm=True)),
    )
    plan = optimize(inp, uuid4(), T0)
    assert len(plan.slots) == 4
    assert all(s.slot_role is not None for s in plan.slots)
    for s in plan.slots:
        assert -s.grid_kw <= 100.0 - 10.0 + 1e-4  # die stumme Box belegt 10 kW

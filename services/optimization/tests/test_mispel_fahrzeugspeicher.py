"""MiSpeL MP-33: das Fahrzeug am bidirektionalen Ladepunkt als Speicher.

Pruefnachweis (Bauplan § 8 Zeile MP-33): **das Abfahrtsziel wird immer erreicht** - ueber Preise, Start-Ladestaende,
V2H/V2G und Fenster hinweg, auch wenn die Rueckspeisung lohnt. Dazu: Ziel hinter dem Horizont bleibt erreichbar,
unerreichbares Ziel macht das Modell nicht unloesbar, V2H vor V2G (E3 = D), Wirkungsgrad 0,85 (A1 S. 35), Fahrstrom
als sonstiger Verbrauch (A1 S. 25 Fn. 19), Zyklenbudget, (14)A2,A3,A4 und (19)A2,A3 im Mischbetrieb (A1 S. 35, S. 37)
und Bestandsschutz: ohne bidirektionalen Ladepunkt kein einziges neues Modellteil.
"""

from __future__ import annotations

import math
import random
import sys
import time as uhr
from dataclasses import replace
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from pyomo.environ import Constraint, Var, value

from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization.config import mispel_fahrzeug_site_ids
from voltpilot_optimization.domain import WIRKUNGSGRAD_LADEPUNKT
from voltpilot_optimization.fahrzeugspeicher import Anwesenheit, Faehigkeit, Fenster, Messung
from voltpilot_optimization import pricing, solver
from voltpilot_optimization.solver import (
    _gutschrift_eur_mwh,
    _solve,
    _solve_plan,
    _wirkungsgrad_14,
    build_model,
    optimize,
)

from test_solver import T0, make_input, needs_highs

BERLIN = ZoneInfo("Europe/Berlin")
# T0 = 2026-07-01 22:00 UTC = Donnerstag 02.07.2026, 00:00 Berliner Zeit.
PENDLER = (
    Anwesenheit(3, time(18, 0), time(7, 0), 80.0),  # Mi 18:00 - Do 07:00 (laeuft beim Start)
    Anwesenheit(4, time(18, 0), time(7, 0), 80.0),  # Do 18:00 - Fr 07:00
    Anwesenheit(5, time(18, 0), time(7, 0), 90.0),  # Fr 18:00 - Sa 07:00
)
V2G = Faehigkeit("bidirektional", True, True, False, 11.0)
V2H = Faehigkeit("bidirektional", True, False, False, 11.0)


def _fahrzeug(faehigkeit=V2G, soc_pct=30.0, anwesenheit=PENDLER, mindest=20.0, kap=60.0, n=192, angesteckt=True):
    fz, grund = fz_regeln.fahrzeugspeicher(
        "lp-1",
        faehigkeit,
        Fenster(mindest, kap, anwesenheit),
        Messung(angesteckt, soc_pct),
        [T0 + timedelta(minutes=15 * i) for i in range(n)],
        15,
        BERLIN,
    )
    assert grund is None, grund
    return fz


def _abend_preise(n=192, seed=0, spitze=400.0):
    """Billige Nacht, teure Abendspitze 18-21 Uhr Berliner Zeit - die Rueckspeisung lohnt."""
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        stunde = (T0 + timedelta(minutes=15 * i)).astimezone(BERLIN).hour
        basis = spitze if 18 <= stunde < 21 else (20.0 if stunde < 6 else 90.0)
        out.append(basis + rnd.uniform(-15.0, 15.0))
    return out


def _input(fz, prices=None, load=1.5, **kw):
    prices = prices if prices is not None else _abend_preise(len(fz.angesteckt))
    return replace(make_input(prices, load=load, **kw), fahrzeug=fz)


# --- Abfahrtsziel immer erreicht --------------------------------------------


@needs_highs
@pytest.mark.parametrize("seed", range(6))
@pytest.mark.parametrize("soc_pct", [0.0, 25.0, 80.0, 100.0])
@pytest.mark.parametrize("faehigkeit", [V2G, V2H], ids=["v2g", "v2h"])
def test_abfahrtsziel_immer_erreicht(seed, soc_pct, faehigkeit):
    fz = _fahrzeug(faehigkeit, soc_pct=soc_pct)
    inp = _input(fz, prices=_abend_preise(seed=seed, spitze=300.0 + 150.0 * seed))
    plan = optimize(inp, uuid4(), T0)
    assert [s for s, _ in fz.abfahrten] == [28, 124]  # Do 07:00 und Fr 07:00
    for s, ziel, geplant in plan.fahrzeug.abfahrten:
        if s == 28 and soc_pct == 0.0:
            # 7 h * 11 kW * sqrt(0,85) = 71 kWh > 48 kWh - auch aus leer erreichbar
            assert ziel == pytest.approx(48.0)
        assert geplant >= ziel - 1e-6, (s, ziel, geplant)


@needs_highs
def test_rueckspeisung_lohnt_und_ziel_haelt_trotzdem():
    """Die Abendspitze lockt das Auto unter das Ziel - der Plan speist zurueck und laedt nachts nach."""
    fz = _fahrzeug(V2G, soc_pct=80.0)
    preise = [900.0] * 8 + [20.0] * 20 + [90.0] * 164  # Do 00-02 Uhr Spitze, 02-07 Uhr billig
    plan = optimize(_input(fz, prices=preise), uuid4(), T0)
    rueck = [s.rueckspeisen_kw for s in plan.fahrzeug.slots]
    laden = [s.laden_kw for s in plan.fahrzeug.slots]
    assert sum(rueck[0:8]) > 0.0  # in der Spitze zurueckgespeist ...
    assert sum(laden[8:28]) > 0.0  # ... und billig nachgeladen
    assert plan.fahrzeug.abfahrten[0][2] == pytest.approx(48.0, abs=1e-4)  # genau das Ziel


@needs_highs
def test_ziel_hinter_dem_horizont_bleibt_erreichbar():
    """Der Horizont endet mitten im Fenster: der Stand am Ende haelt die Abfahrt danach erreichbar."""
    n = 80  # Do 00:00 - Do 20:00; das Auto kommt 18:00 an und faehrt Fr 07:00
    fz = _fahrzeug(V2G, soc_pct=80.0, n=n)
    plan = optimize(_input(fz, prices=_abend_preise(n=n, spitze=2000.0)), uuid4(), T0)
    stunden_bis_abfahrt = 11.0  # Do 20:00 -> Fr 07:00
    ziel = 0.8 * 60.0
    noetig = ziel - math.sqrt(WIRKUNGSGRAD_LADEPUNKT) * 11.0 * stunden_bis_abfahrt
    assert plan.fahrzeug.slots[-1].soc_kwh >= max(noetig, 12.0) - 1e-6
    assert fz.untergrenze_kwh[n] == pytest.approx(max(noetig, 12.0))


@needs_highs
def test_unerreichbares_ziel_wird_auf_den_schnellsten_ladeweg_gekappt():
    fenster = (Anwesenheit(3, time(18, 0), time(1, 0), 100.0),)  # Abfahrt Do 01:00, eine Stunde Zeit
    fz = _fahrzeug(V2G, soc_pct=0.0, anwesenheit=fenster, n=16)
    plan = optimize(_input(fz, prices=[50.0] * 16), uuid4(), T0)
    ((s, ziel, geplant),) = plan.fahrzeug.abfahrten
    assert (s, ziel) == (4, 60.0)
    assert geplant == pytest.approx(math.sqrt(0.85) * 11.0 * 1.0, abs=1e-4)  # volle Leistung, eine Stunde


# --- V2H vor V2G (E3 = D) ----------------------------------------------------


@needs_highs
def test_v2h_ohne_v2g_speist_nie_ins_netz():
    fz = _fahrzeug(V2H, soc_pct=90.0)
    plan = optimize(_input(fz, prices=_abend_preise(spitze=900.0), load=2.0), uuid4(), T0)
    rueck = 0.0
    for slot, f in zip(plan.slots, plan.fahrzeug.slots):
        if f.rueckspeisen_kw > 1e-6:
            rueck += f.rueckspeisen_kw
            assert slot.grid_kw >= -1e-6  # kein Export im rueckspeisenden Slot
    assert rueck > 0.0  # ins Haus wird zurueckgespeist


@needs_highs
def test_v2g_nur_mit_faehigkeit_und_haus_zuerst():
    """Mit V2G: bei Bezug = Spot + 20 ct deckt die Rueckspeisung zuerst das Haus; ins Netz geht sie erst, wenn
    die Spitze den Bezugsvorteil uebertrifft."""
    n = 192
    spot = _abend_preise(spitze=180.0)
    inp = replace(_input(_fahrzeug(V2G, soc_pct=90.0), prices=spot, load=2.0),
                  import_price_eur_mwh=[p + 200.0 for p in spot], export_value_eur_mwh=list(spot))
    plan = optimize(inp, uuid4(), T0)
    rueck_slots = [t for t in range(n) if plan.fahrzeug.slots[t].rueckspeisen_kw > 1e-6]
    assert rueck_slots
    assert all(plan.slots[t].grid_kw >= -1e-6 for t in rueck_slots)  # nur ins Haus
    hoch = replace(inp, prices_eur_mwh=_abend_preise(spitze=1500.0),
                   export_value_eur_mwh=_abend_preise(spitze=1500.0))
    plan = optimize(hoch, uuid4(), T0)
    assert min(s.grid_kw for s in plan.slots) < -2.0  # V2G: ins Netz


# --- Wirkungsgrad, Fahrstrom, Zyklenbudget, Mindest-Ladestand ----------------


@needs_highs
def test_wirkungsgrad_085_je_weg_die_wurzel():
    fz = _fahrzeug(V2G, soc_pct=50.0)
    m = build_model(_input(fz))
    _solve(m)
    e = math.sqrt(0.85)
    assert fz.wirkungsgrad == WIRKUNGSGRAD_LADEPUNKT == 0.85
    for t in range(192):
        if fz.angesteckt[t]:
            delta = value(m.fz_soc[t + 1]) - value(m.fz_soc[t])
            assert delta == pytest.approx((e * value(m.fz_laden[t]) - value(m.fz_rueck[t]) / e) * 0.25, abs=1e-6)


@needs_highs
def test_fahrstrom_ist_sonstiger_verbrauch_nie_rueckspeisung():
    fz = _fahrzeug(V2G, soc_pct=80.0)
    plan = optimize(_input(fz), uuid4(), T0)
    for t, f in enumerate(plan.fahrzeug.slots):
        if not fz.angesteckt[t]:  # unterwegs: kein Laden, kein Rueckspeisen, kein Stand im Plan
            assert (f.laden_kw, f.rueckspeisen_kw, f.soc_kwh) == (0.0, 0.0, None)
    assert fz.stand_kwh[72] == pytest.approx(12.0)  # Ankunft Do 18:00: Planannahme Mindest-Ladestand
    assert fz.angesteckt[27] and not fz.angesteckt[28] and fz.angesteckt[72]


@needs_highs
def test_zyklenbudget_je_kalendertag():
    preise = [3000.0] * 8 + [20.0] * 20 + [90.0] * 164  # Do 00-02 Uhr Spitze: 2 h * 11 kW = 22 kWh moeglich

    def _je_tag(vollzyklen):
        fz = replace(_fahrzeug(V2G, soc_pct=100.0), vollzyklen_je_tag=vollzyklen)
        plan = optimize(_input(fz, prices=preise), uuid4(), T0)
        tage: dict[str, float] = {}
        for t, f in enumerate(plan.fahrzeug.slots):
            tage[fz.tag_je_slot[t]] = tage.get(fz.tag_je_slot[t], 0.0) + f.rueckspeisen_kw * 0.25
        assert all(geplant >= ziel - 1e-6 for _, ziel, geplant in plan.fahrzeug.abfahrten)
        return max(tage.values())

    assert _je_tag(1.0) == pytest.approx(22.0, abs=1e-4)  # ohne bindendes Budget: was die Leistung hergibt
    assert _je_tag(0.25) == pytest.approx(0.25 * 60.0, abs=1e-4)  # Budget: ein Viertel Vollzyklus


@needs_highs
def test_ohne_mindest_ladestand_wird_nie_zurueckgespeist():
    fz = _fahrzeug(V2G, soc_pct=100.0, mindest=None)
    assert fz.rueckspeisen_kw == 0.0
    plan = optimize(_input(fz, prices=_abend_preise(spitze=3000.0)), uuid4(), T0)
    assert all(f.rueckspeisen_kw == 0.0 for f in plan.fahrzeug.slots)
    assert plan.fahrzeug.abfahrten[0][2] >= 48.0 - 1e-6


def test_ohne_frischen_ladestand_oder_angaben_kein_fahrzeug():
    slots = [T0 + timedelta(minutes=15 * i) for i in range(8)]
    fenster = Fenster(20.0, 60.0, PENDLER)
    assert fz_regeln.fahrzeugspeicher("x", V2G, fenster, None, slots, 15, BERLIN) == (None, "ladestand_unbekannt")
    assert fz_regeln.fahrzeugspeicher("x", V2G, Fenster(20.0, None, PENDLER), Messung(True, 50.0), slots, 15,
                                      BERLIN) == (None, "planungsangaben_fehlen")
    ohne_leistung = replace(V2G, rueckspeiseleistung_kw=None)
    assert fz_regeln.fahrzeugspeicher("x", ohne_leistung, fenster, Messung(True, 50.0), slots, 15,
                                      BERLIN)[1] == "planungsangaben_fehlen"
    # Fenster sagt „da“, Stecker sagt „frei“: diese Anwesenheit plant der Lauf nicht
    fz, grund = fz_regeln.fahrzeugspeicher("x", V2G, fenster, Messung(False, None), slots, 15, BERLIN)
    assert (fz, grund) == (None, "nicht_im_horizont")


# --- Einordnung und Foerderweg (A1 S. 26–27) ---------------------------------


def test_einordnung_wie_ladepunktregeln():
    assert fz_regeln.einordnung(None) == "sonstiger_verbrauch"
    assert fz_regeln.einordnung(Faehigkeit("unidirektional", False, False, False, None)) == "sonstiger_verbrauch"
    assert fz_regeln.einordnung(V2G) == "ladepunkt_der_festlegung"
    assert fz_regeln.einordnung(V2H) == "ladepunkt_der_festlegung"
    unterbunden = Faehigkeit("bidirektional", True, False, True, 11.0)
    assert fz_regeln.einordnung(unterbunden) == "alternative_zur_ausschliesslichkeit"


@pytest.mark.parametrize(
    ("einordnung", "weg", "satz", "netzladen", "grund"),
    [
        ("sonstiger_verbrauch", "ungefoerdert", None, True, "unidirektional"),
        ("ladepunkt_der_festlegung", "ungefoerdert", None, True, None),
        ("ladepunkt_der_festlegung", "marktpraemie_abgrenzung", "A3", True, None),
        ("ladepunkt_der_festlegung", "marktpraemie_abgrenzung", "A4", True, None),
        ("ladepunkt_der_festlegung", "marktpraemie_abgrenzung", "A1", True, "formelsatz_ohne_ladepunkt"),
        ("ladepunkt_der_festlegung", "marktpraemie_abgrenzung", "A2", True, "formelsatz_ohne_speicher"),
        ("ladepunkt_der_festlegung", "marktpraemie_ausschliesslichkeit", None, False,
         "ausschliesslichkeit_mit_ladepunkt"),
        ("alternative_zur_ausschliesslichkeit", "marktpraemie_ausschliesslichkeit", None, False, None),
        ("ladepunkt_der_festlegung", "marktpraemie_pauschal", "P1", True, None),
    ],
)
def test_zulaessig_je_foerderweg(einordnung, weg, satz, netzladen, grund):
    assert fz_regeln.zulaessig(einordnung, weg, satz, netzladen) == grund


# --- Mischbetrieb A3/A4: (14) = 0,85, (19)A2,A3 = 0, Z2 = Speicher + Ladepunkt -


def test_wirkungsgrad_14_und_gutschrift_je_formelsatz():
    inp = replace(make_input([50.0] * 4), mischbetrieb=True, saldierte_bestandteile_eur_mwh=100.0)
    assert _wirkungsgrad_14(inp) == 0.92 and _gutschrift_eur_mwh(inp) == pytest.approx(100.0 / 0.92)
    for satz, eta, gut in (("A3", 0.85, 100.0), ("A2", 0.85, 100.0), ("A4", 0.85, 100.0 / 0.92),
                           ("A1", 0.92, 100.0 / 0.92)):
        x = replace(inp, mispel_formelsatz=satz)
        assert (_wirkungsgrad_14(x), _gutschrift_eur_mwh(x)) == (eta, pytest.approx(gut))


@needs_highs
def test_mischbetrieb_a3_bucht_das_fahrzeug_in_z2():
    n = 32  # Do 00:00 - 08:00: das erste Fenster mit Abfahrt 07:00
    fz = _fahrzeug(V2G, soc_pct=50.0, n=n)
    inp = replace(_input(fz, pv=[0.0] * n), mischbetrieb=True, mispel_formelsatz="A3",
                  mispel_praemie_eur_mwh=[30.0] * n, saldierte_bestandteile_eur_mwh=150.0,
                  export_value_eur_mwh=None)
    m = build_model(inp)
    _solve_plan(m, inp)  # MP-33b: Planweg statt freier Ganzzahl (die brauchte hier bis 60 s)
    for t in range(n):
        z2v = value(m.charge[t]) + value(m.fz_laden[t])
        # ohne PV ist (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] die ganze Ladung von Speicher und Fahrzeug (A1 S. 33)
        assert value(m.netz_laden[t]) == pytest.approx(min(value(m.grid_import[t]), z2v), abs=1e-5)
    plan = optimize(inp, uuid4(), T0)
    assert all(geplant >= ziel - 1e-6 for _, ziel, geplant in plan.fahrzeug.abfahrten)


# --- MP-33b: Laufzeit im Mischbetrieb A3/A4 mit Fahrzeug -------------------


def _real(n, satz, pv=0.0):
    """Bezugspreis und Gutschrift aus DENSELBEN Bestandteilen (Recherche-Vorgabe,
    `pricing`): Bezug = (Spot + Bestandteile) * 1,19, Gutschrift = (Umlagen +
    Netzentgelt-AP) * 1,19 - wie `inputs` sie fuer eine Anlage bildet."""
    fz = _fahrzeug(V2G, soc_pct=50.0, n=n)
    spot = _abend_preise(n)
    tarif = pricing.SiteTariff(tarif_art="ohne", supply_price=pricing.DEFAULT_SUPPLY_COMPONENTS)
    return replace(
        _input(fz, prices=spot, pv=[pv] * n), mischbetrieb=True, mispel_formelsatz=satz,
        mispel_praemie_eur_mwh=[30.0] * n,
        saldierte_bestandteile_eur_mwh=pricing.saldierte_bestandteile_eur_mwh(tarif),
        import_price_eur_mwh=pricing.structured_import_prices(pricing.DEFAULT_SUPPLY_COMPONENTS, spot),
        export_value_eur_mwh=None,
    )


@needs_highs
@pytest.mark.parametrize(("satz", "pv"), [("A3", 0.0), ("A3", 3.0), ("A4", 0.0), ("A4", 3.0)])
def test_192_slots_mit_fahrzeug_bewiesen_optimal_in_der_zeitgrenze(satz, pv, caplog):
    # Vorher: freie Lauf-Ganzzahl, HiGHS haengt an der Wurzel (mit PV 60 s,
    # Luecke 63 %; ohne PV 20 s = MISCHBETRIEB_ZEITGRENZE_S, dann Rueckfall ohne
    # Gutschrift). Jetzt: zwei Teilprobleme, beide bewiesen optimal.
    inp = _real(192, satz, pv=pv)
    m = build_model(inp)
    start = uhr.perf_counter()
    _solve_plan(m, inp)
    dauer = uhr.perf_counter() - start
    print(f"MP-33b {satz} pv={pv}: {dauer:.1f} s, Ziel {value(m.total_cost):.6f}")
    assert "mischbetrieb.fahrzeug_saldierung_zeitgrenze" not in caplog.text
    assert dauer < solver.MISCHBETRIEB_ZEITGRENZE_S
    # das bessere Teilproblem gewinnt: mit PV ohne Saldierung, ohne PV mit
    assert value(m.saldierung_aktiv) == (0 if pv else 1)


@needs_highs
@pytest.mark.parametrize("satz", ["A3", "A4"])
def test_aufzaehlung_gleich_dem_ganzen_modell(satz):
    # gleiches Ergebnis wie die freie Ganzzahl innerhalb der MIP-Toleranz
    inp = _real(32, satz)
    ganz, teile = build_model(inp), build_model(inp)
    _solve(ganz)
    _solve_plan(teile, inp)
    assert value(teile.total_cost) == pytest.approx(value(ganz.total_cost), abs=1e-6)
    assert round(value(teile.saldierung_aktiv)) == round(value(ganz.saldierung_aktiv))


@needs_highs
def test_mp33_testfall_in_der_zeitgrenze_mit_gutschrift():
    # Der MP-33-Fall: Bezug = blanker Spot, Gutschrift 150 EUR/MWh - nur im Test
    # moeglich (in `inputs` kommen beide aus demselben Blatt). Gleichzeitiger
    # Bezug und Einspeisung lohnt dann in der Relaxation; der Beweis der letzten
    # Luecke dauert. Der Plan nimmt den besten zulaessigen mit Gutschrift.
    n = 32
    inp = replace(_input(_fahrzeug(V2G, soc_pct=50.0, n=n), pv=[0.0] * n), mischbetrieb=True,
                  mispel_formelsatz="A3", mispel_praemie_eur_mwh=[30.0] * n,
                  saldierte_bestandteile_eur_mwh=150.0, export_value_eur_mwh=None)
    ohne = build_model(inp)
    ohne.saldierung_aktiv.fix(0)
    _solve(ohne)
    m = build_model(inp)
    start = uhr.perf_counter()
    _solve_plan(m, inp)
    dauer = uhr.perf_counter() - start
    print(f"MP-33b Testfall MP-33: {dauer:.1f} s, Ziel {value(m.total_cost):.6f}")
    assert dauer < solver.MISCHBETRIEB_ZEITGRENZE_S
    assert value(m.saldierung_aktiv) == 1 and value(m.total_cost) < value(ohne.total_cost) - 1.0


@needs_highs
def test_zeitgrenze_mit_fahrzeug_faellt_sauber_zurueck(monkeypatch, caplog):
    # Ohne Plan im zweiten Teilproblem gilt der Plan ohne Gutschrift - mit
    # seinen eigenen Werten, nicht dem Rest des abgebrochenen Laufs.
    monkeypatch.setattr(solver, "FAHRZEUG_SALDIERUNG_ZEITGRENZE_S", 1e-4)
    inp = _real(32, "A3")
    ohne = build_model(inp)
    ohne.saldierung_aktiv.fix(0)
    _solve(ohne)
    m = build_model(inp)
    _solve_plan(m, inp)
    assert "mischbetrieb.fahrzeug_saldierung_zeitgrenze" in caplog.text
    assert m.saldierung_aktiv.fixed and value(m.saldierung_aktiv) == 0
    assert value(m.total_cost) == pytest.approx(value(ohne.total_cost), abs=1e-9)
    assert sum(value(m.rot_einspeisung[t]) for t in m.T) == pytest.approx(0.0, abs=1e-9)
    plan = optimize(inp, uuid4(), T0)
    assert all(geplant >= ziel - 1e-6 for _, ziel, geplant in plan.fahrzeug.abfahrten)


def test_ohne_fahrzeug_bleibt_der_mp10_weg(monkeypatch):
    # Bestandsschutz: die Aufzaehlung greift nur mit Fahrzeug; Mischbetrieb ohne
    # Fahrzeug loest wie bisher (MP-10, eine freie Ganzzahl).
    def _nie(model, inp):
        raise AssertionError("Aufzaehlung ohne Fahrzeug")

    monkeypatch.setattr(solver, "_solve_plan_fahrzeug", _nie)
    gesehen = []
    monkeypatch.setattr(solver, "_solve", lambda model, time_limit=None: gesehen.append(time_limit))
    inp = replace(make_input(_abend_preise(n=8), pv=[0.0] * 8), mischbetrieb=True,
                  mispel_praemie_eur_mwh=[30.0] * 8, saldierte_bestandteile_eur_mwh=150.0)
    m = build_model(inp)
    assert hasattr(m, "saldierung_aktiv") and not hasattr(m, "fz_laden")
    _solve_plan(m, inp)
    assert gesehen == [solver.MISCHBETRIEB_ZEITGRENZE_S]


# --- Bestandsschutz: ohne bidirektionalen Ladepunkt byte-gleich ---------------


def test_ohne_fahrzeug_kein_neues_modellteil():
    m = build_model(make_input(_abend_preise(n=96), pv=2.0))
    namen = {c.local_name for c in m.component_objects((Var, Constraint))}
    assert not {n for n in namen if n.startswith(("fz_", "fahrzeug_"))}


@needs_highs
def test_formelsatz_a1_und_ohne_fahrzeug_plan_byte_gleich():
    inp = replace(make_input(_abend_preise(n=96), pv=[3.0] * 96), mischbetrieb=True,
                  mispel_praemie_eur_mwh=[30.0] * 96, saldierte_bestandteile_eur_mwh=150.0)
    a = optimize(inp, uuid4(), T0)
    b = optimize(replace(inp, mispel_formelsatz="A1"), uuid4(), T0)
    assert [s.battery_kw for s in a.slots] == [s.battery_kw for s in b.slots]
    assert [s.grid_kw for s in a.slots] == [s.grid_kw for s in b.slots]
    assert a.fahrzeug is None and b.fahrzeug is None


def test_betreiber_schalter_vorgabe_leer():
    assert mispel_fahrzeug_site_ids({}) == frozenset()
    sid = uuid4()
    assert mispel_fahrzeug_site_ids({"VOLTPILOT_MISPEL_FAHRZEUG_SITES": f" {sid} ,"}) == {sid}
    with pytest.raises(ValueError):
        mispel_fahrzeug_site_ids({"VOLTPILOT_MISPEL_FAHRZEUG_SITES": "kein-uuid"})


class _Cur:
    def __init__(self, tabellen):
        self.tabellen, self.rows = tabellen, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        flat = " ".join(sql.split())
        self.rows = next((rows for name, rows in self.tabellen.items() if f"FROM {name}" in flat), [])

    def fetchall(self):
        return self.rows


def _lader(monkeypatch, tabellen):
    class _Conn(_Cur):
        def cursor(self):
            return _Cur(tabellen)

    errors = SimpleNamespace(UndefinedTable=KeyError, UndefinedColumn=KeyError)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn(tabellen), errors=errors))


def _site(**kw):
    import test_freshness

    return replace(test_freshness._site(), **kw)


def test_lader_unidirektional_bleibt_bestand(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, {
        "ladepunkt_faehigkeit": [(kid, "unidirektional", False, False, False, None)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, 3, time(18), time(7), 80)],
        "device_charge_connector": [(kid, "Charging", 50.0, T0)],
    })
    assert load_fahrzeugspeicher("postgresql://fake", _site(), T0, slots) is None


def test_lader_bidirektional_mit_frischer_messung(monkeypatch):
    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    tabellen = {
        "ladepunkt_faehigkeit": [(kid, "bidirektional", True, True, False, 11)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, a.wochentag, a.ankunft, a.abfahrt, a.abfahrt_soc_pct)
                                      for a in PENDLER],
        "device_charge_connector": [(kid, "SuspendedEV", 40.0, T0 - timedelta(minutes=5))],
    }
    _lader(monkeypatch, tabellen)
    fz = load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots)
    assert fz is not None and fz.stand_kwh[0] == pytest.approx(24.0) and fz.v2g
    # veraltete Messung ist nicht aktuell - ohne Ladestand kein Fahrzeug
    tabellen["device_charge_connector"] = [(kid, "SuspendedEV", 40.0, T0 - timedelta(hours=1))]
    assert load_fahrzeugspeicher("postgresql://fake", _site(netzladen_erlaubt=True), T0, slots) is None

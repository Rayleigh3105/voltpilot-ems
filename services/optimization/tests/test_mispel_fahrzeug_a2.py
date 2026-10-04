"""MiSpeL MP-33d: das Fahrzeug im Haus ohne stationaeren Speicher (A2) und die
Messlatte „nur laden“.

Festlegung BNetzA Az. 618-25-02 (01.10.2026), Anlage 1: Basisfall A2 „Ladepunkt“
ohne Stromspeicher S. 29–30, der Ladepunkt zaehlt wie ein Stromspeicher S. 26–27,
(12) Fremdtankstrom und (13) S. 35, (14)A2,A3,A4 = 0,85 S. 35, (15)/(16) S. 36,
(19)A2,A3 = 0 S. 37. Die Messlatte ist die Gegenrechnung der Erloes-Karte des
Bedienkonzepts BK-41 A („gegenueber nur laden“).
"""

from __future__ import annotations

import time as uhr
from dataclasses import replace
from fractions import Fraction
from uuid import uuid4

import pytest
from pyomo.environ import value

from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization import explain, mispel_abgrenzung, pricing, solver
from voltpilot_optimization.domain import VIERTELSTUNDE_H
from voltpilot_optimization.solver import _solve, _solve_plan, build_model, optimize

from test_mispel_fahrzeugspeicher import (
    PENDLER,
    V2G,
    V2H,
    _abend_preise,
    _fahrzeug,
    _input,
    _lader,
    _site,
)
from test_solver import T0, needs_highs


def _a2(fz, n=None, pv=0.0, praemie=30.0, saldiert=150.0, prices=None, **kw):
    """Ein Haus ohne Speicher in A2: ``battery`` ist nur der Platzhalter."""
    n = n or len(fz.angesteckt)
    return replace(
        _input(fz, prices=prices, pv=[pv] * n, **kw),
        ohne_stromspeicher=True, mischbetrieb=True, mispel_formelsatz="A2",
        mispel_praemie_eur_mwh=[praemie] * n, saldierte_bestandteile_eur_mwh=saldiert,
        export_value_eur_mwh=None,
    )


def _real_a2(n, pv=0.0, soc_pct=50.0, faehigkeit=V2G):
    """Bezug und Gutschrift aus denselben Bestandteilen (wie `inputs`, MP-33b)."""
    fz = _fahrzeug(faehigkeit, soc_pct=soc_pct, n=n)
    spot = _abend_preise(n)
    tarif = pricing.SiteTariff(tarif_art="ohne", supply_price=pricing.DEFAULT_SUPPLY_COMPONENTS)
    return replace(
        _a2(fz, prices=spot, pv=pv),
        saldierte_bestandteile_eur_mwh=pricing.saldierte_bestandteile_eur_mwh(tarif),
        import_price_eur_mwh=pricing.structured_import_prices(pricing.DEFAULT_SUPPLY_COMPONENTS, spot),
    )


def _kwh(model, var):
    return sum(max(value(var[t]), 0.0) for t in model.T) * VIERTELSTUNDE_H


# --- A2 ist zulaessig; live bleibt eine Batterie-Anlage mit A2 ohne Fahrzeug -


def test_a2_ist_ein_formelsatz_mit_fahrzeug():
    assert fz_regeln.FAHRZEUG_FORMELSAETZE == {"A2", "A3", "A4"}
    assert fz_regeln.zulaessig(fz_regeln.LADEPUNKT_DER_FESTLEGUNG, "marktpraemie_abgrenzung", "A2", True) is None
    assert fz_regeln.zulaessig(
        fz_regeln.LADEPUNKT_DER_FESTLEGUNG, "marktpraemie_abgrenzung", "A1", True
    ) == "formelsatz_ohne_ladepunkt"


def test_lader_a2_mit_stromspeicher_plant_kein_fahrzeug(monkeypatch):
    # Jede Anlage des Live-Laders hat einen Speicher; A2 heisst „ohne“ (A1 S. 29–30).
    from datetime import timedelta

    from voltpilot_optimization.inputs import load_fahrzeugspeicher

    kid = uuid4()
    slots = [T0 + timedelta(minutes=15 * i) for i in range(96)]
    _lader(monkeypatch, {
        "ladepunkt_faehigkeit": [(kid, "bidirektional", True, True, False, 11)],
        "ladepunkt_fahrzeugfenster": [(kid, 20, 60, a.wochentag, a.ankunft, a.abfahrt, a.abfahrt_soc_pct)
                                      for a in PENDLER],
        "device_charge_connector": [(kid, "SuspendedEV", 40.0, T0 - timedelta(minutes=5))],
    })
    a2 = _site(netzladen_erlaubt=True, foerderweg_fassung="marktpraemie_abgrenzung", formelsatz="A2")
    a3 = replace(a2, formelsatz="A3")
    assert load_fahrzeugspeicher("postgresql://fake", a2, T0, slots) is None
    assert load_fahrzeugspeicher("postgresql://fake", a3, T0, slots) is not None


# --- A2 mit Fahrzeug: Abfahrtsziel, V2H vor V2G, kein Speicher -------------


@needs_highs
@pytest.mark.parametrize("seed", range(3))
@pytest.mark.parametrize("soc_pct", [0.0, 50.0, 100.0])
@pytest.mark.parametrize("faehigkeit", [V2G, V2H], ids=["v2g", "v2h"])
def test_a2_abfahrtsziel_immer_erreicht(seed, soc_pct, faehigkeit):
    fz = _fahrzeug(faehigkeit, soc_pct=soc_pct)
    inp = _a2(fz, prices=_abend_preise(seed=seed, spitze=300.0 + 150.0 * seed), pv=1.0 * seed)
    plan = optimize(inp, uuid4(), T0)
    assert [s for s, _ in fz.abfahrten] == [28, 124]
    for s, ziel, geplant in plan.fahrzeug.abfahrten:
        assert geplant >= ziel - 1e-6, (s, ziel, geplant)
    # kein stationaerer Speicher: der Platzhalter ruht, sein Stand bleibt
    assert all(slot.battery_kw == 0.0 for slot in plan.slots)
    assert all(slot.stur_cost_eur is None for slot in plan.slots)


@needs_highs
def test_a2_v2h_ohne_v2g_speist_nie_ins_netz():
    inp = _a2(_fahrzeug(V2H, soc_pct=90.0), pv=0.0)
    m = build_model(inp)
    _solve_plan(m, inp)
    zurueck = [t for t in m.T if value(m.fz_rueck[t]) > 1e-6]
    assert zurueck, "die Abendspitze muss die Rueckspeisung lohnen"
    assert all(value(m.grid_export[t]) <= 1e-6 for t in zurueck)
    # ohne Einspeisung aus dem Ladepunkt keine Gutschrift und kein Fremdtankstrom-Abzug
    assert _kwh(m, m.rot_einspeisung) == pytest.approx(0.0, abs=1e-6)
    assert not hasattr(m, "fremdtank_aktiv")


@needs_highs
def test_a2_v2g_deckt_erst_das_haus():
    inp = _a2(_fahrzeug(V2G, soc_pct=90.0), pv=0.0, load=2.0)
    m = build_model(inp)
    _solve_plan(m, inp)
    for t in m.T:
        if value(m.fz_rueck[t]) > 1e-6 and value(m.grid_export[t]) > 1e-6:
            assert value(m.grid_import[t]) <= 1e-6, t  # erst das Haus, dann das Netz


# --- Fremdtankstrom (12)/(13): Buchung wie das Rechenwerk -------------------


def _bruch(x: float) -> Fraction:
    return Fraction(round(max(x, 0.0), 9)).limit_denominator(10**9)


def _rechenwerk_a2(m):
    """Die Monatswerte des Rechenwerks A2 ueber die Viertelstunden des Plans."""
    qs = []
    for t in m.T:
        werte = {
            "Z1NB¼": _bruch(value(m.grid_import[t]) * VIERTELSTUNDE_H),
            "Z1NE¼": _bruch(value(m.grid_export[t]) * VIERTELSTUNDE_H),
            "Z2V¼": _bruch(value(m.fz_laden[t]) * VIERTELSTUNDE_H),
            "Z2E¼": _bruch(value(m.fz_rueck[t]) * VIERTELSTUNDE_H),
            "AW¼": 1,
        }
        qs.append({**werte, **mispel_abgrenzung.viertelstunde("A2", werte)})
    return mispel_abgrenzung.monat("A2", mispel_abgrenzung.summen("A2", qs))


@needs_highs
@pytest.mark.parametrize(
    ("soc_pct", "praemie", "saldiert"),
    [(100.0, 30.0, 150.0), (100.0, 300.0, 20.0), (60.0, 30.0, 150.0), (100.0, 30.0, 0.0)],
    ids=["voll-gutschrift", "voll-praemie", "halb-gutschrift", "voll-ohne-gutschrift"],
)
def test_a2_fremdtankstrom_bucht_wie_das_rechenwerk(soc_pct, praemie, saldiert):
    # n = 32: Do 00:00-08:00, Abfahrt 07:00 mit 80 % - von 100 % bleibt mitgebrachte Energie.
    n = 32
    prices = [400.0 if t < 12 else 20.0 for t in range(n)]  # teuer jetzt, billig vor der Abfahrt
    inp = _a2(_fahrzeug(V2G, soc_pct=soc_pct, n=n), n=n, prices=prices, praemie=praemie,
              saldiert=saldiert, load=0.5)
    m = build_model(inp)
    _solve_plan(m, inp)
    w = _rechenwerk_a2(m)
    gezaehlt = _kwh(m, m.speicher_einspeisung) - _kwh(m, m.fremdtank_netz)
    if round(value(m.fremdtank_aktiv)) == 1:
        # (12) geht ganz von (11) ab: nie mehr gezaehlt als (13) des Rechenwerks
        assert value(m.fremdtank) >= float(w["(12)"]) - 1e-4
        assert gezaehlt <= float(w["(13)"]) + 1e-4
        if hasattr(m, "saldierung_aktiv") and round(value(m.saldierung_aktiv)) == 1:
            # mit Gutschrift exakt: (12), (13) = (11) - (12), (16) = MAX [ (13) - (15) ; 0 ]
            assert value(m.fremdtank) == pytest.approx(float(w["(12)"]), abs=1e-4)
            assert gezaehlt == pytest.approx(float(w["(13)"]), abs=1e-4)
            assert _kwh(m, m.rot_einspeisung) == pytest.approx(float(w["(16)"]), abs=1e-4)
    else:
        # sicherer Zweig: keine Speicher-Einspeisung zaehlt - nie mehr als das Rechenwerk
        assert _kwh(m, m.rot_einspeisung) == pytest.approx(0.0, abs=1e-6)
        assert gezaehlt == pytest.approx(0.0, abs=1e-6)
    # ohne Wert: weder Gutschrift noch Praemie auf den Fremdtankstrom
    assert _kwh(m, m.rot_einspeisung) <= float(w["(16)"]) + 1e-4


@needs_highs
def test_a2_mitgebrachte_energie_traegt_keine_gutschrift():
    # Voll angekommen, 20 % ueber dem Abfahrtsziel, Nachladen lohnt nicht (380 / 0,85 > 400 + 20):
    # die Einspeisung ist ganz mitgebrachte Energie - (6) > (5), (13) = 0, also auch (16) = 0.
    n = 32
    prices = [400.0] * 12 + [380.0] * 20
    inp = _a2(_fahrzeug(V2G, soc_pct=100.0, n=n), n=n, prices=prices, saldiert=20.0, praemie=0.0,
              load=0.0)
    m = build_model(inp)
    _solve_plan(m, inp)
    w = _rechenwerk_a2(m)
    assert float(w["(12)"]) > 1.0 and float(w["(13)"]) == 0.0
    assert _kwh(m, m.rot_einspeisung) == pytest.approx(0.0, abs=1e-6) == float(w["(16)"])


@needs_highs
def test_a2_aufzaehlung_gleich_dem_ganzen_modell():
    inp = _a2(_fahrzeug(V2G, soc_pct=100.0, n=32), n=32,
              prices=[400.0] * 12 + [20.0] * 20, load=0.5)
    ganz, teile = build_model(inp), build_model(inp)
    assert hasattr(teile, "fremdtank_aktiv") and hasattr(teile, "saldierung_aktiv")
    explain._check_constraint_inventory(teile)  # die Erklaerung kennt die neuen Mengen
    _solve(ganz)
    _solve_plan(teile, inp)
    assert value(teile.total_cost) == pytest.approx(value(ganz.total_cost), abs=1e-6)


# --- Laufzeit (MP-33b) und Wiederholbarkeit (MP-33c) ------------------------


@needs_highs
@pytest.mark.parametrize(("pv", "faehigkeit"), [(0.0, V2G), (3.0, V2G), (0.0, V2H)], ids=["v2g", "v2g-pv", "v2h"])
def test_a2_192_slots_in_der_zeitgrenze(pv, faehigkeit, caplog):
    inp = _real_a2(192, pv=pv, faehigkeit=faehigkeit)
    m = build_model(inp)
    start = uhr.perf_counter()
    _solve_plan(m, inp)
    dauer = uhr.perf_counter() - start
    messlatte_start = uhr.perf_counter()
    messlatte = solver.messlatte_nur_laden(inp, m)
    messlatte_dauer = uhr.perf_counter() - messlatte_start
    print(f"MP-33d A2 {faehigkeit.v2g=} pv={pv}: Plan {dauer:.1f} s, Messlatte {messlatte_dauer:.1f} s")
    assert "mischbetrieb.fahrzeug_saldierung_zeitgrenze" not in caplog.text
    assert dauer < solver.MISCHBETRIEB_ZEITGRENZE_S
    assert messlatte is not None and messlatte_dauer < solver.MISCHBETRIEB_ZEITGRENZE_S


@needs_highs
def test_a2_wiederholbar_gleicher_plan():
    inp = replace(_real_a2(96, pv=2.0), wiederholbar=True)
    a = optimize(inp, uuid4(), T0, explain_plan=False)
    b = optimize(inp, uuid4(), T0, explain_plan=False)
    assert a.fahrzeug.slots == b.fahrzeug.slots
    assert a.fahrzeug.messlatte_nur_laden == b.fahrzeug.messlatte_nur_laden


# --- Messlatte „nur laden“ ---------------------------------------------------


def _nur_laden_kosten(inp):
    nur = replace(inp, fahrzeug=replace(inp.fahrzeug, rueckspeisen_kw=0.0))
    plan = optimize(nur, uuid4(), T0, explain_plan=False)
    return sum(s.cost_eur for s in plan.slots), plan


@needs_highs
def test_messlatte_a2_v2h_gegen_dasselbe_haus_das_nur_laedt():
    inp = _a2(_fahrzeug(V2H, soc_pct=90.0), pv=0.0, praemie=0.0, saldiert=0.0)
    plan = optimize(inp, uuid4(), T0)
    ml = plan.fahrzeug.messlatte_nur_laden
    kosten_nur, plan_nur = _nur_laden_kosten(inp)
    assert ml.kosten_nur_laden_eur == pytest.approx(kosten_nur, abs=1e-4)
    assert ml.kosten_eur == pytest.approx(sum(s.cost_eur for s in plan.slots), abs=1e-4)
    p = ml.posten
    # die Posten aus § 6a (MP-41a) ergeben genau die Kostendifferenz, je Slot wie im Ganzen
    assert p.weniger_gekauft_eur + p.mehr_geladen_eur + p.ins_netz_verkauft_eur == pytest.approx(
        ml.kosten_nur_laden_eur - ml.kosten_eur, abs=1e-4)
    for feld in ("weniger_gekauft_eur", "mehr_geladen_eur", "ins_netz_verkauft_eur", "akku_verschleiss_eur"):
        assert sum(getattr(x, feld) for x in ml.posten_je_slot) == pytest.approx(getattr(p, feld), abs=1e-4)
    assert len(ml.posten_je_slot) == len(plan.slots)
    assert plan_nur.fahrzeug.messlatte_nur_laden is None  # „nur laden“ hat selbst keine
    # V2H ohne PV: weniger gekauft am Abend, mehr geladen in der Nacht, nichts ins Netz
    assert p.weniger_gekauft_eur > 0.0 > p.mehr_geladen_eur
    assert p.ins_netz_verkauft_eur == pytest.approx(0.0, abs=1e-6)
    assert ml.rueckgespeist_kwh > 1.0 and ml.gutschrift_eur == 0.0
    assert p.akku_verschleiss_eur == pytest.approx(-0.03 * ml.rueckgespeist_kwh)
    # das Zurueckgeben bringt Geld, auch nach Mehrladen und Verschleiss
    assert ml.gegenueber_nur_laden_eur == pytest.approx(p.summe_eur) and ml.gegenueber_nur_laden_eur > 0.0
    assert ml.mehr_geladen_kwh > 0.0
    # beide Plaene erreichen jedes Abfahrtsziel
    for s, ziel, geplant in plan_nur.fahrzeug.abfahrten:
        assert geplant >= ziel - 1e-6


@needs_highs
def test_messlatte_a2_v2g_mit_gutschrift():
    inp = _real_a2(96, pv=2.0, soc_pct=80.0)
    plan = optimize(inp, uuid4(), T0)
    ml = plan.fahrzeug.messlatte_nur_laden
    assert ml is not None
    assert ml.gutschrift_nur_laden_eur == 0.0  # A2 nur laden: nichts aus dem Ladepunkt eingespeist
    assert ml.kosten_nur_laden_eur == pytest.approx(_nur_laden_kosten(inp)[0], abs=1e-4)


@needs_highs
def test_messlatte_mp33_testfall_a3():
    # Der MP-33-Testfall (A3, 32 Slots, 50 %, Gutschrift 150 EUR/MWh)
    n = 32
    inp = replace(_input(_fahrzeug(V2G, soc_pct=50.0, n=n), pv=[0.0] * n), mischbetrieb=True,
                  mispel_formelsatz="A3", mispel_praemie_eur_mwh=[30.0] * n,
                  saldierte_bestandteile_eur_mwh=150.0, export_value_eur_mwh=None)
    plan = optimize(inp, uuid4(), T0)
    ml = plan.fahrzeug.messlatte_nur_laden
    kosten_nur, _ = _nur_laden_kosten(inp)
    assert ml.kosten_nur_laden_eur == pytest.approx(kosten_nur, abs=1e-4)
    assert ml.rueckgespeist_kwh > 0.0 and ml.gutschrift_eur > ml.gutschrift_nur_laden_eur
    assert ml.gegenueber_nur_laden_eur > 0.0


@needs_highs
def test_ohne_rueckspeisung_keine_messlatte():
    # ohne Mindest-Ladestand wird nie zurueckgespeist - der Plan IST „nur laden“
    fz = _fahrzeug(V2G, soc_pct=50.0, mindest=None)
    plan = optimize(_a2(fz), uuid4(), T0)
    assert fz.rueckspeisen_kw == 0.0 and plan.fahrzeug.messlatte_nur_laden is None


# --- Bestandsschutz ----------------------------------------------------------


def test_ohne_a2_kein_neues_modellteil():
    # A3 mit Fahrzeug: (12) fuer den Lauf 0 wie in MP-33; ohne Fahrzeug: nichts Neues
    a3 = replace(_input(_fahrzeug(V2G, soc_pct=100.0, n=32), pv=[0.0] * 32), mischbetrieb=True,
                 mispel_formelsatz="A3", mispel_praemie_eur_mwh=[30.0] * 32,
                 saldierte_bestandteile_eur_mwh=150.0, export_value_eur_mwh=None)
    for inp in (a3, replace(a3, fahrzeug=None, mispel_formelsatz="A1")):
        m = build_model(inp)
        assert not hasattr(m, "fremdtank_aktiv") and not hasattr(m, "fremdtank")


@needs_highs
def test_ohne_fahrzeug_plan_byte_gleich_mit_vorgabe():
    from test_solver import make_input

    inp = make_input(_abend_preise(96), load=1.5)
    a = optimize(inp, uuid4(), T0)
    b = optimize(replace(inp, ohne_stromspeicher=False), a.plan_id, T0)
    assert a == b and a.fahrzeug is None

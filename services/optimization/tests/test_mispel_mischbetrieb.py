"""MiSpeL MP-10: Optimierer Mischbetrieb I - die dritte Betriebsart.

Festlegung zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az.
618-25-02, Beschluss 01.10.2026), Anlage 1 (Abgrenzungsoption), Formelsatz A1;
Zitierweise „A1 S. 33“ = Anlage 1, Seite 33. Bauplan § 8 Zeile MP-10.

Pruefnachweis laut Bauplan: Netzladen nur bei Gewinn nach Saldierung; kein
Laden ueber die bestehende Bezugsspitze. Dazu: die Buchung je Viertelstunde
stimmt mit dem Rechenwerk aus MP-9 ueberein (Speichervorrang exakt, nicht nur
als Obergrenze), Netzstrom bekommt nie die Praemie, gelb zuerst (16), und jede
Anlage ohne Mischbetrieb plant byte-gleich.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest
from pyomo.environ import Constraint, Var, value

from voltpilot_optimization import mispel_abgrenzung
from voltpilot_optimization.domain import VIERTELSTUNDE_H, BatteryParams
from voltpilot_optimization.inputs import BatterySite
from voltpilot_optimization.pricing import (
    DEFAULT_SUPPLY_COMPONENTS,
    FOERDERWEGE,
    MISCHBETRIEB_FORMELSAETZE,
    SiteTariff,
    SupplyPriceComponents,
    foerderweg_aus_bestand,
    ist_mischbetrieb,
    saldierte_bestandteile_eur_mwh,
)
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import _solve, build_model, optimize

from test_solver import T0, make_input, needs_highs

VEKTOREN = (
    Path(__file__).resolve().parents[3]
    / "docs/contracts/v2/mispel-foerderweg-vectors.json"
)

N = 96
#: Billige Nacht (8 h), teurer Abend (16 h) - Spot in EUR/MWh.
NACHT, ABEND = 20.0, 150.0
SPOT = [NACHT] * 32 + [ABEND] * 64
#: Bezugspreis-Bestandteile 150 EUR/MWh auf den Spot (netto = brutto, USt 0).
BESTANDTEILE = 150.0


def _misch(
    spot=SPOT,
    load=0.0,
    pv=0.0,
    praemie=0.0,
    saldiert=0.0,
    soc0_kwh=0.5,
    netzladen=True,
    **felder,
):
    """Eine Anlage im Mischbetrieb ohne Endwert (der Endwert wuerde Laden fuer
    den Horizont-Rand belohnen und die Pruefung verwischen)."""
    inp = make_input(spot, load=load, pv=pv, soc0_kwh=soc0_kwh, netzladen_erlaubt=netzladen)
    praemien = praemie if isinstance(praemie, list) else [praemie] * len(spot)
    return replace(
        inp,
        import_price_eur_mwh=[p + BESTANDTEILE for p in spot],
        export_value_eur_mwh=list(spot),
        terminal_value_eur_per_kwh=0.0,
        mischbetrieb=True,
        mispel_praemie_eur_mwh=praemien,
        saldierte_bestandteile_eur_mwh=saldiert,
        **felder,
    )


def _geloest(inp):
    model = build_model(inp)
    _solve(model)
    return model


def _kwh(model, var) -> float:
    return sum(value(var[t]) for t in model.T) * VIERTELSTUNDE_H


def _netzladen_kwh(model) -> float:
    """(9) = ∑ (1)¼ über den Lauf (A1 S. 34)."""
    return _kwh(model, model.netz_laden)


# --- Pruefnachweis 1: Netzladen nur bei Gewinn nach Saldierung ---------------


@needs_highs
def test_ohne_saldierung_laedt_der_speicher_nicht_aus_dem_netz():
    # Kauf 20 + 150 = 170, Verkauf 150 * 0,92 = 138 EUR/MWh: Verlust.
    model = _geloest(_misch(saldiert=0.0))
    assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_mit_saldierung_laedt_der_speicher_aus_dem_netz_und_speist_ein():
    # Saldiert 100 von 150: die Netzentnahme kostet nach Saldierung 70, der
    # Verkauf bringt 138 - und die Verluste sind mit privilegiert (19).
    model = _geloest(_misch(saldiert=100.0))
    assert _netzladen_kwh(model) > 4.0
    assert _kwh(model, model.rot_einspeisung) > 4.0
    # Rot = saldierungsfaehige Netzeinspeisung (16): alles aus dem Netz.
    assert _kwh(model, model.rot_einspeisung) == pytest.approx(
        _kwh(model, model.speicher_einspeisung), abs=1e-6
    )


@needs_highs
def test_eine_zu_kleine_gutschrift_macht_netzladen_nicht_lohnend():
    # Saldiert 20: Kauf 150 nach Saldierung, Verkauf 138 - weiter Verlust.
    model = _geloest(_misch(saldiert=20.0))
    assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)


def _schwelle_eur_mwh(inp) -> float:
    """Die Gutschrift, ab der eine Netzentnahme nach Saldierung Gewinn bringt:
    je geladener kWh x kostet sie (SP + Bestandteile) * x - G * x (entlastet ist
    (16) + (19) = (16) / (14) = x, A1 S. 36–37), bringt SP_abend * eta * x und
    verschleisst (1 + eta) * x."""
    eta = inp.battery.roundtrip_efficiency
    verschleiss = inp.battery.wear_cost_eur_per_kwh_each_way * 1000.0
    return (NACHT + BESTANDTEILE) - ABEND * eta + verschleiss * (1.0 + eta)


@needs_highs
def test_netzladen_genau_ab_der_gewinnschwelle_nach_saldierung():
    schwelle = _schwelle_eur_mwh(_misch())
    darunter = _geloest(_misch(saldiert=schwelle - 2.0))
    darueber = _geloest(_misch(saldiert=schwelle + 2.0))
    assert _netzladen_kwh(darunter) == pytest.approx(0.0, abs=1e-6)
    assert _netzladen_kwh(darueber) > 4.0


@needs_highs
def test_die_gutschrift_rechnet_die_privilegierten_verluste_mit():
    # Ohne (19) wuerde nur die eingespeiste Menge eta * x entlastet - die
    # Schwelle laege bei schwelle / eta. Dazwischen laedt der Speicher nur,
    # weil die Speicherverluste mit saldiert sind (§ 21 Abs. 2 EnFG).
    inp = _misch()
    schwelle = _schwelle_eur_mwh(inp)
    ohne_verluste = schwelle / inp.battery.roundtrip_efficiency
    assert ohne_verluste - schwelle > 2.0
    model = _geloest(_misch(saldiert=(schwelle + ohne_verluste) / 2.0))
    assert _netzladen_kwh(model) > 4.0
    rot = _kwh(model, model.rot_einspeisung)
    # Die entlastete Netzentnahme (16) / (14) ist genau der Netzstrom im Speicher.
    assert rot / inp.battery.roundtrip_efficiency == pytest.approx(
        _netzladen_kwh(model), rel=1e-3
    )


# --- Netzstrom bekommt nie die Praemie (gelb zuerst, (16)) -------------------


@needs_highs
def test_netzstrom_im_speicher_traegt_keine_marktpraemie():
    # Altanlage: Praemie 500 EUR/MWh, keine Saldierung. Ein Modell, das die
    # Praemie auf jede Einspeisung gaebe, wuerde nachts laden und abends die
    # Praemie auf Netzstrom kassieren - die Festlegung zaehlt sie rot (16).
    model = _geloest(_misch(praemie=500.0, saldiert=0.0))
    assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_pv_strom_im_speicher_traegt_die_praemie_als_gelb():
    # Mittags PV-Ueberschuss in den Speicher, abends (ohne Last) Einspeisung
    # mit Praemie: gelb (15), keine rote Menge.
    pv = [0.0] * 40 + [6.0] * 16 + [0.0] * 40
    spot = [NACHT] * 40 + [10.0] * 16 + [ABEND] * 40
    load = [1.0] * 56 + [0.0] * 40
    model = _geloest(_misch(spot=spot, pv=pv, load=load, praemie=300.0, saldiert=0.0))
    assert _kwh(model, model.speicher_einspeisung) > 4.0
    assert _kwh(model, model.rot_einspeisung) == pytest.approx(0.0, abs=1e-6)
    assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_gelb_zuerst_auch_wenn_die_gutschrift_mehr_wert_ist():
    # Gutschrift > Praemie: der Solver moechte Rot. Nach (16) = MAX [ (13) -
    # (15) ; 0 ] ist die Speicher-Einspeisung aber zuerst gelb - rot ist nur,
    # was die EE-Speichererzeugung uebersteigt (gesicherte Zuordnung).
    pv = [0.0] * 40 + [6.0] * 16 + [0.0] * 40
    spot = [NACHT] * 40 + [10.0] * 16 + [ABEND] * 40
    inp = _misch(spot=spot, pv=pv, load=1.0, praemie=10.0, saldiert=140.0)
    model = _geloest(inp)
    eta = inp.battery.roundtrip_efficiency
    pv_laden = _kwh(model, model.charge) - _netzladen_kwh(model)
    start = inp.battery.one_way_efficiency * max(
        inp.battery.clamp_soc_kwh(inp.initial_soc_kwh)
        - inp.battery.soc_floor_kwh(inp.initial_soc_kwh),
        0.0,
    )
    gelb = start + eta * pv_laden
    erwartet_rot = max(_kwh(model, model.speicher_einspeisung) - gelb, 0.0)
    assert _kwh(model, model.rot_einspeisung) == pytest.approx(erwartet_rot, abs=1e-5)


# --- Speichervorrang je Viertelstunde = das Rechenwerk aus MP-9 --------------


def _buchung_gegen_rechenwerk(model, inp):
    """(1)¼, (2)¼ und (23)¼ je Slot aus dem Rechenwerk (A1 S. 33–38) gegen die
    Modellvariablen - exakt, nicht nur als Obergrenze."""
    for t in model.T:
        werte = {
            "Z1NB¼": max(value(model.grid_import[t]), 0.0) * VIERTELSTUNDE_H,
            "Z1NE¼": max(value(model.grid_export[t]), 0.0) * VIERTELSTUNDE_H,
            "Z2V¼": max(value(model.charge[t]), 0.0) * VIERTELSTUNDE_H,
            "Z2E¼": max(value(model.discharge[t]), 0.0) * VIERTELSTUNDE_H,
            "AW¼": 1,
        }
        w = mispel_abgrenzung.viertelstunde("A1", werte)
        assert value(model.netz_laden[t]) * VIERTELSTUNDE_H == pytest.approx(
            float(w["(1)¼"]), abs=1e-5
        ), t
        assert value(model.speicher_einspeisung[t]) * VIERTELSTUNDE_H == pytest.approx(
            float(w["(2)¼"]), abs=1e-5
        ), t


#: Ein gemischter Tag: Nacht ohne PV, Mittag mit Ueberschuss, Wolkenloch,
#: Abend mit Last - alle Faelle des MIN in beiden Richtungen.
GEMISCHT_PV = [0.0] * 28 + [2.0] * 4 + [7.0] * 12 + [1.5] * 4 + [7.0] * 12 + [0.0] * 36
GEMISCHT_SPOT = [NACHT] * 28 + [60.0] * 32 + [ABEND] * 36


@needs_highs
@pytest.mark.parametrize(
    "praemie,saldiert",
    [(300.0, 20.0), (20.0, 140.0), (0.0, 0.0)],
    ids=["praemie-schlaegt-gutschrift", "gutschrift-schlaegt-praemie", "weder-noch"],
)
def test_speichervorrang_je_viertelstunde_ist_exakt(praemie, saldiert):
    inp = _misch(
        spot=GEMISCHT_SPOT, pv=GEMISCHT_PV, load=3.0, praemie=praemie, saldiert=saldiert,
        soc0_kwh=4.0,
    )
    model = _geloest(inp)
    _buchung_gegen_rechenwerk(model, inp)


#: Ein Mittag mit negativem Bezugspreis: Spot -200, Bestandteile 20 EUR/MWh.
NEGATIV_SPOT = [NACHT] * 40 + [-200.0] * 16 + [ABEND] * 40
NEGATIV_PV = [0.0] * 40 + [6.0] * 16 + [0.0] * 40


def _negativ(praemie, saldiert):
    # Praemie nur bei Spot >= 0 - der Rueckfall „AW¼ = 0 bei SP¼ < 0“ (W4).
    praemien = [praemie if s >= 0 else 0.0 for s in NEGATIV_SPOT]
    inp = _misch(spot=NEGATIV_SPOT, pv=NEGATIV_PV, load=2.0, praemie=praemien, saldiert=saldiert)
    return replace(inp, import_price_eur_mwh=[p + 20.0 for p in NEGATIV_SPOT])


@needs_highs
def test_negativer_bezugspreis_laedt_aus_dem_netz_und_regelt_nur_bis_zur_last_ab():
    # Bezahltes Laden aus dem Netz bleibt moeglich und ist (1)¼ - gebucht als
    # Netzstrom, nie als PV-Ladung. Abgeregelt wird hoechstens bis auf die Last
    # (Planungsgrenze, Graustrom-Weg ueber die Abregelung bleibt zu).
    inp = _negativ(praemie=300.0, saldiert=0.0)
    model = _geloest(inp)
    _buchung_gegen_rechenwerk(model, inp)
    assert _netzladen_kwh(model) > 4.0
    for t in model.T:
        assert value(model.curtail[t]) <= max(inp.pv_kw[t] - inp.load_kw[t], 0.0) + 1e-6


@needs_highs
def test_zeitgrenze_plant_vorsichtig_ohne_gutschrift(monkeypatch):
    # An Tagen mit negativem Bezugspreis kann der Zweig „(16) > 0“ lange
    # verzweigen. Nach der Zeitgrenze plant der Lauf ohne Gutschrift - er
    # ueberschaetzt nichts. Hier mit einer Zeitgrenze, die sofort greift.
    from voltpilot_optimization import solver

    monkeypatch.setattr(solver, "MISCHBETRIEB_ZEITGRENZE_S", 1e-4)
    inp = _misch(saldiert=140.0)
    model = build_model(inp)
    solver._solve_plan(model, inp)
    assert model.saldierung_aktiv.fixed and value(model.saldierung_aktiv) == 0
    assert _kwh(model, model.rot_einspeisung) == pytest.approx(0.0, abs=1e-6)
    plan = optimize(inp, plan_id=UUID(int=7), generated_at=T0)
    assert len(plan.slots) == N


@needs_highs
def test_netzladen_aus_haelt_die_fk3_klemme_und_bucht_ehrlich():
    # Abgrenzungsoption mit Netzladen aus: die FK3-Klemme bleibt (der Speicher
    # laedt hoechstens die erzeugte PV), die Buchung folgt trotzdem dem
    # Speichervorrang - PV-Bus-Laden bei Netzbezug ist (1)¼ (A1 S. 15).
    inp = _misch(spot=GEMISCHT_SPOT, pv=GEMISCHT_PV, load=3.0, praemie=50.0, netzladen=False)
    model = _geloest(inp)
    assert hasattr(model, "solar_only_charge")
    _buchung_gegen_rechenwerk(model, inp)


# --- Pruefnachweis 2: kein Laden ueber die bestehende Bezugsspitze ----------


@needs_highs
@pytest.mark.parametrize("spitze", [2.0, 4.0, 6.0])
def test_kein_laden_ueber_die_bestehende_bezugsspitze(spitze):
    # Last 2 kW nachts, Gutschrift macht Netzladen lohnend: geladen wird nur
    # bis zur Spitze der Abrechnungsperiode, nie darueber.
    inp = _misch(load=2.0, saldiert=140.0, leistungspreis_eur_kw=0.0, peak_so_far_kw=spitze)
    model = _geloest(inp)
    for t in model.T:
        if value(model.charge[t]) > 1e-6:
            assert value(model.grid_import[t]) <= max(spitze, 2.0) + 1e-6, t
    if spitze == 2.0:
        # Kein Spielraum: kein Netzladen ueberhaupt.
        assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)
    else:
        assert _netzladen_kwh(model) > 1.0


@needs_highs
def test_spitzenschutz_auch_wenn_die_last_schon_ueber_der_spitze_liegt():
    # Last 5 kW ueber der Spitze 4 kW: in diesen Viertelstunden laedt der
    # Speicher gar nicht (er wuerde die neue Spitze nur erhoehen).
    load = [5.0] * 32 + [0.0] * 64
    inp = _misch(load=load, saldiert=140.0, leistungspreis_eur_kw=0.0, peak_so_far_kw=4.0)
    model = _geloest(inp)
    assert _netzladen_kwh(model) == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_ohne_leistungspreis_kein_spitzenschutz():
    model = _geloest(_misch(load=2.0, saldiert=140.0))
    assert not hasattr(model, "mispel_spitzenschutz")
    assert max(value(model.grid_import[t]) for t in model.T) > 2.0


# --- Bestandsschutz: ohne Mischbetrieb byte-gleich ---------------------------


def _komponenten(model) -> set[str]:
    return {c.local_name for c in model.component_objects((Constraint, Var))}


def _payload(inp) -> bytes:
    inp = replace(inp, tenant_id=UUID(int=1), site_id=UUID(int=2), device_id=UUID(int=3))
    plan = optimize(inp, plan_id=UUID(int=10), generated_at=T0)
    return json.dumps(build_schedule_payload(plan), sort_keys=True).encode()


@pytest.mark.parametrize(
    "netzladen,strenge", [(True, False), (False, False), (False, True)],
    ids=["haendler", "eeg-fk3", "eeg-streng-mp45"],
)
def test_ohne_mischbetrieb_kommt_nichts_ins_modell(netzladen, strenge):
    inp = make_input(GEMISCHT_SPOT, load=3.0, pv=GEMISCHT_PV, netzladen_erlaubt=netzladen)
    inp = replace(inp, strenge_ausschliesslichkeit=strenge, leistungspreis_eur_kw=50.0)
    neu = _komponenten(build_model(inp))
    assert not {n for n in neu if "mischbetrieb" in n or "mispel" in n}
    assert not {"netz_laden", "speicher_einspeisung", "rot_einspeisung", "saldierung_aktiv"} & neu


@needs_highs
@pytest.mark.parametrize(
    "netzladen,strenge", [(True, False), (False, False), (False, True)],
    ids=["haendler", "eeg-fk3", "eeg-streng-mp45"],
)
def test_ohne_mischbetrieb_byte_gleicher_plan(netzladen, strenge):
    # Die neuen Felder mit Werten, aber ohne Mischbetrieb: nichts wirkt.
    inp = make_input(GEMISCHT_SPOT, load=3.0, pv=GEMISCHT_PV, netzladen_erlaubt=netzladen)
    inp = replace(inp, strenge_ausschliesslichkeit=strenge)
    mit_feldern = replace(
        inp, mispel_praemie_eur_mwh=[300.0] * N, saldierte_bestandteile_eur_mwh=140.0
    )
    assert _payload(inp) == _payload(mit_feldern)


# --- Foerderweg (MP-5) -> Betriebsart ----------------------------------------


def test_bestand_wie_die_vektoren_des_foerderwegs():
    vektoren = json.loads(VEKTOREN.read_text(encoding="utf-8"))
    for fall in vektoren["bestand"]:
        assert (
            foerderweg_aus_bestand(fall["netzladen_erlaubt"], fall["plant_kind"])
            == fall["foerderweg"]
        ), fall
    assert {w["wert"] for w in vektoren["werte"]} == FOERDERWEGE
    assert MISCHBETRIEB_FORMELSAETZE <= set(vektoren["formelsaetze"])


def test_mischbetrieb_nur_in_der_abgrenzungsoption_mit_formelsatz_der_foerderseite():
    assert ist_mischbetrieb("marktpraemie_abgrenzung", "A1")
    assert ist_mischbetrieb("marktpraemie_abgrenzung", "A5")
    assert ist_mischbetrieb("marktpraemie_abgrenzung", "A5-Variante")
    # A10/A11 haben keine Foerderseite (A1 S. 94–102).
    assert not ist_mischbetrieb("marktpraemie_abgrenzung", "A10")
    assert not ist_mischbetrieb("ungefoerdert", "A1")
    for weg in FOERDERWEGE - {"marktpraemie_abgrenzung"}:
        assert not ist_mischbetrieb(weg, None)


def _site(**felder) -> BatterySite:
    return BatterySite(
        tenant_id=UUID(int=1),
        site_id=UUID(int=2),
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0),
        **felder,
    )


def test_anlage_ohne_fassung_plant_wie_heute():
    for netzladen in (True, False):
        for art in ("direktvermarktung", "eigenverbrauch"):
            site = _site(netzladen_erlaubt=netzladen, tariff=SiteTariff(plant_kind=art))
            assert site.foerderweg == foerderweg_aus_bestand(netzladen, art)
            assert not site.mischbetrieb


def test_anlage_mit_fassung_abgrenzung_plant_im_mischbetrieb():
    site = _site(
        netzladen_erlaubt=True,
        foerderweg_fassung="marktpraemie_abgrenzung",
        formelsatz="A1",
    )
    assert site.foerderweg == "marktpraemie_abgrenzung"
    assert site.mischbetrieb
    # Pauschaloption ist kein Mischbetrieb: sie plant mit dem Jahreszustand (MP-26).
    pauschal = replace(site, foerderweg_fassung="marktpraemie_pauschal", formelsatz=None)
    assert not pauschal.mischbetrieb


# --- Preise: Gutschrift der saldierten Bestandteile (die Praemie ist MP-12) ---

def test_gutschrift_umlagen_und_netzentgelt_ohne_stromsteuer_und_konzession():
    blatt = SupplyPriceComponents(
        netzentgelt_arbeitspreis_ct=6.0,
        stromsteuer_ct=2.05,
        konzessionsabgabe_ct=1.59,
        umlagen_ct=3.0,
        vertriebsaufschlag_ct=1.5,
        ust_pct=19.0,
    )
    tarif = SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=12.0, supply_price=blatt)
    # (6,0 + 3,0) ct * 1,19 = 107,1 EUR/MWh.
    assert saldierte_bestandteile_eur_mwh(tarif) == pytest.approx(107.1)


def test_gutschrift_ohne_blatt_nur_mit_derselben_vorgabe_wie_der_bezugspreis(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "true")
    ohne = SiteTariff(tarif_art="ohne")
    erwartet = (
        (DEFAULT_SUPPLY_COMPONENTS.umlagen_ct + DEFAULT_SUPPLY_COMPONENTS.netzentgelt_arbeitspreis_ct)
        * 10.0
        * 1.19
    )
    assert saldierte_bestandteile_eur_mwh(ohne) == pytest.approx(erwartet)
    # Sammelaufschlag ohne Aufschluesselung, Festpreis: Bestandteile unbekannt.
    assert saldierte_bestandteile_eur_mwh(SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=15.0)) == 0.0
    assert saldierte_bestandteile_eur_mwh(SiteTariff(tarif_art="fest", tarif_param_ct_kwh=30.0)) == 0.0
    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "false")
    assert saldierte_bestandteile_eur_mwh(ohne) == 0.0


def test_mischbetrieb_braucht_ganze_viertelstunden():
    inp = _misch()
    with pytest.raises(ValueError, match="whole quarter hours"):
        replace(inp, slot_minutes=5)
    with pytest.raises(ValueError, match="mispel_praemie_eur_mwh"):
        replace(inp, mispel_praemie_eur_mwh=[1.0])

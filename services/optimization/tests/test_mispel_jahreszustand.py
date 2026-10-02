"""MiSpeL MP-26: Optimierer-Jahreszustand der Pauschaloption.

Festlegung zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az.
618-25-02, Beschluss 01.10.2026), Anlage 2 (Pauschaloption); Zitierweise
„A2 S. 30“ = Anlage 2, Seite 30. Bauplan § 8 Zeile MP-26.

Pruefnachweis laut Bauplan: Solver-Tests an den drei Schwellen - der Wert der
naechsten eingespeisten kWh je nach Jahresstand: unter (P1) die Marktpraemie,
zwischen (P1) und (P4) nichts (Indifferenzbereich), darueber die Saldierung
bis zur Jahres-Netzentnahme, nur in SP≥0-Zeiten (A2 S. 9-10, Abb. 1; S. 30-33).
Dazu: das Modell rechnet (P15) und (P10) wie das Rechenwerk MP-25, der
Jahresrest, die Zeitraeume des Horizonts und der Eingang je Lauf aus dem
Jahreslauf.
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from types import SimpleNamespace
from uuid import UUID

import pytest
from pyomo.environ import Constraint, Var, value

from voltpilot_optimization import mispel_pauschal
from voltpilot_optimization.domain import VIERTELSTUNDE_H, MispelJahresstand
from voltpilot_optimization.inputs import gather_inputs, load_mispel_pauschal_bisher
from voltpilot_optimization.mispel_jahresstand import Bisher, grenzen, jahresstaende, zeitraum
from voltpilot_optimization.mispel_monatsstand import MINDEST_VIERTELSTUNDEN
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import _solve, build_model, optimize

import test_freshness
from test_solver import T0, make_input, needs_highs

N = 96
#: Billige Nacht (8 h), teurer Abend (16 h) - Spot in EUR/MWh.
NACHT, ABEND = 20.0, 150.0
SPOT = [NACHT] * 32 + [ABEND] * 64
#: Bezugspreis-Bestandteile 150 EUR/MWh auf den Spot; die saldierten davon
#: (Umlagen + Netzentgelt-Arbeitspreis) ebenfalls 150 EUR/MWh.
BESTANDTEILE = 150.0
PRAEMIE = 100.0

#: BNetzA-Beispielrechnung (A2 S. 12-14): 8 kWp / 10 kWh -> (P1) = 4 000,
#: (P3) = 320, (P4) = 4 320 kWh - gerechnet vom Rechenwerk MP-25.
STAMM = {"Pinst": Fraction(8), "SKinst": Fraction(10)}
_LEER = {"(P7)": Fraction(0), "(P9)": Fraction(0), "(P14)": Fraction(0)}
P1 = float(mispel_pauschal.jahr("P1", _LEER, STAMM)["(P1)"])
P4 = float(mispel_pauschal.jahr("P1", _LEER, STAMM)["(P4)"])
#: Das Kalenderjahr 2026 nach gesetzlicher Zeit, in UTC.
JAHR = zeitraum(date(2026, 1, 1), date(2026, 12, 31))


def test_grenzen_wie_die_bnetza_beispielrechnung():
    assert (P1, P4) == (4000.0, 4320.0)


def _stand(p14=0.0, p7=0.0, p9=0.0, periode=JAHR):
    return MispelJahresstand(von=periode[0], bis=periode[1], p1_kwh=P1, p4_kwh=P4,
                             p14_kwh=p14, p7_kwh=p7, p9_kwh=p9)


def _pauschal(stand, spot=SPOT, praemie=PRAEMIE, saldiert=BESTANDTEILE, soc0_kwh=0.5, netzladen=True):
    """Eine Anlage in der Pauschaloption ohne Last und PV, ohne Endwert (der
    Endwert wuerde Laden fuer den Horizont-Rand belohnen): jede Einspeisung
    ist Speicher-Einspeisung, der Speicher laedt nur aus dem Netz."""
    inp = make_input(spot, load=0.0, pv=0.0, soc0_kwh=soc0_kwh, netzladen_erlaubt=netzladen)
    return replace(
        inp,
        import_price_eur_mwh=[p + BESTANDTEILE for p in spot],
        export_value_eur_mwh=list(spot),
        terminal_value_eur_per_kwh=0.0,
        mispel_praemie_eur_mwh=praemie if isinstance(praemie, list) else [praemie] * len(spot),
        saldierte_bestandteile_eur_mwh=saldiert,
        mispel_jahresstand=(stand,) if isinstance(stand, MispelJahresstand) else tuple(stand),
    )


def _geloest(inp):
    model = build_model(inp)
    _solve(model)
    return model


def _kwh(model, var, ts=None) -> float:
    return sum(value(var[t]) for t in (model.T if ts is None else ts)) * VIERTELSTUNDE_H


def _zuwachs_p10(model, inp, k=0) -> float:
    """(P10) des Zeitraums k mit dem Lauf minus ohne ihn."""
    stand = [s for s in inp.mispel_jahresstand if any(s.enthaelt(x) for x in inp.slot_starts)][k]
    ohne = min(max(stand.p7_kwh - stand.p4_kwh, 0.0), stand.p9_kwh)
    return value(model.pauschal_saldiert[k]) - ohne


def _pruefe_gegen_rechenwerk(model, inp):
    """(P15) und (P10) des Modells = Rechenwerk MP-25 (``mispel_pauschal.jahr``)
    ueber die ∑J-Summen ausserhalb des Horizonts plus die des Laufs - je
    Zeitraum, als Zuwachs durch den Lauf. AW>0 = Praemie > 0, SP≥0 = Spot ≥ 0."""
    dt = inp.slot_hours
    zeitraeume = [s for s in inp.mispel_jahresstand if any(s.enthaelt(x) for x in inp.slot_starts)]
    for k, stand in enumerate(zeitraeume):
        ts = [t for t in range(inp.slots) if stand.enthaelt(inp.slot_starts[t])]
        lauf = {
            "(P14)": sum(value(model.grid_export[t]) for t in ts if inp.mispel_praemie_eur_mwh[t] > 0) * dt,
            "(P7)": sum(value(model.grid_export[t]) for t in ts if inp.prices_eur_mwh[t] >= 0) * dt,
            "(P9)": sum(value(model.grid_import[t]) for t in ts) * dt,
        }
        aussen = {"(P14)": stand.p14_kwh, "(P7)": stand.p7_kwh, "(P9)": stand.p9_kwh}
        mit = mispel_pauschal.jahr(
            "P1", {nr: Fraction(aussen[nr]) + Fraction(lauf[nr]) for nr in aussen}, STAMM)
        ohne = mispel_pauschal.jahr("P1", {nr: Fraction(aussen[nr]) for nr in aussen}, STAMM)
        assert _kwh(model, model.pauschal_foerderfaehig, ts) == pytest.approx(
            float(mit["(P15)"] - ohne["(P15)"]), abs=1e-4), k
        if hasattr(model, "pauschal_saldiert"):
            assert _zuwachs_p10(model, inp, k) == pytest.approx(
                float(mit["(P10)"] - ohne["(P10)"]), abs=1e-4), k


# --- Die drei Schwellen (Pruefnachweis) ------------------------------------
#
# Ohne Praemie und Saldierung lohnt Netzladen nie: geladen zu 20 + 150 =
# 170 EUR/MWh, eingespeist zu 150 * 0,92 = 138 EUR/MWh. Erst der Jahresstand
# macht die naechste eingespeiste kWh mehr wert - oder eben nicht.


@needs_highs
def test_unter_p1_traegt_die_naechste_kwh_die_marktpraemie():
    # (P14) = 3 000 < (P1) = 4 000: grundsaetzlich foerderfaehig (A2 S. 32-33);
    # (P7) weit unter (P4), keine Saldierung.
    inp = _pauschal(_stand(p14=3000.0, p7=3000.0, p9=1500.0))
    model = _geloest(inp)
    export = _kwh(model, model.grid_export)
    assert export > 5.0
    assert _kwh(model, model.charge) > 5.0
    # Jede eingespeiste kWh traegt die Praemie: (P15) waechst um die Einspeisung.
    assert _kwh(model, model.pauschal_foerderfaehig) == pytest.approx(export, abs=1e-4)
    assert _zuwachs_p10(model, inp) == pytest.approx(0.0, abs=1e-6)
    _pruefe_gegen_rechenwerk(model, inp)


@needs_highs
def test_an_der_schwelle_p1_endet_die_praemie():
    # (P14) = (P1) - 2: nur noch 2 kWh sind foerderfaehig, (P15) = MIN [ (P14) ;
    # (P1) ] (A2 S. 32). Jede weitere kWh traegt keine Praemie, Netzladen
    # lohnt genau fuer 2 kWh Einspeisung.
    inp = _pauschal(_stand(p14=P1 - 2.0, p7=3000.0, p9=1500.0))
    model = _geloest(inp)
    assert _kwh(model, model.pauschal_foerderfaehig) == pytest.approx(2.0, abs=1e-4)
    assert _kwh(model, model.grid_export) == pytest.approx(2.0, abs=1e-3)
    _pruefe_gegen_rechenwerk(model, inp)


def _payload(inp) -> bytes:
    inp = replace(inp, tenant_id=UUID(int=1), site_id=UUID(int=2), device_id=UUID(int=3))
    plan = optimize(inp, plan_id=UUID(int=10), generated_at=T0)
    return json.dumps(build_schedule_payload(plan), sort_keys=True).encode()


@needs_highs
def test_zwischen_p1_und_p4_ist_die_naechste_kwh_nichts_wert():
    # (P14) = 4 100 >= (P1), (P7) = 4 100 < (P4) = 4 320 - und 220 kWh sind in
    # diesem Lauf nicht einzuspeisen: indifferent, weder gefoerdert noch
    # saldiert (A2 S. 10). Der Plan ist der ohne Praemie und ohne Gutschrift.
    stand = _stand(p14=4100.0, p7=4100.0, p9=1500.0)
    inp = _pauschal(stand)
    model = _geloest(inp)
    assert _kwh(model, model.charge) == pytest.approx(0.0, abs=1e-6)
    assert _kwh(model, model.pauschal_foerderfaehig) == pytest.approx(0.0, abs=1e-6)
    assert _zuwachs_p10(model, inp) == pytest.approx(0.0, abs=1e-6)
    assert _payload(inp) == _payload(_pauschal(stand, praemie=0.0, saldiert=0.0))


@needs_highs
def test_ueber_p4_wird_die_naechste_kwh_saldiert():
    # (P7) = 5 000 > (P4): (P8) = 680 < (P9) = 1 500 - jede weitere kWh in
    # SP≥0-Zeiten entlastet eine bezogene kWh (A2 S. 30-31). Netzladen lohnt:
    # 150 + 150 = 300 EUR/MWh * 0,92 > 170 EUR/MWh.
    inp = _pauschal(_stand(p14=5000.0, p7=5000.0, p9=1500.0))
    model = _geloest(inp)
    export = _kwh(model, model.grid_export)
    assert export > 5.0
    assert _zuwachs_p10(model, inp) == pytest.approx(export, abs=1e-4)
    assert _kwh(model, model.pauschal_foerderfaehig) == pytest.approx(0.0, abs=1e-6)
    _pruefe_gegen_rechenwerk(model, inp)


@needs_highs
def test_ueber_p4_saldiert_nur_bis_zur_jahres_netzentnahme():
    # (P7) = 6 000: (P8) = 1 680 > (P9) = 1 000 - wie Beispielrechnung 2 (A2 S.
    # 14) ist der ganze Netzbezug saldiert. Eine weitere Einspeisung bringt nur
    # den Spot; dafuer entlastet jede weitere bezogene kWh (P11) = (P9) - (P10)
    # (A2 S. 31): Netzladen lohnt, weil der BEZUG saldiert wird - 20 statt 170
    # EUR/MWh, eingespeist zu 150 * 0,92.
    inp = _pauschal(_stand(p14=6000.0, p7=6000.0, p9=1000.0))
    model = _geloest(inp)
    bezug = _kwh(model, model.grid_import)
    assert bezug > 5.0
    assert _zuwachs_p10(model, inp) == pytest.approx(bezug, abs=1e-4)
    _pruefe_gegen_rechenwerk(model, inp)


@needs_highs
def test_an_der_schwelle_p4_beginnt_die_saldierung():
    # (P7) = (P4) - 3: die ersten 3 kWh des Laufs sind indifferent, erst danach
    # saldiert (A2 S. 30). Der Lauf ueberschreitet (P4) - mit der Ganzzahl des
    # Zeitraums -, und (P10) waechst um die Einspeisung ueber der Schwelle.
    inp = _pauschal(_stand(p14=5000.0, p7=P4 - 3.0, p9=1500.0))
    model = _geloest(inp)
    export = _kwh(model, model.grid_export)
    assert export > 5.0
    assert value(model.saldierung_jahr_aktiv[0]) == pytest.approx(1.0)
    assert _zuwachs_p10(model, inp) == pytest.approx(export - 3.0, abs=1e-4)
    _pruefe_gegen_rechenwerk(model, inp)


@needs_highs
def test_vor_unerreichbarer_schwelle_p4_keine_saldierung():
    # (P7) = (P4) - 100: physikalisch koennte der Lauf (P4) erreichen, mit 10
    # kWh Speicher aber nicht lohnend - die Ganzzahl bleibt aus, kein Netzladen.
    inp = _pauschal(_stand(p14=5000.0, p7=P4 - 100.0, p9=1500.0))
    model = _geloest(inp)
    assert value(model.saldierung_jahr_aktiv[0]) == pytest.approx(0.0)
    assert _kwh(model, model.charge) == pytest.approx(0.0, abs=1e-6)
    assert _zuwachs_p10(model, inp) == pytest.approx(0.0, abs=1e-6)


@needs_highs
@pytest.mark.parametrize("spot,saldiert", [(-1.0, False), (0.0, True)], ids=["sp-negativ", "sp-null"])
def test_saldiert_wird_nur_einspeisung_in_sp_ge_0_zeiten(spot, saldiert):
    # (P5)¼ = WENN [ SP¼ ≥ 0 ; 1 ; 0 ] (A2 S. 30): SP¼ = 0 zaehlt, SP¼ < 0
    # nicht (Fall p1-sp-und-aw-zeiten). Voller Speicher, ueber (P4).
    inp = _pauschal(_stand(p14=5000.0, p7=5000.0, p9=1500.0), spot=[spot] * N, praemie=0.0,
                    soc0_kwh=10.0)
    model = _geloest(inp)
    export = _kwh(model, model.grid_export)
    if saldiert:
        assert export > 5.0
        assert _zuwachs_p10(model, inp) == pytest.approx(export, abs=1e-4)
    else:
        assert export == pytest.approx(0.0, abs=1e-6)
        assert _zuwachs_p10(model, inp) == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_keine_verlustprivilegierung_die_gutschrift_ohne_wirkungsgrad():
    # Pauschaloption: keine Privilegierung von Speicherverlusten (A2 S. 8 Fn.
    # 5) - anders als (19) der Abgrenzung (Gutschrift / Wirkungsgrad). Je aus
    # dem Netz geladener kWh: Kosten 170 + 20 Verschleiss = 190 EUR/MWh,
    # Ertrag 0,92 * (150 + Gutschrift - 20). Mit 90: 202,4 -> lohnt; mit 74:
    # 187,7 -> lohnt nicht - mit Gutschrift / 0,92 waeren es 193,6 und der
    # Speicher luede.
    verschleiss = make_input(SPOT).battery.wear_cost_eur_per_kwh_each_way * 1000.0
    assert verschleiss == pytest.approx(20.0)
    for gutschrift, lohnt in ((90.0, True), (74.0, False)):
        inp = _pauschal(_stand(p14=5000.0, p7=5000.0, p9=1500.0), praemie=0.0, saldiert=gutschrift)
        model = _geloest(inp)
        assert (_kwh(model, model.charge) > 1.0) is lohnt, gutschrift


@needs_highs
def test_zeitgrenze_plant_ohne_saldierung_im_zeitraum_der_die_schwelle_erst_erreicht(monkeypatch, caplog):
    from voltpilot_optimization import solver

    monkeypatch.setattr(solver, "MISCHBETRIEB_ZEITGRENZE_S", 1e-4)
    inp = _pauschal(_stand(p14=5000.0, p7=P4 - 3.0, p9=1500.0), praemie=0.0)
    model = build_model(inp)
    with caplog.at_level(logging.WARNING):
        solver._solve_plan(model, inp)
    assert "jahreszustand.saldierung_zeitgrenze" in caplog.text
    assert model.saldierung_jahr_aktiv[0].fixed
    assert _zuwachs_p10(model, inp) == pytest.approx(0.0, abs=1e-6)
    plan = optimize(inp, plan_id=UUID(int=11), generated_at=T0)
    assert len(plan.slots) == inp.slots


# --- Bestandsschutz ---------------------------------------------------------


def _komponenten(model) -> set[str]:
    return {c.local_name for c in model.component_objects((Constraint, Var))}


def test_ohne_jahresstand_kommt_nichts_ins_modell():
    inp = make_input(SPOT, load=3.0, pv=2.0)
    inp = replace(inp, mispel_praemie_eur_mwh=[PRAEMIE] * N, saldierte_bestandteile_eur_mwh=150.0)
    assert not {n for n in _komponenten(build_model(inp)) if "pauschal" in n or "jahr" in n}


@needs_highs
def test_ohne_jahresstand_byte_gleicher_plan():
    inp = make_input(SPOT, load=3.0, pv=2.0)
    mit_feldern = replace(inp, mispel_praemie_eur_mwh=[PRAEMIE] * N, saldierte_bestandteile_eur_mwh=150.0)
    assert _payload(inp) == _payload(mit_feldern)


def test_jahresstand_nur_ohne_mischbetrieb_und_lueckenlos():
    inp = make_input(SPOT, load=0.0)
    with pytest.raises(ValueError, match="excludes mischbetrieb"):
        replace(inp, mischbetrieb=True, mispel_jahresstand=(_stand(),))
    juli = zeitraum(date(2026, 7, 1), date(2026, 7, 1))
    with pytest.raises(ValueError, match="exactly once"):
        replace(inp, mispel_jahresstand=(_stand(periode=juli),))
    with pytest.raises(ValueError, match="exactly once"):
        replace(inp, mispel_jahresstand=(_stand(), _stand()))
    with pytest.raises(ValueError, match=r"\(P4\) >= \(P1\)"):
        MispelJahresstand(von=JAHR[0], bis=JAHR[1], p1_kwh=10.0, p4_kwh=5.0)
    with pytest.raises(ValueError, match="finite and >= 0"):
        _stand(p9=-1.0)


# --- Jahresstand und Jahresrest ----------------------------------------------


def _bisher(von=date(2026, 1, 1), bis=date(2026, 12, 31), viertelstunden=182 * 96,
            p14="2000", p7="2100", p9="800", rumpfjahr=False):
    w = {"(P14)": Fraction(p14), "(P7)": Fraction(p7), "(P9)": Fraction(p9)}
    if rumpfjahr:
        r = mispel_pauschal.jahr("P1", w, STAMM, mispel_pauschal.Rumpfjahr(von, bis, STAMM))
        w.update({"(P1)R": r["(P1)R"], "(P4)R": r["(P4)R"]})
    else:
        w.update({"(P1)": Fraction(P1), "(P4)": Fraction(P4)})
    return Bisher(von=von, bis=bis, rumpfjahr=rumpfjahr, formelsatz="P1", basisfall="P1",
                  stammdaten=STAMM, jahreswerte=w, viertelstunden=viertelstunden)


def test_jahresrest_mit_dem_bisherigen_tempo():
    # 182 Tage gerechnet (01.01.-01.07.), Horizont 24 h ab 02.07. 00:00 Berlin;
    # das Jahr 2026 hat 8 760 Stunden (Sommerzeit hin und zurueck).
    slots = [T0 + timedelta(minutes=15 * i) for i in range(N)]
    (stand,) = jahresstaende(_bisher(), slots, 0.25)
    assert (stand.von, stand.bis) == JAHR
    assert (stand.p1_kwh, stand.p4_kwh) == (P1, P4)
    unbekannt = 8760 - 182 * 24 - 24
    assert stand.p14_kwh == pytest.approx(2000 + 2000 / (182 * 24) * unbekannt)
    assert stand.p7_kwh == pytest.approx(2100 + 2100 / (182 * 24) * unbekannt)
    assert stand.p9_kwh == pytest.approx(800 + 800 / (182 * 24) * unbekannt)


def test_unter_einem_tag_kein_tempo_kein_rest():
    slots = [T0 + timedelta(minutes=15 * i) for i in range(N)]
    (stand,) = jahresstaende(_bisher(viertelstunden=MINDEST_VIERTELSTUNDEN - 1), slots, 0.25)
    assert (stand.p14_kwh, stand.p7_kwh, stand.p9_kwh) == (2000.0, 2100.0, 800.0)


def test_horizont_ueber_den_jahreswechsel_bekommt_zwei_zeitraeume():
    # 31.12.2026 20:00 Berlin + 8 h: kein Uebertrag zwischen Jahren (A2 S. 28;
    # T S. 63) - 2027 beginnt mit dem Tempo, ohne bisherige Menge.
    start = datetime(2026, 12, 31, 19, 0, tzinfo=timezone.utc)
    slots = [start + timedelta(minutes=15 * i) for i in range(32)]
    bisher = _bisher(viertelstunden=364 * 96)
    alt, neu = jahresstaende(bisher, slots, 0.25)
    assert (alt.von, alt.bis) == JAHR
    assert (neu.von, neu.bis) == zeitraum(date(2027, 1, 1), date(2027, 12, 31))
    assert (neu.p1_kwh, neu.p4_kwh) == (P1, P4)
    tempo = 2000 / (364 * 24)
    assert alt.p14_kwh == pytest.approx(2000 + tempo * (8760 - 364 * 24 - 4))
    assert neu.p14_kwh == pytest.approx(tempo * (8760 - 4))


def test_rumpfjahr_ist_der_zeitraum_und_der_rest_des_jahres_ein_eigenes():
    # Jahreslauf im Rumpfjahr 01.01.-02.07.2026 (der Aenderungstag zaehlt zum
    # Rumpfjahr davor, A2 S. 53); der 03.07. liegt im naechsten Rumpfjahr
    # 03.07.-31.12. - dessen (P1)R/(P4)R rechnet das Rechenwerk mit den
    # Stammdaten des Laufs (A2 S. 54-55: (P1) nur ueber die Sommertage).
    bisher = _bisher(bis=date(2026, 7, 2), viertelstunden=182 * 96, rumpfjahr=True)
    slots = [T0 + timedelta(minutes=15 * i) for i in range(2 * N)]
    eigen, rest = jahresstaende(bisher, slots, 0.25)
    assert (eigen.von, eigen.bis) == zeitraum(date(2026, 1, 1), date(2026, 7, 2))
    assert eigen.p1_kwh == pytest.approx(float(bisher.jahreswerte["(P1)R"]))
    assert eigen.p4_kwh == pytest.approx(float(bisher.jahreswerte["(P4)R"]))
    assert (rest.von, rest.bis) == zeitraum(date(2026, 7, 3), date(2026, 12, 31))
    w = mispel_pauschal.jahr("P1", _LEER, STAMM,
                             mispel_pauschal.Rumpfjahr(date(2026, 7, 3), date(2026, 12, 31), STAMM))
    assert w["(P19)R"] == 90  # 29 + 31 + 30 Sommertage
    assert (rest.p1_kwh, rest.p4_kwh) == (float(w["(P1)R"]), float(w["(P4)R"]))
    assert grenzen(bisher, date(2026, 7, 3), date(2026, 12, 31)) == (w["(P1)R"], w["(P4)R"])


# --- Eingang je Lauf: der juengste Jahreslauf (MP-25) ueber fake-psycopg ------

#: Ein Nachweis wie ihn MP-25 schreibt (Vertrag mispel-pauschal.md): exakte
#: Zahlen als Text, Jahreswerte unter dem Schluessel des Laufs.
NACHWEIS = {
    "schluessel": "2026",
    "formelsatz": "P1",
    "basisfall": "P1",
    "stammdaten": {"Pinst": "8", "SKinst": "10"},
    "jahreswerte": {"2026": {"(P1)": "4000", "(P2)P1": "0.08", "(P3)": "320", "(P4)": "4320",
                             "(P7)": "2100", "(P8)": "0", "(P9)": "800", "(P10)": "0",
                             "(P11)": "800", "(P14)": "2000", "(P15)": "2000"}},
}


def _lauf_cursor(lauf, log):
    class _Cursor(test_freshness._FakeCursor):
        def execute(self, sql, params=()):
            flat = " ".join(sql.split())
            if "FROM mispel_pauschal_jahr" in flat:
                log.append(params)
                self._rows = [lauf] if lauf is not None else []
                return
            if any(f"FROM {t}" in flat for t in ("site_foerderweg", "annual_market_value", "eeg_aw_zeit",
                                                  "mispel_abgrenzung_monat")):
                self._rows = []  # MP-12: kein Jahresmarktwert, keine Praemie; MP-11: kein Monatslauf
                return
            super().execute(sql, params)

    return _Cursor


@pytest.fixture()
def jahreslauf(monkeypatch):
    stand = {"lauf": None, "log": []}

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _lauf_cursor(stand["lauf"], stand["log"])({})

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    for name in ("VOLTPILOT_ACTIVE_LOAD_MODEL", "VOLTPILOT_ACTIVE_PV_MODEL",
                 "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES", "OPTIMIZER_SOC_MAX_AGE_MINUTES",
                 "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH"):
        monkeypatch.delenv(name, raising=False)
    return stand


def _pauschal_site():
    return replace(test_freshness._site(), foerderweg_fassung="marktpraemie_pauschal", formelsatz=None)


def _lauf(formelsatz="P1", nachweis=NACHWEIS, gerechnet=181 * 96 + 56):
    return (date(2026, 1, 1), date(2026, 12, 31), formelsatz, gerechnet, json.dumps(nachweis))


def test_jeder_lauf_bekommt_den_jahresstand_des_jahreslaufs(jahreslauf):
    jahreslauf["lauf"] = _lauf()
    inp = gather_inputs("postgresql://fake", _pauschal_site(), test_freshness.NOW, test_freshness.SLOTS)
    assert not inp.mischbetrieb
    assert inp.export_value_eur_mwh == inp.prices_eur_mwh  # blanker Spot
    (stand,) = inp.mispel_jahresstand
    assert (stand.von, stand.bis) == JAHR
    assert (stand.p1_kwh, stand.p4_kwh) == (P1, P4)
    # Rest: 8 760 h - 4 358 h gerechnet - 4 h im Horizont, Tempo (P14) 2 000 / 4 358 h.
    gerechnet_h = (181 * 96 + 56) / 4
    assert stand.p14_kwh == pytest.approx(2000 + 2000 / gerechnet_h * (8760 - gerechnet_h - 4))
    (params,) = jahreslauf["log"]
    assert params["jahr"] == 2026
    assert params["jetzt"] == test_freshness.NOW


def test_ohne_jahreslauf_plant_die_pauschal_anlage_wie_vorher(jahreslauf):
    inp = gather_inputs("postgresql://fake", _pauschal_site(), test_freshness.NOW, test_freshness.SLOTS)
    assert inp.mispel_jahresstand is None
    vorher = gather_inputs("postgresql://fake", test_freshness._site(), test_freshness.NOW, test_freshness.SLOTS)
    # MiSpeL MP-14: nur der Foerderweg, den der Plan zur Box traegt, ist ein anderer.
    assert inp.foerderweg == "marktpraemie_pauschal"
    assert replace(inp, foerderweg=vorher.foerderweg) == vorher


def test_anlage_ohne_pauschaloption_liest_keinen_jahreslauf(jahreslauf):
    jahreslauf["lauf"] = _lauf()
    for site in (test_freshness._site(),
                 replace(test_freshness._site(), foerderweg_fassung="marktpraemie_abgrenzung", formelsatz="A1")):
        inp = gather_inputs("postgresql://fake", site, test_freshness.NOW, test_freshness.SLOTS)
        assert inp.mispel_jahresstand is None
    assert jahreslauf["log"] == []


@pytest.mark.parametrize("formelsatz", ["P4", "P4-Variante", "P5"])
def test_sonderfaelle_haben_noch_keinen_jahresstand(jahreslauf, formelsatz):
    # P4/P4-Variante teilen die Foerderung auf zwei anzulegende Werte auf (A2 S.
    # 36-41), P5 misst die Einspeisung an ZW (A2 S. 45-46): offen.
    jahreslauf["lauf"] = _lauf(formelsatz=formelsatz)
    assert load_mispel_pauschal_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None


def test_ohne_jahreswert_kein_jahresstand(jahreslauf):
    kaputt = json.loads(json.dumps(NACHWEIS))
    kaputt["jahreswerte"]["2026"]["(P9)"] = None
    jahreslauf["lauf"] = _lauf(nachweis=kaputt)
    assert load_mispel_pauschal_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None
    ohne_stamm = json.loads(json.dumps(NACHWEIS))
    del ohne_stamm["stammdaten"]["SKinst"]
    jahreslauf["lauf"] = _lauf(nachweis=ohne_stamm)
    assert load_mispel_pauschal_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None


def test_rumpfjahr_aus_dem_nachweis(jahreslauf):
    rumpf = json.loads(json.dumps(NACHWEIS))
    rumpf["schluessel"] = "2026-01-01/2026-07-02"
    werte = rumpf["jahreswerte"].pop("2026")
    w = mispel_pauschal.jahr("P1", _LEER, STAMM,
                             mispel_pauschal.Rumpfjahr(date(2026, 1, 1), date(2026, 7, 2), STAMM))
    werte.update({"(P1)R": f"{w['(P1)R'].numerator}/{w['(P1)R'].denominator}",
                  "(P4)R": f"{w['(P4)R'].numerator}/{w['(P4)R'].denominator}"})
    rumpf["jahreswerte"]["2026-01-01/2026-07-02"] = werte
    jahreslauf["lauf"] = (date(2026, 1, 1), date(2026, 7, 2), "P1", 181 * 96, json.dumps(rumpf))
    bisher = load_mispel_pauschal_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW)
    assert bisher.rumpfjahr
    assert (bisher.jahreswerte["(P1)R"], bisher.jahreswerte["(P4)R"]) == (w["(P1)R"], w["(P4)R"])


def test_ohne_tabelle_kein_jahresstand(monkeypatch):
    class _Undefined(Exception):
        pass

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=()):
            raise _Undefined("relation mispel_pauschal_jahr does not exist")

    class _Conn(_Cur):
        def cursor(self):
            return _Cur()

    errors = SimpleNamespace(UndefinedTable=_Undefined, UndefinedColumn=_Undefined)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn(), errors=errors))
    assert load_mispel_pauschal_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None

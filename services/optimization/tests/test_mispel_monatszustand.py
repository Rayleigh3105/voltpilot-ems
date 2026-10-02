"""MiSpeL MP-11: Optimierer Mischbetrieb II - der Monatszustand.

Festlegung zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az.
618-25-02, Beschluss 01.10.2026), Anlage 1 (Abgrenzungsoption); Zitierweise
„A1 S. 36“ = Anlage 1, Seite 36, „T S. 38“ = Tenor mit Begruendung, Seite 38.
Bauplan § 8 Zeile MP-11.

Pruefnachweis laut Bauplan: „mittags ins Netz entladen, mit PV nachfuellen“
bringt keinen Vorteil (T S. 38-39) - mit Gegenprobe: ohne den Abzug der
EE-Speichererzeugung in (16) lohnt genau dieser Kreislauf. Dazu: (16) je
Saldierungsperiode ist exakt das MAX der Festlegung, der Monatszustand dreht
die Entscheidung (Schattenpreis), Saldo und Monatsrest aus den ∑M-Summen.
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from types import SimpleNamespace
from uuid import UUID

import pytest
from pyomo.environ import Constraint, value

from voltpilot_optimization import mispel_abgrenzung
from voltpilot_optimization.domain import VIERTELSTUNDE_H, MispelMonatsstand
from voltpilot_optimization.inputs import gather_inputs, load_mispel_bisher
from voltpilot_optimization.mispel_monatsstand import (
    MINDEST_VIERTELSTUNDEN,
    Bisher,
    kalendermonat,
    monatsstaende,
    saldo,
)
from voltpilot_optimization.solver import _solve, build_model, optimize

import test_freshness
from test_mispel_mischbetrieb import ABEND, NACHT, _kwh, _misch, _netzladen_kwh
from test_solver import T0, needs_highs

UTC = timezone.utc
#: T0 = 02.07.2026 00:00 Berlin; der Kalendermonat Juli in UTC.
JULI = kalendermonat(T0)


def _stand(bisher_kwh, rest_kwh=0.0, periode=JULI):
    return MispelMonatsstand(von=periode[0], bis=periode[1], bisher_kwh=bisher_kwh, rest_kwh=rest_kwh)


def _mit_stand(inp, *staende):
    return replace(inp, mispel_monatsstand=tuple(staende))


def _slots(inp, stand):
    return [t for t in range(inp.slots) if stand.enthaelt(inp.slot_starts[t])]


def _pruefe_saldierung(model, inp):
    """(16) je Periode im Modell = MAX [ D + (13) - (15) ; 0 ] (A1 S. 36) aus
    den geloesten Mengen - exakt, nicht nur als Schranke. Gibt (16) je Periode."""
    eta = inp.battery.roundtrip_efficiency
    dt = inp.slot_hours
    out = []
    perioden = [s for s in inp.mispel_monatsstand if _slots(inp, s)]
    for k, stand in enumerate(perioden):
        ts = _slots(inp, stand)
        e = sum(value(model.speicher_einspeisung[t]) for t in ts) * dt
        g = eta * sum(value(model.charge[t]) - value(model.netz_laden[t]) for t in ts) * dt
        erwartet = max(stand.saldo_kwh + e - g, 0.0)
        im_modell = (
            max(stand.saldo_kwh, 0.0)
            + sum(value(model.rot_einspeisung[t]) for t in ts) * dt
            - value(model.mispel_entrot[k])
        )
        assert im_modell == pytest.approx(erwartet, abs=1e-4), k
        out.append(im_modell)
    return out


# --- Saldo aus den ∑M-Summen (A1 S. 34-36) ---------------------------------


#: Der Beispiel-Monat aus dem Konzept: 1 000 kWh PV und 500 kWh Netzstrom
#: geladen, 1 350 kWh abgegeben (Wirkungsgrad 0,9), davon 1 200 kWh ins Netz.
BEISPIEL = {"(3)": 600, "(4)": 3000, "(5)": 1500, "(6)": 1350, "(9)": 500, "(11)": 1200, "(26)": 0, "(29)": 1200}


def test_saldo_ist_13_minus_15_wie_das_rechenwerk():
    # (10) = 1 000, (13) = 1 200, (15) = 0,9 * 1 000 = 900 -> 300 = (16).
    assert saldo(BEISPIEL, 0.9) == pytest.approx(300.0)
    monat = mispel_abgrenzung.monat("A1", {k: Fraction(v) for k, v in BEISPIEL.items()})
    assert monat["(14)A1"] == Fraction(9, 10)
    assert saldo(BEISPIEL, float(monat["(14)A1"])) == pytest.approx(float(monat["(16)"]))


def test_saldo_behaelt_den_vorsprung_der_ee_speichererzeugung():
    # Viel PV im Speicher, wenig Einspeisung: (16) = 0, der Saldo bleibt
    # negativ - der Vorsprung traegt in den Rest der Periode (T S. 39).
    werte = {"(5)": 1000, "(6)": 900, "(9)": 0, "(11)": 200}
    assert saldo(werte, 0.9) == pytest.approx(200.0 - 900.0)


def test_saldo_zieht_den_fremdtankstrom_ab():
    # (12) = MAX [ (6) - (5) ; 0 ] = 50 mindert (13) (A1 S. 35).
    werte = {"(5)": 100, "(6)": 150, "(9)": 100, "(11)": 150}
    assert saldo(werte, 0.9) == pytest.approx(100.0)


def test_saldo_unbekannt_ist_keine_null():
    with pytest.raises(ValueError, match="unbekannt"):
        saldo({"(5)": 1, "(6)": 1, "(9)": 0, "(11)": None}, 0.9)
    with pytest.raises(ValueError, match="nie negativ"):
        saldo({"(5)": 1, "(6)": 1, "(9)": 0, "(11)": "-1"}, 0.9)


def test_saldo_liest_brueche_aus_dem_nachweis():
    # Der Nachweis schreibt exakt: Dezimal oder z/n (Vertrag MP-8).
    assert saldo({"(5)": "10/3", "(6)": "3", "(9)": "1/3", "(11)": "2.5"}, 0.9) == pytest.approx(
        2.5 - 0.9 * 3.0
    )


# --- Perioden und Monatsrest ------------------------------------------------


def _bisher(tage, saldo_kwh_je_tag=10.0, von=JULI[0], bis=JULI[1]):
    # Saldo = (11) - 0,9 * (5) bei (9) = 0, (6) = 0,9 * (5).
    return Bisher(
        von=von,
        bis=bis,
        monatswerte={"(5)": 0, "(6)": 0, "(9)": 0, "(11)": saldo_kwh_je_tag * tage},
        viertelstunden=tage * 96,
    )


def _horizont(start, n=96):
    return [start + timedelta(minutes=15 * i) for i in range(n)]


def test_monatsrest_mit_dem_bisherigen_tempo():
    # Bisher 15 Tage mit +10 kWh/Tag, Horizont ein Tag: unbekannt sind
    # 31 - 15 - 1 = 15 Tage -> Rest 150 kWh.
    start = JULI[0] + timedelta(days=15)
    (stand,) = monatsstaende(_bisher(15), _horizont(start), 0.25, 0.9)
    assert (stand.von, stand.bis) == JULI
    assert stand.bisher_kwh == pytest.approx(150.0)
    assert stand.rest_kwh == pytest.approx(150.0)
    assert stand.saldo_kwh == pytest.approx(300.0)


def test_unter_einem_tag_kein_tempo_kein_rest():
    b = Bisher(von=JULI[0], bis=JULI[1], monatswerte={"(5)": 0, "(6)": 0, "(9)": 0, "(11)": 40},
               viertelstunden=MINDEST_VIERTELSTUNDEN - 1)
    (stand,) = monatsstaende(b, _horizont(JULI[0] + timedelta(hours=24)), 0.25, 0.9)
    assert stand.bisher_kwh == pytest.approx(40.0)
    assert stand.rest_kwh == 0.0


def test_horizont_ueber_das_monatsende_bekommt_zwei_perioden():
    # 31.07. 12:00 Berlin + 24 h: Juli (bisher + Rest 0) und August (nur Rest).
    start = JULI[1] - timedelta(hours=12)
    juli, august = monatsstaende(_bisher(30), _horizont(start), 0.25, 0.9)
    # Juli: 744 h - 720 h gerechnet - 12 h im Horizont = 12 h Rest.
    assert (juli.von, juli.bis) == JULI
    assert juli.rest_kwh == pytest.approx(10.0 * 0.5)
    assert august.von == JULI[1] and august.bisher_kwh == 0.0
    # August: 31 Tage minus 12 h im Horizont, Tempo 10 kWh/Tag.
    assert august.rest_kwh == pytest.approx(10.0 * (31 - 0.5))


def test_rumpfmonat_ist_die_periode():
    # Ein Rumpfmonat ab dem 15.07. tritt an die Stelle des Kalendermonats
    # (A1 S. 102): seine Laenge, nicht die des Juli, zaehlt.
    von = JULI[0] + timedelta(days=14)
    (stand,) = monatsstaende(_bisher(2, von=von), _horizont(von + timedelta(days=2)), 0.25, 0.9)
    assert (stand.von, stand.bis) == (von, JULI[1])
    assert stand.rest_kwh == pytest.approx(10.0 * (17 - 2 - 1))


def test_kalendermonat_in_gesetzlicher_zeit():
    # Oktober 2026 hat 745 Stunden (Ende der Sommerzeit am 25.10.).
    von, bis = kalendermonat(datetime(2026, 10, 15, tzinfo=UTC))
    assert von == datetime(2026, 9, 30, 22, tzinfo=UTC)
    assert (bis - von).total_seconds() / 3600 == 745


def test_monatsstand_nur_im_mischbetrieb_und_lueckenlos():
    inp = _misch()
    with pytest.raises(ValueError, match="mischbetrieb"):
        replace(inp, mischbetrieb=False, mispel_monatsstand=(_stand(0.0),))
    halb = (T0, T0 + timedelta(hours=12))
    with pytest.raises(ValueError, match="exactly once"):
        _mit_stand(inp, _stand(0.0, periode=halb))


# --- Schattenpreis der gesicherten Zuordnung (16) ---------------------------

#: Nacht billig, Mittag PV-Ueberschuss, Abend teuer mit Last - der Speicher
#: deckt abends den Verbrauch (keine Einspeisung). Je kWh, die er abends
#: liefert: aus dem Netz geladen -170 + 276 = 106 EUR/MWh, aus PV geladen
#: -(40 + 10) + 276 = 226 - im roten Monat minus 140 Gutschrift, weil die
#: EE-Speichererzeugung (16) mindert (gelb zuerst, T S. 39): 86.
PV = [0.0] * 40 + [6.0] * 16 + [0.0] * 40
TAG_SPOT = [NACHT] * 40 + [40.0] * 16 + [ABEND] * 40
TAG_LAST = [1.0] * 56 + [2.0] * 40
MITTAG = range(40, 56)


def _tag(**felder):
    return _misch(spot=TAG_SPOT, pv=PV, load=TAG_LAST, praemie=10.0, saldiert=140.0, **felder)


#: Die HTW-Szene: Mittag mit PV-Ueberschuss und sehr niedrigem, leicht
#: steigendem Spot; abends Einspeisung zum hohen Preis.
HTW_SPOT = [NACHT] * 40 + [5.0 + 0.2 * i for i in range(16)] + [ABEND] * 40


def _htw(**felder):
    return _misch(spot=HTW_SPOT, pv=PV, load=1.0, praemie=10.0, saldiert=140.0, soc0_kwh=9.0, **felder)


@needs_highs
@pytest.mark.parametrize("d_kwh", [500.0, 3.0, -3.0, -500.0], ids=["rot", "knapp-rot", "knapp-gelb", "gelb"])
def test_saldierung_je_periode_ist_exakt_das_max(d_kwh):
    inp = _mit_stand(_tag(), _stand(d_kwh))
    model = build_model(inp)
    _solve(model)
    _pruefe_saldierung(model, inp)
    # Nur wenn der Lauf das Vorzeichen drehen kann, braucht das MAX eine Ganzzahl.
    assert hasattr(model, "saldierung_monat_aktiv") == (abs(d_kwh) < 100.0)


@needs_highs
def test_im_roten_monat_kostet_pv_im_speicher_die_gutschrift():
    # Rot: jede PV-geladene kWh mindert (16) um (14) - der Speicher laedt
    # nachts aus dem Netz (saldiert) und laesst die PV direkt einspeisen.
    # Gelb: eine weitere rote kWh ist nichts wert - Netzladen lohnt nicht,
    # der Speicher nimmt die PV.
    rot_inp = _mit_stand(_tag(), _stand(500.0))
    rot = build_model(rot_inp)
    _solve(rot)
    gelb = build_model(_mit_stand(_tag(), _stand(-500.0)))
    _solve(gelb)
    pv_rot = _kwh(rot, rot.charge) - _netzladen_kwh(rot)
    pv_gelb = _kwh(gelb, gelb.charge) - _netzladen_kwh(gelb)
    assert _netzladen_kwh(rot) > 4.0
    assert _netzladen_kwh(gelb) == pytest.approx(0.0, abs=1e-6)
    assert pv_gelb > 4.0
    assert pv_rot < pv_gelb - 4.0
    _pruefe_saldierung(rot, rot_inp)


@needs_highs
def test_ohne_monatsstand_plant_der_lauf_wie_mp10():
    # Der Start-Ladestand zaehlt in MP-10 als EE-Speichererzeugung; mit
    # Monatsstand steckt er in den bisherigen Mengen.
    model = build_model(_htw())
    assert hasattr(model, "mischbetrieb_saldierung")
    assert not hasattr(model, "mischbetrieb_monat_saldierung")


@needs_highs
def test_zwei_perioden_im_horizont_rechnen_getrennt():
    # 31.07. 12:00 Berlin: der Juli ist rot, der August gelb - die rote
    # Einspeisung im August wird nicht saldiert, die im Juli schon.
    start = JULI[1] - timedelta(hours=12)
    inp = replace(_tag(), slot_starts=_horizont(start))
    august = kalendermonat(JULI[1])
    inp = _mit_stand(inp, _stand(500.0), _stand(0.0, -500.0, periode=august))
    model = build_model(inp)
    _solve(model)
    juli_16, august_16 = _pruefe_saldierung(model, inp)
    assert august_16 == pytest.approx(0.0, abs=1e-6)
    assert juli_16 >= 500.0 - 1e-6


@needs_highs
def test_zeitgrenze_mit_monatsstand_plant_ohne_gutschrift(monkeypatch):
    # Der Rueckfall aus MP-10 (Ganzzahl = 0) waere bei einem roten Monat
    # unzulaessig; mit Monatsstand faellt stattdessen die Gutschrift weg.
    from voltpilot_optimization import solver

    monkeypatch.setattr(solver, "MISCHBETRIEB_ZEITGRENZE_S", 1e-4)
    inp = _mit_stand(_tag(), _stand(3.0))
    model = build_model(inp)
    solver._solve_plan(model, inp)
    assert value(model.mispel_gutschrift) == 0.0
    assert not model.mischbetrieb_monat_max.active
    # Ohne Gutschrift haelt die Minimierung (16) von selbst am MAX.
    _pruefe_saldierung(model, inp)
    plan = optimize(inp, plan_id=UUID(int=11), generated_at=T0)
    assert len(plan.slots) == inp.slots


# --- Pruefnachweis: der HTW-Fehlanreiz (T S. 38-39) ---------------------------
#
# „Mein Optimierungsalgorithmus entscheidet sich auffallend haeufig dafuer, den
# Speicher mittags bei sehr niedrigen Boersenstrompreisen ins Netz zu entladen,
# nur um ihn in der Folgestunde wieder mit Strom aus der Photovoltaikanlage zu
# fuellen. Dieses Verhalten tritt auch bei gleichbleibenden oder leicht
# steigenden Boersenstrompreisen auf“ (T S. 38-39). Die Szene: Mittag mit
# PV-Ueberschuss und leicht steigendem Spot, ein voller Speicher, Gutschrift
# weit ueber der Praemie (T S. 38: die Saldierungsvorteile „uebersteigen die
# wirtschaftlichen Vorteile der EEG-Foerderzahlung per Marktpraemie in aller
# Regel um ein Vielfaches“).


def _kosten_mit_und_ohne_kreislauf(inp, ohne_abzug=False):
    """Zielwert des freien Plans und des Plans, der mittags NICHT aus dem
    Speicher ins Netz speist. ``ohne_abzug`` = die Gegenprobe: (16) ohne
    den Abzug der EE-Speichererzeugung (15) - jede Speicher-Einspeisung
    waere saldierungsfaehig (die „Rotfaerbung von EE-Strom“, T S. 38)."""
    kosten = []
    for verbot in (False, True):
        model = build_model(inp)
        if ohne_abzug:
            model.mischbetrieb_monat_saldierung.deactivate()
            model.mischbetrieb_monat_max.deactivate()
        if verbot:
            model.htw_verbot = Constraint(
                expr=sum(model.speicher_einspeisung[t] for t in MITTAG) <= 0.0
            )
        _solve(model)
        if not verbot:
            frei = model
        kosten.append(value(model.total_cost))
    mittags_ins_netz = sum(value(frei.speicher_einspeisung[t]) for t in MITTAG) * VIERTELSTUNDE_H
    return kosten[0], kosten[1], mittags_ins_netz


@needs_highs
@pytest.mark.parametrize("d_kwh", [500.0, 3.0, 0.0, -500.0], ids=["rot", "knapp-rot", "null", "gelb"])
def test_mittags_entladen_und_mit_pv_nachfuellen_bringt_keinen_vorteil(d_kwh):
    inp = _mit_stand(_htw(), _stand(d_kwh))
    frei, ohne_kreislauf, mittags = _kosten_mit_und_ohne_kreislauf(inp)
    assert frei == pytest.approx(ohne_kreislauf, abs=1e-6)
    assert mittags == pytest.approx(0.0, abs=1e-6)


@needs_highs
def test_gegenprobe_ohne_abzug_der_ee_speichererzeugung_lohnt_der_kreislauf():
    # Dieselbe Szene ohne (15) in (16): der Optimierer entlaedt mittags ins
    # Netz und fuellt mit PV nach - genau der Fehlanreiz, den die Festlegung
    # mit Formel (16) schliesst (T S. 39). Der Test oben erkennt ihn also.
    inp = _mit_stand(_htw(), _stand(500.0))
    frei, ohne_kreislauf, mittags = _kosten_mit_und_ohne_kreislauf(inp, ohne_abzug=True)
    # Gemessen: rund 0,49 EUR Vorteil an diesem Tag - mit (16) exakt 0.
    assert mittags > 5.0
    assert ohne_kreislauf - frei > 0.25


def test_im_rechenwerk_aendert_der_kreislauf_die_saldierung_nicht():
    # Der Beispiel-Monat plus X = 90 kWh mittags ins Netz entladen und mit
    # X / (14) PV nachgefuellt: (13) und (15) wachsen um X, (16) und (20)
    # bleiben (A1 S. 36-37). Ohne den Abzug (15) waere (16) um X gewachsen.
    x = Fraction(90)
    vorher = mispel_abgrenzung.monat("A1", {k: Fraction(v) for k, v in BEISPIEL.items()})
    mit = dict(BEISPIEL)
    mit["(5)"] += x / Fraction(9, 10)
    mit["(6)"] += x
    mit["(11)"] += x
    mit["(4)"] += x
    nachher = mispel_abgrenzung.monat("A1", {k: Fraction(v) for k, v in mit.items()})
    assert nachher["(16)"] == vorher["(16)"]
    assert nachher["(20)"] == vorher["(20)"]
    assert nachher["(13)"] - vorher["(13)"] == x


# --- Eingang je Lauf: der juengste Monatslauf (MP-8) ueber fake-psycopg -------

#: Ein Nachweis wie ihn MP-8 schreibt (Vertrag mispel-abgrenzung.md): exakte
#: Zahlen als Text, Monatswerte unter dem Schluessel des Laufs.
NACHWEIS = {
    "schluessel": "2026-07",
    "viertelstunden": {"erwartet": 2976, "gerechnet": 96, "luecken": 2880},
    "monatswerte": {"2026-07": {"(3)": "50", "(4)": "120", "(5)": "100", "(6)": "92",
                                "(9)": "40", "(11)": "80", "(16)": "24.8"}},
}


def _lauf_cursor(lauf, log):
    class _Cursor(test_freshness._FakeCursor):
        def execute(self, sql, params=()):
            flat = " ".join(sql.split())
            if "FROM mispel_abgrenzung_monat" in flat:
                log.append(params)
                self._rows = [lauf] if lauf is not None else []
                return
            if any(f"FROM {t}" in flat for t in ("site_foerderweg", "annual_market_value", "eeg_aw_zeit")):
                self._rows = []  # MP-12: kein Jahresmarktwert, keine Praemie
                return
            super().execute(sql, params)

    return _Cursor


@pytest.fixture()
def monatslauf(monkeypatch):
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


def _misch_site():
    return replace(test_freshness._site(), foerderweg_fassung="marktpraemie_abgrenzung", formelsatz="A1")


def _lauf(formelsatz="A1", nachweis=NACHWEIS):
    return (JULI[0], JULI[1], formelsatz, json.dumps(nachweis))


def test_jeder_lauf_bekommt_den_monatsstand_des_monatslaufs(monatslauf):
    monatslauf["lauf"] = _lauf()
    inp = gather_inputs("postgresql://fake", _misch_site(), test_freshness.NOW, test_freshness.SLOTS)
    assert inp.mischbetrieb
    (stand,) = inp.mispel_monatsstand
    assert (stand.von, stand.bis) == JULI
    # (13) = 80, (15) = 0,92 * (100 - 40) = 55,2 -> bisher 24,8 kWh;
    # Rest: 744 h - 24 h gerechnet - 4 h im Horizont, Tempo 24,8 / 24 h.
    assert stand.bisher_kwh == pytest.approx(24.8)
    assert stand.rest_kwh == pytest.approx(24.8 / 24.0 * (744 - 24 - 4))
    (params,) = monatslauf["log"]
    assert params["monat"] == date(2026, 7, 1)
    assert params["jetzt"] == test_freshness.NOW


def test_ohne_monatslauf_plant_der_lauf_wie_mp10(monatslauf):
    inp = gather_inputs("postgresql://fake", _misch_site(), test_freshness.NOW, test_freshness.SLOTS)
    assert inp.mischbetrieb and inp.mispel_monatsstand is None


def test_anlage_ohne_mischbetrieb_liest_keinen_monatslauf(monatslauf):
    monatslauf["lauf"] = _lauf()
    inp = gather_inputs("postgresql://fake", test_freshness._site(), test_freshness.NOW, test_freshness.SLOTS)
    assert inp.mispel_monatsstand is None
    assert monatslauf["log"] == []


def test_ohne_saldierung_nach_16_oder_lesbare_summen_kein_monatsstand(monatslauf):
    # A10/A11 kennen (5), (6) nicht (A1 S. 96, S. 100); eine fehlende Summe
    # ist keine Null.
    monatslauf["lauf"] = _lauf(formelsatz="A10")
    assert load_mispel_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None
    kaputt = json.loads(json.dumps(NACHWEIS))
    kaputt["monatswerte"]["2026-07"]["(11)"] = None
    monatslauf["lauf"] = _lauf(nachweis=kaputt)
    assert load_mispel_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None


def test_ohne_tabelle_kein_monatsstand(monkeypatch):
    class _Undefined(Exception):
        pass

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=()):
            raise _Undefined("relation mispel_abgrenzung_monat does not exist")

    class _Conn(_Cur):
        def cursor(self):
            return _Cur()

    errors = SimpleNamespace(UndefinedTable=_Undefined, UndefinedColumn=_Undefined)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn(), errors=errors))
    assert load_mispel_bisher("postgresql://fake", test_freshness.SITE, test_freshness.NOW) is None

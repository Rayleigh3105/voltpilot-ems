"""NS-2 A: das Vorsprung-Budget (Herzogau/Pilsting, Captain-Entscheid
15.10.2026, Untersuchung vp-herzogau-nie-schlechter-k5 §7, Bauplan NS-P2).

Monat und letzte 7 Tage MIT BESTAND fallen nie tiefer als das Budget unter
den sturen Speicher; wo der fertige Plan es täte, fährt der Slot stur und
sagt warum. Bewiesen in drei Lagen:

- der Schalter je Anlage mit seinem Budget und der gelesene Stand (``inputs``);
- die reine Prüfung (:func:`voltpilot_optimization.vorsprung.pruefe`) an
  handgebauten Plänen: Bewertung, Mitternacht (7 Tage), Monatsanker,
  kein Budget bei fehlenden Daten;
- die Prüfung im echten gelösten Plan: greift / greift nicht, Erklärung,
  verträglich mit NS-5 B, Schalter aus = byte-identisch.
"""

from __future__ import annotations

import importlib.util
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization.config import vorsprung_budget_eur
from voltpilot_optimization.domain import (
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    OptimizationInput,
    PlanSlot,
    SchedulePlan,
    VorsprungStand,
    horizon_slot_starts,
)
from voltpilot_optimization.slot_trim import SLOT_FLAG_MORGEN_UEBERSCHUSS
from voltpilot_optimization.vorsprung import (
    HOECHSTALTER,
    SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT,
    mit_budget,
    wert_vorsprung_eur,
)
from test_morgen_ueberschuss import (  # noqa: E402
    BOX,
    HERZOGAU,
    T0,
    TENANT,
    _fake_psycopg,
    herzogau_tage,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

BERLIN = ZoneInfo("Europe/Berlin")
ENV = "OPTIMIZER_VORSPRUNG_BUDGET_ANLAGEN"
BEWERTUNG = 23.98  # ct/kWh: 25 ct x sqrt(0,92)


def _stand(start: datetime, **over) -> VorsprungStand:
    """Ein frischer Stand: Monat und 7 Tage genau auf der Messlatte."""
    base = dict(
        messung_bis=start,
        tag=start.astimezone(BERLIN).date(),
        bewertung_ct_kwh=BEWERTUNG,
        vorsprung_kwh=0.0,
        kapazitaet_kwh=60.0,
        monat_eur=0.0,
        sieben_tage_eur=0.0,
        tage_eur=(0.0,) * 6,
    )
    base.update(over)
    return VorsprungStand(**base)


# ---- der Schalter je Anlage ------------------------------------------------------


def test_der_schalter_ist_je_anlage_vorgabe_aus_und_traegt_das_budget():
    assert vorsprung_budget_eur(HERZOGAU, {}) is None
    assert vorsprung_budget_eur(HERZOGAU, {ENV: ""}) is None
    assert vorsprung_budget_eur(HERZOGAU, {ENV: f" {HERZOGAU} ,"}) == 0.0
    assert vorsprung_budget_eur(str(HERZOGAU), {ENV: f"{uuid4()},{HERZOGAU}=1.5"}) == 1.5
    assert vorsprung_budget_eur(uuid4(), {ENV: str(HERZOGAU)}) is None
    for kaputt in ("herzogau", f"{HERZOGAU}=viel", f"{HERZOGAU}=-1", f"{HERZOGAU}=nan",
                   f"{HERZOGAU},{HERZOGAU}=2"):
        with pytest.raises(ValueError):
            vorsprung_budget_eur(HERZOGAU, {ENV: kaputt})


def test_nur_eine_eingeschaltete_anlage_liest_den_stand(monkeypatch):
    """Aus = nichts gelesen, nichts übergeben. An = das Budget und der Stand,
    auch wenn er fehlt (dann gibt es kein Budget, nie keinen Plan)."""
    from voltpilot_optimization import inputs

    gelesen = []
    monkeypatch.setattr(inputs, "_vorsprung_stand", lambda dsn, site: gelesen.append(site) or "stand")
    assert inputs._vorsprung_eingabe("dsn", HERZOGAU, {}) == (None, None)
    assert gelesen == []
    assert inputs._vorsprung_eingabe("dsn", HERZOGAU, {ENV: f"{HERZOGAU}=2"}) == (2.0, "stand")
    assert gelesen == [HERZOGAU]


def test_der_stand_wird_aus_der_tabelle_der_api_gelesen(monkeypatch):
    from voltpilot_optimization.inputs import _vorsprung_stand

    seen: dict = {}
    _fake_psycopg(monkeypatch, seen)
    bis = datetime(2026, 10, 13, 10, 0, tzinfo=timezone.utc)
    seen["row"] = (bis, date(2026, 10, 13), 23.98, -4.5, 59.7, 12.34, None, [1.0, None, 2.5])
    stand = _vorsprung_stand("dsn", HERZOGAU)
    assert seen["params"] == (HERZOGAU,)
    assert "FROM steuerung_vorsprung WHERE site_id" in seen["sql"]
    assert stand == VorsprungStand(
        messung_bis=bis, tag=date(2026, 10, 13), bewertung_ct_kwh=23.98, vorsprung_kwh=-4.5,
        kapazitaet_kwh=59.7, monat_eur=12.34, sieben_tage_eur=None, tage_eur=(1.0, None, 2.5),
    )
    seen["row"] = None
    assert _vorsprung_stand("dsn", HERZOGAU) is None
    seen["row"] = RuntimeError("Tabelle fehlt")
    assert _vorsprung_stand("dsn", HERZOGAU) is None


# ---- die Bewertung des Bestands ----------------------------------------------------


def test_ein_rueckstand_kostet_die_bewertung_ein_vorsprung_bringt_den_mittag():
    b = BEWERTUNG / 100.0
    assert wert_vorsprung_eur(-10.0, b, 0.08) == pytest.approx(-2.398)
    assert wert_vorsprung_eur(10.0, b, 0.08) == pytest.approx(0.80)
    # nie mehr als die Bewertung, nie unter null (abregeln statt zu zahlen)
    assert wert_vorsprung_eur(10.0, b, 0.40) == pytest.approx(2.398)
    assert wert_vorsprung_eur(10.0, b, -0.05) == 0.0


# ---- die reine Prüfung an handgebauten Plänen ----------------------------------------

BATTERY = BatteryParams(capacity_kwh=60.0, max_charge_kw=30.0, max_discharge_kw=30.0)


def _nacht(start: datetime, n: int, **over) -> OptimizationInput:
    """Nachts: keine Sonne, 1 kW Haus, Einspeisung 10 ct, Bezug 25 ct, Speicher 50 kWh."""
    base = dict(
        tenant_id=TENANT, site_id=HERZOGAU, device_id=BOX, battery=BATTERY,
        slot_starts=horizon_slot_starts(start, n), prices_eur_mwh=[100.0] * n,
        load_kw=[1.0] * n, pv_kw=[0.0] * n, initial_soc_kwh=50.0, netzladen_erlaubt=False,
        import_price_eur_mwh=[250.0] * n, export_value_eur_mwh=[100.0] * n,
    )
    base.update(over)
    return OptimizationInput(**base)


def _verkauf(inp: OptimizationInput, kw: float = 8.0) -> SchedulePlan:
    """Ein Plan, der jeden Slot 8 kW entlädt - 1 kW deckt das Haus, 7 kW verkauft
    er zu 10 ct. Gegen den sturen Speicher (deckt nur das Haus) kostet das je Slot
    1,825 kWh Bestand zu 23,98 ct = 0,4376 EUR und bringt 0,175 EUR Kasse:
    der Vorsprung sinkt um 0,2626 EUR je Slot."""
    eta = BATTERY.one_way_efficiency
    soc = inp.initial_soc_kwh
    slots = []
    for t, start in enumerate(inp.slot_starts):
        soc -= kw * inp.slot_hours / eta
        grid = inp.load_kw[t] - inp.pv_kw[t] - kw
        slots.append(PlanSlot(
            start=start, battery_kw=-kw, grid_kw=grid, soc_kwh=soc, load_kw=inp.load_kw[t],
            pv_kw=inp.pv_kw[t], price_eur_mwh=inp.prices_eur_mwh[t],
            cost_eur=inp.cashflow_cost_eur(t, grid), baseline_cost_eur=inp.baseline_cost_eur(t),
            slot_role="verkaufen", slot_flags=(),
        ))
    return SchedulePlan(plan_id=uuid4(), tenant_id=TENANT, site_id=HERZOGAU, device_id=BOX,
                        generated_at=inp.slot_starts[0], battery=BATTERY, slots=slots)


def _stur_gestellt(plan) -> list[int]:
    return [i for i, s in enumerate(plan.slots) if SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT in (s.slot_flags or ())]


def test_regel_aus_ist_dasselbe_objekt():
    start = datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)
    inp = _nacht(start, 8, vorsprung=_stand(start))
    plan = _verkauf(inp)
    neu, bericht = mit_budget(plan, inp)
    assert neu is plan and bericht.ohne_budget == "aus"


def test_mit_vorsprung_verkauft_der_plan_bis_das_budget_aufgebraucht_ist():
    """Monat +1 EUR, Budget 0: drei Verkaufs-Slots (je -0,2626 EUR) passen,
    der vierte nicht mehr - ab dort fährt der Plan stur und der Vorsprung bleibt
    stehen. Der Slot sagt warum, deckt nur noch das Haus und folgt der Messung."""
    start = datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)  # 20:00 Berlin
    inp = _nacht(start, 8, vorsprung_budget_eur=0.0,
                 vorsprung=_stand(start, monat_eur=1.0, sieben_tage_eur=None))
    plan, bericht = mit_budget(_verkauf(inp), inp)
    assert bericht.ohne_budget is None
    assert _stur_gestellt(plan) == [3, 4, 5, 6, 7] == list(bericht.eingriffe)
    assert bericht.tiefster_monat_eur == pytest.approx(1.0 - 3 * 0.2626, abs=1e-3)
    s = plan.slots[3]
    assert s.battery_kw == pytest.approx(-1.0) and s.grid_kw == pytest.approx(0.0)
    assert s.slot_flags == (SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT,)
    assert s.slot_role == "eigenverbrauch"
    assert s.cover_load_from_battery is True and s.limit_discharge_to_load is True
    assert s.charge_surplus_to_battery is False
    # die Ladestands-Bahn führt nach: 3 x 8 kW, dann je 1 kW
    eta = BATTERY.one_way_efficiency
    assert plan.slots[7].soc_kwh == pytest.approx(50.0 - (3 * 8 + 5 * 1) * 0.25 / eta, abs=1e-3)
    assert plan.slots[2].battery_kw == -8.0


def test_das_budget_ist_der_erlaubte_rueckstand():
    start = datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)
    stand = _stand(start, monat_eur=0.0, sieben_tage_eur=None)
    plan0, _ = mit_budget(_verkauf(_nacht(start, 8)), _nacht(start, 8, vorsprung_budget_eur=0.0, vorsprung=stand))
    plan1, b1 = mit_budget(_verkauf(_nacht(start, 8)), _nacht(start, 8, vorsprung_budget_eur=1.0, vorsprung=stand))
    assert _stur_gestellt(plan0) == list(range(8))
    assert _stur_gestellt(plan1) == [3, 4, 5, 6, 7]
    assert b1.tiefster_monat_eur >= -1.0


def test_ein_vorsprung_genuegt_nicht_wenn_die_sieben_tage_hinten_liegen():
    """Beide Fenster gelten zugleich: der Monat trüge den Verkauf, die 7 Tage nicht."""
    start = datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)
    inp = _nacht(start, 4, vorsprung_budget_eur=0.0,
                 vorsprung=_stand(start, monat_eur=20.0, sieben_tage_eur=0.3))
    plan, bericht = mit_budget(_verkauf(inp), inp)
    assert _stur_gestellt(plan) == [1, 2, 3]
    assert bericht.tiefster_sieben_eur >= 0.0 and bericht.tiefster_monat_eur > 19.0


def test_um_mitternacht_faellt_der_aelteste_tag_aus_den_sieben_tagen():
    """13.10. 22:00 Berlin: die 7 Tage liegen bei -0,50 EUR (der 7.10. mit
    -3,00 EUR darin), also fährt der Plan stur. Um Mitternacht fällt der 7.10.
    heraus: +2,50 EUR, und der Verkauf läuft wieder 9 Slots lang."""
    start = datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)
    inp = _nacht(start, 20, vorsprung_budget_eur=0.0, vorsprung=_stand(
        start, monat_eur=None, sieben_tage_eur=-0.5, tage_eur=(-3.0, 0.5, 0.5, 0.5, 0.5, 0.5)))
    plan, _ = mit_budget(_verkauf(inp), inp)
    assert plan.slots[8].start.astimezone(BERLIN) == datetime(2026, 10, 14, tzinfo=BERLIN)
    assert _stur_gestellt(plan) == list(range(8)) + [17, 18, 19]


def test_am_monatsersten_beginnt_der_monat_bei_null():
    """31.10. 22:00 Berlin, Monat -5 EUR, Budget 1 EUR: bis Mitternacht stur.
    Am 1.11. verankert die api den Vergleich neu - der Monat beginnt bei 0, drei
    Verkaufs-Slots passen ins Budget, der vierte nicht."""
    start = datetime(2026, 10, 31, 21, 0, tzinfo=timezone.utc)  # 22:00 MEZ
    inp = _nacht(start, 14, vorsprung_budget_eur=1.0,
                 vorsprung=_stand(start, monat_eur=-5.0, sieben_tage_eur=None))
    plan, bericht = mit_budget(_verkauf(inp), inp)
    assert plan.slots[8].start.astimezone(BERLIN) == datetime(2026, 11, 1, tzinfo=BERLIN)
    assert _stur_gestellt(plan) == list(range(8)) + [11, 12, 13]


def test_der_monatsanker_bucht_den_bestand_in_die_sieben_tage():
    """Der Vergleich springt am Monatsersten auf den echten Stand; was der echte
    Speicher bis dahin weniger hat, bleibt in den 7 Tagen gebucht (zur Bewertung)."""
    start = datetime(2026, 10, 31, 22, 0, tzinfo=timezone.utc)  # 23:00 MEZ
    stand = _stand(start, monat_eur=None, sieben_tage_eur=-1.0, vorsprung_kwh=-10.0)
    inp = _nacht(start, 8, vorsprung_budget_eur=5.0, vorsprung=stand)
    _, bericht = mit_budget(_verkauf(inp), inp)
    # 4 Verkaufs-Slots vor dem Anker, 4 danach: der Rückstand wächst durchgehend.
    assert bericht.eingriffe == ()
    assert bericht.tiefster_sieben_eur == pytest.approx(-1.0 - 8 * 0.2626, abs=1e-3)


@pytest.mark.parametrize(
    "grund, over",
    [
        ("luecke", dict(vorsprung=_stand(T0, monat_eur=None, sieben_tage_eur=None))),
        ("zu_alt", dict(vorsprung=_stand(T0 - HOECHSTALTER - timedelta(minutes=1)))),
        ("kein_stand", dict(vorsprung=None)),
        ("ladestand_unbekannt", dict(soc_source=SOC_SOURCE_UNBEKANNT)),
        ("nicht_gesteuert", dict(battery_held=True)),
    ],
)
def test_fehlende_daten_heisst_kein_budget(grund, over):
    """Keine Zahl auf der Kachel, kein Ladestand, kein gesteuerter Speicher:
    die Regel greift nicht, der Plan bleibt dasselbe Objekt."""
    base = dict(vorsprung_budget_eur=0.0, vorsprung=_stand(T0, monat_eur=-50.0, sieben_tage_eur=-50.0))
    base.update(over)
    inp = _nacht(T0, 4, **base)
    plan = _verkauf(_nacht(T0, 4))
    neu, bericht = mit_budget(plan, inp)
    assert neu is plan and bericht.ohne_budget == grund


def test_ein_fehler_kostet_die_regel_nie_den_plan(monkeypatch):
    from voltpilot_optimization import vorsprung

    def kaputt(slots, inp):
        raise RuntimeError("Rechenfehler")

    monkeypatch.setattr(vorsprung, "pruefe", kaputt)
    inp = _nacht(T0, 4, vorsprung_budget_eur=0.0, vorsprung=_stand(T0, monat_eur=-50.0))
    plan = _verkauf(_nacht(T0, 4))
    neu, bericht = mit_budget(plan, inp)
    assert neu is plan and bericht.ohne_budget == "fehler"


def test_ein_vorsprung_im_speicher_zaehlt_nur_mit_dem_mittag():
    """Hält der Plan Energie (Vorsprung im Speicher) und kauft dafür Strom zu
    25 ct, ist das gegen die Kachel (23,98 ct je kWh) fast neutral - die Regel
    bewertet den gehaltenen Bestand aber nur mit dem Einspeisewert des nächsten
    Mittags (hier 5 ct) und stellt stur, sobald der Vorsprung aufgebraucht ist."""
    start = datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc)  # 18:00 Berlin
    n = 24  # bis 13.10. 23:45 - kein Mittag im Horizont: kleinster Einspeisewert (5 ct)
    inp = _nacht(start, n, export_value_eur_mwh=[50.0] * n, load_kw=[4.0] * n,
                 vorsprung_budget_eur=0.0, vorsprung=_stand(start, monat_eur=0.5, sieben_tage_eur=None))
    halten = _verkauf(inp, kw=0.0)  # der Plan ruht ...
    # ... und die Box deckt das Defizit in Ruhe selbst (deficitcover.go): kein Eingriff.
    _, bericht = mit_budget(halten, inp)
    assert bericht.eingriffe == ()
    # Hält er ausdrücklich (Sollwert 0 bei Netzbezug, ein Lade-Slot mit 0,1 kW),
    # deckt die Box nicht - dann kostet jeder Slot 1 kWh Bezug gegen 0,96 kWh Bestand.
    laden = replace(halten, slots=[replace(s, battery_kw=0.1) for s in halten.slots])
    plan, bericht = mit_budget(laden, inp)
    assert 0 < len(bericht.eingriffe) < n
    assert bericht.tiefster_monat_eur >= -1e-9


# ---- im echten gelösten Plan -------------------------------------------------------


def solve(inp: OptimizationInput, plan_id=None):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=plan_id or UUID(int=1), generated_at=T0)


@needs_highs
def test_schalter_aus_ist_byte_identisch():
    """Aus (kein Budget) ist derselbe Plan wie heute - auch mit gelesenem Stand.
    An mit bequemem Vorsprung greift die Regel nicht: wieder derselbe Plan."""
    heute = solve(herzogau_tage())
    assert solve(herzogau_tage(vorsprung=_stand(T0, monat_eur=-50.0))) == heute
    assert solve(herzogau_tage(vorsprung_budget_eur=0.0,
                               vorsprung=_stand(T0, monat_eur=50.0, sieben_tage_eur=50.0))) == heute


@needs_highs
def test_ohne_vorsprung_laedt_der_vormittag_stur_statt_zu_warten():
    """Der Fall des 13.10. im Kleinen: vormittags lässt der Plan den Überschuss
    zu 12 ct ins Netz, weil er mittags zu 1 ct laden will. Der sture Speicher
    lädt sofort; ohne Vorsprung (Monat und 7 Tage 0, Budget 0) darf der Plan
    nicht dahinter fallen - die Vormittags-Slots fahren stur, mit Grund."""
    heute = solve(herzogau_tage())
    inp = herzogau_tage(vorsprung_budget_eur=0.0, vorsprung=_stand(T0))
    plan = solve(inp)
    stur = _stur_gestellt(plan)
    vormittag = [i for i, s in enumerate(heute.slots)
                 if 8 <= s.start.astimezone(BERLIN).hour < 11 and s.start.date() == T0.date()]
    assert vormittag and set(vormittag) <= set(stur)
    for i in vormittag:
        assert abs(heute.slots[i].battery_kw) < 0.05 and heute.slots[i].grid_kw < -10.0
        s = plan.slots[i]
        assert s.battery_kw == pytest.approx(s.pv_kw - s.load_kw)  # lädt den Überschuss
        assert s.slot_role == "pv_speichern"
        assert s.charge_surplus_to_battery is True and s.charge_from_surplus_only is True
    # vor dem Vormittag (Nacht, Morgen ohne Sonne) ändert sich nichts
    assert plan.slots[: vormittag[0]] == heute.slots[: vormittag[0]]
    # die Bahn ist in sich stimmig: jeder Ladestand folgt aus Sollwert und Vorgänger
    eta = BATTERY.one_way_efficiency
    for a, b in zip(plan.slots[vormittag[0]:], plan.slots[vormittag[0] + 1:]):
        d = eta * max(b.battery_kw, 0) * 0.25 - max(-b.battery_kw, 0) / eta * 0.25
        assert b.soc_kwh == pytest.approx(a.soc_kwh + d, abs=2e-3)
    # die Garantie über den ganzen Horizont, gegen die Prognose
    _, bericht = mit_budget(heute, inp)
    assert bericht.tiefster_monat_eur >= -1e-6 and bericht.tiefster_sieben_eur >= -1e-6


@needs_highs
def test_verträglich_mit_dem_morgenueberschuss():
    """NS-5 B gibt den Vormittags-Ruhe-Slots die Überschuss-Freigabe, ohne den
    Sollwert zu ändern - die Box lädt dort schon wie stur. Die Prüfung sieht das
    Ergebnis, nicht die Regel: dort greift sie nicht, der Grund bleibt der
    Morgenüberschuss."""
    inp = herzogau_tage(morgen_ueberschuss=True, vorsprung_budget_eur=0.0, vorsprung=_stand(T0))
    plan = solve(inp)
    ohne = solve(herzogau_tage(morgen_ueberschuss=True))
    morgen = [i for i, s in enumerate(ohne.slots) if SLOT_FLAG_MORGEN_UEBERSCHUSS in (s.slot_flags or ())]
    assert morgen
    for i in morgen:
        a, b = plan.slots[i], ohne.slots[i]
        assert (a.battery_kw, a.slot_flags, a.charge_surplus_to_battery) == (
            b.battery_kw, b.slot_flags, b.charge_surplus_to_battery)
    assert not set(morgen) & set(_stur_gestellt(plan))


@needs_highs
def test_vertraeglich_mit_dem_speicher_vor_dem_verbraucher():
    """NS-3 B nimmt den Überschuss-Verbraucher aus der Last (``load_kw`` ist die
    Grundlast) und lässt die Box jede getrimmte Ladung gegen ihn halten. Ein
    stur gestellter Lade-Slot bleibt dabei: er behält den Grund
    ``ueberschuss_verbraucher`` und ``charge_hold_base_load_kw`` - stur heißt
    „sofort laden“, nicht „dem Verbraucher die Sonne lassen“."""
    from voltpilot_optimization.ueberschuss_verbraucher import SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER

    n = 2 * 96
    vormittag = range(8, 20)  # 13.10. 08:00-10:45 Berlin: Verbraucher erkannt
    erkannt = tuple(t in vormittag for t in range(n))
    inp = herzogau_tage(ueberschuss_verbraucher=erkannt, vorsprung_budget_eur=0.0,
                        vorsprung=_stand(T0))
    plan = solve(inp)
    assert set(vormittag) <= set(_stur_gestellt(plan))
    for i in vormittag:
        s = plan.slots[i]
        assert s.slot_flags == (SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT, SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER)
        assert s.battery_kw == pytest.approx(s.pv_kw - s.load_kw)
        assert s.charge_from_surplus_only is True
        assert s.charge_hold_base_load_kw == pytest.approx(s.load_kw)
    # ohne erkannten Verbraucher keine Haltelast
    ohne = solve(herzogau_tage(vorsprung_budget_eur=0.0, vorsprung=_stand(T0)))
    assert all(ohne.slots[i].charge_hold_base_load_kw is None for i in vormittag)

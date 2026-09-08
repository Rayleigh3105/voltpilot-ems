"""Die Nacht-Wertfunktion (P3, Konzept ``vp-nachtreserve-konzept-k2`` §3).

Der Kern ist das ZAHLENBEISPIEL: der Fahrplan-Lauf vom 04.09.2026 19:45 für
Herzogau, die Nacht, in der der Speicher um 02:45 leer stand. Seine Eingaben
liegen als committete Zeitreihe in ``tests/p3_night_vector.json`` (Prognosen,
Preise, Batterie, Ladestand und die 28 Nacht-Fehler davor, gezogen aus dem
Analyse-Harness des Konzepts), und dieser Test pinnt Stufe für Stufe die Zahlen
des Reports auf dem Solver DIESES Repos::

    i1 = 47 (05.09. 07:30) · D_Rest = 40,8 kWh · p_imp = 25,0 ct · v_left = 0,0 ct
    L   = [0,0; 4,9; 13,4; 27,0] kWh · c = [0; 0,0625; 0,0375; 0,025] EUR/kWh
    ohne Term: Verkauf 14,5 kWh heute Abend, SoC-Pfad am Boden
    mit  Term: Verkauf 9,8 kWh, SoC bei Sonnenaufgang 12,6 %, vf_s = [0; 0; 8,469; 22,082]
    Sollwert des LAUFENDEN Slots in beiden Fällen -30,0 kW

Dazu die drei Fälle, in denen ausdrücklich NICHTS entstehen darf (keine
Verteilung, kein Preisabstand, kein Überschuss-Slot nach der Nacht), der
Reservestapel, die Grenzbedingung des Newsvendor-Bruchs und die reine
Fehler-Statistik aus P3a.
"""

from __future__ import annotations

import importlib.util
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from pyomo.environ import value

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.co_solver import build_co_model
from voltpilot_optimization.night_reserve import (
    BERLIN,
    DEFAULT_QUANTILES,
    MEDIAN_Q,
    NightErrorQuantiles,
    _evening_run_target,
    _night_windows,
    held_level,
    night_error_rels,
    night_reserve_of,
    night_reserve_terms,
    quantile,
    quantiles_of,
)
from voltpilot_optimization.solver import (
    _extract_plan,
    _solve,
    build_model,
    optimize,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

VECTOR = json.loads((Path(__file__).resolve().parent / "p3_night_vector.json").read_text())
UTC = timezone.utc


# ---------------------------------------------------------------------------
# Der Testvektor (04.09.2026 19:45, Herzogau)
# ---------------------------------------------------------------------------


def vector_quantiles() -> NightErrorQuantiles:
    """Die Verteilung der 28 Nächte vor dem Lauf: {0.5: -0.001, 0.75: 0.121,
    0.9: 0.328, 0.95: 0.662}."""
    rels = VECTOR["night_errors"]
    errors = quantiles_of(rels, DEFAULT_QUANTILES, "persistence")
    assert errors is not None
    return errors


def vector_input(errors: NightErrorQuantiles | None, **overrides) -> OptimizationInput:
    battery = BatteryParams(**VECTOR["battery"])
    first = datetime.fromisoformat(VECTOR["first_slot"].replace("Z", "+00:00"))
    starts = [first + timedelta(minutes=15 * i) for i in range(VECTOR["slots"])]
    series = VECTOR["series"]
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        battery=battery,
        slot_starts=starts,
        prices_eur_mwh=series["prices_eur_mwh"],
        load_kw=series["load_kw"],
        pv_kw=series["pv_kw"],
        initial_soc_kwh=VECTOR["initial_soc_kwh"],
        netzladen_erlaubt=VECTOR["netzladen_erlaubt"],
        max_feed_in_kw=VECTOR["max_feed_in_kw"],
        import_price_eur_mwh=series["import_price_eur_mwh"],
        export_value_eur_mwh=series["export_value_eur_mwh"],
        night_error_quantiles=errors,
        **overrides,
    )


def evening_sale_kwh(inp: OptimizationInput, plan) -> float:
    """Was der Plan HEUTE ABEND (17-23 Uhr) über den Hausbedarf hinaus aus dem
    Speicher verkauft - die Größe, um die der ganze Streit geht."""
    day = inp.slot_starts[0].astimezone(BERLIN).date()
    total = 0.0
    for i, slot in enumerate(plan.slots):
        local = inp.slot_starts[i].astimezone(BERLIN)
        if local.date() != day or not (17 <= local.hour < 23):
            continue
        deficit = max(inp.load_kw[i] - inp.pv_kw[i], 0.0)
        total += max(-slot.battery_kw - deficit, 0.0) * inp.slot_hours
    return total


def test_the_distribution_of_the_28_nights_before_the_run():
    errors = vector_quantiles()
    assert errors.nights == 28
    rounded = {q: round(errors.level(q), 3) for q in errors.qs}
    assert rounded == {0.5: -0.001, 0.75: 0.121, 0.9: 0.328, 0.95: 0.662}


def test_the_value_function_terms_of_the_worked_example():
    inp = vector_input(vector_quantiles())
    terms = night_reserve_terms(
        load_kw=inp.load_kw,
        pv_kw=inp.pv_kw,
        import_price_eur_mwh=inp.import_prices,
        export_value_eur_mwh=inp.export_values,
        slot_hours=inp.slot_hours,
        one_way_efficiency=inp.battery.one_way_efficiency,
        soc_floor_kwh=inp.battery.soc_floor_kwh(inp.initial_soc_kwh),
        errors=inp.night_error_quantiles,
    )
    assert terms is not None
    # Sonnenaufgang = der erste Überschuss-Slot NACH der Nacht: 05.09. 07:30.
    assert terms.i1 == 47
    assert inp.slot_starts[terms.i1].astimezone(BERLIN).strftime(
        "%d.%m. %H:%M"
    ) == "05.09. 07:30"
    assert terms.d_rest_kwh == pytest.approx(40.8, abs=0.05)
    assert terms.p_imp_ct == pytest.approx(25.0, abs=0.05)
    # Negativpreise am 05.09. mittags: die kWh nach Sonnenaufgang ist nichts wert.
    assert terms.v_left_ct == pytest.approx(0.0, abs=1e-9)
    assert [round(x, 2) for x in terms.levels_kwh] == [0.0, 4.92, 13.39, 27.0]
    assert [round(c, 5) for c in terms.coefficients_eur_kwh] == [
        0.0,
        0.0625,
        0.0375,
        0.025,
    ]


@needs_highs
def test_the_worked_example_end_to_end():
    """Ohne Term Verkauf 14,5 kWh und SoC am Boden; mit Term 9,8 kWh und
    12,6 % bei Sonnenaufgang - und in BEIDEN Fällen derselbe Sollwert der
    laufenden Viertelstunde (der Term ändert die MENGE, nie den laufenden
    Verkauf)."""
    plans = {}
    for name, errors in (("none", None), ("valuefn", vector_quantiles())):
        inp = vector_input(errors)
        model = build_model(inp)
        _solve(model)
        plan = _extract_plan(model, inp, uuid4(), inp.slot_starts[0])
        plans[name] = (inp, model, plan)

    inp_none, _, plan_none = plans["none"]
    inp_vf, model_vf, plan_vf = plans["valuefn"]
    capacity = inp_vf.battery.capacity_kwh

    assert evening_sale_kwh(inp_none, plan_none) == pytest.approx(14.48, abs=0.05)
    assert evening_sale_kwh(inp_vf, plan_vf) == pytest.approx(9.76, abs=0.05)
    assert plan_none.slots[0].battery_kw == pytest.approx(-30.0, abs=1e-3)
    assert plan_vf.slots[0].battery_kw == pytest.approx(-30.0, abs=1e-3)

    terms = night_reserve_of(model_vf)
    assert terms is not None
    soc_sunrise_pct = 100.0 * plan_vf.slots[terms.i1 - 1].soc_kwh / capacity
    assert soc_sunrise_pct == pytest.approx(12.6, abs=0.1)
    # Ohne den Term steht der SoC-Pfad die ganze Nacht am Boden.
    floor_pct = 100.0 * inp_none.battery.soc_floor_kwh(inp_none.initial_soc_kwh) / capacity
    assert 100.0 * plan_none.slots[terms.i1 - 1].soc_kwh / capacity == pytest.approx(
        floor_pct, abs=0.1
    )
    assert [round(value(model_vf.vf_s[k]), 3) for k in (1, 2, 3, 4)] == [
        0.0,
        0.0,
        8.469,
        22.082,
    ]
    # Gehalten wird die 75-%-Stufe: 4,9 kWh über dem Boden.
    held = held_level(terms, plan_vf.slots[terms.i1 - 1].soc_kwh)
    assert held is not None
    assert held[0] == pytest.approx(4.92, abs=0.05)
    assert held[1] == 0.75


@needs_highs
def test_the_marginal_rule_is_the_newsvendor_ratio():
    """Die Grenzbedingung des Reports: eine kWh wird verkauft GENAU DANN, wenn
    ``p_sale − wear > v_left + (p_imp − v_left) · P(eps > slack)``.

    Im Modell ist die rechte Seite die Summe der Stufenkosten, die eine weitere
    verkaufte kWh auslöst - und die ist per Konstruktion
    ``(p_imp − v_left) · (1 − q_gehalten)``, also genau die
    Überschreitungs-Wahrscheinlichkeit der gehaltenen Stufe. Der Plan bleibt
    deshalb dort stehen, wo der Abend-Erlös diese Zahl gerade noch trägt.
    """
    inp = vector_input(vector_quantiles())
    model = build_model(inp)
    _solve(model)
    plan = _extract_plan(model, inp, uuid4(), inp.slot_starts[0])
    terms = night_reserve_of(model)
    assert terms is not None
    held = held_level(terms, plan.slots[terms.i1 - 1].soc_kwh)
    assert held is not None
    held_kwh, held_q = held
    # Der Plan steht GENAU auf der gehaltenen Stufe (4,92 kWh über dem Boden):
    # das ist die Kante, an der die Grenzbedingung ausgewertet wird.
    assert plan.slots[terms.i1 - 1].soc_kwh - terms.soc_floor_kwh == pytest.approx(
        held_kwh, abs=1e-3
    )
    # Der Preis der letzten noch verkauften kWh: die Stufen OBERHALB der
    # gehaltenen - per Konstruktion die Überschreitungs-Wahrscheinlichkeit.
    marginal = sum(
        c
        for q, c in zip(terms.q, terms.coefficients_eur_kwh)
        if q > held_q
    )
    spread_eur = (terms.p_imp_ct - terms.v_left_ct) / 100.0
    assert marginal == pytest.approx(spread_eur * (1.0 - held_q), rel=1e-9)
    assert marginal == pytest.approx(0.0625, abs=1e-6)  # 25 ct * P(eps > q75)


# ---------------------------------------------------------------------------
# Die drei Fälle, in denen NICHTS entstehen darf
# ---------------------------------------------------------------------------


def terms_of(inp: OptimizationInput):
    return night_reserve_terms(
        load_kw=inp.load_kw,
        pv_kw=inp.pv_kw,
        import_price_eur_mwh=inp.import_prices,
        export_value_eur_mwh=inp.export_values,
        slot_hours=inp.slot_hours,
        one_way_efficiency=inp.battery.one_way_efficiency,
        soc_floor_kwh=inp.battery.soc_floor_kwh(inp.initial_soc_kwh),
        errors=inp.night_error_quantiles,
    )


@needs_highs
def test_without_a_distribution_the_model_is_byte_identical():
    """Der Regelfall jeder jungen Anlage - und die Bedingung, unter der die
    Golden-Suite unberührt bleibt: kein ``vf_c``, kein ``vf_s``, derselbe
    Zielwert."""
    inp = vector_input(None)
    model = build_model(inp)
    assert not hasattr(model, "vf_c")
    assert not hasattr(model, "vf_s")
    assert night_reserve_of(model) is None
    _solve(model)
    reference = value(model.total_cost)
    plan = _extract_plan(model, inp, uuid4(), inp.slot_starts[0])
    assert plan.why_night_reserve is None
    # Und derselbe Lauf mit Verteilung ist NICHT identisch - sonst prüfte der
    # Test oben nichts.
    with_errors = build_model(vector_input(vector_quantiles()))
    _solve(with_errors)
    assert value(with_errors.total_cost) != pytest.approx(reference, abs=1e-6)


def test_too_few_nights_yield_no_distribution_at_all():
    assert quantiles_of([], DEFAULT_QUANTILES, "persistence") is None


@needs_highs
def test_without_a_price_spread_there_is_no_term():
    """Ein Standort ohne Preisabstand (``p_imp <= v_left``) - der ``ohne``-Tarif
    und jede Nacht, deren Bezug den Verkaufswert nach Sonnenaufgang nicht
    übersteigt. Zurückhalten wäre dort nie wirtschaftlich, also gibt es keinen
    Term und der Plan ist byte-identisch."""
    flat = vector_input(vector_quantiles())
    n = flat.slots
    flat = replace(
        flat,
        import_price_eur_mwh=[120.0] * n,
        export_value_eur_mwh=[120.0] * n,
    )
    assert terms_of(flat) is None
    model = build_model(flat)
    assert not hasattr(model, "vf_c")
    assert night_reserve_of(model) is None


@needs_highs
def test_a_winter_horizon_without_a_sunrise_gets_no_term():
    """Der Winterhorizont: nach der Nacht kommt kein Überschuss-Slot mehr
    (``i1 = n``). Es gibt dann keinen Knoten, über dem die Wertfunktion leben
    könnte - der Terminalwert trägt allein."""
    dark = vector_input(vector_quantiles())
    n = dark.slots
    dark = replace(dark, pv_kw=[0.0] * n, load_kw=[4.0] * n)
    assert terms_of(dark) is None
    model = build_model(dark)
    assert not hasattr(model, "vf_c")


def test_a_night_shorter_than_four_slots_gets_no_term():
    errors = vector_quantiles()
    assert (
        night_reserve_terms(
            load_kw=[1.0, 5.0, 5.0, 1.0, 1.0],
            pv_kw=[9.0, 0.0, 0.0, 9.0, 9.0],
            import_price_eur_mwh=[300.0] * 5,
            export_value_eur_mwh=[10.0] * 5,
            slot_hours=0.25,
            one_way_efficiency=0.96,
            soc_floor_kwh=3.0,
            errors=errors,
        )
        is None
    )


@needs_highs
def test_a_battery_a_customer_rule_owns_gets_no_term():
    """Steuerung Stufe 3: ein von einer Kundenregel beanspruchter Speicher ist
    nicht der Plan seine. Der Term koennte dort nur eine Konstante ins Ziel
    legen - die ERKLAERUNG behauptete aber, der Plan halte die Ladung fuer die
    Nacht zurueck, obwohl sie die Regel haelt."""
    held = replace(vector_input(vector_quantiles()), battery_held=True)
    model = build_model(held)
    assert not hasattr(model, "vf_c")
    assert night_reserve_of(model) is None


# ---------------------------------------------------------------------------
# Der Reservestapel und die Erklär-Schicht
# ---------------------------------------------------------------------------


def test_the_reserve_stack_moves_the_floor_but_never_the_levels():
    """``backup_reserve_soc_pct = 20`` hebt den Boden, gegen den die
    Wertfunktion rechnet - die Stufen ``L_k`` sind eine Aussage über die
    NACHT und bleiben davon unberührt. Beides komponiert deshalb: über einem
    höheren Boden hält der Plan dieselbe Menge zusätzlich."""
    plain = vector_input(vector_quantiles())
    reserved = replace(
        plain, battery=replace(plain.battery, backup_reserve_pct=20.0)
    )
    a, b = terms_of(plain), terms_of(reserved)
    assert a is not None and b is not None
    assert b.soc_floor_kwh > a.soc_floor_kwh
    assert b.soc_floor_kwh == pytest.approx(
        0.20 * plain.battery.capacity_kwh, abs=1e-9
    )
    assert b.levels_kwh == a.levels_kwh
    assert b.coefficients_eur_kwh == a.coefficients_eur_kwh
    assert b.d_rest_kwh == a.d_rest_kwh


@needs_highs
def test_a_binding_step_becomes_a_slot_flag_and_a_run_fact():
    """Ein bindender ``vf_c[k]`` heißt ``reserve_q<k>`` am Slot ``i1 − 1``, und
    der Lauf trägt den Erklär-Fakt. Die ROLLE des Slots bleibt, was sie war -
    P3 ändert die Menge, nicht die Bedeutung eines Slots."""
    inp = vector_input(vector_quantiles())
    plan = optimize(inp, uuid4(), inp.slot_starts[0])
    fact = plan.why_night_reserve
    assert fact is not None
    assert fact["sunrise"] == 47
    assert fact["q"] == [0.5, 0.75, 0.9, 0.95]
    assert [round(x, 2) for x in fact["levels_kwh"]] == [0.0, 4.92, 13.39, 27.0]
    assert fact["p_imp_ct"] == pytest.approx(25.0, abs=0.05)
    assert fact["v_left_ct"] == pytest.approx(0.0, abs=1e-9)
    assert fact["held_kwh"] == pytest.approx(4.92, abs=0.05)
    assert fact["held_q"] == 0.75
    # Der Plan steht GENAU auf der 75-%-Stufe, also bindet sie (mit
    # Gleichheit) zusammen mit allen darüber - und alles davon am letzten Slot
    # der Nacht, nirgends sonst. Die Median-Stufe (L_0 = 0) bindet nicht: sie
    # liegt unter dem, was der Plan hält.
    flags = plan.slots[fact["sunrise"] - 1].slot_flags
    assert [f for f in flags if f.startswith("reserve_q")] == [
        "reserve_q1",
        "reserve_q2",
        "reserve_q3",
    ]
    for other in (fact["sunrise"], fact["sunrise"] - 2):
        assert not [f for f in plan.slots[other].slot_flags if f.startswith("reserve_q")]


@needs_highs
def test_the_run_fact_stays_absent_when_nothing_was_held():
    """Ein Lauf, dessen Ökonomie jede Stufe verwirft, sagt NICHTS - nie eine
    erfundene 0."""
    inp = vector_input(vector_quantiles())
    # Der Speicher startet auf dem Boden: es gibt nichts zurückzuhalten.
    empty = replace(
        inp, initial_soc_kwh=inp.battery.soc_min_kwh
    )
    plan = optimize(empty, uuid4(), empty.slot_starts[0])
    assert plan.why_night_reserve is None


# ---------------------------------------------------------------------------
# P3c: der Weg des Erklär-Fakts in die Datenbank
# ---------------------------------------------------------------------------


def _column_index(column: str) -> int:
    """Position von ``column`` in der Spaltenliste des Persistenz-INSERT."""
    from voltpilot_optimization.persistence import _UPSERT_SQL

    columns = [
        c.strip() for c in _UPSERT_SQL.split("(", 1)[1].split(")", 1)[0].split(",")
    ]
    return columns.index(column)


@needs_highs
def test_the_run_fact_reaches_every_row_of_the_run():
    """Ein RUN-Fakt, je Zeile wiederholt (das ``terminal_value``-Muster) - so
    beantwortet EINE Zeile die Frage für den ganzen Lauf. Persistiert wird nur
    das ERGEBNIS (Menge + Häufigkeit), nie die Herleitung."""
    from voltpilot_optimization.persistence import plan_rows

    inp = vector_input(vector_quantiles())
    plan = optimize(inp, uuid4(), inp.slot_starts[0])
    rows = plan_rows(plan)
    kwh = _column_index("why_night_reserve_kwh")
    q = _column_index("why_night_reserve_q")
    assert all(r[kwh] == pytest.approx(4.92, abs=0.05) for r in rows)
    assert all(r[q] == 0.75 for r in rows)


@needs_highs
def test_a_run_without_the_value_function_persists_null_not_zero():
    from voltpilot_optimization.persistence import plan_rows

    inp = vector_input(None)
    plan = optimize(inp, uuid4(), inp.slot_starts[0])
    rows = plan_rows(plan)
    kwh = _column_index("why_night_reserve_kwh")
    q = _column_index("why_night_reserve_q")
    assert all(r[kwh] is None and r[q] is None for r in rows)


# ---------------------------------------------------------------------------
# Co-Optimierer: derselbe Term über der SUMME der Ladestände
# ---------------------------------------------------------------------------


@needs_highs
def test_the_co_optimizer_reproduces_the_v1_term_for_one_storage():
    inp = vector_input(vector_quantiles())
    v1 = build_model(inp)
    co = build_co_model(from_v1_input(inp))
    _solve(v1)
    _solve(co)
    assert value(co.total_cost) == pytest.approx(value(v1.total_cost), abs=1e-5)
    for k in (1, 2, 3, 4):
        assert value(co.vf_s[k]) == pytest.approx(value(v1.vf_s[k]), abs=1e-3)
    a, b = night_reserve_of(v1), night_reserve_of(co)
    assert a is not None and b is not None
    assert (a.i1, a.levels_kwh, a.coefficients_eur_kwh) == (
        b.i1,
        b.levels_kwh,
        b.coefficients_eur_kwh,
    )


@needs_highs
def test_the_co_optimizer_is_byte_identical_without_a_distribution():
    co = build_co_model(from_v1_input(vector_input(None)))
    assert not hasattr(co, "vf_c")
    assert night_reserve_of(co) is None


# ---------------------------------------------------------------------------
# What-if und Ersparnis-Simulation
# ---------------------------------------------------------------------------


def test_the_what_if_overrides_never_invent_a_distribution():
    """Die Vorschau rechnet mit den Eingaben ihres Standorts - eine
    Verteilung reist mit, eine fehlende wird nie erfunden."""
    from voltpilot_optimization.whatif import WhatIfOverrides, apply_overrides

    bare = vector_input(None)
    overrides = WhatIfOverrides(backup_reserve_soc_pct=20.0)
    assert apply_overrides(bare, overrides).night_error_quantiles is None
    withdist = vector_input(vector_quantiles())
    assert (
        apply_overrides(withdist, overrides).night_error_quantiles
        is withdist.night_error_quantiles
    )


def test_the_savings_simulation_plans_without_the_value_function():
    """Die Ersparnis-Simulation baut ihre Eingaben selbst und liest keine
    Historie - sie bleibt damit ohne Wertfunktion und ihre Jahresketten
    vergleichbar mit jedem Lauf davor.

    Zwei Hälften, die zusammen den Beweis ergeben: das Feld hat die Vorgabe
    ``None``, und der Runner setzt es nirgends."""
    import dataclasses
    import inspect

    from voltpilot_optimization.simulation import runner

    field = next(
        f
        for f in dataclasses.fields(OptimizationInput)
        if f.name == "night_error_quantiles"
    )
    assert field.default is None
    assert "night_error_quantiles" not in inspect.getsource(runner)


# ---------------------------------------------------------------------------
# P3a: die reine Fehler-Statistik
# ---------------------------------------------------------------------------


def test_the_quantile_is_linearly_interpolated():
    values = [0.0, 1.0, 2.0, 3.0]
    assert quantile(values, 0.5) == pytest.approx(1.5)
    assert quantile(values, 0.75) == pytest.approx(2.25)
    assert quantile([], 0.5) is None


def test_the_night_windows_are_berlin_evenings_that_already_ended():
    now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
    windows = _night_windows(now, nights=3, window=(18, 7))
    assert len(windows) == 3
    starts = [w[0].astimezone(BERLIN) for w in windows]
    ends = [w[1].astimezone(BERLIN) for w in windows]
    assert [s.strftime("%d.%m %H:%M") for s in starts] == [
        "07.09 18:00",
        "06.09 18:00",
        "05.09 18:00",
    ]
    assert all(e.hour == 7 for e in ends)
    assert all(e <= now.astimezone(BERLIN) for e in ends)


def test_a_night_that_has_not_ended_yet_is_skipped():
    # 06:00 Berlin: die Nacht von gestern 18:00 läuft noch bis 07:00.
    now = datetime(2026, 9, 8, 4, 0, tzinfo=UTC)
    windows = _night_windows(now, nights=1, window=(18, 7))
    assert windows[0][0].astimezone(BERLIN).strftime("%d.%m") == "06.09"


def test_the_evening_run_target_is_1745_berlin_of_the_window_day():
    start = datetime(2026, 9, 4, 16, 0, tzinfo=UTC)  # 18:00 Berlin
    target = _evening_run_target(start)
    local = target.astimezone(BERLIN)
    assert (local.date().isoformat(), local.hour, local.minute) == (
        "2026-09-04",
        17,
        45,
    )


def _night(day: int, load: float, forecast: float, slots: int = 52):
    """Ein Nacht-Fenster plus die zwei Reihen darüber (18:00 Berlin, `slots`
    Viertelstunden gepaart)."""
    start = datetime(2026, 9, day, 16, 0, tzinfo=UTC)
    end = start + timedelta(hours=13)
    measured = {}
    predicted = {}
    for i in range(slots):
        slot = start + timedelta(minutes=15 * i)
        measured[slot] = load
        predicted[slot] = forecast
    return (start, end), measured, predicted


def test_the_relative_night_error_is_measured_over_forecast_minus_one():
    window, measured, predicted = _night(4, load=6.2, forecast=5.0)
    rels = night_error_rels([window], measured, {window[0]: predicted})
    assert rels == pytest.approx([0.24])


def test_an_incomplete_night_is_discarded_not_scaled():
    """43 von 52 Viertelstunden sind keine Nacht - der Quotient beschriebe zwei
    verschieden lange Fenster."""
    window, measured, predicted = _night(4, load=6.2, forecast=5.0, slots=43)
    assert night_error_rels([window], measured, {window[0]: predicted}) == []
    window, measured, predicted = _night(4, load=6.2, forecast=5.0, slots=44)
    assert len(night_error_rels([window], measured, {window[0]: predicted})) == 1


def test_a_night_without_the_evening_run_contributes_nothing():
    window, measured, _predicted = _night(4, load=6.2, forecast=5.0)
    assert night_error_rels([window], measured, {}) == []


def test_the_median_step_is_free_by_construction():
    """``q_0`` ist die Prognose des Plans SELBST - was er ohnehin erwartet,
    kostet ihn in der Wertfunktion nichts."""
    errors = quantiles_of([0.0, 0.1, 0.2, 0.4], DEFAULT_QUANTILES, "persistence")
    assert errors is not None
    assert errors.qs[0] == MEDIAN_Q
    terms = night_reserve_terms(
        load_kw=[1.0] + [5.0] * 8 + [1.0],
        pv_kw=[9.0] + [0.0] * 8 + [9.0],
        import_price_eur_mwh=[300.0] * 10,
        export_value_eur_mwh=[10.0] * 10,
        slot_hours=0.25,
        one_way_efficiency=0.96,
        soc_floor_kwh=3.0,
        errors=errors,
    )
    assert terms is not None
    assert terms.coefficients_eur_kwh[0] == 0.0
    assert sum(terms.coefficients_eur_kwh) == pytest.approx(
        (terms.p_imp_ct - terms.v_left_ct) / 100.0 * 0.5
    )


def test_horizon_helper_is_untouched():
    # Guard against an accidental import-time side effect on the shared grid.
    assert len(horizon_slot_starts(datetime(2026, 9, 4, 17, 45, tzinfo=UTC), 4)) == 4

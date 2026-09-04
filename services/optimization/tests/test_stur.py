"""Die MESSLATTE: der sture Speicher als Referenz der geplanten Ersparnis.

Captain 04.09.2026: "du musst Anlage immer mit Speicher berechnen, einer halt
ohne smart Steuerung." Diese Suite beweist drei Dinge:

1. die REGEL selbst gegen die GETEILTEN Vektoren
   ``docs/contracts/stur-speicher-vectors.json``, die auch der Java-Zwilling
   ``StandardSpeicherTest`` PER PFAD liest - so koennen die geplante und die
   gemessene Seite nicht auseinanderlaufen;
2. die Eigenschaften, die die Regel zur Regel machen (nie Netzladen, nie
   Export aus dem Speicher, SoC im Band, Wirkungsgrad-Verluste);
3. die VERDRAHTUNG in den Plan - dass der geloeste Fahrplan sich um kein Byte
   aendert, dass die Messlatte persistiert wird und dass die Steuerungs-Zahl
   kleiner ist als der Gesamtwert des Speichers.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.persistence import plan_rows
from voltpilot_optimization.simulation.greedy import greedy_dispatch
from voltpilot_optimization.stur import stur_cost_eur, stur_dispatch

# Read the shared vectors BY PATH - moving them breaks this test deliberately.
VECTORS = Path(__file__).resolve().parents[3] / "docs" / "contracts" / (
    "stur-speicher-vectors.json"
)

T0 = datetime(2026, 9, 4, 22, 0, tzinfo=timezone.utc)


def _battery(spec: dict, **overrides) -> BatteryParams:
    kwargs = dict(
        capacity_kwh=spec["capacity_kwh"],
        max_charge_kw=spec["max_charge_kw"],
        max_discharge_kw=spec["max_discharge_kw"],
        roundtrip_efficiency=spec["roundtrip_efficiency"],
        soc_min_fraction=spec["soc_min_fraction"],
        soc_max_fraction=spec["soc_max_fraction"],
    )
    kwargs.update(overrides)
    return BatteryParams(**kwargs)


def _cases() -> list[dict]:
    return json.loads(VECTORS.read_text())["faelle"]


def make_input(
    prices: list[float],
    load,
    pv,
    battery: BatteryParams,
    soc0_kwh: float,
    import_price_eur_mwh: list[float] | None = None,
    export_value_eur_mwh: list[float] | None = None,
    netzladen_erlaubt: bool = True,
    **kw,
) -> OptimizationInput:
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[load] * n if isinstance(load, (int, float)) else load,
        pv_kw=[pv] * n if isinstance(pv, (int, float)) else pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=import_price_eur_mwh,
        export_value_eur_mwh=export_value_eur_mwh,
        **kw,
    )


# ---------------------------------------------------------------------------
# 1. Die geteilten Vektoren - die EINE Regel, beidsprachig festgenagelt
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_the_shared_vectors_pin_the_stur_dispatch_slot_by_slot(case):
    spec = case["batterie"]
    battery = _battery(spec)
    # The fixture's derived numbers must match the params, or the vectors are
    # describing a battery nobody builds.
    assert battery.one_way_efficiency == pytest.approx(spec["one_way_efficiency"])
    assert battery.soc_max_kwh == pytest.approx(spec["soc_max_kwh"])
    assert battery.soc_floor_kwh(spec["soc_max_kwh"]) == pytest.approx(
        spec["soc_floor_kwh"]
    )

    slots = case["slots"]
    result = greedy_dispatch(
        battery,
        load_kw=[s["load_kw"] for s in slots],
        pv_kw=[s["pv_kw"] for s in slots],
        initial_soc_kwh=case["initial_soc_kwh"],
        slot_hours=case["slot_hours"],
    )
    for i, s in enumerate(slots):
        expected = s["charge_kw"] - s["discharge_kw"]
        assert result.battery_kw[i] == pytest.approx(expected, abs=1e-9), (
            f"slot {i} ({s['why']})"
        )
        assert result.soc_kwh[i] == pytest.approx(s["soc_kwh"], abs=1e-9), (
            f"slot {i} ({s['why']})"
        )
        assert result.grid_kw[i] == pytest.approx(s["grid_kw"], abs=1e-9), (
            f"slot {i} ({s['why']})"
        )
    assert result.charge_kwh == pytest.approx(case["charge_kwh_total"], abs=1e-9)
    assert result.discharge_kwh == pytest.approx(case["discharge_kwh_total"], abs=1e-9)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_the_shared_vectors_pin_the_euro_value_the_java_twin_computes(case):
    """Der Java-Zwilling rechnet direkt sum(discharge*ip - charge*ev); die
    Python-Seite leitet denselben Betrag aus ihrer Trajektorie ab. Der
    Negativpreis-Slot dreht dabei das Vorzeichen des Export-Terms."""
    spec = case["batterie"]
    slots = case["slots"]
    dt = case["slot_hours"]
    result = greedy_dispatch(
        _battery(spec),
        load_kw=[s["load_kw"] for s in slots],
        pv_kw=[s["pv_kw"] for s in slots],
        initial_soc_kwh=case["initial_soc_kwh"],
        slot_hours=dt,
    )
    eur = 0.0
    for i, s in enumerate(slots):
        b = result.battery_kw[i]
        eur += max(-b, 0.0) * dt * s["import_price_eur_kwh"]
        eur -= max(b, 0.0) * dt * s["export_value_eur_kwh"]
    assert eur == pytest.approx(case["speicher_eur"], abs=1e-9)


# ---------------------------------------------------------------------------
# 2. Die Eigenschaften der Regel
# ---------------------------------------------------------------------------


BATTERY = BatteryParams(
    capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0,
    roundtrip_efficiency=0.64,
)


def test_the_stur_battery_never_charges_from_the_grid():
    """Per Konstruktion: es wird nur aus UEBERSCHUSS geladen. Ein Horizont
    ohne einen einzigen Sonnenstrahl darf den Speicher nie fuellen - auch
    nicht in einem geschenkten Preis-Slot, den der Plan zum Laden nutzt."""
    inp = make_input(
        prices=[-500.0] * 8, load=3.0, pv=0.0, battery=BATTERY, soc0_kwh=5.0
    )
    d = stur_dispatch(inp)
    assert all(b <= 0 for b in d.battery_kw), d.battery_kw
    assert all(g >= 0 for g in d.grid_kw), "ohne PV kann es keinen Export geben"


def test_the_stur_battery_never_exports_from_storage():
    """Er entlaedt hoechstens das DEFIZIT: die Netzleistung eines
    Defizit-Slots faellt nie unter null, der Speicher verkauft also nie."""
    inp = make_input(
        prices=[900.0] * 8, load=[4.0] * 8, pv=[0.0] * 8,
        battery=BATTERY, soc0_kwh=9.5,
    )
    d = stur_dispatch(inp)
    assert all(g >= -1e-12 for g in d.grid_kw), d.grid_kw
    assert min(d.soc_kwh) >= BATTERY.soc_floor_kwh(9.5) - 1e-12


def test_the_soc_never_leaves_the_band_and_the_round_trip_costs_its_losses():
    """Charge bis zur Decke, Entladung bis zum Boden - und aus 4 kWh AC
    hinein werden mit eta=0,8 nur 2,56 kWh AC heraus (0,64 Round Trip)."""
    inp = make_input(
        prices=[50.0] * 8,
        load=[0.0] * 4 + [10.0] * 4,
        pv=[4.0] * 4 + [0.0] * 4,
        battery=BATTERY, soc0_kwh=0.5,
    )
    d = stur_dispatch(inp)
    floor, ceiling = BATTERY.soc_floor_kwh(0.5), BATTERY.soc_max_kwh
    assert all(floor - 1e-9 <= s <= ceiling + 1e-9 for s in d.soc_kwh), d.soc_kwh
    assert d.charge_kwh == pytest.approx(4.0)          # 4 kW x 4 x 0.25 h
    assert d.discharge_kwh == pytest.approx(4.0 * 0.64)  # round trip 0.64


def test_a_deficit_slot_without_stored_energy_buys_everything_from_the_grid():
    inp = make_input(prices=[50.0] * 2, load=6.0, pv=0.0, battery=BATTERY, soc0_kwh=0.5)
    d = stur_dispatch(inp)
    assert d.battery_kw == [0.0, 0.0]
    assert d.grid_kw == [6.0, 6.0]


def test_the_stur_run_starts_at_the_plans_own_soc_not_at_the_floor():
    """Die Messlatte tritt aus derselben Vergangenheit an wie der Plan - sonst
    bekaeme sie einen leeren Morgen angedichtet, den die Anlage nicht hatte."""
    inp = make_input(prices=[50.0] * 4, load=4.0, pv=0.0, battery=BATTERY, soc0_kwh=8.0)
    d = stur_dispatch(inp)
    assert d.battery_kw[0] < 0, "ein voller Speicher deckt sofort"
    leer = make_input(
        prices=[50.0] * 4, load=4.0, pv=0.0, battery=BATTERY, soc0_kwh=0.5
    )
    assert stur_dispatch(leer).battery_kw[0] == 0.0


def test_a_below_reserve_start_uses_the_plans_relaxed_floor():
    """Der MILP relaxiert den Reservations-Stack auf den tatsaechlichen Stand,
    wenn die Batterie darunter sitzt. Die Messlatte muss denselben Boden
    fahren - sonst bekaeme sie Energie geschenkt, die der Plan nicht hat, und
    die Steuerungs-Zahl fiele zu klein aus."""
    battery = BatteryParams(
        capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0,
        roundtrip_efficiency=0.64, backup_reserve_pct=60.0,
    )
    inp = make_input(prices=[50.0] * 4, load=4.0, pv=0.0, battery=battery, soc0_kwh=3.0)
    d = stur_dispatch(inp)
    # Start 3.0 kWh is BELOW the 6.0 kWh reserve -> floor relaxes to 3.0 and
    # the reference stands still instead of being lifted to the reserve.
    assert d.soc_kwh[0] == pytest.approx(3.0)
    assert d.battery_kw == [0.0, 0.0, 0.0, 0.0]


def test_the_stur_cost_uses_the_same_price_composition_as_the_plan():
    """Keine zweite Oekonomie: die Messlatte laeuft durch dieselbe
    cashflow_cost_eur wie cost_eur und baseline_cost_eur."""
    inp = make_input(
        prices=[100.0] * 4,
        load=[0.0, 0.0, 8.0, 8.0],
        pv=[6.0, 6.0, 0.0, 0.0],
        battery=BATTERY, soc0_kwh=0.5,
        import_price_eur_mwh=[300.0] * 4,
        export_value_eur_mwh=[80.0] * 4,
    )
    costs = stur_cost_eur(inp)
    d = stur_dispatch(inp)
    assert costs == [
        pytest.approx(inp.cashflow_cost_eur(t, g)) for t, g in enumerate(d.grid_kw)
    ]
    # Slot 0: 6 kW surplus, charge capped at 5 kW -> 1 kW exported at 80 EUR/MWh.
    assert costs[0] == pytest.approx(-80.0 * 1.0 * 0.25 / 1000.0)


def test_the_measured_java_delta_is_the_stur_cost_against_the_no_battery_baseline():
    """Bruecke zwischen den beiden Seiten: was der Java-Walk als
    speicherEur = sum(discharge*ip - charge*ev) direkt rechnet, ist exakt
    baseline_cost - stur_cost. Die zwei Formeln beschreiben dieselbe Groesse."""
    case = _cases()[0]
    slots = case["slots"]
    inp = make_input(
        prices=[0.0] * len(slots),
        load=[s["load_kw"] for s in slots],
        pv=[s["pv_kw"] for s in slots],
        battery=_battery(case["batterie"]),
        soc0_kwh=case["initial_soc_kwh"],
        import_price_eur_mwh=[s["import_price_eur_kwh"] * 1000.0 for s in slots],
        export_value_eur_mwh=[s["export_value_eur_kwh"] * 1000.0 for s in slots],
    )
    delta = sum(inp.baseline_cost_eur(t) for t in range(len(slots))) - sum(
        stur_cost_eur(inp)
    )
    assert delta == pytest.approx(case["speicher_eur"], abs=1e-9)


# ---------------------------------------------------------------------------
# 3. Die Verdrahtung in den Plan
# ---------------------------------------------------------------------------

highs = pytest.importorskip("highspy", reason="MILP tests need the solver extra")


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


def _pv_day(n: int = 32) -> dict:
    """Ein PV-Tag mit Ueberschuss am Mittag und Last am Abend, dazu ein
    Preisbild, das echte Arbitrage lohnt (Nacht billig, Abend teuer)."""
    quarter = n // 4
    return dict(
        prices=[20.0] * quarter + [40.0] * quarter + [40.0] * quarter
        + [300.0] * (n - 3 * quarter),
        load=[2.0] * quarter + [2.0] * quarter + [2.0] * quarter
        + [7.0] * (n - 3 * quarter),
        pv=[0.0] * quarter + [9.0] * quarter + [9.0] * quarter
        + [0.0] * (n - 3 * quarter),
    )


def test_every_slot_carries_the_messlatte_and_the_plan_stays_byte_identical():
    """Die Messlatte beschreibt nur die BEWERTUNG - der geloeste Fahrplan
    (Setpoints, SoC-Bahn, Abregelung, Kosten) aendert sich um kein Byte."""
    inp = make_input(**_pv_day(), battery=BATTERY, soc0_kwh=0.5)
    plan = solve(inp)
    assert all(s.stur_cost_eur is not None for s in plan.slots)

    import voltpilot_optimization.solver as solver_mod

    original = solver_mod.stur_cost_eur
    solver_mod.stur_cost_eur = lambda i: [None] * i.slots  # type: ignore[assignment]
    try:
        bare = solve(inp)
    finally:
        solver_mod.stur_cost_eur = original
    for a, b in zip(plan.slots, bare.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw, a.cost_eur,
                a.baseline_cost_eur, a.wear_cost_eur) == (
            b.battery_kw, b.grid_kw, b.soc_kwh, b.curtail_kw, b.cost_eur,
            b.baseline_cost_eur, b.wear_cost_eur)
    assert bare.stur_cost_eur is None, "eine Teil-Messlatte wird nie summiert"
    assert bare.steuerung_savings_eur is None


def test_the_steuerung_figure_is_smaller_than_the_whole_battery_value():
    """Ein STURER Speicher ist besser als gar keiner - also muss der Mehrwert
    der Steuerung kleiner sein als der Gesamtwert des Speichers. Und er ist
    positiv: der Plan schlaegt die sture Referenz."""
    inp = make_input(**_pv_day(), battery=BATTERY, soc0_kwh=0.5)
    plan = solve(inp)
    steuerung = plan.steuerung_savings_eur
    assert steuerung is not None
    assert steuerung == pytest.approx(plan.stur_cost_eur - plan.cost_eur)
    assert 0 < steuerung < plan.savings_eur, (
        f"steuerung={steuerung} savings={plan.savings_eur}"
    )
    # ... und die Messlatte liegt zwischen Plan und keiner Batterie.
    assert plan.cost_eur <= plan.stur_cost_eur <= plan.baseline_cost_eur


def test_a_flat_price_horizon_leaves_almost_nothing_for_the_steering():
    """Ohne Preisunterschiede kann die Steuerung nichts verdienen, was der
    sture Speicher nicht auch holt - die Steuerungs-Zahl faellt gegen 0,
    waehrend der SPEICHER weiterhin echten Wert schafft."""
    n = 32
    inp = make_input(
        prices=[100.0] * n,
        load=[1.0] * (n // 2) + [6.0] * (n - n // 2),
        pv=[8.0] * (n // 2) + [0.0] * (n - n // 2),
        battery=BATTERY, soc0_kwh=0.5,
        import_price_eur_mwh=[300.0] * n,
        export_value_eur_mwh=[80.0] * n,
    )
    plan = solve(inp)
    assert plan.savings_eur > 0.1, "der Speicher selbst verdient hier klar"
    assert abs(plan.steuerung_savings_eur) < 0.05


def test_the_messlatte_is_persisted_and_degrades_to_null():
    inp = make_input(**_pv_day(), battery=BATTERY, soc0_kwh=0.5)
    plan = solve(inp)
    rows = plan_rows(plan)
    assert len(rows) == len(plan.slots)
    # Column order: ... cost_eur, baseline_cost_eur, stur_cost_eur, curtail_kw
    assert rows[0][14] == plan.slots[0].stur_cost_eur
    assert rows[0][13] == plan.slots[0].baseline_cost_eur

    import dataclasses

    old = dataclasses.replace(plan, slots=[
        dataclasses.replace(s, stur_cost_eur=None) for s in plan.slots
    ])
    assert plan_rows(old)[0][14] is None
    assert old.stur_cost_eur is None


def test_the_log_line_names_both_measuring_sticks_and_omits_a_missing_one():
    import dataclasses

    from voltpilot_optimization.engine import CycleSummary

    inp = make_input(**_pv_day(), battery=BATTERY, soc0_kwh=0.5)
    plan = solve(inp)
    line = CycleSummary(planned=[plan]).line()
    assert "vs. no-battery baseline" in line
    assert "steuerung=" in line and "vs. stur battery" in line

    old = dataclasses.replace(plan, slots=[
        dataclasses.replace(s, stur_cost_eur=None) for s in plan.slots
    ])
    old_line = CycleSummary(planned=[old]).line()
    assert "vs. no-battery baseline" in old_line
    assert "steuerung=" not in old_line

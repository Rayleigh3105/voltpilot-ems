"""Der "Jetzt-Vorzug" IM HORIZONT-INNEREN (captain 2026-08-18: "erst dein
Verbrauch, dann der Rest").

Auf einem FLACHEN Bezugspreis vermeidet jeder Defizit-Slot denselben Preis, also
sind "die 09:15-Blocklast decken" und "die 22:00-Abendlast decken" algebraisch
dasselbe Geld: der Plan entlaedt dieselbe Menge, nur die PLATZIERUNG ist
degeneriert - und HiGHS platzierte sie spaet. Gemessen an Anlage Pilsting/
Herzogau am 18.08.2026: der Speicher stand drei Stunden bei 17 % (NICHT am
5-%-Boden) neben einer 25-30-kW-Blocklast und importierte 15-23 kW zu 25 ct,
und gab dieselbe Energie spaeter aus.

``solver.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW`` bricht genau diesen Gleichstand
zeitlich (frueheste Deckung gewinnt) - der Zwilling von
``config.TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH``, das denselben Gleichstand
an der Horizont-KANTE bricht ("jetzt decken vs. nach dem Horizont decken").

Vier Eigenschaften sind tragend und haben je ihren Test:
1. der Vormittag wird gedeckt statt geparkt (die Regression),
2. ein ECHTES Preissignal schlaegt die Frueh-Praeferenz weiterhin,
3. das VERKAUFS-Timing wandert nicht nach vorn und der S2-Winterschutz haelt,
4. ohne Gleichstand ist der Plan byte-identisch (nur Ties werden gebrochen).
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization import solver as solver_module
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

# 18.08.2026, 08:00 lokal (= 06:00 UTC) - der Lauf, der den Vormittag plante.
# Der Horizont endet um Mitternacht, weil der Day-ahead fuer morgen erst gegen
# 12:45 veroeffentlicht wird: 64 Slots, genau wie in der Anlage.
T0 = datetime(2026, 8, 18, 6, 0, tzinfo=timezone.utc)
N = 64

# Echte DE-LU-Kurve des 18.08.2026 (energy-charts, stuendlich, 08-24 lokal) auf
# Viertelstunden ausgerollt. Jeder Wert liegt UNTER dem flachen Bezugspreis von
# 250 EUR/MWh - das ist der Winterschutz-Kontext, in dem nichts verkauft wird.
_SPOT_HOURLY = [
    201.38, 174.56, 160.98, 148.95, 137.31, 133.77, 129.85, 131.79,
    132.03, 138.26, 159.01, 192.00, 198.56, 203.60, 200.23, 191.52,
]
SPOT = [p for p in _SPOT_HOURLY for _ in range(4)]
assert len(SPOT) == N

# Die Anlage: 65 kWh / 30 kW, Wirkungsgrad 92 %, Verschleiss-Override 1,0 ct.
BATTERY = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
    wear_cost_ct_per_kwh=1.0,
)
SOC_FLOOR_KWH = BATTERY.soc_min_kwh


def _local_hour(t: int) -> float:
    """Ortszeit-Stunde des Slots (MESZ = UTC+2)."""
    return 8.0 + t * 0.25


def block_load() -> list[float]:
    """Der gemessene Vormittag: 25-30 kW Blocklast von 09:15 bis 13:00, davor
    und danach Grundlast, abends die uebliche Haushaltsspitze."""
    out = []
    for t in range(N):
        h = _local_hour(t)
        if 9.25 <= h < 13.0:
            out.append(26.0)
        elif 17.0 <= h < 21.0:
            out.append(6.0)
        else:
            out.append(4.5)
    return out


def cloudy_pv(peak_kw: float = 6.0) -> list[float]:
    """Tief bedeckt: eine flache Glocke um 13:30 - genug, um den Speicher am
    Nachmittag ein Stueck nachzuladen, zu wenig fuer einen sicheren Refill."""
    import math

    out = []
    for t in range(N):
        h = _local_hour(t)
        if h < 7.0 or h > 20.5:
            out.append(0.0)
            continue
        x = (h - 7.0) / (20.5 - 7.0)
        px = (13.5 - 7.0) / (20.5 - 7.0)
        out.append(round(peak_kw * math.exp(-((x - px) ** 2) / (2 * 0.20**2)), 3))
    return out


def morning_input(
    *,
    soc_pct: float = 25.0,
    pv_peak_kw: float = 6.0,
    import_eur_mwh: list[float] | None = None,
    export_eur_mwh: list[float] | None = None,
    netzladen_erlaubt: bool = False,
) -> OptimizationInput:
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, N),
        prices_eur_mwh=list(SPOT),
        load_kw=block_load(),
        pv_kw=cloudy_pv(pv_peak_kw),
        initial_soc_kwh=soc_pct / 100.0 * BATTERY.capacity_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        max_feed_in_kw=70.0,
        # Festtarif 25,0 ct all-in gegen einen Spot, der nie herankommt.
        import_price_eur_mwh=[250.0] * N if import_eur_mwh is None else import_eur_mwh,
        export_value_eur_mwh=list(SPOT) if export_eur_mwh is None else export_eur_mwh,
    )


def solve(inp: OptimizationInput):
    return solver_module.optimize(inp, plan_id=uuid4(), generated_at=T0)


def parked_slots(plan) -> list[int]:
    """Slots, in denen der Speicher RUHT, obwohl er Energie ueber dem Boden
    haelt, das Haus gerade Strom KAUFT - und der Plan spaeter sehr wohl noch
    entlaedt. Genau der beobachtete Zustand; die einzige ehrliche Ausnahme ist
    der Boden selbst (dann ist nichts mehr da)."""
    out = []
    for i, s in enumerate(plan.slots):
        if abs(s.battery_kw) > 0.05:
            continue
        if s.grid_kw <= 1.0:  # kein nennenswerter Bezug -> nichts zu decken
            continue
        if s.soc_kwh <= SOC_FLOOR_KWH + 0.05:
            continue
        if any(later.battery_kw < -0.05 for later in plan.slots[i + 1 :]):
            out.append(i)
    return out


# ---- 1. die Regression: der Vormittag wird gedeckt, nicht geparkt -----------


@needs_highs
def test_the_block_load_morning_is_covered_now_instead_of_parked():
    """Anlage Pilsting/Herzogau, 18.08.2026 (Beweisfall): Festtarif, EEG-Modus
    (Nur-Solarladen), SoC 25 %, truebe Prognose, 09:15-13:00 eine 26-kW-Blocklast.
    OHNE den Tie-Break parkt der Speicher mitten im 25-ct-Bezug ueber dem Boden
    und gibt dieselbe Energie Stunden spaeter aus; MIT ihm deckt er sofort, bis
    der Boden erreicht ist."""
    plan = solve(morning_input())
    assert parked_slots(plan) == [], (
        "kein Ruhen ueber dem Boden, waehrend das Haus kauft und spaeter noch "
        "entladen wird"
    )
    # Die Blocklast wird wirklich aus dem Speicher bedient, und zwar sofort:
    # bis zum Ende der ersten Blocklast-Stunde ist der Boden erreicht.
    first_block = next(t for t in range(N) if _local_hour(t) >= 9.25)
    soc_after_first_hour = plan.slots[first_block + 3].soc_kwh
    assert soc_after_first_hour <= SOC_FLOOR_KWH + 0.1, (
        "die verfuegbare Energie geht in die laufende Blocklast, nicht in den Abend"
    )


@needs_highs
def test_covering_earlier_moves_the_same_energy_and_the_same_money():
    """Der Beleg, dass hier nur ein GLEICHSTAND gebrochen wird: gegenueber dem
    Plan ohne den Tie-Break aendert sich weder die entladene noch die geladene
    Menge, weder Export noch Kosten - nur der Zeitpunkt."""
    inp = morning_input()
    with_fix = solve(inp)
    saved = solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW
    try:
        solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW = 0.0
        without = solve(inp)
    finally:
        solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW = saved

    def totals(plan):
        return (
            round(sum(-s.battery_kw for s in plan.slots if s.battery_kw < 0) * 0.25, 6),
            round(sum(s.battery_kw for s in plan.slots if s.battery_kw > 0) * 0.25, 6),
            round(sum(max(-s.grid_kw, 0.0) for s in plan.slots) * 0.25, 6),
            round(sum(s.cost_eur for s in plan.slots), 6),
        )

    assert totals(with_fix) == totals(without)
    # ... und der alte Plan hatte das Parken wirklich (sonst beweist der Test
    # oben nichts).
    assert parked_slots(without), "die Vorlage muss den Gleichstand enthalten"


# ---- 2. echte Preissignale schlagen die Frueh-Praeferenz --------------------


@needs_highs
def test_a_real_price_difference_still_beats_the_earliness_preference():
    """Der Tie-Break entspricht ~4e-4 EUR/MWh im letzten Slot - zwei
    Groessenordnungen unter der 0,01-EUR/MWh-Aufloesung echter Preise. Ein
    dynamischer Tarif muss den teuren Stunden weiterhin folgen: hier ist der
    Abend WIRKLICH teurer als der Vormittag, also wartet der Speicher."""
    # Dynamischer Bezug: Vormittag guenstig, Abend teuer (die Blocklast liegt
    # am Vormittag - der Frueh-Anreiz zoege genau dorthin).
    imports = [120.0 if _local_hour(t) < 17.0 else 400.0 for t in range(N)]
    plan = solve(
        morning_input(
            soc_pct=25.0,
            import_eur_mwh=imports,
            export_eur_mwh=[min(p, 100.0) for p in SPOT],
        )
    )
    evening = [t for t in range(N) if _local_hour(t) >= 17.0]
    morning = [t for t in range(N) if _local_hour(t) < 13.0]
    dis_evening = -sum(min(plan.slots[t].battery_kw, 0.0) for t in evening) * 0.25
    dis_morning = -sum(min(plan.slots[t].battery_kw, 0.0) for t in morning) * 0.25
    assert dis_evening > 5.0, "die teure Abendlast wird bedient"
    assert dis_morning <= 1e-6, (
        "der billige Vormittag wird NICHT aus dem Speicher gedeckt - "
        "ein echter Preisunterschied schlaegt die Frueh-Praeferenz"
    )


# ---- 3. Verkaufs-Timing + S2-Winterschutz ----------------------------------


@needs_highs
def test_the_sell_slot_does_not_move_forward():
    """Der Jetzt-Vorzug gilt der LASTDECKUNG, nicht dem Verkaufs-Timing. Eine
    Merchant-Anlage mit einer echten Abendspitze im Einspeisewert verkauft
    weiterhin IN der Spitze - der Tie-Break ist zu klein, um einen realen
    Preisunterschied zu drehen."""
    exports = [80.0 if _local_hour(t) < 19.0 else 300.0 for t in range(N)]
    plan = solve(
        morning_input(
            soc_pct=90.0,
            pv_peak_kw=0.0,
            import_eur_mwh=[90.0] * N,  # Bezug unter der Spitze -> Verkauf lohnt
            export_eur_mwh=exports,
            netzladen_erlaubt=True,
        )
    )
    peak = [t for t in range(N) if _local_hour(t) >= 19.0]
    exported_peak = sum(max(-plan.slots[t].grid_kw, 0.0) for t in peak) * 0.25
    exported_before = (
        sum(max(-plan.slots[t].grid_kw, 0.0) for t in range(N) if t not in peak) * 0.25
    )
    assert exported_peak > 5.0, "die Anlage verkauft in der Spitze"
    assert exported_before <= 1e-6, "und kein Slot davor - nichts wandert nach vorn"


@needs_highs
def test_nothing_is_sold_below_the_import_price():
    """S2-Winterschutz, unangetastet: auf dem Festtarif liegt jeder Spot-Wert
    unter dem Bezugspreis, also darf trotz der Frueh-Praeferenz keine einzige
    kWh ins Netz gehen - die Frueh-Praeferenz macht Entladen teurer, nie
    billiger, schiebt also nie in Richtung Verkauf."""
    for soc in (25.0, 60.0, 92.0):
        plan = solve(morning_input(soc_pct=soc))
        assert all(s.grid_kw >= -1e-6 for s in plan.slots), (
            f"kein Verkauf unter dem Bezugspreis (SoC {soc} %)"
        )


# ---- 4. ohne Gleichstand: byte-identisch -----------------------------------


@needs_highs
def test_a_horizon_without_a_tie_plans_byte_identically():
    """Die Bau-Disziplin des Hauses: der Tie-Break darf NUR Gleichstaende
    brechen. Auf einem Horizont mit lauter verschiedenen Preisen (keine
    Deckungs-Gleichstaende) ist der Plan Zahl fuer Zahl derselbe wie ohne ihn."""
    # Jeder Slot ein eigener Preis, Abstaende weit ueber der Tie-Break-Skala.
    imports = [90.0 + 3.0 * t for t in range(N)]
    exports = [40.0 + 1.0 * t for t in range(N)]
    inp = morning_input(
        soc_pct=70.0,
        pv_peak_kw=12.0,
        import_eur_mwh=imports,
        export_eur_mwh=exports,
        netzladen_erlaubt=True,
    )
    with_fix = solve(inp)
    saved = solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW
    try:
        solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW = 0.0
        without = solve(inp)
    finally:
        solver_module.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW = saved

    assert [s.battery_kw for s in with_fix.slots] == [s.battery_kw for s in without.slots]
    assert [s.grid_kw for s in with_fix.slots] == [s.grid_kw for s in without.slots]
    assert [s.soc_kwh for s in with_fix.slots] == [s.soc_kwh for s in without.slots]
    assert [s.curtail_kw for s in with_fix.slots] == [s.curtail_kw for s in without.slots]


# ---- 5. v1 <-> Co-Optimizer im Lockstep --------------------------------------


@needs_highs
def test_the_co_optimizer_places_the_same_discharge():
    """Der Tie-Break lebt in BEIDEN Solvern (die Golden-Suite-Disziplin). Ihre
    Szenarien ankern im Einspeisewert und enthalten deshalb genau diesen
    Gleichstand NICHT - ein nur in v1 eingebauter Tie-Break faellt dort nicht
    auf. Hier faellt er auf: derselbe Vormittag durch beide Modelle, Slot fuer
    Slot."""
    from voltpilot_optimization.co_solver import _extract_site_plan, build_co_model
    from voltpilot_optimization.entities import from_v1_input
    from voltpilot_optimization.solver import _extract_plan, _solve, build_model

    inp = morning_input()
    m1 = build_model(inp)
    _solve(m1)
    v1 = _extract_plan(m1, inp, plan_id=uuid4(), generated_at=T0)

    co_inp = from_v1_input(inp)
    m2 = build_co_model(co_inp)
    _solve(m2)
    co = _extract_site_plan(m2, co_inp, plan_id=uuid4(), generated_at=T0)

    (storage,) = co.storages
    for t, (a, b) in enumerate(zip(v1.slots, storage.slots)):
        assert b.setpoint_kw == pytest.approx(a.battery_kw, abs=1e-6), f"slot {t}"

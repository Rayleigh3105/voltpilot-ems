"""Erklaerbarkeit Stufe 1: the DECISION DRIVERS the solver used to discard.

Konzept ``data/vp-warum-erklaerbar-e2`` §4.2 (the export), §4.5 (the acceptance
test) and §10 Stufe 1. Stufe 0 removed the invented causes; this level supplies
the facts that let the true ones be told again:

- **A/B the origin of the stored-energy value** - which branch anchored it
  (``einspeisewert`` / ``bezugspreis`` / ``marktpreis`` / ``vorgabe``) and how
  much free PV refill the horizon offers. On 17.08.2026 those two facts WERE
  the answer ("der Speicher hebt die Ladung fuer die kommenden Abende auf, weil
  morgen kaum Sonne gemeldet ist") and the derivation threw both away.
- **C the scarcity of a resting decision** - what the slot's best rejected
  action would have been and by how much it was worse. A margin of 0,0 ct is a
  TIE, and calling it one is the honest reading of the same evening.

Two properties are load-bearing throughout and each has its own test: the
committed plan must stay byte-identical (the export is pure additional output,
never an input), and nothing may be claimed where nothing was measurable
(``None``, never a fabricated 0 or an inadmissible alternative).
"""

from __future__ import annotations

import importlib.util
import math
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

import pytest

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

from voltpilot_optimization.domain import (
    ANCHOR_BEZUGSPREIS,
    ANCHOR_EINSPEISEWERT,
    ANCHOR_MARKTPREIS,
    ANCHOR_VORGABE,
    BatteryParams,
    OptimizationInput,
    derive_terminal_value,
    derive_terminal_value_eur_per_kwh,
    horizon_slot_starts,
)
from voltpilot_optimization.explain import (
    NEXT_BEST_DECKEN,
    NEXT_BEST_NETZLADEN,
    NEXT_BEST_SOLAR_SPEICHERN,
    NEXT_BEST_TIE_CT,
    NEXT_BEST_VERKAUFEN,
    explain,
    resolve_lp_duals,
    slot_duals,
)
from voltpilot_optimization.persistence import plan_rows
from voltpilot_optimization.solver import _solve, build_model, optimize

T0 = datetime(2026, 8, 17, 18, 45, tzinfo=timezone.utc)
BATTERY = BatteryParams(
    capacity_kwh=20.0,
    max_charge_kw=10.0,
    max_discharge_kw=10.0,
    roundtrip_efficiency=0.90,
    wear_cost_ct_per_kwh=1.0,
)


def make_input(
    *,
    n: int = 96,
    load: float | list[float] = 2.0,
    pv: float | list[float] = 0.0,
    spot: float | list[float] = 50.0,
    import_price: float | list[float] | None = None,
    export_value: float | list[float] | None = None,
    battery: BatteryParams = BATTERY,
    soc0_kwh: float = 17.2,  # 86% of 20 kWh - the captain's evening
    netzladen_erlaubt: bool = False,
    terminal_value_eur_per_kwh: float | None = None,
    start: datetime = T0,
) -> OptimizationInput:
    def series(v):
        return list(v) if isinstance(v, list) else [float(v)] * n

    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(start, n),
        prices_eur_mwh=series(spot),
        load_kw=series(load),
        pv_kw=series(pv),
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=None if import_price is None else series(import_price),
        export_value_eur_mwh=None if export_value is None else series(export_value),
        terminal_value_eur_per_kwh=terminal_value_eur_per_kwh,
    )


def truebe_nacht(n: int = 96) -> OptimizationInput:
    """The 17.08.2026 evening: a battery at 86%, a flat retail tariff, and a
    horizon that is honestly almost PV-less (dense cloud) - the constellation
    in which the freeze happened and the "Preisunterschied" sentence lied."""
    pv = [0.0] * n
    for t in range(40, 60):  # a thin, cloudy midday
        pv[t] = 0.6
    return make_input(
        n=n,
        pv=pv,
        load=2.0,
        spot=50.0,
        import_price=250.0,
        export_value=50.0,
        netzladen_erlaubt=False,
    )


def truebe_nacht_mit_abendspitze(n: int = 96) -> OptimizationInput:
    """The same cloudy horizon, but on a DYNAMIC tariff whose evening is
    genuinely more expensive - so a part of the charge is honestly reserved
    and the plan really does rest with a charged battery.

    Needed since the Jetzt-Vorzug (captain 2026-08-18,
    ``solver.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW``): on a FLAT tariff a rest at
    a covering TIE no longer happens - the plan now spends the tie on covering,
    which is the whole point. A rest with a charged battery therefore needs a
    reason, and here it is the SoC path (covering the cheap slots early would
    starve the expensive evening), while the marginal trade in the resting slot
    itself stays the same tie the export must report as one."""
    pv = [0.0] * n
    for t in range(40, 60):
        pv[t] = 0.6
    return make_input(
        n=n,
        pv=pv,
        load=2.0,
        spot=50.0,
        import_price=[250.0] * 72 + [420.0] * 24,
        export_value=50.0,
        netzladen_erlaubt=False,
    )


def sonniger_tag(n: int = 96) -> OptimizationInput:
    """The ordinary summer day: a real PV bell, a spot curve with a midday
    trough - the horizon whose own surplus refills the battery for free."""
    pv = [max(0.0, 14.0 * math.sin(math.pi * (t - 16) / 56)) if 16 < t < 72 else 0.0
          for t in range(n)]
    spot = [40.0 + 60.0 * math.sin(math.pi * t / 48) for t in range(n)]
    return make_input(
        n=n,
        pv=pv,
        load=2.0,
        spot=spot,
        import_price=320.0,
        export_value=spot,
        soc0_kwh=6.0,
        netzladen_erlaubt=False,
        start=datetime(2026, 6, 20, 4, 0, tzinfo=timezone.utc),
    )


def solve(inp: OptimizationInput, **kwargs):
    return optimize(inp, plan_id=uuid4(), generated_at=T0, **kwargs)


# ---------------------------------------------------------------------------
# A/B - the origin of the value of stored energy.
# ---------------------------------------------------------------------------


def test_the_value_is_unchanged_and_the_float_entry_point_still_answers():
    # The Stufe-1 change RETURNS what the derivation always knew; it must not
    # move the number a single bit, or every plan on the platform would shift.
    for inp in (truebe_nacht(), sonniger_tag(), make_input(netzladen_erlaubt=True)):
        facts = inp.effective_terminal_value()
        assert inp.effective_terminal_value_eur_per_kwh() == facts.v_end
        assert derive_terminal_value_eur_per_kwh(
            import_prices=inp.import_prices,
            export_values=inp.export_values,
            pv_kw=inp.pv_kw,
            load_kw=inp.load_kw,
            slot_hours=inp.slot_hours,
            max_charge_kw=inp.battery.max_charge_kw,
            usable_band_kwh=inp.battery.soc_max_kwh
            - inp.battery.soc_floor_kwh(inp.initial_soc_kwh),
            one_way_efficiency=inp.battery.one_way_efficiency,
            wear_eur_per_kwh_each_way=inp.battery.wear_cost_eur_per_kwh_each_way,
            grid_charge_allowed=inp.netzladen_erlaubt,
        ) == facts.v_end


def test_a_trueb_horizon_anchors_on_the_avoided_grid_import():
    # THE 17.08. fact. Almost every slot is a deficit slot, so the low quantile
    # lands in the import range: the stored kWh is worth the Bezug it replaces,
    # which is exactly why "hold for the coming evenings" was the true story.
    facts = truebe_nacht().effective_terminal_value()
    assert facts.anchor_kind == ANCHOR_BEZUGSPREIS
    assert facts.refill_free_pct == 0.0  # no free surplus at a positive price


def test_a_sunny_horizon_anchors_on_the_forgone_feed_in_and_reports_free_refill():
    facts = sonniger_tag().effective_terminal_value()
    assert facts.anchor_kind == ANCHOR_EINSPEISEWERT
    assert facts.refill_free_pct is not None and facts.refill_free_pct > 0.0


def test_grid_charging_permission_makes_the_anchor_the_market():
    facts = make_input(netzladen_erlaubt=True, import_price=250.0,
                       export_value=50.0).effective_terminal_value()
    assert facts.anchor_kind == ANCHOR_MARKTPREIS


def test_a_pinned_terminal_value_derives_nothing_and_says_so():
    # An env-pinned V_end has no anchor and no refill share - claiming one
    # would describe a derivation that never ran.
    facts = make_input(terminal_value_eur_per_kwh=0.21).effective_terminal_value()
    assert facts == replace(facts, v_end=0.21, anchor_kind=ANCHOR_VORGABE,
                            refill_free_pct=None, guard_capped=False)


def test_the_free_refill_share_is_the_absorbable_surplus_over_the_usable_band():
    # Hand-computed: 4 slots x 15 min x 5 kW absorbable surplus at a zero
    # export value = 5 kWh free against a 10 kWh band = 50%.
    n = 8
    pv = [0.0] * n
    load = [0.0] * n
    export = [10.0] * n
    for t in range(4):
        pv[t] = 5.0
        export[t] = 0.0  # feeding in earns nothing -> storing is free
    facts = derive_terminal_value(
        import_prices=[100.0] * n,
        export_values=export,
        pv_kw=pv,
        load_kw=load,
        slot_hours=0.25,
        max_charge_kw=8.0,
        usable_band_kwh=10.0,
        one_way_efficiency=0.95,
        wear_eur_per_kwh_each_way=0.0,
        grid_charge_allowed=False,
    )
    assert facts.refill_free_pct == pytest.approx(50.0)


def test_an_unevaluable_band_reports_no_share_instead_of_zero():
    # A zero usable band (a full battery pinned by its reserve) cannot be
    # "0% refilled" - the question has no answer, and 0 would read as "the
    # horizon offers nothing", which is a different statement.
    facts = derive_terminal_value(
        import_prices=[100.0] * 4,
        export_values=[100.0] * 4,
        pv_kw=[5.0] * 4,
        load_kw=[0.0] * 4,
        slot_hours=0.25,
        max_charge_kw=8.0,
        usable_band_kwh=0.0,
        one_way_efficiency=0.95,
        wear_eur_per_kwh_each_way=0.0,
        grid_charge_allowed=False,
    )
    assert facts.refill_free_pct is None


def test_the_dispersion_guard_reports_when_it_bound():
    # A genuinely FLAT curve is the case step 3 exists for: the anchor equals
    # the horizon's best use, so without the guard V_end would sit AT it and
    # the discharge gradient would be exactly 0 (the pilot-plant freeze). The
    # fact is solver-internal - it is reported on the object, never persisted.
    facts = derive_terminal_value(
        import_prices=[100.0] * 8,
        export_values=[100.0] * 8,
        pv_kw=[0.0] * 8,
        load_kw=[3.0] * 8,
        slot_hours=0.25,
        max_charge_kw=5.0,
        usable_band_kwh=10.0,
        one_way_efficiency=0.95,
        wear_eur_per_kwh_each_way=0.0,
        grid_charge_allowed=False,
    )
    assert facts.guard_capped is True
    # ... and a curve with room to spare is not capped.
    assert derive_terminal_value(
        import_prices=[400.0] * 8,
        export_values=[50.0] * 8,
        pv_kw=[0.0] * 8,
        load_kw=[3.0] * 8,
        slot_hours=0.25,
        max_charge_kw=5.0,
        usable_band_kwh=10.0,
        one_way_efficiency=0.95,
        wear_eur_per_kwh_each_way=0.0,
        grid_charge_allowed=False,
    ).guard_capped is False


# ---------------------------------------------------------------------------
# C - the scarcity of a resting decision.
# ---------------------------------------------------------------------------


@needs_highs
def test_an_active_slot_reports_no_next_best():
    # At the optimum the marginal benefit of the CHOSEN action is 0, so a
    # "next best" number on an active slot would be noise dressed as a fact.
    plan = solve(sonniger_tag())
    active = [s for s in plan.slots if abs(s.battery_kw) > 0.05]
    assert active, "scenario must exercise active slots"
    for s in active:
        assert s.why_next_best is None
        assert s.why_next_best_margin_ct is None


@needs_highs
def test_the_17_08_evening_spends_the_tie_on_covering_and_still_explains_why():
    """The acceptance case (§4.5), as it reads AFTER the Jetzt-Vorzug (captain
    2026-08-18): a trueb horizon still anchors on the Bezugspreis with no free
    refill on offer - those two run facts ARE the answer to "why is a stored
    kWh worth 23 ct here" and the derivation used to throw both away. What
    changed is the ACT: covering now vs. later is still the same money, and
    ``solver.EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW`` now spends that tie on the
    house instead of resting. So the evening no longer rests with a charged
    battery at all - it reads ``eigenverbrauch`` ("deckt Ihren Verbrauch"),
    which is exactly the honest driver, and every remaining rest is at the
    floor where there is nothing left to compare against."""
    plan = solve(truebe_nacht())
    assert plan.why_terminal_anchor == ANCHOR_BEZUGSPREIS
    assert plan.why_refill_free_pct == 0.0
    resting_with_charge = [
        s for s in plan.slots
        if s.slot_role == "warten" and "soc_floor" not in (s.slot_flags or ())
    ]
    assert not resting_with_charge, (
        "the flat-tariff tie is spent on covering, never parked - a rest here "
        "would be the 2026-08-18 defect"
    )
    covering = [s for s in plan.slots if s.slot_role == "eigenverbrauch"]
    assert covering, "the night is served from the battery"
    # And it is served from the FIRST slot on - the Jetzt-Vorzug is a timing
    # statement, so the first slot must be one of them.
    assert plan.slots[0].slot_role == "eigenverbrauch"


@needs_highs
def test_a_reserved_rest_names_decken_and_calls_the_tie_a_tie():
    """The export's C-facts on a rest that is genuinely right: with a real
    evening peak the plan holds a part of its charge back (covering the cheap
    slots early would starve the expensive ones), and the resting slot reports
    what it rejected - covering - and that the marginal trade itself was a TIE,
    not a decision. Since the Jetzt-Vorzug this is where that reading lives:
    on a flat tariff the plan no longer rests at such a tie."""
    plan = solve(truebe_nacht_mit_abendspitze())
    assert plan.why_terminal_anchor == ANCHOR_BEZUGSPREIS
    resting = [
        s for s in plan.slots
        if s.slot_role == "warten" and "soc_floor" not in (s.slot_flags or ())
    ]
    assert resting, "the plan must actually rest with a charged battery"
    assert all(s.why_next_best == NEXT_BEST_DECKEN for s in resting)
    assert all(abs(s.why_next_best_margin_ct) <= NEXT_BEST_TIE_CT for s in resting)
    # The reserve is real: the expensive evening is served from the battery.
    evening = plan.slots[72:]
    assert -sum(min(s.battery_kw, 0.0) for s in evening) * 0.25 > 5.0


@needs_highs
def test_a_margin_is_never_positive_and_a_name_never_stands_alone():
    for inp in (truebe_nacht(), sonniger_tag(), make_input(netzladen_erlaubt=True)):
        plan = solve(inp)
        for s in plan.slots:
            if abs(s.battery_kw) > 0.05:
                continue
            # Name and margin are one statement: never one without the other.
            assert (s.why_next_best is None) == (s.why_next_best_margin_ct is None)
            if s.why_next_best is not None:
                # A rejected option is by definition not better than the
                # chosen one; a positive margin would be plainly wrong.
                assert s.why_next_best_margin_ct <= 0.0


@needs_highs
def test_a_slot_with_no_admissible_alternative_claims_nothing():
    # An empty battery on an EEG plant in a PV-less slot: discharging is below
    # the floor, grid charging is forbidden, and there is no surplus to store.
    # "Nothing else was possible" is honestly not a margin, so BOTH fields stay
    # empty rather than naming a regret about an impossible action.
    plan = solve(truebe_nacht())
    empty_rest = [
        s for s in plan.slots
        if abs(s.battery_kw) <= 0.05
        and "soc_floor" in (s.slot_flags or ())
        and s.pv_kw <= s.load_kw
    ]
    assert empty_rest, "the trueb night must run the battery down"
    for s in empty_rest:
        assert s.why_next_best is None
        assert s.why_next_best_margin_ct is None


@needs_highs
def test_eeg_mode_never_offers_grid_charging_as_the_rejected_option():
    # In EEG mode charging from the grid is not "worse", it is FORBIDDEN -
    # reporting a margin against it would invent a regret about an action the
    # plant may never take.
    plan = solve(truebe_nacht())
    assert all(s.why_next_best != NEXT_BEST_NETZLADEN for s in plan.slots)
    merchant = solve(make_input(netzladen_erlaubt=True, import_price=250.0,
                                export_value=50.0))
    assert any(s.why_next_best == NEXT_BEST_NETZLADEN for s in merchant.slots)


@needs_highs
def test_a_full_battery_offers_no_charging_alternative():
    # soc_max binds: charging is impossible, so only the discharge side may be
    # named. The horizon is a cheap night before an expensive morning, so the
    # plan fills up and then waits.
    n = 48
    spot = [10.0] * (n // 2) + [300.0] * (n - n // 2)
    inp = make_input(
        n=n, spot=spot, import_price=spot, export_value=spot,
        load=0.5, pv=0.0, soc0_kwh=2.0, netzladen_erlaubt=True,
    )
    plan = solve(inp)
    full = [s for s in plan.slots
            if s.slot_flags and "soc_max" in s.slot_flags and abs(s.battery_kw) <= 0.05]
    assert full, "scenario must actually fill the battery and then rest"
    for s in full:
        assert s.why_next_best in (NEXT_BEST_DECKEN, NEXT_BEST_VERKAUFEN)


@needs_highs
def test_a_pv_surplus_slot_offers_storing_the_surplus():
    # With PV above the load the admissible charge alternative is the SOLAR
    # one; the grid one stays out (EEG) and the discharge side would export.
    plan = solve(sonniger_tag())
    surplus_rest = [
        s for s in plan.slots
        if abs(s.battery_kw) <= 0.05 and s.pv_kw - s.load_kw > 1.0
    ]
    if surplus_rest:  # a very sunny plan may never rest under surplus
        assert all(
            s.why_next_best in (NEXT_BEST_SOLAR_SPEICHERN, NEXT_BEST_VERKAUFEN)
            for s in surplus_rest
        )


@needs_highs
def test_the_margin_agrees_with_the_lp_reduced_costs():
    # The concept's cross-check (§12 limit 1): the analytical formulas and the
    # reduced costs the LP re-solve already yields must tell the SAME story.
    # Compared on the DISCHARGE side of resting slots, where the fixed
    # is_charging gate leaves the reduced cost meaningful (with the binary at
    # 0 the charge side is pinned by its gate, so its rc is degenerate - the
    # documented reason the analytical formulas are the exported truth).
    #
    # The formulas use the site's CUSTOMER prices, the LP uses pi; they
    # coincide except where §14a or the peak module deform a slot, and this
    # scenario has neither.
    inp = truebe_nacht()
    model = build_model(inp)
    _solve(model)
    duals = slot_duals(model, inp)
    _lp_duals, rcs = resolve_lp_duals(model)

    from pyomo.environ import value

    eta = inp.battery.one_way_efficiency
    wear = inp.battery.wear_cost_eur_per_kwh_each_way
    dt = inp.slot_hours
    checked = 0
    for t in range(inp.slots):
        charge = float(value(model.charge[t]))
        discharge = float(value(model.discharge[t]))
        if abs(charge - discharge) > 0.05 or discharge > 1e-6:
            continue
        if float(value(model.is_charging[t])) > 0.5:
            continue  # the discharge gate pins it: rc is not the economics
        # rc of a variable at its lower bound = marginal objective INCREASE
        # per unit; the gain of taking the action is its negation, per kWh.
        gain_from_rc = -rcs[model.discharge[t]] / dt
        gain_analytic = duals[t].pi_eur_kwh - duals[t].lambda_eur_kwh / eta - wear
        assert abs(gain_from_rc - gain_analytic) < 1e-4  # EUR/kWh
        checked += 1
    assert checked > 0, "the cross-check must not pass vacuously"


# ---------------------------------------------------------------------------
# Safety: the export is output, never input.
# ---------------------------------------------------------------------------


@needs_highs
def test_the_committed_plan_is_byte_identical_with_and_without_the_export():
    for inp in (truebe_nacht(), sonniger_tag()):
        with_why = solve(inp)
        without = solve(inp, explain_plan=False)
        assert [s.battery_kw for s in with_why.slots] == [
            s.battery_kw for s in without.slots
        ]
        assert [s.curtail_kw for s in with_why.slots] == [
            s.curtail_kw for s in without.slots
        ]
        assert [s.soc_kwh for s in with_why.slots] == [s.soc_kwh for s in without.slots]
        # ... and the plan WITHOUT the layer claims nothing.
        assert without.why_terminal_anchor is None
        assert without.why_refill_free_pct is None
        assert all(s.why_next_best is None for s in without.slots)


@needs_highs
def test_persistence_carries_the_run_facts_on_every_row_and_the_slot_facts_per_slot():
    # The reserved-rest horizon: it carries BOTH kinds of row (a resting slot
    # with a margin, an active one without). The flat-tariff twin no longer
    # rests with a charged battery since the Jetzt-Vorzug.
    plan = solve(truebe_nacht_mit_abendspitze())
    rows = plan_rows(plan)
    # The four new columns are the last four of the tuple, in the INSERT's
    # order: anchor, refill share, next best, margin.
    assert all(r[-4] == plan.why_terminal_anchor for r in rows)
    assert all(r[-3] == plan.why_refill_free_pct for r in rows)
    assert [r[-2] for r in rows] == [s.why_next_best for s in plan.slots]
    assert [r[-1] for r in rows] == [s.why_next_best_margin_ct for s in plan.slots]
    # A resting slot carries its margin, an active one carries nothing.
    assert any(r[-2] is not None for r in rows)
    assert any(r[-2] is None for r in rows)

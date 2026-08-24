"""Terminal energy value (P3, optimizer-redesign Stage 3, critique finding F3).

The hard ``soc_T >= soc_0`` floor froze an EEG battery on every low-PV day
(critique Experiment 1: a 90%-full battery idled through a 250 EUR/MWh evening
because no PV surplus meant nothing could charge, hence nothing was allowed to
discharge) and forced merchant plans into uneconomic end-of-horizon buy-backs.
P3 replaces it with an objective credit ``V_end * (soc_T - soc_0)``.

These tests pin the three behavioral results the redesign demands:
1. the F3 scenario now DISCHARGES into the evening peak,
2. a horizon-end dump for a trivial gain is still avoided (V_end holds it -
   proven by the contrast with an explicit V_end = 0, which dumps),
3. a merchant end-state is no longer forced into a buy-back,
plus the V_end derivation itself (quantile anchor, wear/eta discount, zero
floor, env override/validation). Solver tests need the HiGHS wheel.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.config import (
    TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH,
    TERMINAL_VALUE_MARGIN_EUR_PER_KWH,
    terminal_value_override_eur_per_kwh,
    terminal_value_quantile,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 6, 0, tzinfo=timezone.utc)
BATTERY = BatteryParams(
    capacity_kwh=10.0,
    max_charge_kw=5.0,
    max_discharge_kw=5.0,
    roundtrip_efficiency=0.92,
)
ETA = BATTERY.one_way_efficiency
WEAR_EUR_MWH = BATTERY.wear_cost_eur_per_kwh_each_way * 1000.0  # 20 at default


def make_input(
    prices: list[float],
    load: float = 2.0,
    pv: float | list[float] = 0.0,
    soc0_kwh: float = 9.0,
    netzladen_erlaubt: bool = False,
    terminal_value_eur_per_kwh: float | None = None,
    max_feed_in_kw: float | None = None,
) -> OptimizationInput:
    n = len(prices)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[load] * n,
        pv_kw=[pv] * n if isinstance(pv, (int, float)) else pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        terminal_value_eur_per_kwh=terminal_value_eur_per_kwh,
        max_feed_in_kw=max_feed_in_kw,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


# ---- the F3 scenario: full battery, cloudy day, expensive evening ------------


@needs_highs
def test_f3_eeg_site_discharges_its_full_battery_into_the_evening_peak():
    """Critique Experiment 1, reproduced: EEG mode, battery 90% full, NO PV
    for the whole 24h horizon (cloudy), a 250 EUR/MWh evening peak. The old
    terminal floor forbade ALL discharge (charging was impossible, so the end
    SoC could never recover) - 9 kWh of stored solar idled through the peak
    while the household imported. Now the stored energy serves the peak."""
    n = 96
    prices = [100.0] * 80 + [250.0] * 16  # cloudy day, expensive evening
    plan = solve(make_input(prices, load=2.0, pv=0.0, soc0_kwh=9.0))

    peak = plan.slots[80:]
    discharged_kwh = -sum(min(s.battery_kw, 0.0) for s in peak) * 0.25
    assert discharged_kwh > 5.0, "the frozen battery must discharge into the peak"
    # EEG mode still never charges (no PV is produced at all).
    assert all(s.battery_kw <= 1e-6 for s in plan.slots)
    # The horizon ends BELOW the start SoC - exactly what the old hard floor
    # forbade and what P3 legalizes.
    assert plan.slots[-1].soc_kwh < 9.0 - 5.0
    # And it is worth real money vs. the battery-idle baseline.
    assert plan.savings_eur > 1.0


@needs_highs
def test_f3_stored_energy_waits_for_the_peak_instead_of_dumping_early():
    # Same scenario: the cheap 100-slots BEFORE the peak must not discharge -
    # the terminal value (and the better peak ahead) both beat realizing at
    # the anchor price.
    n = 96
    prices = [100.0] * 80 + [250.0] * 16
    plan = solve(make_input(prices, load=2.0, pv=0.0, soc0_kwh=9.0))
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots[:80])


# ---- no dump for a trivial gain ----------------------------------------------


@needs_highs
def test_cheap_end_of_horizon_tail_is_held_not_dumped():
    """Battery full, prices decline into a cheap tail: dumping at the 100-tail
    would earn a little NOW, but the derived V_end (anchored at the horizon's
    dominant 200 level) values holding higher - the plan keeps the energy for
    tomorrow instead of realizing a trivial gain."""
    prices = [200.0] * 80 + [100.0] * 16
    inp = make_input(
        prices, load=2.0, pv=0.0, soc0_kwh=BATTERY.soc_max_kwh,
        netzladen_erlaubt=True,
    )
    plan = solve(inp)
    tail = plan.slots[80:]
    assert all(s.battery_kw >= -1e-6 for s in tail), "no dump into the cheap tail"
    # Nothing better than the anchor exists in-horizon either (200 == anchor
    # is an exact tie, broken toward holding), so the battery holds outright.
    assert plan.slots[-1].soc_kwh == pytest.approx(BATTERY.soc_max_kwh, abs=1e-3)

    # CONTRAST: with the terminal value explicitly zeroed (stored energy worth
    # nothing at the horizon end), the same input dumps - proving V_end is
    # what prevents the dump, not some leftover constraint.
    dumped = solve(
        make_input(
            prices, load=2.0, pv=0.0, soc0_kwh=BATTERY.soc_max_kwh,
            netzladen_erlaubt=True, terminal_value_eur_per_kwh=0.0,
        )
    )
    assert dumped.slots[-1].soc_kwh == pytest.approx(BATTERY.soc_min_kwh, abs=1e-3)


@needs_highs
def test_plan_is_stamped_with_the_effective_terminal_value_it_credited():
    """FK2: the value the objective actually credited per stored kWh must ride
    on the plan (and from there into schedule.terminal_value_eur_per_kwh), for
    both the derived and the explicit-override case - the portal's banked-value
    line is computed from exactly this number."""
    inp = make_input([100.0] * 80 + [250.0] * 16)
    plan = solve(inp)
    assert plan.terminal_value_eur_per_kwh == pytest.approx(
        inp.effective_terminal_value_eur_per_kwh(), abs=1e-6
    )
    explicit = solve(make_input([100.0] * 96, terminal_value_eur_per_kwh=0.05))
    assert explicit.terminal_value_eur_per_kwh == pytest.approx(0.05, abs=1e-9)


@needs_highs
def test_flat_curve_still_plans_an_idle_battery():
    # The long-standing product property "zero savings on a flat curve" must
    # survive P3: discharging at exactly the derived anchor price is an exact
    # tie with holding, broken toward idle by the epsilon tie-breaks.
    plan = solve(
        make_input([100.0] * 96, load=5.0, pv=0.0, soc0_kwh=5.0,
                   netzladen_erlaubt=True)
    )
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert plan.savings_eur == pytest.approx(0.0, abs=1e-6)


# ---- merchant end-states: no forced buy-back ----------------------------------


@needs_highs
def test_merchant_site_is_not_forced_to_buy_back_after_selling_the_peak():
    """Early peak, then a long 200-priced rest: the old terminal floor forced
    the plan to re-purchase whatever it sold at 250 (at 200 + wear + losses -
    an uneconomic mandatory buy-back). Now it sells the peak and simply ends
    lower: re-charging at 200 is worth less than the terminal value gains."""
    prices = [250.0] * 16 + [200.0] * 80
    plan = solve(
        make_input(prices, load=2.0, pv=0.0, soc0_kwh=9.0, netzladen_erlaubt=True)
    )
    peak_discharged = -sum(min(s.battery_kw, 0.0) for s in plan.slots[:16]) * 0.25
    assert peak_discharged > 5.0, "the early 250 peak is sold"
    charged_kwh = sum(max(s.battery_kw, 0.0) for s in plan.slots) * 0.25
    assert charged_kwh < 1e-6, "no forced (or speculative) buy-back at 200"
    assert plan.slots[-1].soc_kwh < 9.0 - 5.0


# ---- the V_end derivation ------------------------------------------------------


def test_derived_value_is_the_wear_and_efficiency_discounted_quantile(monkeypatch):
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    # 96 slots, 30th percentile of the best-use prices: index int(0.3*95)=28
    # of the ascending sort -> 100 on this curve.
    prices = [100.0] * 48 + [200.0] * 48
    inp = make_input(prices, netzladen_erlaubt=True)
    expected = ETA * (100.0 - WEAR_EUR_MWH) / 1000.0
    assert inp.effective_terminal_value_eur_per_kwh() == pytest.approx(expected)


def _asymmetric_eeg_input(
    *,
    spot: list[float],
    import_eur_mwh: list[float],
    export_eur_mwh: list[float],
    pv_kw: list[float],
    load_kw: float = 2.0,
    soc0_kwh: float = 5.0,
    terminal_value_eur_per_kwh: float | None = None,
) -> OptimizationInput:
    n = len(spot)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=spot,
        load_kw=[load_kw] * n,
        pv_kw=pv_kw,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=False,
        import_price_eur_mwh=import_eur_mwh,
        export_value_eur_mwh=export_eur_mwh,
        terminal_value_eur_per_kwh=terminal_value_eur_per_kwh,
    )


def test_derived_value_is_the_replacement_cost_not_the_best_use_price(monkeypatch):
    """THE defect (scout vp-fahrplan-idle-n7). A retail site: import (fest 430)
    dwarfs the export value (82). The old derivation anchored on the best USE
    (``max(import, export)`` = 430), asserting that a stored kWh carries the
    retail price as scarcity value - which froze the battery, because no spot
    peak ever reaches German retail.

    ``V_end`` is a REPLACEMENT cost: this plant is in EEG mode, so only PV may
    refill the battery, and wherever the horizon OFFERS that refill (PV surplus
    slots - the pilot plant has 70 kWp, its summer horizon is full of them) the
    marginal cost is the forgone feed-in (82), not the retail price it might
    later avoid. The retail level plays no role at all then - a twin with
    bare-spot import derives the identical value."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 96
    # 32 surplus slots (a sunny third of the day) put the 30th-percentile
    # anchor (index 28) firmly in the refill-on-offer range. The export series
    # carries a small evening peaklet so the best in-horizon use stays clear of
    # the anchor (the strict-dispersion guard is not what is under test here).
    pv = [20.0] * 32 + [0.0] * 64
    exports = [82.0] * 92 + [200.0] * 4
    retail = _asymmetric_eeg_input(
        spot=[100.0] * n,
        import_eur_mwh=[430.0] * n,
        export_eur_mwh=exports,
        pv_kw=pv,
    )
    expected = ETA * (82.0 - WEAR_EUR_MWH) / 1000.0
    assert retail.effective_terminal_value_eur_per_kwh() == pytest.approx(expected)
    # and emphatically NOT the old best-use anchor
    assert retail.effective_terminal_value_eur_per_kwh() < ETA * (430.0 - WEAR_EUR_MWH) / 1000.0
    # Gegenprobe: where the refill is on offer the import level is irrelevant -
    # a spot-priced twin (Bezug NOT dearer than the feed-in) values identically.
    spot_priced = _asymmetric_eeg_input(
        spot=[100.0] * n,
        import_eur_mwh=[82.0] * n,
        export_eur_mwh=exports,
        pv_kw=pv,
    )
    assert spot_priced.effective_terminal_value_eur_per_kwh() == pytest.approx(expected)


def test_eeg_anchor_carries_the_avoided_import_when_nothing_refills(monkeypatch):
    """S2 (scout vp-nacht-bezug-e7 §1.5): the same retail site on a winter/
    bad-weather horizon with NO PV surplus anywhere. There is no forgone
    feed-in because there is nothing to feed in - refilling is impossible, and
    the true worth of a stored kWh is the (high) import it lets the house
    avoid. The pre-S2 export-only anchor said 82 here, and the plan then sold
    the battery into any cheap tail above ~3 ct - energy the house re-buys at
    43 ct the next morning.

    The strict-dispersion guard is untouched: the flat 430 import series has
    zero dispersion, so the anchor lands ON the best in-horizon use value and
    is held one margin BELOW it (the flat-tariff trap: a constant ``fest``
    import series must never lift ``V_end`` over the horizon's best use)."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 96
    winter = _asymmetric_eeg_input(
        spot=[100.0] * n,
        import_eur_mwh=[430.0] * n,
        export_eur_mwh=[82.0] * n,
        pv_kw=[0.0] * n,
    )
    # The deficit entries carry the avoided import MINUS the cover-now discount
    # (Herzogau 17.08.2026: without it, covering tonight vs holding was an
    # exact tie frozen to "hold" by the idle tie-break). The dispersion guard
    # no longer binds here - the discounted anchor already sits below best use.
    expected = ETA * (
        (430.0 - TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH) / 1000.0
        - WEAR_EUR_MWH / 1000.0
    )
    assert winter.effective_terminal_value_eur_per_kwh() == pytest.approx(expected, rel=1e-12)
    # strictly below the best in-horizon use - the guard survives S2
    assert winter.effective_terminal_value_eur_per_kwh() < ETA * (430.0 - WEAR_EUR_MWH) / 1000.0
    # and far above the pre-S2 export-only anchor
    assert winter.effective_terminal_value_eur_per_kwh() > ETA * (82.0 - WEAR_EUR_MWH) / 1000.0


@needs_highs
def test_eeg_winter_day_banks_stored_energy_for_the_house_instead_of_selling_out():
    """S2 behaviorally: EEG plant, cloudy day (no PV), all-in import = spot +
    25 ct, tiny house load - so the in-horizon load cannot absorb the battery
    and the old plan SOLD the surplus into the 20 ct evening (the report's
    sell-out: feed-in at spot while tomorrow's Bezug costs 30+ ct). With the
    avoided import in the anchor, holding beats every export on this horizon:
    the plan never exports a single slot and banks the energy for the house.

    The contrast run (V_end explicitly zeroed) proves the anchor is what
    prevents the sell-out; the symmetric twin (Bezug == feed-in, nothing
    dearer to avoid) still sells the evening - the hold is driven by the
    import/export asymmetry, not by a new blanket conservatism."""
    n = 96
    spot = [50.0] * 40 + [200.0] * 24 + [60.0] * 32
    imports = [s + 250.0 for s in spot]

    plan = solve(
        _asymmetric_eeg_input(
            spot=spot, import_eur_mwh=imports, export_eur_mwh=spot,
            pv_kw=[0.0] * n, load_kw=0.2, soc0_kwh=9.0,
        )
    )
    assert all(s.grid_kw >= -1e-6 for s in plan.slots), "kein Ausverkauf ins Netz"
    # Since the cover-now discount the battery SERVES the house instead of
    # banking past it: the drain equals the day's house coverage (0.2 kW),
    # and still not a single slot exports below the Bezugspreis.
    covered = sum(-s.battery_kw * 0.25 for s in plan.slots if s.battery_kw < 0)
    assert covered == pytest.approx(0.2 * 24 / ETA, rel=0.10), "Entladung == Hausdeckung"

    dumped = solve(
        _asymmetric_eeg_input(
            spot=spot, import_eur_mwh=imports, export_eur_mwh=spot,
            pv_kw=[0.0] * n, load_kw=0.2, soc0_kwh=9.0,
            terminal_value_eur_per_kwh=0.0,
        )
    )
    assert any(s.grid_kw < -1e-6 for s in dumped.slots), "without V_end it sells"
    assert dumped.slots[-1].soc_kwh == pytest.approx(BATTERY.soc_min_kwh, abs=1e-3)

    symmetric = solve(
        _asymmetric_eeg_input(
            spot=spot, import_eur_mwh=spot, export_eur_mwh=spot,
            pv_kw=[0.0] * n, load_kw=0.2, soc0_kwh=9.0,
        )
    )
    assert any(s.grid_kw < -1e-6 for s in symmetric.slots), (
        "where Bezug is not dearer, selling the 200-evening stays correct"
    )


def test_replacement_cost_is_the_cheaper_of_grid_and_forgone_export(monkeypatch):
    """With grid charging permitted the battery refills from whichever source
    is cheaper, so the anchor is ``min(import, export)`` - here the 60 spot
    import, not the 82 the export would forgo."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 96
    inp = OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=[60.0] * n,
        load_kw=[2.0] * n,
        pv_kw=[0.0] * n,
        initial_soc_kwh=5.0,
        netzladen_erlaubt=True,
        import_price_eur_mwh=[60.0] * n,
        export_value_eur_mwh=[82.0] * n,
    )
    assert inp.effective_terminal_value_eur_per_kwh() == pytest.approx(
        ETA * (60.0 - WEAR_EUR_MWH) / 1000.0
    )


def test_symmetric_spot_pricing_is_unchanged_by_the_replacement_anchor(monkeypatch):
    """Regression pin for the plants that already worked: under the symmetric
    model (``ohne`` - import == export == spot) ``min`` and ``max`` coincide,
    so the charge-side anchor is a mathematical no-op."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    prices = [40.0] * 30 + [100.0] * 40 + [260.0] * 26
    for netzladen in (True, False):
        inp = make_input(prices, netzladen_erlaubt=netzladen)
        # 30th percentile of the ascending sort: index int(0.3*95) = 28 -> 40.
        assert inp.effective_terminal_value_eur_per_kwh() == pytest.approx(
            ETA * (40.0 - WEAR_EUR_MWH) / 1000.0
        )


def test_free_pv_refill_scales_the_value_to_zero(monkeypatch):
    """A plant whose horizon offers enough zero/negative-priced PV surplus to
    refill the whole usable band carries NO scarcity value in stored energy -
    it will be full again for free. This is the "tomorrow's PV refills it"
    truth that must stop a full battery sitting through an evening peak."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    # Ten zero-priced slots, then a dear rest. The 30th percentile lands on
    # 150 (only ten zeros), and the 300 peak keeps the dispersion guard clear
    # of the anchor, so the free-PV cap is the only thing under test.
    prices = [0.0] * 10 + [150.0] * 76 + [300.0] * 10
    band = BATTERY.soc_max_kwh - BATTERY.soc_min_kwh  # 9.0 kWh
    uncapped = ETA * (150.0 - WEAR_EUR_MWH) / 1000.0

    # No PV: the value is the plain replacement-cost anchor.
    dry = make_input(prices, load=2.0, pv=0.0, netzladen_erlaubt=True)
    assert dry.effective_terminal_value_eur_per_kwh() == pytest.approx(uncapped)

    # A surplus that covers the whole band (charge-power-limited to 5 kW over
    # 10 slots = 12.5 kWh > 9.0 kWh) zeroes it.
    covered = make_input(
        prices, load=2.0, pv=[20.0] * 10 + [0.0] * 86, netzladen_erlaubt=True
    )
    assert covered.effective_terminal_value_eur_per_kwh() == 0.0

    # Partial coverage scales proportionally: 2 kW surplus over 10 slots =
    # 5.0 kWh of the 9.0 kWh band.
    partial = make_input(
        prices, load=2.0, pv=[4.0] * 10 + [0.0] * 86, netzladen_erlaubt=True
    )
    assert partial.effective_terminal_value_eur_per_kwh() == pytest.approx(
        uncapped * (1.0 - 5.0 / band), rel=1e-9
    )

    # Surplus in slots that still EARN something is not free and does not cap.
    earning = make_input(
        [150.0] * 96, load=2.0, pv=[20.0] * 96, netzladen_erlaubt=True
    )
    assert earning.effective_terminal_value_eur_per_kwh() > 0.0


def test_derived_value_never_goes_negative(monkeypatch):
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    # An all-negative horizon values stored energy at nothing - never below.
    inp = make_input([-80.0] * 96, netzladen_erlaubt=True)
    assert inp.effective_terminal_value_eur_per_kwh() == 0.0


# ---- FK1 feed-in-cap awareness (scout vp-verkauf-praemisse-s8 §1.4) ---------
#
# The solver's feed_in_cap constraint made lambda/explain cap-honest
# automatically, but the terminal anchor kept pricing refills against feed-in
# the connection point cannot carry. Pilsting-shaped numbers throughout:
# cap 30 kW, midday surplus ~41 kW -> ~11 kW beyond the cap, POSITIVE prices.


def replace_max_feed_in(inp: OptimizationInput, cap: float) -> OptimizationInput:
    """The same input with a maintained connection-point cap."""
    import dataclasses

    return dataclasses.replace(inp, max_feed_in_kw=cap)


def test_pilsting_beyond_cap_surplus_lowers_v_end_vs_cap_blind(monkeypatch):
    """The Pilsting 10.08. shape: an EEG plant whose midday surplus (pv 48 -
    load 7 = 41 kW) exceeds the 30-kW connection-point cap at a positive spot.
    Cap-blind, every surplus slot priced the refill at the full feed-in value
    87 although the marginal kWh cannot be exported at all; cap-aware both
    corrections bite - the surplus entries drop to 0 (anchor) and the 11 kW
    beyond the cap count as free refill (charge-limited to 5 kW x 8 slots =
    10 kWh > the 9 kWh band), so V_end honestly reads 0: refilling after the
    horizon costs this plant nothing."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 16
    pv = [48.0] * 8 + [0.0] * 8
    day = _asymmetric_eeg_input(
        spot=[87.0] * n,
        import_eur_mwh=[300.0] * n,
        export_eur_mwh=[87.0] * n,
        pv_kw=pv,
        load_kw=7.0,
        soc0_kwh=9.0,
    )
    blind = day.effective_terminal_value()
    # 30th percentile of [87 x8, (300 - discount) x8] -> index 4 -> 87.
    assert blind.v_end == pytest.approx(ETA * (87.0 - WEAR_EUR_MWH) / 1000.0)
    assert blind.refill_free_pct == 0.0

    capped = replace_max_feed_in(day, 30.0).effective_terminal_value()
    assert capped.v_end == 0.0
    assert capped.v_end < blind.v_end
    assert capped.refill_free_pct == 100.0
    # The anchor entry is still the forgone feed-in - which the cap makes 0.
    assert capped.anchor_kind == "einspeisewert"


def test_free_kwh_counts_only_the_beyond_cap_portion_at_positive_prices(
    monkeypatch,
):
    """Step 2 in isolation: the anchor comes from the deficit night (identical
    with and without the cap), so the ONLY difference is the free-refill count.
    8 surplus slots at pv 39 / load 7 (surplus 32, beyond-cap portion 2 kW)
    against a 30-kW cap contribute 8 x 2 kW x 0.25 h = 4 kWh of the 9 kWh
    usable band - the below-cap 30 kW still earn their feed-in and stay
    excluded."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 96
    pv = [0.0] * 44 + [39.0] * 8 + [0.0] * 44
    day = _asymmetric_eeg_input(
        spot=[100.0] * n,
        import_eur_mwh=[430.0] * n,
        export_eur_mwh=[82.0] * n,
        pv_kw=pv,
        load_kw=7.0,
        soc0_kwh=9.0,
    )
    blind = day.effective_terminal_value()
    capped = replace_max_feed_in(day, 30.0).effective_terminal_value()
    # Both anchors land on a deficit entry (the 8 surplus entries sort below
    # the 30th-percentile index 28 either way).
    assert blind.anchor_kind == "bezugspreis"
    assert capped.anchor_kind == "bezugspreis"
    assert blind.refill_free_pct == 0.0
    assert capped.refill_free_pct == pytest.approx(100.0 * 4.0 / 9.0)
    assert capped.v_end == pytest.approx(blind.v_end * (1.0 - 4.0 / 9.0), rel=1e-9)


def test_cap_above_every_surplus_is_byte_identical(monkeypatch):
    """A maintained cap the surplus never reaches changes NOTHING - the exact
    Pilsting addendum state (cap wrongly kept at 75 while the plant peaks at
    41 kW of surplus), and the invariance guarantee for every uncapped plant:
    all new branches key on the cap actually binding."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 16
    pv = [48.0] * 8 + [0.0] * 8
    day = _asymmetric_eeg_input(
        spot=[87.0] * n,
        import_eur_mwh=[300.0] * n,
        export_eur_mwh=[87.0] * n,
        pv_kw=pv,
        load_kw=7.0,
    )
    assert (
        replace_max_feed_in(day, 75.0).effective_terminal_value()
        == day.effective_terminal_value()
    )


def test_beyond_cap_at_negative_prices_changes_nothing(monkeypatch):
    """At export values <= 0 the whole surplus already counted as free and the
    surplus entry already carried the (negative) feed-in value - min(exp, 0)
    keeps it, so the cap adds nothing on a negative-price day."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 8
    day = _asymmetric_eeg_input(
        spot=[-40.0] * n,
        import_eur_mwh=[100.0] * n,
        export_eur_mwh=[-40.0] * n,
        pv_kw=[48.0] * n,
        load_kw=7.0,
    )
    capped = replace_max_feed_in(day, 30.0).effective_terminal_value()
    assert capped == day.effective_terminal_value()
    assert capped.v_end == 0.0
    assert capped.refill_free_pct == 100.0


def test_merchant_beyond_cap_gains_the_free_refill_channel(monkeypatch):
    """Merchant mode prices the refill min(buy, forgo-export); beyond the cap
    the free channel joins the min - storing what the connection point cannot
    carry costs nothing there either."""
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    n = 8
    blind = make_input(
        [87.0] * n, load=7.0, pv=48.0, netzladen_erlaubt=True
    ).effective_terminal_value()
    capped = make_input(
        [87.0] * n, load=7.0, pv=48.0, netzladen_erlaubt=True, max_feed_in_kw=30.0
    ).effective_terminal_value()
    # The flat symmetric curve has zero dispersion, so the strict-dispersion
    # guard holds the cap-blind value one margin below the anchor.
    assert blind.v_end == pytest.approx(
        ETA * ((87.0 - WEAR_EUR_MWH) / 1000.0 - TERMINAL_VALUE_MARGIN_EUR_PER_KWH)
    )
    assert capped.v_end == 0.0
    assert capped.anchor_kind == "marktpreis"


def test_cooptimizer_twin_shares_the_cap_aware_derivation(monkeypatch):
    """The N=1 adapter must hand the cap to the shared derivation too, or the
    golden lockstep silently diverges on capped plants."""
    from voltpilot_optimization.entities import from_v1_input

    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", raising=False)
    day = _asymmetric_eeg_input(
        spot=[87.0] * 16,
        import_eur_mwh=[300.0] * 16,
        export_eur_mwh=[87.0] * 16,
        pv_kw=[48.0] * 8 + [0.0] * 8,
        load_kw=7.0,
    )
    capped = replace_max_feed_in(day, 30.0)
    co = from_v1_input(capped)
    assert (
        co.effective_terminal_value(co.storages[0])
        == capped.effective_terminal_value()
    )


def test_explicit_field_wins_over_the_derivation():
    inp = make_input([100.0] * 96, terminal_value_eur_per_kwh=0.123)
    assert inp.effective_terminal_value_eur_per_kwh() == 0.123
    with pytest.raises(ValueError):
        make_input([100.0] * 96, terminal_value_eur_per_kwh=-0.01)


def test_quantile_env_is_tunable_and_validated(monkeypatch):
    prices = [100.0] * 48 + [200.0] * 48
    inp = make_input(prices, netzladen_erlaubt=True)
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", "0.9")
    # A high quantile lands the anchor ON the horizon's best use value (200),
    # which is exactly where the strict-dispersion guard engages: the value is
    # held one margin BELOW it so the gradient can never be nulled by equality.
    expected = ETA * (
        200.0 / 1000.0
        - WEAR_EUR_MWH / 1000.0
        - TERMINAL_VALUE_MARGIN_EUR_PER_KWH
    )
    assert inp.effective_terminal_value_eur_per_kwh() == pytest.approx(
        expected, rel=1e-12
    )
    assert inp.effective_terminal_value_eur_per_kwh() < ETA * (
        200.0 - WEAR_EUR_MWH
    ) / 1000.0

    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", "1.5")
    with pytest.raises(ValueError):
        terminal_value_quantile()
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_QUANTILE", "garbage")
    with pytest.raises(ValueError):
        terminal_value_quantile()


def test_override_env_resolves_ct_to_eur_and_validates(monkeypatch):
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", raising=False)
    assert terminal_value_override_eur_per_kwh() is None
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", "8.5")
    assert terminal_value_override_eur_per_kwh() == pytest.approx(0.085)
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", "0")
    assert terminal_value_override_eur_per_kwh() == 0.0  # explicit zero, not None
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", "-1")
    with pytest.raises(ValueError):
        terminal_value_override_eur_per_kwh()
    monkeypatch.setenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", "garbage")
    with pytest.raises(ValueError):
        terminal_value_override_eur_per_kwh()


@needs_highs
def test_flat_tariff_eeg_covers_the_night_instead_of_freezing():
    """Herzogau 17.08.2026 ~20:45 (scout vp-nacht-ruhe-warum-q8): Fest-Tarif
    (flacher Bezug 25 ct) ueber jedem Spot-Peak, EEG-Modus, SoC 86 %, morgen
    tief bedeckt (<30 % Ueberschuss-Slots -> das Quantil landet AUF dem
    Bezugspreis). Ohne den Cover-now-Abschlag ist "heute Nacht decken" vs.
    "halten und spaeter decken" ein EXAKTER Gleichstand (Marge algebraisch
    0,000 ct/kWh), den der Prefer-idle-Tie-Break zur Dauer-Ruhe kippt - der
    Speicher stand bei 86 % neben einem laufenden Nachtbezug. Mit Abschlag
    wird der Verbrauch aus dem Speicher gedeckt und trotzdem NICHTS unter dem
    Bezugspreis verkauft (der S2-Winterschutz haelt)."""
    n = 96
    # Spot ~ echte Kurve 17./18.08.: Abend 19-22 ct, Nacht-Tal 15, Morgen 20,
    # Mittag 13 - alles UNTER dem flachen Bezugspreis 25 ct.
    spot = (
        [190.0] * 4 + [219.0] * 8 + [200.0] * 8 + [170.0] * 8 + [150.0] * 16
        + [190.0] * 12 + [160.0] * 8 + [133.0] * 20 + [150.0] * 12
    )
    assert len(spot) == n
    # Truebtag-Glocke morgen: Spitze 1,2 kW bei Slot ~64, Ueberschuss nur dort
    # (Last 0,5 kW flach) -> deutlich unter 30 % der Slots.
    pv = [0.0] * n
    for i in range(52, 76):
        pv[i] = round(max(0.0, 1.2 - abs(i - 64) * 0.11), 3)
    plan = solve(
        _asymmetric_eeg_input(
            spot=spot,
            import_eur_mwh=[250.0] * n,
            export_eur_mwh=spot,
            pv_kw=pv,
            load_kw=0.5,
            soc0_kwh=0.86 * BATTERY.capacity_kwh,
        )
    )
    # Die Nacht (die ersten 40 Slots, vor der PV-Glocke) wird aus dem Speicher
    # gedeckt - nicht bei 86 % geruht, waehrend das Haus importiert.
    covered = sum(-s.battery_kw * 0.25 for s in plan.slots[:40] if s.battery_kw < 0)
    deficit = 0.5 * 40 * 0.25
    assert covered >= 0.9 * deficit, "die Nacht wird aus dem Speicher gedeckt"
    # ... und NICHTS wird unter dem Bezugspreis verkauft (S2-Schutz intakt).
    assert all(s.grid_kw >= -1e-6 for s in plan.slots), "kein Verkauf ins Netz"

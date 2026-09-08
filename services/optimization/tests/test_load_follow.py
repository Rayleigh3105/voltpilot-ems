"""In-slot load following: which slots the cloud marks
``cover_load_from_battery`` for the edge (2026-07-30, the Pilsting NIGHT half of
the quarter-hour gap - scout report vp-netzbezug-nacht-s3, P1).

The mirror of :mod:`tests.test_slot_trim`, and proven in the same two layers:

- the pure RULE (:mod:`voltpilot_optimization.slot_trim`, discharge side) -
  stated as economic properties with the measured live numbers as the anchor; and
- the rule reaching a real solved plan through the solver's explain stamping,
  where lambda is the model's OWN marginal value of stored energy.
"""

from __future__ import annotations

import importlib.util
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from voltpilot_optimization.config import (
    SLOT_TRIM_MARGIN_CT_PER_KWH,
    limit_discharge_enabled,
    load_follow_enabled,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.slot_trim import (
    PLANNED_GRID_EXCHANGE_DEADBAND_KW,
    cost_to_cover_ct_kwh,
    cover_load_economic,
    cover_load_from_battery,
    grid_charge_uneconomic,
    limit_discharge_to_load,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 30, 19, 15, tzinfo=timezone.utc)  # 21:15 CEST
ETA = math.sqrt(0.92)  # one-way efficiency of the 92 % round trip
WEAR_EACH_WAY_CT = 2.0  # the 4 ct/kWh-cycle platform default, half per direction


# ---- the rule ---------------------------------------------------------------


def test_the_observed_pilsting_night_slot_is_flagged():
    """THE anchor case (report §2.1): import ~32,5 ct all-in, and the stored kWh
    is worth roughly the ~21,2 ct feed-in it displaces. Covering the house from
    the battery is clearly right - the rule must say so, otherwise the whole fix
    would not fire on the very night that motivated it."""
    stored = ETA * 21.2  # water value of a kWh worth only the forgone feed-in
    assert cover_load_economic(
        import_price_ct_kwh=32.5,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    # ... and the full flag agrees on the observed plan shape (a -4,332 kW
    # discharge planned against ~0 grid: the "Netz = 0" kink, role eigenverbrauch).
    assert cover_load_from_battery(
        battery_kw=-4.332,
        grid_kw=0.0,
        import_price_ct_kwh=32.5,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_a_slot_holding_energy_for_a_more_valuable_hour_is_not_flagged():
    """The counter-case that keeps the feature from becoming the price-blind
    self-consumption logic: when the stored kWh is worth MORE elsewhere than the
    import costs here, covering the house now would destroy value."""
    stored = ETA * 45.0  # an expensive later hour makes the water value high
    assert not cover_load_economic(
        import_price_ct_kwh=32.5,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_the_cost_to_cover_prices_losses_and_wear_and_never_goes_negative():
    cost = cost_to_cover_ct_kwh(
        stored_value_ct_kwh=30.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert cost == pytest.approx(30.0 / ETA + 2.0)
    assert cost > 30.0  # losses + wear always ADD to the raw water value
    # A worthless (or nonsensically negative) water value floors at zero, so the
    # cost collapses to the wear alone instead of inventing a negative price.
    assert cost_to_cover_ct_kwh(
        stored_value_ct_kwh=-5.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    ) == pytest.approx(WEAR_EACH_WAY_CT)
    # A nonsensical efficiency can never justify a discharge.
    assert math.isinf(
        cost_to_cover_ct_kwh(
            stored_value_ct_kwh=10.0,
            one_way_efficiency=0.0,
            wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
        )
    )


def test_the_two_duties_can_never_contradict_each_other():
    """Covering costs lambda/eta + wear while charging is worth eta*lambda - wear,
    so 'cover the load' is STRICTLY tighter than 'do not grid-charge': every slot
    that must follow the load must also not be topped up from the grid. The edge
    composes them most-restrictive-wins, and this is why they can never fight."""
    common = dict(
        one_way_efficiency=ETA, wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT
    )
    for stored in (0.0, 5.0, 12.0, 21.2, 30.0, 45.0):
        for price in (0.0, 8.0, 14.6, 21.2, 32.5, 60.0):
            if cover_load_economic(
                import_price_ct_kwh=price, stored_value_ct_kwh=stored, **common
            ):
                assert grid_charge_uneconomic(
                    import_price_ct_kwh=price, stored_value_ct_kwh=stored, **common
                ), f"stored={stored} price={price}"


def test_a_hairline_difference_is_not_flagged_the_margin_is_the_deadband():
    stored = 20.0
    cost = cost_to_cover_ct_kwh(
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    common = dict(
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert not cover_load_economic(
        import_price_ct_kwh=cost + SLOT_TRIM_MARGIN_CT_PER_KWH - 0.01, **common
    )
    assert cover_load_economic(
        import_price_ct_kwh=cost + SLOT_TRIM_MARGIN_CT_PER_KWH + 0.01, **common
    )


def test_no_stored_value_and_no_finite_number_make_no_claim():
    common = dict(one_way_efficiency=ETA, wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT)
    # No why-layer -> lambda absent -> no duty (fail-open by contract).
    assert not cover_load_economic(
        import_price_ct_kwh=40.0, stored_value_ct_kwh=None, **common
    )
    # A duty the edge enforces against measured values must never rest on NaN.
    assert not cover_load_economic(
        import_price_ct_kwh=float("nan"), stored_value_ct_kwh=1.0, **common
    )
    assert not cover_load_economic(
        import_price_ct_kwh=40.0, stored_value_ct_kwh=float("inf"), **common
    )


def test_a_charging_or_idle_slot_carries_no_load_following_duty():
    """The duty only ever DEEPENS an existing discharge - it never starts one and
    never touches a charge."""
    common = dict(
        grid_kw=0.0,
        import_price_ct_kwh=40.0,
        stored_value_ct_kwh=1.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    assert not cover_load_from_battery(battery_kw=4.0, **common)
    assert not cover_load_from_battery(battery_kw=0.0, **common)
    assert not cover_load_from_battery(battery_kw=-0.02, **common)  # noise
    assert cover_load_from_battery(battery_kw=-4.0, **common)  # a real discharge


def test_only_the_netz_zero_kink_is_flagged_never_a_deliberate_trade():
    """The price-arbitrage protection, BOTH sides (P1b, 2026-07-30).

    Only the "Netz = 0" kink of the eigenverbrauch role carries the duty. A
    planned IMPORT is a deliberate cheap-hour purchase the edge must never undo;
    a planned EXPORT is a deliberate sale, and since the edge enforcement became
    bidirectional (it now LIMITS a discharge that overshoots the measured house)
    marking such a slot would let the edge cut that sale back to zero grid. The
    edge cannot tell an intended export from a forecast overshoot, so the
    distinction is made here, where the plan's own grid power is known."""
    common = dict(
        battery_kw=-4.0,
        import_price_ct_kwh=40.0,
        stored_value_ct_kwh=1.0,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    # A deliberate purchase: never.
    assert not cover_load_from_battery(grid_kw=3.0, **common)
    # A deliberate sale: never either - not even a small one.
    assert not cover_load_from_battery(grid_kw=-8.0, **common)
    assert not cover_load_from_battery(grid_kw=-0.3, **common)
    # The kink itself, and the rounding noise around it on BOTH sides.
    assert cover_load_from_battery(grid_kw=0.0, **common)
    assert cover_load_from_battery(grid_kw=0.04, **common)
    assert cover_load_from_battery(grid_kw=-0.04, **common)
    # The deadband is a magnitude, so it is symmetric by construction.
    assert PLANNED_GRID_EXCHANGE_DEADBAND_KW > 0
    for sign in (1, -1):
        edge = sign * PLANNED_GRID_EXCHANGE_DEADBAND_KW
        assert cover_load_from_battery(grid_kw=edge, **common)
        assert not cover_load_from_battery(grid_kw=edge * 1.5, **common)


def test_the_flag_is_env_switchable_and_defaults_on():
    assert load_follow_enabled({}) is True
    assert load_follow_enabled({"OPTIMIZER_LOAD_FOLLOW_ENABLED": "false"}) is False
    with pytest.raises(ValueError):
        load_follow_enabled({"OPTIMIZER_LOAD_FOLLOW_ENABLED": "maybe"})


# ---- through the real solver -------------------------------------------------

BATTERY = BatteryParams(
    capacity_kwh=60.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
)


def make_input(
    spot: list[float],
    load: list[float],
    pv: list[float],
    import_price: list[float] | None = None,
    export_value: list[float] | None = None,
    soc0_kwh: float = 46.2,  # the observed 77 % of 60 kWh
    netzladen_erlaubt: bool = True,
) -> OptimizationInput:
    n = len(spot)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=BATTERY,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=spot,
        load_kw=load,
        pv_kw=pv,
        initial_soc_kwh=soc0_kwh,
        netzladen_erlaubt=netzladen_erlaubt,
        import_price_eur_mwh=import_price,
        export_value_eur_mwh=export_value,
    )


def solve(inp: OptimizationInput):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=T0)


@needs_highs
def test_the_pilsting_night_gets_its_eigenverbrauch_slots_flagged():
    """The real night shape: no PV, a steady house, a full-enough battery and an
    import price well above the feed-in. Every slot the plan covers from the
    battery at ~zero grid must carry the duty - that is exactly where the
    measured 2,79 kW was being bought."""
    n = 12
    pv = [0.0] * n
    load = [7.1] * n
    spot = [212.0] * n  # 21,2 ct/kWh
    imp = [p + 113.3 for p in spot]  # + 11,33 ct Bayernwerk components
    plan = solve(make_input(spot, load, pv, import_price=imp, export_value=spot))

    covering = [
        s for s in plan.slots if s.battery_kw < -0.05 and s.grid_kw <= 0.05
    ]
    assert covering, "scenario must plan discharge-into-the-house slots"
    assert all(s.cover_load_from_battery for s in covering)
    # Every one of them is the eigenverbrauch role the report identified.
    assert all(s.slot_role == "eigenverbrauch" for s in covering)
    # Charging / idle slots carry no duty - there is nothing to deepen there.
    assert all(
        not s.cover_load_from_battery
        for s in plan.slots
        if s.battery_kw >= -0.05
    )


@needs_highs
def test_a_cheap_hour_the_plan_deliberately_buys_in_is_left_alone():
    """The price arbitrage must stay untouched: in the cheap half the plan buys
    (and charges) on purpose, so no slot there may carry the duty - otherwise the
    edge would fight the very strategy that earns the money."""
    n = 12
    pv = [0.0] * n
    load = [7.1] * n
    spot = [20.0] * 6 + [400.0] * 6  # cheap night, expensive morning
    imp = [p + 113.3 for p in spot]
    plan = solve(
        make_input(spot, load, pv, import_price=imp, export_value=spot, soc0_kwh=6.0)
    )

    buying = [s for s in plan.slots if s.grid_kw > 0.05]
    assert buying, "scenario must plan deliberate purchases"
    assert all(not s.cover_load_from_battery for s in buying)


@needs_highs
def test_a_slot_the_plan_deliberately_exports_from_the_battery_is_never_flagged():
    """The OTHER half of the arbitrage protection (P1b, 2026-07-30): where the
    plan sells battery energy into the grid on purpose, no slot may carry the
    duty - the edge enforcement is bidirectional and would otherwise limit that
    sale back to zero grid, and the edge cannot tell an intended export from a
    forecast overshoot.

    Deliberately NON-VACUOUS: the test also proves the economics in those slots
    SAY "covering is economic", i.e. it really is the planned export that
    suppresses the flag, not a rule that would have refused them anyway."""
    n = 12
    pv = [0.0] * n
    load = [2.0] * n  # a small house against a big, nearly full battery
    # An expensive peak first, a cheap tail after it: selling into the peak beats
    # holding the energy, so the plan exports on purpose.
    spot = [600.0] * 4 + [50.0] * 8
    imp = [p + 113.3 for p in spot]
    plan = solve(
        make_input(spot, load, pv, import_price=imp, export_value=spot, soc0_kwh=57.0)
    )

    exporting = [
        (i, s)
        for i, s in enumerate(plan.slots)
        if s.battery_kw < -0.05 and s.grid_kw < -PLANNED_GRID_EXCHANGE_DEADBAND_KW
    ]
    assert exporting, "scenario must plan real battery exports"
    assert all(not s.cover_load_from_battery for _, s in exporting)

    economic = [
        cover_load_economic(
            import_price_ct_kwh=imp[i] / 10.0,
            stored_value_ct_kwh=s.stored_value_ct_kwh,
            one_way_efficiency=BATTERY.one_way_efficiency,
            wear_ct_per_kwh_each_way=BATTERY.wear_cost_ct_per_kwh / 2.0,
        )
        for i, s in exporting
    ]
    assert any(economic), (
        "the scenario must contain exporting slots whose economics WOULD have "
        "flagged them - otherwise this test proves nothing about the export guard"
    )
    # Measured on this scenario: the four peak slots sell at -30 kW battery /
    # -28 kW grid (role verkaufen) and would have been flagged under the old
    # grid_kw <= 0 rule, i.e. the edge would have cut the sale back to -2 kW.
    assert all(s.slot_role == "verkaufen" for _, s in exporting)

    # ...and the SAME plan still flags the eigenverbrauch slots that follow it:
    # the guard narrows the marking, it does not switch the duty off.
    covering = [
        s
        for s in plan.slots
        if s.battery_kw < -0.05 and abs(s.grid_kw) <= PLANNED_GRID_EXCHANGE_DEADBAND_KW
    ]
    assert covering, "the tail must plan cover-the-house slots"
    assert all(s.cover_load_from_battery for s in covering)


@needs_highs
def test_the_flag_is_absent_without_the_explain_layer_and_with_the_switch_off(
    monkeypatch,
):
    n = 12
    inp = make_input(
        [212.0] * n,
        [7.1] * n,
        [0.0] * n,
        import_price=[325.3] * n,
        export_value=[212.0] * n,
    )

    monkeypatch.setenv("OPTIMIZER_LOAD_FOLLOW_ENABLED", "false")
    off = solve(inp)
    assert all(s.cover_load_from_battery is None for s in off.slots)
    # ... the why-layer AND the charge-side trim still work (its own lever).
    assert any(s.slot_role for s in off.slots)
    assert any(s.charge_from_surplus_only is not None for s in off.slots)

    monkeypatch.delenv("OPTIMIZER_LOAD_FOLLOW_ENABLED")
    monkeypatch.setenv("OPTIMIZER_EXPLAIN_ENABLED", "false")
    no_explain = solve(inp)
    assert all(s.cover_load_from_battery is None for s in no_explain.slots)
    assert all(s.slot_role is None for s in no_explain.slots)


@needs_highs
def test_the_two_switches_are_independent():
    """An operator must be able to stop ONE of the two in-slot corrections: they
    push the setpoint in opposite directions on a safety-relevant control path."""
    import os

    n = 12
    inp = make_input(
        [212.0] * n,
        [7.1] * n,
        [0.0] * n,
        import_price=[325.3] * n,
        export_value=[212.0] * n,
    )
    os.environ["OPTIMIZER_SLOT_TRIM_ENABLED"] = "false"
    try:
        plan = solve(inp)
    finally:
        del os.environ["OPTIMIZER_SLOT_TRIM_ENABLED"]
    assert all(s.charge_from_surplus_only is None for s in plan.slots)
    assert any(s.cover_load_from_battery for s in plan.slots), (
        "killing the charge-side trim must not disable the load following"
    )


@needs_highs
def test_the_flag_never_changes_the_committed_setpoints():
    """The duty is stamped POST-HOC like the why-fields: a plan solved with the
    load following off must carry byte-identical decisions."""
    import os

    n = 12
    inp = make_input(
        [212.0] * n,
        [7.1] * n,
        [0.0] * n,
        import_price=[325.3] * n,
        export_value=[212.0] * n,
    )

    on = solve(inp)
    os.environ["OPTIMIZER_LOAD_FOLLOW_ENABLED"] = "false"
    try:
        off = solve(inp)
    finally:
        del os.environ["OPTIMIZER_LOAD_FOLLOW_ENABLED"]
    for a, b in zip(on.slots, off.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw) == (
            b.battery_kw,
            b.grid_kw,
            b.soc_kwh,
            b.curtail_kw,
        )


# ---- Netz-null-Reduzieren: the REDUCE-only right (2026-09-08) ----------------
#
# P1 of the Nachtreserve analysis (scout vp-nachtreserve-konzept-k2): the ONE
# economic flag granted BOTH halves of the correction, and on a FIXED-tariff
# site (Pilsting/Herzogau, 25 ct flat) it flips to false exactly when the
# battery gets scarce - lambda rises past the import price. The box then fell
# back to deepen-only and EXPORTED the running slot's nowcast reserve: 3,8 kWh
# per night, sold at 6-12 ct and missing hours later at 25 ct.
#
# The EMISSION half is proven here, the EXECUTION half in the Go twin
# (edge-app/core/internal/guards/loadfollow_test.go) - both against the SHARED
# vectors docs/contracts/v2/load-follow-vectors.json, read BY PATH so moving the
# file breaks both.

VECTORS = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2" / (
    "load-follow-vectors.json"
)


def _vectors() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_the_shared_emission_vectors_hold():
    """Every shared emission vector run through the REAL rules. The pair is the
    point: on a discharging "Netz = 0" slot the new right is a SUPERSET of the
    economic duty, and outside that kink both are silent together."""
    data = _vectors()
    params = data["$emissions_parameter"]
    cases = data["emission"]
    assert cases, "the shared vectors carry no emission cases"
    for case in cases:
        got_cover = cover_load_from_battery(
            battery_kw=case["battery_kw"],
            grid_kw=case["grid_kw"],
            import_price_ct_kwh=case["import_price_ct_kwh"],
            stored_value_ct_kwh=case["stored_value_ct_kwh"],
            one_way_efficiency=params["one_way_efficiency"],
            wear_ct_per_kwh_each_way=params["wear_ct_per_kwh_each_way"],
            margin_ct_per_kwh=params["margin_ct_per_kwh"],
        )
        got_limit = limit_discharge_to_load(
            battery_kw=case["battery_kw"], grid_kw=case["grid_kw"]
        )
        assert got_cover is case["erwartet_cover_load_from_battery"], (
            case["name"],
            "cover_load_from_battery",
            case["why"],
        )
        assert got_limit is case["erwartet_limit_discharge_to_load"], (
            case["name"],
            "limit_discharge_to_load",
            case["why"],
        )
        # The superset property, stated on every single vector rather than once:
        # wherever the economic duty grants, the unpriced right grants too.
        if got_cover:
            assert got_limit, (case["name"], "the right must never be narrower")


def test_the_reduce_right_ignores_the_economics_that_switch_its_sibling_off():
    """THE anchor (report §2 F, the measured 23:15 slot): 25 ct fixed import
    against lambda 23,5 ct - the cover duty says no (23,5/0,959 + 0,5 + 0,5 =
    25,5 ct > 25,0), and the right to LIMIT says yes on the very same numbers.
    Limiting keeps energy the plan itself values above the export here; the
    rising lambda that silences the sibling is what makes it MORE valuable."""
    assert not cover_load_from_battery(
        battery_kw=-6.06,
        grid_kw=0.0,
        import_price_ct_kwh=25.0,
        stored_value_ct_kwh=23.5,
        one_way_efficiency=0.959,
        wear_ct_per_kwh_each_way=0.5,
        margin_ct_per_kwh=0.5,
    )
    assert limit_discharge_to_load(battery_kw=-6.06, grid_kw=0.0)
    # ...and it stays true however the price moves, because it never reads one.
    assert limit_discharge_to_load(battery_kw=-6.06, grid_kw=0.0)


def test_only_the_netz_zero_kink_carries_the_reduce_right():
    """The both-sided exclusion is INHERITED from the economic sibling and for
    the same reason: a planned EXPORT is a deliberate sale the edge would cut
    back to zero grid, a planned IMPORT a deliberate cheap-hour purchase. The
    edge cannot tell either from a forecast error, so the cloud decides."""
    deadband = PLANNED_GRID_EXCHANGE_DEADBAND_KW
    assert limit_discharge_to_load(battery_kw=-6.06, grid_kw=deadband)
    assert limit_discharge_to_load(battery_kw=-6.06, grid_kw=-deadband)
    assert not limit_discharge_to_load(battery_kw=-6.06, grid_kw=deadband + 0.01)
    assert not limit_discharge_to_load(battery_kw=-6.06, grid_kw=-deadband - 0.01)
    # A charge and an idle hold have no discharge to limit.
    assert not limit_discharge_to_load(battery_kw=8.0, grid_kw=0.0)
    assert not limit_discharge_to_load(battery_kw=-0.02, grid_kw=0.0)


def test_the_reduce_right_is_env_switchable_and_defaults_on():
    """Hausregel: a flag defaults ON - and it is its OWN lever, because it widens
    what the edge may do WITHOUT an economic test."""
    assert limit_discharge_enabled({}) is True
    assert limit_discharge_enabled({"OPTIMIZER_LIMIT_DISCHARGE_ENABLED": "false"}) is False
    assert limit_discharge_enabled({"OPTIMIZER_LIMIT_DISCHARGE_ENABLED": "on"}) is True
    with pytest.raises(ValueError):
        limit_discharge_enabled({"OPTIMIZER_LIMIT_DISCHARGE_ENABLED": "vielleicht"})


@needs_highs
def test_the_fixed_tariff_night_gets_the_right_where_the_duty_goes_silent():
    """The whole fix in ONE solved plan: a fixed 25 ct night with a battery
    scarce enough that the plan's own lambda exceeds the import price. Slots the
    economic duty refuses must still carry the right - otherwise the leak stays
    open exactly where it was measured."""
    n = 20
    pv = [0.0] * n
    load = [4.35] * n
    spot = [139.0] * n  # 13,9 ct/kWh export value - the measured sale price
    imp = [250.0] * n  # 25 ct FIXED, the site's real tariff
    # A battery that cannot serve the whole night: scarcity is what raises
    # lambda past the import price and silences cover_load_from_battery.
    plan = solve(
        make_input(spot, load, pv, import_price=imp, export_value=spot, soc0_kwh=6.0)
    )

    discharging = [
        s
        for s in plan.slots
        if s.battery_kw < -0.05 and abs(s.grid_kw) <= PLANNED_GRID_EXCHANGE_DEADBAND_KW
    ]
    assert discharging, "the scenario must plan cover-the-house slots"
    # EVERY one of them carries the right - unconditionally, that is the point.
    assert all(s.limit_discharge_to_load for s in discharging)
    # ...and no slot outside the kink carries it.
    assert all(
        not s.limit_discharge_to_load
        for s in plan.slots
        if s.battery_kw >= -0.05
        or abs(s.grid_kw) > PLANNED_GRID_EXCHANGE_DEADBAND_KW
    )


@needs_highs
def test_the_right_is_a_superset_of_the_duty_in_a_real_plan():
    """Not a rule property but a PLAN property: in a solved plan no slot may
    carry the economic duty without the right - the edge would then be allowed
    to limit under economics and forbidden to under the plain shape."""
    n = 12
    plan = solve(
        make_input(
            [212.0] * n,
            [7.1] * n,
            [0.0] * n,
            import_price=[325.3] * n,
            export_value=[212.0] * n,
        )
    )
    covering = [s for s in plan.slots if s.cover_load_from_battery]
    assert covering, "the scenario must flag the economic duty somewhere"
    assert all(s.limit_discharge_to_load for s in covering)


@needs_highs
def test_the_reduce_right_has_its_own_switch_and_changes_no_setpoint(monkeypatch):
    """Its own lever (the operator must be able to stop it without losing the
    economic load following), and - like every stamped duty - it is POST-HOC:
    the committed decisions are byte-identical with it on and off."""
    n = 12
    inp = make_input(
        [212.0] * n,
        [7.1] * n,
        [0.0] * n,
        import_price=[325.3] * n,
        export_value=[212.0] * n,
    )
    on = solve(inp)
    assert any(s.limit_discharge_to_load for s in on.slots)

    monkeypatch.setenv("OPTIMIZER_LIMIT_DISCHARGE_ENABLED", "false")
    off = solve(inp)
    assert all(s.limit_discharge_to_load is None for s in off.slots)
    # The economic sibling keeps working - the levers are independent.
    assert any(s.cover_load_from_battery for s in off.slots)
    for a, b in zip(on.slots, off.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw) == (
            b.battery_kw,
            b.grid_kw,
            b.soc_kwh,
            b.curtail_kw,
        )


def test_the_execution_vectors_name_only_words_the_guard_can_report():
    """The shared file is read by TWO twins, so its vocabulary is part of the
    contract: a path or direction the Go guard cannot produce would make the
    Python side pass while the edge side fails."""
    for case in _vectors()["ausfuehrung"]:
        assert case["erwartet_pfad"] in ("", "follow", "idle_follow", "deficit_cover", "limit"), case["name"]
        assert case["erwartet_richtung"] in (None, "deepen", "reduce"), case["name"]
        # A named path needs a direction and vice versa - a correction that
        # cannot say what it did reads as a defect.
        assert (case["erwartet_pfad"] == "") == (case["erwartet_richtung"] is None), (
            case["name"]
        )

"""In-slot surplus absorption: which slots the cloud marks
``charge_surplus_to_battery`` for the edge (2026-08-02, the Pilsting
negative-price MORNING - scout report vp-pilsting-abregeln, question 5b).

The third member of the in-slot duty family and the only one that RAISES a
charge, so it is proven in the same two layers as its siblings
(:mod:`tests.test_slot_trim`, :mod:`tests.test_load_follow`):

- the pure RULE (:mod:`voltpilot_optimization.slot_trim`, charge side) - stated
  as economic properties with the measured live numbers as the anchor; and
- the rule reaching a real solved plan through the solver's explain stamping,
  where lambda is the model's OWN marginal value of stored energy.

The two negative cases the report calls out have their own tests: a slot the
plan deliberately SELLS in stays unmarked (non-vacuously - the economics there
WOULD have marked it), and the honest hold of hypothesis H2 (a stored kWh worth
no more than the feed-in it displaces) never fires the duty at all.
"""

from __future__ import annotations

import importlib.util
import math
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization.config import (
    SLOT_TRIM_MARGIN_CT_PER_KWH,
    surplus_charge_enabled,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.slot_trim import (
    PLANNED_CURTAIL_DEADBAND_KW,
    PLANNED_GRID_EXCHANGE_DEADBAND_KW,
    SOC_HEADROOM_DEADBAND_KWH,
    charge_surplus_to_battery,
    marginal_storage_value_ct_kwh,
    storing_beats_selling,
    willingness_to_pay_ct_kwh,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 8, 2, 6, 30, tzinfo=timezone.utc)  # 08:30 CEST
ETA = math.sqrt(0.92)  # one-way efficiency of the 92 % round trip
WEAR_EACH_WAY_CT = 2.0  # the 4 ct/kWh-cycle platform default, half per direction


# ---- the rule ---------------------------------------------------------------


def test_the_observed_pilsting_morning_slot_is_flagged():
    """THE anchor case (report §5): a negative spot (-0,48 ct/kWh feed-in value)
    against a stored kWh that displaces the ~32,5 ct evening import - so keeping
    the surplus is obviously right. The plant sat at 7 % SoC and exported
    16,6 kW for hours instead, which is the money this duty exists to stop."""
    stored = ETA * 32.5  # water value of a kWh that displaces the evening import
    assert storing_beats_selling(
        export_value_ct_kwh=-0.48,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    # ... and the full flag agrees on the observed plan shape: a curtailing slot
    # (role abregeln) commanding 0,0 kW with the battery nearly empty.
    assert charge_surplus_to_battery(
        grid_kw=0.0,
        curtail_kw=19.6,
        soc_kwh=4.2,  # 7 % of a 60 kWh battery
        soc_max_kwh=57.0,
        export_value_ct_kwh=-0.48,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_a_stored_kwh_worth_no_more_than_the_feed_in_carries_no_duty():
    """Hypothesis H2 of the report, as a pure rule: when the plan holds because
    the stored kWh is genuinely worth no more than selling it, the duty must
    stay silent - otherwise it would be the price-blind self-consumption logic
    this module's header explicitly rejects."""
    # A stored kWh worth exactly the feed-in it displaces LOSES the round-trip
    # losses and the wear, so storing can never beat selling there.
    stored = ETA * 8.0
    assert not storing_beats_selling(
        export_value_ct_kwh=8.0,
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )


def test_the_marginal_storage_value_is_unclamped_on_purpose():
    """The rule compares the RAW eta*lambda - wear, not the trim's
    willingness-to-pay (which floors at zero). Against a NEGATIVE export value
    the floor would compare 0 to a negative number and claim storing is worth it
    even where the wear spent exceeds the giveaway avoided - so the two differ,
    and the conservative one is the one this rule uses."""
    common = dict(one_way_efficiency=ETA, wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT)
    # A nearly worthless stored kWh: the raw marginal value is NEGATIVE...
    raw = marginal_storage_value_ct_kwh(stored_value_ct_kwh=0.5, **common)
    assert raw < 0
    # ...while the trim's clamped twin reports zero.
    assert willingness_to_pay_ct_kwh(stored_value_ct_kwh=0.5, **common) == 0.0
    # Against an export value between the two, only the clamped one would fire -
    # and that is exactly the overstatement the rule must not make.
    export = raw + SLOT_TRIM_MARGIN_CT_PER_KWH / 2.0
    assert not storing_beats_selling(
        export_value_ct_kwh=export, stored_value_ct_kwh=0.5, **common
    )


def test_a_hairline_difference_is_not_flagged_the_margin_is_the_deadband():
    stored = 20.0
    common = dict(
        stored_value_ct_kwh=stored,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    value = marginal_storage_value_ct_kwh(**common)
    assert not storing_beats_selling(
        export_value_ct_kwh=value - SLOT_TRIM_MARGIN_CT_PER_KWH + 0.01, **common
    )
    assert storing_beats_selling(
        export_value_ct_kwh=value - SLOT_TRIM_MARGIN_CT_PER_KWH - 0.01, **common
    )


def test_no_stored_value_and_no_finite_number_make_no_claim():
    common = dict(one_way_efficiency=ETA, wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT)
    # No why-layer -> lambda absent -> no duty (fail-open by contract).
    assert not storing_beats_selling(
        export_value_ct_kwh=-5.0, stored_value_ct_kwh=None, **common
    )
    # A duty the edge enforces against measured values must never rest on NaN.
    assert not storing_beats_selling(
        export_value_ct_kwh=float("nan"), stored_value_ct_kwh=30.0, **common
    )
    assert not storing_beats_selling(
        export_value_ct_kwh=-5.0, stored_value_ct_kwh=float("inf"), **common
    )
    # ... and neither on a non-finite plan number.
    assert not charge_surplus_to_battery(
        grid_kw=float("nan"),
        curtail_kw=0.0,
        soc_kwh=4.2,
        soc_max_kwh=57.0,
        export_value_ct_kwh=-0.48,
        stored_value_ct_kwh=30.0,
        **common,
    )


def _flag(**overrides) -> bool:
    """The anchor slot with individual conditions overridden."""
    args = dict(
        grid_kw=0.0,
        curtail_kw=0.0,
        soc_kwh=4.2,
        soc_max_kwh=57.0,
        export_value_ct_kwh=-0.48,
        stored_value_ct_kwh=ETA * 32.5,
        one_way_efficiency=ETA,
        wear_ct_per_kwh_each_way=WEAR_EACH_WAY_CT,
    )
    args.update(overrides)
    return charge_surplus_to_battery(**args)


def test_a_deliberate_sale_is_never_flagged_but_a_planned_purchase_is_not_excluded():
    """The trade protection, and its DELIBERATE asymmetry to
    ``cover_load_from_battery`` (documented on the rule).

    A planned EXPORT is a deliberate sale and must never be reshaped. A planned
    IMPORT is NOT excluded: this duty only ever RAISES a charge, and only up to
    the MEASURED surplus, i.e. up to predicted grid 0 - so it bites only where
    reality EXPORTS and can never touch a cheap-hour purchase (which charges
    MORE than the surplus by construction). Excluding it would kill the money
    case, because under FK3 PV-bus semantics an ordinary EEG charging slot plans
    ``grid_kw = +load``."""
    assert _flag(grid_kw=0.0)
    assert _flag(grid_kw=4.3)  # the FK3 shape: battery takes the PV, house buys
    assert _flag(grid_kw=30.0)  # a deliberate purchase - harmless, see above
    assert not _flag(grid_kw=-8.0)  # a deliberate sale
    assert not _flag(grid_kw=-0.3)
    # The deadband bounds the export side only.
    assert _flag(grid_kw=-PLANNED_GRID_EXCHANGE_DEADBAND_KW)
    assert not _flag(grid_kw=-PLANNED_GRID_EXCHANGE_DEADBAND_KW * 1.5)


def test_a_curtailing_slot_may_absorb_even_while_it_exports():
    """A slot that CURTAILS already prefers not to export (that is what
    curtailment means), so storing beats discarding there - which is exactly the
    Fahrplan 'Abregeln' shape of the observed morning."""
    assert not _flag(grid_kw=-8.0, curtail_kw=0.0)
    assert _flag(grid_kw=-8.0, curtail_kw=19.6)
    # ... but only a REAL curtailment, not solver rounding noise.
    assert not _flag(grid_kw=-8.0, curtail_kw=PLANNED_CURTAIL_DEADBAND_KW)


def test_an_unfulfillable_duty_is_never_published():
    """A plan whose own SoC trajectory ends the slot at the usable ceiling has
    nowhere to put the surplus - publishing a duty the device cannot honour
    would only make the local card claim a correction that never happens."""
    assert _flag(soc_kwh=4.2, soc_max_kwh=57.0)
    assert _flag(soc_kwh=57.0 - 2 * SOC_HEADROOM_DEADBAND_KWH, soc_max_kwh=57.0)
    assert not _flag(soc_kwh=57.0, soc_max_kwh=57.0)
    assert not _flag(soc_kwh=57.0 - SOC_HEADROOM_DEADBAND_KWH / 2, soc_max_kwh=57.0)


def test_the_flag_is_env_switchable_and_defaults_on():
    assert surplus_charge_enabled({}) is True
    assert surplus_charge_enabled({"OPTIMIZER_SURPLUS_CHARGE_ENABLED": "false"}) is False
    with pytest.raises(ValueError):
        surplus_charge_enabled({"OPTIMIZER_SURPLUS_CHARGE_ENABLED": "maybe"})


# ---- through the real solver -------------------------------------------------

BATTERY = BatteryParams(
    capacity_kwh=60.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
)

MORNING = 12  # the negative-price surplus half
EVENING = 12  # the expensive half that gives a stored kWh its value


def make_input(
    spot: list[float],
    load: list[float],
    pv: list[float],
    import_price: list[float] | None = None,
    export_value: list[float] | None = None,
    soc0_kwh: float = 4.2,  # the observed 7 % of 60 kWh
    netzladen_erlaubt: bool = False,  # Pilsting is an EEG plant
    battery: BatteryParams = BATTERY,
) -> OptimizationInput:
    n = len(spot)
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
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


def pilsting_morning(pv_forecast_kw: float = 6.0) -> OptimizationInput:
    """The observed shape: a negative-price morning with PV surplus in front of
    an expensive evening, on a plant sitting at 7 % SoC.

    ``pv_forecast_kw`` is what the PLAN believes - hypothesis H1 of the report
    is that the forecast fell far short of the ~25 kW that was really there,
    which is why the plan charges a trickle and every 15-min re-plan repeats it
    (there is no nowcast of the running slot)."""
    spot = [-4.8] * MORNING + [250.0] * EVENING
    return make_input(
        spot,
        load=[4.3] * MORNING + [8.0] * EVENING,
        pv=[pv_forecast_kw] * MORNING + [0.0] * EVENING,
        import_price=[p + 113.3 for p in spot],  # + 11,33 ct Bayernwerk components
        export_value=list(spot),
    )


@needs_highs
def test_the_pilsting_negative_price_morning_is_flagged():
    """THE money case end to end: the plan charges only the small FORECAST
    surplus, so every morning slot carries the duty and the edge may put the
    real surplus into the battery instead of paying to export it."""
    plan = solve(pilsting_morning())

    morning = plan.slots[:MORNING]
    assert all(s.charge_surplus_to_battery for s in morning)
    # The shape the duty exists for: a trickle charge, an almost empty battery,
    # and a stored kWh worth far more than the (negative) feed-in.
    assert all(s.battery_kw == pytest.approx(6.0) for s in morning)
    assert morning[0].soc_kwh < 0.2 * BATTERY.capacity_kwh
    assert morning[0].stored_value_ct_kwh > 30.0
    # Note the planned grid is a real IMPORT (+4,3 kW): FK3 PV-bus semantics -
    # battery takes the PV, the house buys its load. The duty must survive that
    # (see the rule's documented deviation), otherwise it never fires at all.
    assert all(s.grid_kw > PLANNED_GRID_EXCHANGE_DEADBAND_KW for s in morning)


@needs_highs
def test_a_full_battery_never_carries_the_duty():
    """Same morning, but the forecast surplus alone already fills the battery:
    the plan's own trajectory reaches the usable ceiling, so from there on there
    is nothing left to absorb and no duty is published."""
    plan = solve(pilsting_morning(pv_forecast_kw=25.0))

    at_ceiling = [
        s
        for s in plan.slots[:MORNING]
        if s.soc_kwh >= BATTERY.soc_max_kwh - SOC_HEADROOM_DEADBAND_KWH
    ]
    assert at_ceiling, "the scenario must fill the battery within the morning"
    assert all(not s.charge_surplus_to_battery for s in at_ceiling)


@needs_highs
def test_a_slot_the_plan_deliberately_exports_is_never_flagged():
    """NEGATIVE CASE 1 of the report: a deliberate sale stays unmarked.

    Deliberately NON-VACUOUS: in these slots the ECONOMICS say storing beats
    selling (the plant is charge-power-limited, so the plan exports what it
    cannot store), i.e. it really is the planned export that suppresses the
    flag - not a rule that would have refused them anyway."""
    small_charger = BatteryParams(
        capacity_kwh=60.0,
        max_charge_kw=8.0,
        max_discharge_kw=30.0,
        roundtrip_efficiency=0.92,
    )
    spot = [60.0] * MORNING + [250.0] * EVENING
    plan = solve(
        make_input(
            spot,
            load=[2.0] * MORNING + [8.0] * EVENING,
            pv=[30.0] * MORNING + [0.0] * EVENING,
            import_price=[p + 113.3 for p in spot],
            export_value=list(spot),
            battery=small_charger,
        )
    )

    exporting = [
        (i, s)
        for i, s in enumerate(plan.slots)
        if s.grid_kw < -PLANNED_GRID_EXCHANGE_DEADBAND_KW
        and s.curtail_kw <= PLANNED_CURTAIL_DEADBAND_KW
    ]
    assert exporting, "scenario must plan real exports"
    assert all(not s.charge_surplus_to_battery for _, s in exporting)

    economic = [
        storing_beats_selling(
            export_value_ct_kwh=spot[i] / 10.0,
            stored_value_ct_kwh=s.stored_value_ct_kwh,
            one_way_efficiency=small_charger.one_way_efficiency,
            wear_ct_per_kwh_each_way=small_charger.wear_cost_ct_per_kwh / 2.0,
        )
        for i, s in exporting
    ]
    assert all(economic), (
        "the exporting slots' economics must WANT to store - otherwise this test "
        "proves nothing about the deliberate-sale guard"
    )
    # ...and the SAME plan still marks its non-exporting slots: the guard
    # narrows the marking, it does not switch the duty off.
    assert any(s.charge_surplus_to_battery for s in plan.slots)


@needs_highs
def test_the_honest_hold_of_hypothesis_h2_never_fires_the_duty():
    """NEGATIVE CASE 2 of the report: where the solver holds for an HONEST
    economic reason - a stored kWh worth no more than the feed-in it displaces -
    the duty must not fire, or it would turn the price-aware plan back into the
    price-blind 'just charge the surplus' logic.

    Symmetric flat pricing with no expensive hour: cycling moves no money, so
    the plan idles at 7 % SoC while the surplus is exported. The assertion is
    NON-VACUOUS on the economics: it checks the rule refuses those slots on
    ``storing_beats_selling`` alone, independently of any trade guard."""
    flat = [80.0] * (MORNING + EVENING)
    inp = make_input(
        flat,
        load=[4.3] * (MORNING + EVENING),
        pv=[6.0] * MORNING + [0.0] * EVENING,
        import_price=flat,
        export_value=flat,
        netzladen_erlaubt=True,  # merchant: nothing but the price holds it back
    )
    plan = solve(inp)

    assert all(s.battery_kw == pytest.approx(0.0, abs=1e-6) for s in plan.slots), (
        "the honest-hold scenario must plan an idle battery"
    )
    assert all(not s.charge_surplus_to_battery for s in plan.slots)
    # The economics alone refuse it - not the trade guard, not the SoC headroom
    # (the battery sits at 7 %, so there is plenty of room).
    assert all(
        not storing_beats_selling(
            export_value_ct_kwh=flat[i] / 10.0,
            stored_value_ct_kwh=s.stored_value_ct_kwh,
            one_way_efficiency=BATTERY.one_way_efficiency,
            wear_ct_per_kwh_each_way=BATTERY.wear_cost_ct_per_kwh / 2.0,
        )
        for i, s in enumerate(plan.slots)
    )
    assert plan.slots[0].soc_kwh < 0.2 * BATTERY.capacity_kwh


@needs_highs
def test_the_flag_is_absent_without_the_explain_layer_and_with_the_switch_off(
    monkeypatch,
):
    inp = pilsting_morning()

    monkeypatch.setenv("OPTIMIZER_SURPLUS_CHARGE_ENABLED", "false")
    off = solve(inp)
    assert all(s.charge_surplus_to_battery is None for s in off.slots)
    # ... the why-layer AND the two sibling duties still work (own levers).
    assert any(s.slot_role for s in off.slots)
    assert any(s.charge_from_surplus_only is not None for s in off.slots)
    assert any(s.cover_load_from_battery is not None for s in off.slots)

    monkeypatch.delenv("OPTIMIZER_SURPLUS_CHARGE_ENABLED")
    monkeypatch.setenv("OPTIMIZER_EXPLAIN_ENABLED", "false")
    no_explain = solve(inp)
    assert all(s.charge_surplus_to_battery is None for s in no_explain.slots)
    assert all(s.slot_role is None for s in no_explain.slots)


@needs_highs
def test_the_three_switches_are_independent(monkeypatch):
    """An operator must be able to stop exactly ONE of the three in-slot duties:
    they move the setpoint in different directions on a safety-relevant control
    path, and this one is the only one that RAISES a charge."""
    inp = pilsting_morning()

    monkeypatch.setenv("OPTIMIZER_SLOT_TRIM_ENABLED", "false")
    monkeypatch.setenv("OPTIMIZER_LOAD_FOLLOW_ENABLED", "false")
    plan = solve(inp)
    assert all(s.charge_from_surplus_only is None for s in plan.slots)
    assert all(s.cover_load_from_battery is None for s in plan.slots)
    assert any(s.charge_surplus_to_battery for s in plan.slots), (
        "killing the two older duties must not disable the surplus absorption"
    )


@needs_highs
def test_the_flag_never_changes_the_committed_setpoints(monkeypatch):
    """The duty is stamped POST-HOC like the why-fields: a plan solved with the
    absorption off must carry byte-identical decisions."""
    inp = pilsting_morning()

    on = solve(inp)
    monkeypatch.setenv("OPTIMIZER_SURPLUS_CHARGE_ENABLED", "false")
    off = solve(inp)
    for a, b in zip(on.slots, off.slots):
        assert (a.battery_kw, a.grid_kw, a.soc_kwh, a.curtail_kw) == (
            b.battery_kw,
            b.grid_kw,
            b.soc_kwh,
            b.curtail_kw,
        )

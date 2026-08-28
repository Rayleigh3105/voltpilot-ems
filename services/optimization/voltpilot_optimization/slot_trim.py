"""Price-aware in-slot corrections: where the edge may follow the METER instead
of the forecast watt value - on the charge side (do not top the battery up from
the grid) and on the discharge side (do cover the measured house from it).

THE PROBLEM (captain observation, Anlage Pilsting, 2026-07-30 14:44)
--------------------------------------------------------------------
A dispatch setpoint stands for the whole quarter hour, but reality moves every
second. Measured PV 15.3 kW, house 7.6 kW, battery charging 11.1 kW - so
3.4 kW of the charge came from the GRID, because the plan's 10.8 kW setpoint
was computed against a PV forecast that reality undercut. In that particular
slot the purchase was economically RIGHT (~14.6 ct/kWh all-in against ~33.5 ct
of avoided evening import), which is exactly why the naive answer - "just charge
the surplus" - is wrong: it is the price-blind self-consumption logic and the
same category of mistake as the night-emptying bug, only with the sign flipped.

The honest answer is CONDITIONAL: in slots where importing is EXPENSIVE relative
to what the stored kWh is worth, the battery must not cover a forecast shortfall
from the grid; in cheap slots the plan's setpoint stands untouched.

WHO DECIDES (architecture constraint, non-negotiable)
-----------------------------------------------------
Price authority stays in the cloud - ONE price truth, the same discipline as
:mod:`voltpilot_optimization.pricing` / ``SlotEconomics.java``. This module
turns the optimizer's own numbers into a per-slot BOOLEAN duty, published as the
additive ``charge_from_surplus_only`` field of
``docs/contracts/mqtt-schedule.schema.json``. The edge evaluates no price ever;
it only enforces the flag against MEASURED values.

THE RULE
--------
The marginal willingness to pay for one more AC kWh charged in slot ``t`` is

    WTP_t = eta * lambda_t - wear

where ``lambda_t`` is the model's OWN marginal value of a stored kWh at the end
of slot ``t`` (the "Wasserwert", the exact LP dual the explain layer already
extracts and persists as ``stored_value_ct_kwh``), ``eta`` the one-way
efficiency (only ``eta`` of an AC kWh arrives in the battery) and ``wear`` the
priced degradation of that kWh of charge throughput. Buying that kWh from the
grid costs ``import_price_t``. So

    grid-charging in t is UNECONOMIC  <=>  import_price_t > WTP_t + margin

A pure threshold ("above X ct") was deliberately rejected: it is wrong the
moment the price regime, the tariff or the battery changes, whereas this test is
the model's own optimality condition and therefore self-adjusting. Sanity check
against the observed case: with ~33.5 ct of avoided evening import the water
value lands near 28 ct, so WTP >> 14.6 ct import -> NOT uneconomic -> no trim,
i.e. Pilsting keeps doing exactly what it did. In a slot whose stored energy is
only worth the forgone feed-in, WTP collapses to the export value and any grid
purchase for the battery is correctly refused.

lambda comes from the explain layer, so the flag exists only where the why-layer
exists. That is deliberate: with ``OPTIMIZER_EXPLAIN_ENABLED=false`` (or a
failed LP re-solve) no flag is published and every edge behaves exactly as
before - the contract makes absence FAIL-OPEN, because an unpriced restriction
must never silently reshape dispatch.

THE DISCHARGE SIDE: in-slot LOAD FOLLOWING (2026-07-30, Pilsting night)
-----------------------------------------------------------------------
The same quarter-hour gap exists with the sign flipped, and it is where the
money was: the plan discharges exactly as much as it FORECASTS the house to
draw, so an under-forecast quarter is covered from the grid. Measured live:
forecast 4.33 kW against a 7.12 kW house, the 2.79 kW difference bought at
~32.5 ct/kWh while the battery sat at 77 % SoC - and the plan, believing the
night smaller than it was, held ~15 kWh unused into the morning (~4.9 EUR in
ONE night). The naive answer - "always cover the house" - is again the WRONG
one: it is the price-blind self-consumption logic and would destroy the
deliberate cheap-hour purchases that make arbitrage work.

So the rule is CONDITIONAL and again marginal. Covering one AC kWh of house
load from the battery costs

    COST_t = lambda_t / eta + wear

(delivering one AC kWh drains ``1/eta`` stored kWh, each worth ``lambda_t``,
plus the priced wear of that discharge throughput), and it saves
``import_price_t``. So

    covering load from the battery in t is ECONOMIC  <=>
        import_price_t > COST_t + margin

Note this is STRICTLY tighter than :func:`grid_charge_uneconomic` for any
``eta <= 1`` and ``wear >= 0``, i.e. a slot that must follow the load is always
also a slot that must not grid-charge - the two duties can never contradict
each other. The published flag additionally requires the plan to actually
DISCHARGE in the slot and to plan NO grid exchange worth the name
(``|grid_kw| <= PLANNED_GRID_EXCHANGE_DEADBAND_KW``, see
:func:`cover_load_from_battery`), which is exactly the "role ``eigenverbrauch``
with planned grid ~ 0" shape the night analysis identified. Excluding BOTH
directions is what leaves the price arbitrage alone: a planned import is a
deliberate cheap-hour purchase (role ``warten``), and a planned export is a
deliberate sale that the edge - whose enforcement is BIDIRECTIONAL since P1b -
would otherwise cut back to zero grid.

THE CHARGE SIDE, RAISING: in-slot surplus absorption (2026-08-02, Pilsting)
--------------------------------------------------------------------------
The trim above only ever LOWERS a charge, and the load follower only ever acts
on a discharge - so nothing could put an unforecast PV surplus INTO the battery.
That is where the real money of the negative-price morning was: the solver
charges only the FORECAST surplus (``charge <= pv_forecast - curtail``), so an
under-forecast morning plans 0.0 kW and every 15-min re-plan repeats it, because
there is no nowcast of the running slot. Measured at Pilsting on 2026-08-02:
7 % SoC, ~19,6 kW of measured surplus, plan 0,0 kW charge, and 16,6 kW exported
into a NEGATIVE price for hours - roughly 2-10 EUR given away in one morning,
against ~0,1-0,7 EUR for the curtailment that was displayed but not executed.

The naive answer is again the WRONG one, and this module's header already says
why: "just charge the surplus" IS the price-blind self-consumption logic. So the
duty follows the same architecture - the CLOUD prices it, the EDGE enforces it -
and is emitted only where the slot's OWN economics prefer storing to selling:

    storing beats selling in t  <=>  eta * lambda_t - wear > export_value_t + margin

i.e. the marginal value of one more stored kWh against what feeding it in
fetches. At a negative export value this is satisfied as soon as the water value
covers the wear, which is exactly the morning it exists for; where the solver
holds for an HONEST economic reason (a stored kWh worth less than the feed-in it
displaces) it is not satisfied and nothing is marked. Published as the additive
per-slot ``charge_surplus_to_battery``, FAIL-OPEN on absence like its two
siblings, with its own kill switch (``OPTIMIZER_SURPLUS_CHARGE_ENABLED``)
because it is the only one of the three that RAISES a charge.
"""

from __future__ import annotations

import math

from voltpilot_optimization.config import SLOT_TRIM_MARGIN_CT_PER_KWH

#: Below this a planned grid-sourced charge is rounding noise, not an intent
#: (kW). Same order as the solver's other slot deadbands.
PLANNED_GRID_CHARGE_DEADBAND_KW = 0.05

#: Below this magnitude a planned discharge is rounding noise, not an intent
#: (kW) - the mirror of :data:`PLANNED_GRID_CHARGE_DEADBAND_KW` on the discharge
#: side, and the same order as the solver's other slot deadbands.
PLANNED_DISCHARGE_DEADBAND_KW = 0.05

#: A slot is idle only while its signed battery command is inside the same
#: tolerance used for planned charge/discharge intent throughout this module.
PLANNED_IDLE_DEADBAND_KW = PLANNED_DISCHARGE_DEADBAND_KW

#: How far a planned grid EXCHANGE may sit from zero and still count as the
#: "Netz = 0" kink rather than a deliberate trade (kW, magnitude - so it bounds
#: a planned import AND a planned export). Same order as the solver's other slot
#: deadbands.
PLANNED_GRID_EXCHANGE_DEADBAND_KW = 0.05

#: Deprecated alias of :data:`PLANNED_GRID_EXCHANGE_DEADBAND_KW`, kept so an
#: external reader of the old one-sided name keeps working.
PLANNED_GRID_IMPORT_DEADBAND_KW = PLANNED_GRID_EXCHANGE_DEADBAND_KW

#: Above this a slot really curtails (kW) - the same deadband the explain
#: layer's ``abregeln`` role uses (``explain.CURTAIL_DEADBAND_KW``), so "the
#: slot the portal calls Abregeln" and "the slot that may absorb its surplus"
#: are the same set of slots.
PLANNED_CURTAIL_DEADBAND_KW = 0.01

#: How much room below the usable SoC ceiling the plan's own trajectory must
#: still leave for an absorption duty to be publishable (kWh). Below it the duty
#: would be unfulfillable, and a duty a device cannot honour must never be sent.
#: 0.1 kWh is well under one slot's worth of charge at any meaningful power.
SOC_HEADROOM_DEADBAND_KWH = 0.1


def willingness_to_pay_ct_kwh(
    *,
    stored_value_ct_kwh: float,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
) -> float:
    """What one more AC kWh charged into the battery is worth (ct/kWh).

    ``eta * lambda - wear``: only ``eta`` of an AC kWh is stored, and the charge
    throughput costs its half of the per-cycle wear. Never negative - a stored
    kWh cannot be worth less than nothing (the objective would simply not
    charge).
    """
    return max(
        0.0,
        one_way_efficiency * stored_value_ct_kwh - wear_ct_per_kwh_each_way,
    )


def grid_charge_uneconomic(
    *,
    import_price_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """Whether buying grid energy for the battery in this slot costs more than
    the resulting stored kWh earns over the rest of the horizon.

    ``stored_value_ct_kwh`` is the persisted lambda; ``None`` (no why-layer)
    yields ``False`` - no claim, no restriction. Non-finite inputs likewise
    yield ``False``: a guard the edge enforces against measured values must
    never rest on a NaN.
    """
    if stored_value_ct_kwh is None:
        return False
    values = (
        import_price_ct_kwh,
        stored_value_ct_kwh,
        one_way_efficiency,
        wear_ct_per_kwh_each_way,
        margin_ct_per_kwh,
    )
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
        return False
    wtp = willingness_to_pay_ct_kwh(
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
    )
    return import_price_ct_kwh > wtp + margin_ct_per_kwh


def planned_grid_charge_kw(
    *, battery_kw: float, pv_kw: float, load_kw: float, curtail_kw: float = 0.0
) -> float:
    """How much of the slot's PLANNED charge the plan itself intends to buy from
    the grid: charge beyond the slot's available surplus (kW, >= 0).

    The same arithmetic the edge applies to MEASURED values, evaluated on the
    forecast the plan was built from - which is what makes the consistency guard
    in :func:`charge_from_surplus_only` meaningful.
    """
    charge = max(battery_kw, 0.0)
    if charge <= 0.0:
        return 0.0
    surplus = max(max(pv_kw, 0.0) - curtail_kw - load_kw, 0.0)
    return max(charge - surplus, 0.0)


def charge_from_surplus_only(
    *,
    battery_kw: float,
    pv_kw: float,
    load_kw: float,
    curtail_kw: float,
    import_price_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """The per-slot contract flag: must the edge clamp commanded CHARGE to the
    measured surplus in this slot?

    Three conditions, all of them:

    1. **The plan commands a charge here.** The flag is a duty about a charge
       that could be topped up from the grid; a discharging/idle slot has
       nothing to trim. Emitting it only where it matters also keeps every other
       payload byte-identical to before the feature (the ``pv_limit_kw``
       discipline).
    2. **Buying is uneconomic** per :func:`grid_charge_uneconomic`.
    3. **The plan does not itself intend to buy.** By LP optimality a planned
       grid purchase implies the purchase is worth it, so (2) and (3) cannot
       genuinely disagree - but a solver-tolerance artefact must never produce a
       payload that tells the edge to undo a purchase the cloud deliberately
       planned. Consistency guard, not economics.
    """
    if battery_kw <= PLANNED_GRID_CHARGE_DEADBAND_KW:
        return False
    if not grid_charge_uneconomic(
        import_price_ct_kwh=import_price_ct_kwh,
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
        margin_ct_per_kwh=margin_ct_per_kwh,
    ):
        return False
    intended = planned_grid_charge_kw(
        battery_kw=battery_kw, pv_kw=pv_kw, load_kw=load_kw, curtail_kw=curtail_kw
    )
    return intended <= PLANNED_GRID_CHARGE_DEADBAND_KW


# ---- the discharge side: in-slot load following ------------------------------


def cost_to_cover_ct_kwh(
    *,
    stored_value_ct_kwh: float,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
) -> float:
    """What covering one AC kWh of house load from the battery COSTS (ct/kWh).

    ``lambda / eta + wear``: delivering one AC kWh drains ``1/eta`` stored kWh
    (each worth ``lambda``) and the discharge throughput costs its half of the
    per-cycle wear. The mirror of :func:`willingness_to_pay_ct_kwh`, and never
    negative - a stored kWh cannot be worth less than nothing.

    A non-positive efficiency yields ``inf`` (nothing arrives, so no import
    price can ever justify the discharge), which keeps the caller's comparison
    total instead of raising on a nonsense battery parameter.
    """
    if one_way_efficiency <= 0.0:
        return math.inf
    return max(0.0, stored_value_ct_kwh) / one_way_efficiency + wear_ct_per_kwh_each_way


def cover_load_economic(
    *,
    import_price_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """Whether covering the house from the battery in this slot saves more than
    the discharged kWh is worth elsewhere in the horizon.

    ``stored_value_ct_kwh`` is the persisted lambda; ``None`` (no why-layer)
    yields ``False`` - no claim, no duty. Non-finite inputs likewise yield
    ``False``: a duty the edge enforces against measured values must never rest
    on a NaN. Same discipline as :func:`grid_charge_uneconomic`.
    """
    if stored_value_ct_kwh is None:
        return False
    values = (
        import_price_ct_kwh,
        stored_value_ct_kwh,
        one_way_efficiency,
        wear_ct_per_kwh_each_way,
        margin_ct_per_kwh,
    )
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
        return False
    cost = cost_to_cover_ct_kwh(
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
    )
    return import_price_ct_kwh > cost + margin_ct_per_kwh


def cover_load_from_battery(
    *,
    battery_kw: float,
    grid_kw: float,
    import_price_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """The per-slot contract flag: may the edge RAISE this slot's discharge to
    the MEASURED house deficit instead of executing the forecast watt value?

    Three conditions, all of them - the mirror of
    :func:`charge_from_surplus_only`:

    1. **The plan commands a real DISCHARGE here.** The duty changes the
       MAGNITUDE of an existing discharge; it never STARTS one, and it never
       touches a commanded charge. That keeps the behavioural surface on a
       safety-critical control path as small as the money case needs (every slot
       of the observed Pilsting night is a planned discharge) and keeps every
       other payload byte-identical (the ``pv_limit_kw`` discipline). It also
       costs nothing: an idle slot the plan chose because it HOLDS energy for
       later carries a high lambda, so condition (2) would refuse it anyway.
    2. **Covering is economic** per :func:`cover_load_economic`.
    3. **The plan itself plans NO grid exchange worth the name**: ``|grid_kw|``
       at or below :data:`PLANNED_GRID_EXCHANGE_DEADBAND_KW`, i.e. exactly the
       "Netz = 0" kink of the ``eigenverbrauch`` role. Both sides are excluded
       on purpose, and each for its own reason:

       * a planned IMPORT is a DELIBERATE cheap-hour purchase (role ``warten``)
         the duty must never undo;
       * a planned EXPORT is a DELIBERATE sale, and since the edge enforcement
         became BIDIRECTIONAL (P1b, 2026-07-30 - it now also LIMITS a discharge
         that overshoots the measured house) marking such a slot would let the
         edge cut that sale back to zero grid. The edge cannot tell an intended
         export from a forecast overshoot - the plan carries only the setpoint,
         never its own forecast grid power - so the distinction has to be made
         HERE, where both numbers exist. This condition is what keeps the price
         arbitrage untouched in BOTH directions.

       By LP optimality (2) and (3) cannot genuinely disagree on a discharging
       slot with no planned exchange; for the import side this is the
       consistency guard against a solver-tolerance artefact, not economics.
    """
    if battery_kw >= -PLANNED_DISCHARGE_DEADBAND_KW:
        return False
    if abs(grid_kw) > PLANNED_GRID_EXCHANGE_DEADBAND_KW:
        return False
    return cover_load_economic(
        import_price_ct_kwh=import_price_ct_kwh,
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
        margin_ct_per_kwh=margin_ct_per_kwh,
    )


def unplanned_load_discharge(
    *,
    battery_kw: float,
    grid_kw: float,
    charge_surplus_to_battery: bool,
    import_price_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """Authorize local load coverage from a planned idle/hold slot.

    This is additive to :func:`cover_load_from_battery`.  It may START a
    discharge from zero, so its plan-shape gates are deliberately stricter:

    * the battery command must be inside the idle deadband (never reinterpret a
      planned charge or discharge);
    * a simultaneous surplus-absorption duty would grant the opposite
      direction and is refused;
    * the identical marginal price test retains future prices, efficiency,
      wear, margin and a possible later grid recharge through ``lambda``.

    Measurement freshness, the full reserve floor and no-export enforcement
    are edge responsibilities because only the edge sees the instantaneous
    plant.  Missing/non-finite economics fail closed through
    :func:`cover_load_economic`.

    THE PLANNED-EXPORT REFUSAL IS GONE (2026-08-28, Pilsting/Herzogau 19:37).
    It copied P1b's protection of a deliberate SALE, but in an IDLE slot there
    is no battery sale to protect: the battery is commanded 0, so a planned
    export is PV leaving the site, not stored energy. What the refusal really
    keyed on was therefore the PV FORECAST - and that is precisely the input
    that fails at dusk. Measured on the live box: plan slot 19:30-19:45
    ``battery_setpoint_kw = 0`` against a forecast surplus, while the real
    plant sat at PV 1,3 kW / house 2,7 kW and bought 1,4 kW at ~25 ct with the
    storage at 92 %. The refusal made the ONE slot that needed the duty the one
    slot that could not have it.

    Dropping it is structurally safe because the edge caps the correction at the
    MEASURED deficit ``max(load - pv, 0)``: where the forecast export is real
    the deficit is 0 and the duty does not bite at all, and where it bites there
    is by construction no export to cut. A planned IMPORT stays admitted for the
    reason it always was - a genuinely cheap hour makes ``lambda`` large enough
    that :func:`cover_load_economic` refuses on economics, which is the gate
    that actually protects the arbitrage.

    The sibling :func:`cover_load_from_battery` KEEPS both-sided exclusion: its
    edge enforcement is BIDIRECTIONAL (it also limits an overshooting
    discharge), so marking a sale slot there would cut the sale back to zero
    grid. This duty only ever raises a discharge out of idle.
    """
    if not isinstance(battery_kw, (int, float)) or not math.isfinite(battery_kw):
        return False
    if abs(battery_kw) > PLANNED_IDLE_DEADBAND_KW:
        return False
    # grid_kw is no longer a REFUSAL criterion (see the docstring), but a slot
    # whose own numbers are broken is still not a slot to authorize anything
    # from - the fail-closed discipline this module applies everywhere.
    if not isinstance(grid_kw, (int, float)) or not math.isfinite(grid_kw):
        return False
    if charge_surplus_to_battery:
        return False
    return cover_load_economic(
        import_price_ct_kwh=import_price_ct_kwh,
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
        margin_ct_per_kwh=margin_ct_per_kwh,
    )


# ---- the charge side, RAISING: in-slot surplus absorption --------------------


def marginal_storage_value_ct_kwh(
    *,
    stored_value_ct_kwh: float,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
) -> float:
    """What one more AC kWh charged into the battery is worth, UNCLAMPED
    (ct/kWh): ``eta * lambda - wear``.

    The same expression :func:`willingness_to_pay_ct_kwh` computes, WITHOUT its
    floor at zero - and the difference is load-bearing for
    :func:`storing_beats_selling`. That floor encodes "a stored kWh cannot be
    worth less than nothing, the objective would simply not charge", which is
    true when the alternative to charging is free. It is NOT true against a
    NEGATIVE export value, where the floor would compare 0 against a negative
    number and declare storing worthwhile even when the wear it spends exceeds
    the giveaway it avoids. Comparing the raw marginal value is the conservative
    reading, and it is the one the report's formula states.
    """
    return one_way_efficiency * stored_value_ct_kwh - wear_ct_per_kwh_each_way


def storing_beats_selling(
    *,
    export_value_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """Whether keeping one more marginal kWh of PV in the battery earns more
    than feeding it in right now.

    ``eta * lambda - wear > export_value + margin``: the value of the stored kWh
    over the rest of the horizon against what selling it fetches here. At a
    NEGATIVE export value (feeding in COSTS money) the test is satisfied as soon
    as the water value covers the wear, which is exactly the negative-price
    morning this duty exists for.

    ``stored_value_ct_kwh`` is the persisted lambda; ``None`` (no why-layer)
    yields ``False`` - no claim, no duty. Non-finite inputs likewise yield
    ``False``: a duty the edge enforces against measured values must never rest
    on a NaN. Same discipline as :func:`grid_charge_uneconomic`.
    """
    if stored_value_ct_kwh is None:
        return False
    values = (
        export_value_ct_kwh,
        stored_value_ct_kwh,
        one_way_efficiency,
        wear_ct_per_kwh_each_way,
        margin_ct_per_kwh,
    )
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
        return False
    value = marginal_storage_value_ct_kwh(
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
    )
    return value > export_value_ct_kwh + margin_ct_per_kwh


def charge_surplus_to_battery(
    *,
    grid_kw: float,
    curtail_kw: float,
    soc_kwh: float,
    soc_max_kwh: float,
    export_value_ct_kwh: float,
    stored_value_ct_kwh: float | None,
    one_way_efficiency: float,
    wear_ct_per_kwh_each_way: float,
    margin_ct_per_kwh: float = SLOT_TRIM_MARGIN_CT_PER_KWH,
) -> bool:
    """The per-slot contract flag: may the edge RAISE this slot's commanded
    charge to the MEASURED PV surplus?

    Three conditions, all of them (report ``vp-pilsting-abregeln`` §5b):

    1. **Storing beats selling** per :func:`storing_beats_selling` - the ONLY
       economic content, and the reason this is not the price-blind
       "just charge the surplus" rule this module's header rejects.
    2. **The plan intends no deliberate SALE**: its own grid power is not an
       export worth the name (``grid_kw >= -PLANNED_GRID_EXCHANGE_DEADBAND_KW``)
       - or the slot CURTAILS, which by definition prefers not to export, so
       absorbing beats throwing the energy away. A planned export is a
       deliberate sale (role ``verkaufen``) that a duty enforced against
       measured values must never reshape - the P1b protection
       :func:`cover_load_from_battery` applies on that side.

       DELIBERATE DEVIATION from the report's literal formula (which copied
       P1b's two-sided ``|grid_kw| ~ 0`` exclusion): a planned IMPORT is NOT
       excluded, for two reasons.

       * It is structurally safe. This duty is UNIDIRECTIONAL - the edge only
         ever RAISES a charge, and only up to the MEASURED surplus, which lands
         the predicted grid power at exactly 0. So it bites ONLY where reality
         is EXPORTING, it can never create or raise an import, and it can never
         lower a planned charge: a deliberate cheap-hour purchase (role
         ``warten``) charges MORE than the surplus by construction, so the duty
         does not bite there at all. That is the asymmetry to P1b, whose
         enforcement is bidirectional and therefore genuinely could undo a
         purchase.
       * Excluding it would kill the money case. Under FK3 PV-bus semantics an
         EEG plant legitimately plans "battery takes the PV, house takes its
         load from the grid", so a perfectly ordinary charging slot plans
         ``grid_kw = +load``. That is the H1 shape of the Pilsting morning
         (measured: plan 6 kW against 25 kW of real PV, ~4,7 EUR/h at stake in
         a single slot) - the very slot the duty exists for.

    3. **The plan's own SoC trajectory still has headroom** (slot-END SoC below
       ``soc_max_kwh``): a duty the device cannot fulfil must not be published.
       Using the END SoC is the conservative reading - a slot the plan already
       fills to the ceiling needs no help absorbing more.

    Deliberately NOT conditioned on the plan commanding a charge: the whole
    point is the slot where the plan charges 0.0 kW because its PV forecast
    never saw the surplus (Pilsting, 2026-08-02: 7 % SoC, ~19,6 kW surplus,
    plan 0,0 kW, hours of negative-price export).
    """
    numeric = (grid_kw, curtail_kw, soc_kwh, soc_max_kwh)
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in numeric):
        return False
    if not (
        grid_kw >= -PLANNED_GRID_EXCHANGE_DEADBAND_KW
        or curtail_kw > PLANNED_CURTAIL_DEADBAND_KW
    ):
        return False
    if soc_kwh >= soc_max_kwh - SOC_HEADROOM_DEADBAND_KWH:
        return False
    return storing_beats_selling(
        export_value_ct_kwh=export_value_ct_kwh,
        stored_value_ct_kwh=stored_value_ct_kwh,
        one_way_efficiency=one_way_efficiency,
        wear_ct_per_kwh_each_way=wear_ct_per_kwh_each_way,
        margin_ct_per_kwh=margin_ct_per_kwh,
    )

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

#: How far a planned grid EXCHANGE may sit from zero and still count as the
#: "Netz = 0" kink rather than a deliberate trade (kW, magnitude - so it bounds
#: a planned import AND a planned export). Same order as the solver's other slot
#: deadbands.
PLANNED_GRID_EXCHANGE_DEADBAND_KW = 0.05

#: Deprecated alias of :data:`PLANNED_GRID_EXCHANGE_DEADBAND_KW`, kept so an
#: external reader of the old one-sided name keeps working.
PLANNED_GRID_IMPORT_DEADBAND_KW = PLANNED_GRID_EXCHANGE_DEADBAND_KW


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

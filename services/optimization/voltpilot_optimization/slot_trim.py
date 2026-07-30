"""Price-aware in-slot trim: which slots must not be topped up from the grid.

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
"""

from __future__ import annotations

import math

from voltpilot_optimization.config import SLOT_TRIM_MARGIN_CT_PER_KWH

#: Below this a planned grid-sourced charge is rounding noise, not an intent
#: (kW). Same order as the solver's other slot deadbands.
PLANNED_GRID_CHARGE_DEADBAND_KW = 0.05


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

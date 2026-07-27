"""The flat-tariff idle-battery defect, as a behavioral regression fixture.

Scout ``vp-fahrplan-idle-n7`` (2026-07-27): the pilot plant planned a
COMPLETELY IDLE battery through a 20 ct/kWh evening spread, at flat 95 % SoC,
and told its owner "die Preisunterschiede lohnen kein Laden und Entladen".

Cause: ``site.tarif_art = 'fest'`` makes the import price a CONSTANT, and
German retail (25-42 ct) exceeds any realistic spot peak, so the old best-use
terminal anchor ``max(import_t, export_t)`` was constant over the whole
horizon. Zero dispersion means ANY quantile returns retail, so ``V_end`` came
out at 28.3 ct against a 20 ct peak: discharging was strictly worse than
holding in every slot and the spot curve never entered the decision. Measured
cost: ~7-10 EUR for this single 11-hour window on a 40 kWh battery, on
essentially every day of the year.

This module pins the fix behaviorally, on the report's own price curve:

* a ``fest`` plant discharges into the evening peak (and matches what the same
  plant does under spot-settled pricing - the shape that always worked),
* the ``dynamisch`` and ``ohne`` plants that were ALREADY correct are pinned
  unchanged, so the fix cannot silently alter them,
* a genuinely flat SPOT curve still plans an idle battery - the fix must not
  trade a never-dispatch bug for a dump-at-any-price one.

Reproduction parameters are the report's Appendix verbatim (13:00-23:45 local,
44 slots - tomorrow's day-ahead prices were not yet published when the plan was
made, which is why the horizon carries no next-day PV and ``V_end`` is fully
load-bearing).
"""

from __future__ import annotations

import importlib.util
import math
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.pricing import SiteTariff, export_values, import_prices

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

BERLIN = ZoneInfo("Europe/Berlin")
SLOTS = 44
CAPACITY_KWH = 40.0
POWER_KW = 15.0

# ct/kWh anchors read off the portal chart's labelled times (report Appendix).
ANCHORS = {
    "13:00": 0.0, "14:00": 0.0, "15:00": -0.2, "16:00": 0.0, "17:00": 0.3,
    "17:30": 1.0, "18:00": 6.0, "18:15": 10.5, "19:00": 14.0, "20:00": 18.0,
    "20:30": 19.5, "21:00": 20.0, "21:15": 19.6, "22:00": 18.0, "23:00": 16.5,
    "23:30": 15.5, "23:45": 15.0,
}


def _horizon() -> tuple[list[datetime], list[float]]:
    slots = [
        datetime(2026, 7, 27, 13, 0, tzinfo=BERLIN) + i * timedelta(minutes=15)
        for i in range(SLOTS)
    ]
    pts = sorted(
        (datetime(2026, 7, 27, int(k[:2]), int(k[3:]), tzinfo=BERLIN), v)
        for k, v in ANCHORS.items()
    )
    spot = []
    for s in slots:  # piecewise-linear, ct/kWh -> EUR/MWh
        ct = pts[0][1] if s <= pts[0][0] else pts[-1][1]
        for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
            if t0 <= s <= t1:
                ct = v0 + (s - t0) / (t1 - t0) * (v1 - v0)
                break
        spot.append(round(ct * 10.0, 2))
    return [s.astimezone(timezone.utc) for s in slots], spot


def _pv_load(slots, pv_peak=70.0, load_kw=14.0):
    pv, load = [], []
    for s in slots:  # July: sunrise 5:20, sunset 21:15
        local = s.astimezone(BERLIN)
        h = local.hour + local.minute / 60.0
        frac = max(0.0, math.sin(math.pi * (h - 5.3) / 15.95)) if 5.3 < h < 21.25 else 0.0
        pv.append(round(pv_peak * frac ** 1.6, 3))
        load.append(load_kw if 6 <= h < 22 else load_kw * 0.5)
    return pv, load


def build_input(
    tarif_art: str,
    tarif_param: float | None,
    *,
    wear_ct: float = 1.0,
    spot_override: list[float] | None = None,
) -> OptimizationInput:
    slots, spot = _horizon()
    if spot_override is not None:
        spot = spot_override
    pv, load = _pv_load(slots)
    battery = BatteryParams(
        capacity_kwh=CAPACITY_KWH,
        max_charge_kw=POWER_KW,
        max_discharge_kw=POWER_KW,
        roundtrip_efficiency=0.92,
        wear_cost_ct_per_kwh=wear_ct,
    )
    tariff = SiteTariff(
        plant_kind="direktvermarktung",
        tarif_art=tarif_art,
        tarif_param_ct_kwh=tarif_param,
    )
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=slots,
        prices_eur_mwh=spot,
        load_kw=load,
        pv_kw=pv,
        initial_soc_kwh=CAPACITY_KWH,  # the battery starts FULL
        netzladen_erlaubt=False,
        import_price_eur_mwh=import_prices(tariff, spot),
        export_value_eur_mwh=export_values(tariff, False, spot, slots, {}),
    )


def plan_for(**kwargs):
    from voltpilot_optimization.solver import optimize

    inp = build_input(**kwargs)
    return inp, optimize(inp, plan_id=uuid4(), generated_at=inp.slot_starts[0])


def discharged_kwh(plan) -> float:
    return -sum(min(s.battery_kw, 0.0) for s in plan.slots) * 0.25


def soc_span_pct(plan) -> tuple[float, float]:
    socs = [100.0 * s.soc_kwh / CAPACITY_KWH for s in plan.slots]
    return min(socs), max(socs)


def window_cashflow_eur(inp, plan) -> float:
    """The plant's real cashflow over the window at its own asymmetric prices
    (negative = revenue)."""
    return sum(inp.cashflow_cost_eur(i, s.grid_kw) for i, s in enumerate(plan.slots))


# ---- the defect: a flat retail tariff must not freeze the battery ------------


@needs_highs
@pytest.mark.parametrize("retail_ct", [22.0, 30.0, 42.0])
def test_flat_retail_tariff_discharges_into_the_evening_peak(retail_ct):
    """The headline regression. Before the fix EVERY ``fest`` configuration
    planned 0.00 kWh of discharge at flat 95 % SoC, whatever the retail level -
    and the higher the retail price, the more certainly the battery did
    nothing, the exact inverse of the correct economics."""
    inp, plan = plan_for(tarif_art="fest", tarif_param=retail_ct)

    assert discharged_kwh(plan) > 30.0, "the full battery must serve the evening"
    low, high = soc_span_pct(plan)
    assert high - low > 80.0, "the SoC must traverse its band, not sit flat at 95%"
    assert low == pytest.approx(5.0, abs=0.5), "and end at the technical floor"

    # The evening peak (>= 15 ct/kWh spot) is where the energy goes.
    peak_kwh = -sum(
        min(s.battery_kw, 0.0)
        for s in plan.slots
        if s.price_eur_mwh is not None and s.price_eur_mwh >= 150.0
    ) * 0.25
    assert peak_kwh > 20.0

    # V_end must no longer exceed the horizon's best price: that was the
    # mechanism by which selling into the peak was strictly rejected.
    best_use_eur_kwh = max(
        max(i, e) for i, e in zip(inp.import_prices, inp.export_values)
    ) / 1000.0
    assert inp.effective_terminal_value_eur_per_kwh() < best_use_eur_kwh


@needs_highs
def test_flat_retail_now_dispatches_like_the_spot_settled_plant():
    """Same physics, same curve, three tariff models: the ``fest`` plant that
    used to be the odd one out now moves the same energy as the ``ohne`` and
    ``dynamisch`` plants that always worked."""
    _, fest = plan_for(tarif_art="fest", tarif_param=30.0)
    _, ohne = plan_for(tarif_art="ohne", tarif_param=None)
    _, dyn = plan_for(tarif_art="dynamisch", tarif_param=18.0)

    assert discharged_kwh(fest) == pytest.approx(discharged_kwh(ohne), abs=0.5)
    assert discharged_kwh(fest) == pytest.approx(discharged_kwh(dyn), abs=0.5)


@needs_highs
@pytest.mark.parametrize("wear_ct", [0.0, 1.0, 4.0, 8.0])
def test_speicherschonung_no_longer_masks_a_frozen_battery(wear_ct):
    """The owner's ``aggressiv`` setting was provably incapable of helping:
    wear cancelled on both sides of the old degeneracy, so even wear = 0 kept
    the plan idle. Every preset must now dispatch."""
    _, plan = plan_for(tarif_art="fest", tarif_param=30.0, wear_ct=wear_ct)
    assert discharged_kwh(plan) > 30.0


# ---- regression: the plants that already worked must not move ---------------


@needs_highs
@pytest.mark.parametrize(
    "tarif_art,tarif_param", [("ohne", None), ("dynamisch", 18.0)]
)
def test_spot_settled_plans_are_unchanged(tarif_art, tarif_param):
    """Pinned to the values measured on the unfixed solver, so the terminal
    value rework cannot silently alter the plans that were already correct:
    34.53 kWh discharged, the full 95 % -> 5 % traverse, and the identical
    window cashflow."""
    expected_cash = {"ohne": -1.145, "dynamisch": -0.163}[tarif_art]
    inp, plan = plan_for(tarif_art=tarif_art, tarif_param=tarif_param)

    assert discharged_kwh(plan) == pytest.approx(34.53, abs=0.05)
    low, high = soc_span_pct(plan)
    assert low == pytest.approx(5.0, abs=0.1)
    assert high == pytest.approx(95.0, abs=0.1)
    assert window_cashflow_eur(inp, plan) == pytest.approx(expected_cash, abs=0.01)


# ---- the protection that must survive: no dumping on a flat curve -----------


@needs_highs
def test_a_genuinely_flat_curve_still_plans_an_idle_battery():
    """The other half of the contract: the fix must restore the price signal
    WITHOUT trading a never-dispatch bug for a dump-at-any-price bug.

    "Nothing to earn" means no dispersion in the curve AND no import/export
    spread - i.e. the symmetric ``ohne`` model on a flat spot. Then holding and
    using a stored kWh are worth exactly the same, and the throughput tie-break
    must keep the battery still."""
    inp, plan = plan_for(
        tarif_art="ohne", tarif_param=None, spot_override=[120.0] * SLOTS
    )
    assert all(abs(s.battery_kw) < 1e-6 for s in plan.slots)
    assert discharged_kwh(plan) == pytest.approx(0.0, abs=1e-6)


@needs_highs
@pytest.mark.parametrize("tarif_art,tarif_param", [("fest", 30.0), ("dynamisch", 18.0)])
def test_a_flat_curve_under_an_asymmetric_tariff_self_consumes_without_churn(
    tarif_art, tarif_param
):
    """A flat SPOT curve is not a no-arbitrage situation for a retail-priced
    plant: importing costs 30 ct while exporting earns 12, so covering the
    evening house load from storage is genuinely worth 18 ct/kWh. Idling there
    is the bug, not the protection - this is the everyday self-consumption a
    ``fest`` plant could never do before.

    What "no dumping" means here is that the plan must not CHURN: it spends the
    charge it already had and never buys energy back through the round trip,
    and it never exports more than the same plant would with the battery idle
    (the stored energy displaces import, it is not sold below its replacement
    cost)."""
    flat = [120.0] * SLOTS
    inp, plan = plan_for(
        tarif_art=tarif_art, tarif_param=tarif_param, spot_override=flat
    )
    _, idle_reference = plan_for(
        tarif_art="ohne", tarif_param=None, spot_override=flat
    )

    charged = sum(max(s.battery_kw, 0.0) for s in plan.slots) * 0.25
    assert charged == pytest.approx(0.0, abs=1e-6), "no round-trip churn"
    assert discharged_kwh(plan) > 30.0, "the evening load is served from storage"

    exported = -sum(min(s.grid_kw, 0.0) for s in plan.slots) * 0.25
    reference_export = -sum(min(s.grid_kw, 0.0) for s in idle_reference.slots) * 0.25
    assert exported == pytest.approx(reference_export, abs=0.05), (
        "the stored energy displaces import, it is never exported at the flat price"
    )
    # ... and that displacement is the whole point: grid import collapses.
    imported = sum(max(s.grid_kw, 0.0) for s in plan.slots) * 0.25
    reference_import = sum(max(s.grid_kw, 0.0) for s in idle_reference.slots) * 0.25
    assert imported < reference_import - 25.0

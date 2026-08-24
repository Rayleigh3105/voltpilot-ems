"""Replay: Herzogau, Sonntag 23.08.2026, plan run 09:36 - with and without the anchor.

THE acceptance test of the Morgenprognose fix (Captain-Order 24.08.2026). It
drives the REAL solver over the REAL DE-LU quarter-hour prices of that day and
the site's documented master data, and shows the one thing that matters: with
only the data the 09:36 run itself had, the anchored plan CHARGES the negative
price window instead of discharging into it.

What the run really did (Captain's admin optimizer readout,
``captain-screenshots/optimizer-run-0936-readout.md`` of scout report
``vp-negativpreis-herzogau-g3``): a 0,5 kW DISCHARGE at 09:30 and 09:45 and a
charge ramp starting only at 10:00 - while the plant was measurably producing
38,9 kW into a 09:45 spot price of -0,4 EUR/MWh.

**Reconstruction, stated openly.** The scout had read-only access to the box,
not to the production database, so three inputs are reconstructed - each from a
documented number, and each one checked here rather than assumed:

* ``RUN_PV_FORECAST`` - the PV forecast the run HELD. Derived from the readout's
  own per-slot planned battery power: in a negative-price slot the optimum is
  ``grid = 0`` (importing costs 25 ct, exporting costs money), so the planned
  charge is exactly ``pv_forecast - load_forecast``. The reconstruction is not
  taken on trust: ``test_the_reconstruction_reproduces_the_documented_run``
  feeds it to the real solver and asserts the readout's plan comes back out.
* ``LOAD_FORECAST`` 6,0 kW - the value the scout's own counterfactual run
  carries (``counterfactual-run1.txt``: at 09:30 F-LOW plans +1,87 kW charge on
  a 7,9 kW forecast at grid 0,00).
* ``MEASURED_PV`` - the completed morning slots the anchor draws its evidence
  from. Anchored on the documented 36,7 kW at 09:30 (the scout's measured
  F-REAL curve), the cockpit's 38,9 kW at ~09:55 and the 18,5 kW total measured
  at 08:25 on the near-identical following morning. **The replay does not
  depend on the interpolation between them:** every plausible morning shape
  puts the raw ratio far above the clamp, so the applied ratio is the clamp
  either way - ``test_the_result_does_not_depend_on_the_reconstructed_morning``
  runs three deliberately different shapes and asserts one identical plan.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from voltpilot_optimization import nowcast
from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.pricing import (
    PLANT_KIND_DIREKTVERMARKTUNG,
    TARIF_FEST,
    SiteTariff,
    export_values,
    import_prices,
)
from voltpilot_optimization.solver import optimize

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS not installed (pip install -e '.[solver]')",
)

# ---- the run's own facts ------------------------------------------------------

#: 09:30 local = 07:30 UTC, the slot the 09:36 run started its horizon on.
RUN_START = datetime(2026, 8, 23, 7, 30, tzinfo=timezone.utc)
SLOT = timedelta(minutes=15)

#: Real DE-LU quarter-hour day-ahead prices, 09:30 local -> midnight, EUR/MWh
#: (energy-charts, ``prices/de-lu-2026-08-23.json``). 58 slots - exactly the
#: "58/58 Slots bepreist" the readout reports for this run.
PRICES = [
    -0.13, -0.38, -0.19, -0.44, -0.64, -1.01, -1.0, -1.62,
    -2.03, -2.67, -2.99, -3.17, -2.99, -2.99, -3.52, -4.99,
    -5.44, -6.04, -6.21, -5.07, -3.04, -2.61, -2.01, -1.73,
    -1.0, -1.17, -1.03, -1.0, -0.1, 0.0, 0.07, 10.71,
    70.68, 112.04, 104.2, 129.33, 161.71, 182.45, 165.07, 177.63,
    189.05, 189.05, 188.4, 187.17, 185.37, 182.62, 179.93, 179.07,
    176.95, 176.25, 174.86, 173.54, 172.48, 169.83, 168.91, 166.69,
    166.12, 160.08,
]
SLOTS = len(PRICES)

LOAD_FORECAST = 6.0

#: The PV forecast the run held, reconstructed from the readout's planned
#: battery power (charge + load in a grid=0 slot). The tail past 13:30 follows
#: the readout's "Ladestand ~95 % gegen 13:30, halten bis ~19:00" - the plan is
#: full there, so its exact PV no longer moves the dispatch.
RUN_PV_FORECAST = [
    5.5, 5.5,                       # 09:30, 09:45 - BELOW the 6,0 kW house load
    14.0, 14.0, 13.0, 12.0,         # 10:00 .. 10:45
    11.5, 28.5, 16.5, 9.0,          # 11:00 .. 11:45
    29.0, 35.0, 36.0, 29.5,         # 12:00 .. 12:45
    34.5, 27.5, 16.0, 14.0,         # 13:00 .. 13:45
] + [12.0] * 6 + [8.0] * 4 + [5.0] * 4 + [3.0] * 4 + [1.0] * 4 + [0.0] * 18
assert len(RUN_PV_FORECAST) == SLOTS

#: What the plant actually PRODUCED over the horizon (the scout's measured
#: F-REAL curve, ``counterfactual-run1.txt``): 36,7 kW at 09:30 rising past
#: 45 kW around midday. Used here only to score the two plans against REALITY -
#: neither run ever saw it.
MEASURED_PV_HORIZON = [
    36.7, 39.0, 39.8, 40.6, 41.4, 42.2, 43.0, 43.3,
    43.7, 44.0, 44.3, 44.7, 45.0, 44.5, 44.0, 43.5,
    43.0, 42.5, 42.0, 40.9, 39.8, 38.6, 37.5, 36.4,
    35.2, 34.1, 33.0, 31.1, 29.2, 27.4, 25.5, 23.6,
    21.8, 19.9, 18.0, 16.0, 14.0, 12.0, 10.0, 8.0,
    6.0, 4.5, 3.0, 1.5, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0,
]
assert len(MEASURED_PV_HORIZON) == SLOTS

#: What the plant MEASURED in the completed slots before 09:30 (the anchor's
#: evidence window: 08:30, 08:45, 09:00, 09:15) and what the active model had
#: predicted for them - the same under-forecast the readout pins at 09:30.
MEASURED_PV = [27.0, 30.0, 33.0, 35.0]
PREDICTED_PV = [4.0, 4.5, 5.0, 5.5]

BATTERY = BatteryParams(
    capacity_kwh=65.0,
    max_charge_kw=30.0,
    max_discharge_kw=30.0,
    roundtrip_efficiency=0.92,
    soc_min_fraction=0.05,
    soc_max_fraction=0.95,
    wear_cost_ct_per_kwh=1.0,  # the site's 1,0 ct/kWh Anlagen-Override
)
TARIFF = SiteTariff(
    plant_kind=PLANT_KIND_DIREKTVERMARKTUNG,
    tarif_art=TARIF_FEST,
    tarif_param_ct_kwh=25.0,
    anzulegender_wert_ct_kwh=6.90,
    pv_capacity_kwp=70.0,
)
START_SOC_PCT = 10.0


def _slot_starts() -> list[datetime]:
    return [RUN_START + SLOT * i for i in range(SLOTS)]


def _input(pv_kw: list[float], anchor_ratio: float | None = None) -> OptimizationInput:
    starts = _slot_starts()
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=None,
        battery=BATTERY,
        slot_starts=starts,
        prices_eur_mwh=list(PRICES),
        load_kw=[LOAD_FORECAST] * SLOTS,
        pv_kw=list(pv_kw),
        initial_soc_kwh=START_SOC_PCT / 100.0 * BATTERY.capacity_kwh,
        netzladen_erlaubt=False,  # "EEG - Nur Solarladen", hartes Constraint
        max_feed_in_kw=70.0,
        import_price_eur_mwh=import_prices(TARIFF, list(PRICES)),
        export_value_eur_mwh=export_values(
            TARIFF, False, list(PRICES), starts, {}
        ),
        pv_anchor_ratio=anchor_ratio,
    )


def _anchored(measured: list[float], predicted: list[float]) -> list[float]:
    """The run's PV input as the shipped anchor would have corrected it."""
    evidence = nowcast.anchor_evidence(measured, predicted)
    series, _ = nowcast.apply_anchor(
        RUN_PV_FORECAST, evidence, capacity_kwp=TARIFF.pv_capacity_kwp
    )
    return series


def _solve(inp: OptimizationInput):
    return optimize(inp, plan_id=uuid4(), generated_at=RUN_START)


def _negative_slots() -> list[int]:
    return [i for i, p in enumerate(PRICES) if p < 0.0]


def _real_export_kwh(plan, slots: int | None = None) -> float:
    """What the plant would REALLY have exported into the negative window.

    Scored against the measured PV, with the plan's own curtailment left OUT:
    at Herzogau it has no actuator at all (both Fronius uncertified, the Deye
    remote path structurally cannot curtail - the second link of the causal
    chain, scout report section 4c), so an "abregeln" slot is display only and
    every un-absorbed kilowatt goes to the grid. The battery setpoint is what
    the plant really executes, and it is the only lever this fix moves.
    """
    total = 0.0
    for i in _negative_slots():
        if slots is not None and i >= slots:
            break
        grid = MEASURED_PV_HORIZON[i] - LOAD_FORECAST - plan.slots[i].battery_kw
        total += max(grid, 0.0) * 0.25
    return total


def _full_at(plan) -> int:
    """Index of the first slot whose planned SoC reaches the 95 % ceiling."""
    for i, slot in enumerate(plan.slots):
        if plan.soc_pct(slot) >= 94.9:
            return i
    return len(plan.slots)


# ---- the reconstruction is checked, not assumed --------------------------------


@needs_highs
def test_the_reconstruction_reproduces_the_documented_run():
    # Fed the reconstructed forecast, the shipped solver reproduces the
    # readout: a small self-consumption DISCHARGE at 09:30/09:45, the charge
    # ramp opening only at 10:00, and ~95 % SoC by ~13:30.
    plan = _solve(_input(RUN_PV_FORECAST))
    assert plan.slots[0].battery_kw == pytest.approx(-0.5, abs=0.1)
    assert plan.slots[1].battery_kw == pytest.approx(-0.5, abs=0.1)
    assert plan.slots[2].battery_kw == pytest.approx(8.0, abs=0.5)  # 10:00
    soc_1330 = plan.soc_pct(plan.slots[16])
    assert soc_1330 > 90.0


# ---- the acceptance criterion --------------------------------------------------


@needs_highs
def test_the_anchored_run_charges_the_negative_window_instead_of_discharging():
    before = _solve(_input(RUN_PV_FORECAST))
    after = _solve(_input(_anchored(MEASURED_PV, PREDICTED_PV)))

    # 1. No planned discharge in the two slots the run got wrong.
    assert before.slots[0].battery_kw < 0.0 and before.slots[1].battery_kw < 0.0
    assert after.slots[0].battery_kw > 0.0 and after.slots[1].battery_kw > 0.0

    # 2. The charge is of the order of the REAL surplus (36,7 - 6,0 = 30,7 kW
    #    at 09:30), not of the order of the forecast one (-0,5 kW).
    assert after.slots[0].battery_kw > 20.0
    assert after.slots[1].battery_kw > 15.0

    # 3. Nothing is bought from the grid to do it (EEG solar-only holds).
    assert after.slots[0].grid_kw <= 0.0001
    assert all(s.battery_kw <= s.pv_kw + 1e-6 for s in after.slots)

    # 4. Scored against the measured day: the very slot the Captain looked at
    #    stops giving 30 kW away, and the first hour of the window loses ~3/4
    #    of its paid export.
    before_09_30 = MEASURED_PV_HORIZON[0] - LOAD_FORECAST - before.slots[0].battery_kw
    after_09_30 = MEASURED_PV_HORIZON[0] - LOAD_FORECAST - after.slots[0].battery_kw
    assert before_09_30 > 30.0  # the observed ~30 kW of paid export
    assert after_09_30 < 12.0
    assert _real_export_kwh(after, slots=4) < 0.35 * _real_export_kwh(before, slots=4)

    # 5. It absorbs SOONER: the 95 % ceiling ~1,5 h earlier.
    assert _full_at(after) < _full_at(before) - 4

    # 6. Honest boundary, asserted so nobody later inflates the claim: over the
    #    WHOLE window the two plans export the same ~190 kWh. The battery is
    #    the binding constraint there (~55 usable kWh against ~290 kWh of
    #    surplus - scout report section 8), so this fix moves the TIMING of the
    #    absorption, not its total; closing the rest needs the second link of
    #    the causal chain, an executable curtailment.
    assert _real_export_kwh(after) == pytest.approx(_real_export_kwh(before), abs=1.0)

    # 5. And it is still the same economically sane day: the battery is full
    #    for the evening peak and sells into it.
    assert after.soc_pct(after.slots[16]) > 90.0
    assert min(s.battery_kw for s in after.slots) < -25.0


@needs_highs
def test_the_result_does_not_depend_on_the_reconstructed_morning():
    # Three deliberately different reconstructions of the evidence window - a
    # flat morning, the interpolated ramp, a steep one. Every plausible shape
    # is far above the clamp, so all three yield the SAME anchored plan.
    shapes = [
        ([30.0, 30.0, 30.0, 30.0], [5.0, 5.0, 5.0, 5.0]),
        (MEASURED_PV, PREDICTED_PV),
        ([15.0, 22.0, 30.0, 38.0], [3.0, 4.0, 5.0, 6.0]),
        ([25.0, 28.0, 31.0, 34.0], [4.5, 4.5, 5.5, 5.5]),
    ]
    plans = []
    for measured, predicted in shapes:
        evidence = nowcast.anchor_evidence(measured, predicted)
        assert evidence.raw_ratio > nowcast.DEFAULT_MAX_RATIO
        assert evidence.ratio == nowcast.DEFAULT_MAX_RATIO
        plans.append(_solve(_input(_anchored(measured, predicted))))
    first = [round(s.battery_kw, 4) for s in plans[0].slots]
    for plan in plans[1:]:
        assert [round(s.battery_kw, 4) for s in plan.slots] == first


@needs_highs
def test_a_correct_forecast_is_left_alone_by_the_anchor():
    # The control case: a model whose recent slots MATCHED reality establishes
    # a ratio of 1,0 and the plan comes back byte-identical. The anchor is a
    # bias correction, not a thumb on the scale.
    ratio_one = _anchored([20.0, 20.0, 20.0, 20.0], [20.0, 20.0, 20.0, 20.0])
    assert ratio_one == pytest.approx(RUN_PV_FORECAST)
    plain = _solve(_input(RUN_PV_FORECAST))
    anchored = _solve(_input(ratio_one))
    assert [s.battery_kw for s in anchored.slots] == [
        s.battery_kw for s in plain.slots
    ]


@needs_highs
def test_the_run_carries_its_anchor_into_the_persisted_plan():
    # The diagnostic path: the ratio the run corrected by is stamped on the
    # SchedulePlan (and from there onto every schedule row), so the admin
    # readout can name it next to the active model that needed it.
    plan = _solve(_input(RUN_PV_FORECAST, anchor_ratio=5.0))
    assert plan.pv_anchor_ratio == pytest.approx(5.0)
    assert _solve(_input(RUN_PV_FORECAST)).pv_anchor_ratio is None

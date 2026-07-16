"""The captain's Excel reference spec day as an offline regression fixture.

Scout task ``vp-solver-xlsx-f2`` (2026-07-16) reconstructed the captain's
Excel solver workbook (``Solver-PV.xlsx``) as a SOLL spec and proved our MILP
reproduces its decision logic exactly when the physics knobs are matched
(report §3.1 run B): objective **28.8797 EUR** vs. the workbook's cached GRG
solution 28.4878 EUR - the delta decomposes fully into +0.0205 EUR GRG
suboptimality and +0.3714 EUR efficiency bookkeeping (Excel: loss only on
discharge; we: symmetric sqrt split of the same 90% round trip).

This test pins that equivalence forever: the 24h inputs (report §1.4), the
matched configuration (report §8), the objective to 1e-3, and the dispatch
STRUCTURE (night discharge to the floor, full-power charge in the h13-14
price trough, evening-peak discharge, terminal SoC back at the start). The
input tables are copied verbatim so the test stands alone.

The spec's "Max Einspeisung am Netzpunkt" (workbook scalar R11 = 75 kW,
export-only constraint #4) maps onto the FK1 ``max_feed_in_kw`` field - the
faithful replication (the report's run B used the symmetric ``grid_limit_kw``,
which is identical here because import never approaches 75 kW on this day).
The cap never binds on this dataset (max export ~35 kW), exactly as in the
spec.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from uuid import uuid4

import pytest

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

from pyomo.environ import Constraint

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.solver import _extract_plan, _solve, build_model

# ---- the Excel inputs, verbatim (report §1.4; Tabelle1 columns C, D, I) ------
# One row per hour 0..23: (Verbrauch kW, PV kW, VK EUR/kWh).
EXCEL_DAY: list[tuple[float, float, float]] = [
    (3.00, 0.00, 0.154),  # h0
    (3.00, 0.00, 0.144),  # h1
    (3.00, 0.00, 0.139),  # h2
    (3.75, 0.00, 0.137),  # h3
    (3.00, 0.00, 0.141),  # h4
    (2.77, 0.00, 0.150),  # h5
    (2.97, 5.71, 0.167),  # h6
    (3.98, 17.26, 0.166),  # h7
    (5.16, 25.60, 0.156),  # h8
    (11.37, 36.56, 0.135),  # h9
    (11.93, 39.37, 0.111),  # h10
    (16.11, 47.03, 0.096),  # h11
    (7.00, 41.86, 0.074),  # h12
    (8.22, 55.03, 0.064),  # h13
    (8.82, 49.72, 0.063),  # h14
    (9.15, 33.68, 0.073),  # h15
    (8.03, 35.38, 0.097),  # h16
    (6.93, 29.18, 0.118),  # h17
    (6.60, 22.21, 0.146),  # h18
    (18.07, 7.87, 0.176),  # h19
    (12.81, 0.40, 0.206),  # h20
    (8.00, 0.00, 0.202),  # h21
    (3.00, 0.00, 0.188),  # h22
    (3.00, 0.00, 0.171),  # h23
]

# Workbook scalars (report §1.2): R4 Bezugspreis 0.21 EUR/kWh flach, R7/R8
# +-30 kW, R9 Kapazitaet 65 kWh, R10 SoC min 10%, R11 Max Einspeisung am
# Netzpunkt 75 kW (export only), R14 Roundtrip 90%, Start-SoC N7 = 18 kWh.
IMPORT_PRICE_EUR_MWH = 210.0
START_SOC_KWH = 18.0
MAX_FEED_IN_KW = 75.0

# The workbook's own optimum with the matched physics (report §3.1 run B == A1,
# the exact spec replica with the symmetric sqrt efficiency split).
EXPECTED_ERTRAG_EUR = 28.8797

T0 = datetime(2026, 7, 15, 0, 0, tzinfo=timezone.utc)


def excel_input() -> OptimizationInput:
    """The matched configuration from report §8 (run B)."""
    battery = BatteryParams(
        capacity_kwh=65.0,
        max_charge_kw=30.0,
        max_discharge_kw=30.0,
        roundtrip_efficiency=0.9,
        soc_min_fraction=0.10,
        soc_max_fraction=1.00,
        wear_cost_ct_per_kwh=0.0,
    )
    # Hourly rows expanded to the 96 15-min slots of our grid.
    load = [row[0] for row in EXCEL_DAY for _ in range(4)]
    pv = [row[1] for row in EXCEL_DAY for _ in range(4)]
    vk_eur_mwh = [row[2] * 1000.0 for row in EXCEL_DAY for _ in range(4)]
    return OptimizationInput(
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, 96),
        prices_eur_mwh=vk_eur_mwh,
        load_kw=load,
        pv_kw=pv,
        initial_soc_kwh=START_SOC_KWH,
        netzladen_erlaubt=True,
        max_feed_in_kw=MAX_FEED_IN_KW,
        import_price_eur_mwh=[IMPORT_PRICE_EUR_MWH] * 96,
        export_value_eur_mwh=vk_eur_mwh,
        # The spec has a HARD terminal constraint instead of a terminal value
        # (added onto the model below); no residual bank credit.
        terminal_value_eur_per_kwh=0.0,
    )


def hour_battery_kw(plan, hour: int) -> list[float]:
    return [s.battery_kw for s in plan.slots[hour * 4 : hour * 4 + 4]]


@needs_highs
def test_excel_spec_day_reproduces_the_reference_objective_and_dispatch():
    inp = excel_input()
    model = build_model(inp)
    # The spec's terminal constraint N31 >= N7: end SoC >= start (18 kWh).
    model.hard_terminal = Constraint(expr=model.soc[96] >= START_SOC_KWH)
    _solve(model)
    plan = _extract_plan(model, inp, plan_id=uuid4(), generated_at=T0)

    # --- the reference objective: Ertrag = sum(VK*export - 0.21*import)*dt ---
    ertrag_eur = -sum(s.cost_eur for s in plan.slots)
    assert ertrag_eur == pytest.approx(EXPECTED_ERTRAG_EUR, abs=1e-3)

    # --- terminal: the constraint binds, the day ends where it started ------
    assert plan.slots[-1].soc_kwh == pytest.approx(START_SOC_KWH, abs=1e-3)

    # --- night: load served from the battery down to the 10% floor ----------
    # (WHICH night hours discharge is a degenerate tie at the flat import
    # price - report §3.2 - so assert the outcome, not the exact hours: net
    # discharge over h0-5 and the 6.5 kWh floor reached and held before the
    # midday charge window.)
    night_kwh = sum(s.battery_kw for s in plan.slots[: 6 * 4]) * 0.25
    assert night_kwh < -8.0
    assert plan.slots[12 * 4 - 1].soc_kwh == pytest.approx(6.5, abs=1e-3)

    # --- midday price trough (6.4/6.3 ct, h13-14): charge at full power -----
    for hour in (13, 14):
        for kw in hour_battery_kw(plan, hour):
            assert kw == pytest.approx(30.0, abs=0.1), (
                f"h{hour} must charge at the full 30 kW"
            )

    # --- evening peak (h19-23): discharge in every hour ---------------------
    for hour in range(19, 24):
        assert sum(hour_battery_kw(plan, hour)) * 0.25 < -0.1, (
            f"h{hour} must discharge into the evening peak"
        )

    # --- the spec's export cap (R11 = 75 kW) is honored and never binds -----
    max_export = max(max(-s.grid_kw, 0.0) for s in plan.slots)
    assert max_export <= MAX_FEED_IN_KW + 1e-6
    assert max_export < 40.0  # ~35 kW on this day, per the report

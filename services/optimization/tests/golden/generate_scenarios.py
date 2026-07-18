"""Regenerate the golden co-optimizer scenario fixtures (provenance tool).

Run from ``services/optimization``::

    .venv/bin/python tests/golden/generate_scenarios.py

Deterministic by construction (no clock, no randomness): re-running always
reproduces the committed JSON byte for byte -
``test_golden_cooptimizer.py::test_fixtures_match_the_generator`` pins that,
so a fixture edit is always a CONSCIOUS regeneration, never silent drift.

Scenario sources (representative pilot-site shapes, per the E4-Basis ticket:
existing simulation fixtures - never live DB dumps):

- the captain's Excel reference workbook day (``tests/test_excel_spec_day.py``,
  scout vp-solver-xlsx-f2 - the pilot plant's shape),
- the simulation service's synthetic household profile
  (``voltpilot_optimization.simulation.profiles.household_weight``),
- deterministic diurnal PV / C&I load / DE-LU-shaped price curves defined
  here.

Each scenario is one full :class:`OptimizationInput` worth of data: 96 slots
of prices/load/PV (+ optional asymmetric import/export series) plus battery
params and every site-level flag - chosen so that TOGETHER the eight
scenarios exercise every solver module (EEG solar-only, §14a, feed-in cap,
peak shaving, reservation stack) and both pricing models.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

N = 96  # 24h at 15 min


# ---------------------------------------------------------------------------
# Shared deterministic series builders
# ---------------------------------------------------------------------------


def hourly(values24: list[float]) -> list[float]:
    """Expand one value per hour onto the 96-slot grid."""
    assert len(values24) == 24
    return [v for v in values24 for _ in range(4)]


def diurnal_pv(peak_kw: float, sunrise_h: float = 5.5, sunset_h: float = 21.0) -> list[float]:
    """Clear-day PV bell: zero outside daylight, sine bump inside."""
    series = []
    for i in range(N):
        h = i / 4.0
        if h <= sunrise_h or h >= sunset_h:
            series.append(0.0)
        else:
            x = (h - sunrise_h) / (sunset_h - sunrise_h)
            series.append(round(peak_kw * math.sin(math.pi * x) ** 1.5, 4))
    return series


def household_day(daily_kwh: float, day: datetime) -> list[float]:
    """One day of the simulation service's synthetic household shape, scaled
    to ``daily_kwh`` (reuses profiles.household_weight - the existing
    simulation fixture, per the ticket)."""
    from zoneinfo import ZoneInfo

    from voltpilot_optimization.simulation.profiles import household_weight

    berlin = ZoneInfo("Europe/Berlin")
    starts = [day + timedelta(minutes=15 * i) for i in range(N)]
    weights = [household_weight(s.astimezone(berlin)) for s in starts]
    scale = daily_kwh / (sum(weights) * 0.25)
    return [round(w * scale, 4) for w in weights]


def ci_business_load() -> list[float]:
    """Deterministic C&I weekday load: ~20 kW base, 60-95 kW working hours
    with a morning ramp and a noon peak - the RLM shape peak shaving exists
    for."""
    series = []
    for i in range(N):
        h = i / 4.0
        base = 20.0
        if 6.0 <= h < 8.0:
            kw = base + (h - 6.0) / 2.0 * 45.0  # ramp-up
        elif 8.0 <= h < 12.0:
            kw = 65.0 + 10.0 * math.sin(math.pi * (h - 8.0) / 4.0)
        elif 12.0 <= h < 13.0:
            kw = 95.0  # the noon peak
        elif 13.0 <= h < 17.0:
            kw = 70.0 - (h - 13.0) * 5.0
        elif 17.0 <= h < 19.0:
            kw = 45.0 - (h - 17.0) * 10.0
        else:
            kw = base
        series.append(round(kw, 4))
    return series


# DE-LU-shaped summer duck curve (EUR/MWh per hour): cheap night, negative
# midday dip, evening peak - the 2026 15-min-MTU market's daily shape.
SUMMER_DUCK_24 = [
    62.0, 55.0, 49.0, 46.0, 44.0, 48.0, 70.0, 95.0,
    88.0, 60.0, 25.0, 4.0, -12.0, -18.0, -9.0, 8.0,
    35.0, 68.0, 105.0, 148.0, 172.0, 133.0, 96.0, 74.0,
]

# Winter spread day (EUR/MWh per hour): expensive dark morning/evening.
WINTER_SPREAD_24 = [
    48.0, 45.0, 43.0, 42.0, 44.0, 55.0, 120.0, 205.0,
    218.0, 160.0, 110.0, 92.0, 88.0, 85.0, 90.0, 105.0,
    140.0, 230.0, 262.0, 240.0, 180.0, 120.0, 80.0, 58.0,
]

# The captain's Excel workbook day, verbatim (tests/test_excel_spec_day.py,
# scout vp-solver-xlsx-f2 report §1.4; Tabelle1 columns C, D, I):
# (Verbrauch kW, PV kW, VK EUR/kWh) per hour 0..23.
EXCEL_DAY = [
    (3.00, 0.00, 0.154), (3.00, 0.00, 0.144), (3.00, 0.00, 0.139),
    (3.75, 0.00, 0.137), (3.00, 0.00, 0.141), (2.77, 0.00, 0.150),
    (2.97, 5.71, 0.167), (3.98, 17.26, 0.166), (5.16, 25.60, 0.156),
    (11.37, 36.56, 0.135), (11.93, 39.37, 0.111), (16.11, 47.03, 0.096),
    (7.00, 41.86, 0.074), (8.22, 55.03, 0.064), (8.82, 49.72, 0.063),
    (9.15, 33.68, 0.073), (8.03, 35.38, 0.097), (6.93, 29.18, 0.118),
    (6.60, 22.21, 0.146), (18.07, 7.87, 0.176), (12.81, 0.40, 0.206),
    (8.00, 0.00, 0.202), (3.00, 0.00, 0.188), (3.00, 0.00, 0.171),
]

DAY = datetime(2026, 7, 15, 0, 0, tzinfo=timezone.utc)


def battery(
    capacity: float,
    charge: float,
    discharge: float,
    roundtrip: float = 0.92,
    soc_min: float = 0.05,
    soc_max: float = 0.95,
    wear_ct: float = 4.0,
    backup_reserve: float | None = None,
    peak_reserve: float | None = None,
) -> dict:
    return {
        "capacity_kwh": capacity,
        "max_charge_kw": charge,
        "max_discharge_kw": discharge,
        "roundtrip_efficiency": roundtrip,
        "soc_min_fraction": soc_min,
        "soc_max_fraction": soc_max,
        "wear_cost_ct_per_kwh": wear_ct,
        "backup_reserve_pct": backup_reserve,
        "peak_reserve_pct": peak_reserve,
    }


def scenarios() -> list[dict]:
    out: list[dict] = []

    # 1 - the captain's Excel reference day (the pilot plant's shape):
    # merchant, flat retail import, spot-settled export, static feed-in cap.
    spot = hourly([row[2] * 1000.0 for row in EXCEL_DAY])
    out.append(
        {
            "name": "excel-reference-day",
            "description": (
                "The captain's Solver-PV.xlsx reference day (scout "
                "vp-solver-xlsx-f2): merchant site, 65 kWh / +-30 kW battery "
                "at 90% roundtrip with a 10-100% band, flat 21 ct import "
                "tariff, spot-settled export, 75 kW static feed-in cap, "
                "explicit zero terminal value - the pilot-site shape."
            ),
            "battery": battery(
                65.0, 30.0, 30.0, roundtrip=0.9,
                soc_min=0.10, soc_max=1.0, wear_ct=0.0,
            ),
            "initial_soc_kwh": 18.0,
            "netzladen_erlaubt": True,
            "max_feed_in_kw": 75.0,
            "terminal_value_eur_per_kwh": 0.0,
            "series": {
                "prices_eur_mwh": spot,
                "load_kw": hourly([row[0] for row in EXCEL_DAY]),
                "pv_kw": hourly([row[1] for row in EXCEL_DAY]),
                "import_price_eur_mwh": [210.0] * N,
                "export_value_eur_mwh": spot,
            },
        }
    )

    # 2 - EEG household on a sunny summer day: solar-only charging, dynamic
    # tariff import, feste Einspeiseverguetung export.
    out.append(
        {
            "name": "eeg-household-pv-summer",
            "description": (
                "EEG household (netzladen_erlaubt=false, solar-only charge): "
                "10 kWh / 5 kW battery, synthetic household load (simulation "
                "profile, 12.5 kWh/day), 10 kWp clear-day PV, summer duck "
                "spot with negative midday, dynamic tariff import (spot + "
                "18 ct), feste Verguetung 7.94 ct export."
            ),
            "battery": battery(10.0, 5.0, 5.0),
            "initial_soc_kwh": 3.0,
            "netzladen_erlaubt": False,
            "series": {
                "prices_eur_mwh": hourly(SUMMER_DUCK_24),
                "load_kw": household_day(12.5, DAY),
                "pv_kw": diurnal_pv(8.2),
                "import_price_eur_mwh": [
                    p + 180.0 for p in hourly(SUMMER_DUCK_24)
                ],
                "export_value_eur_mwh": [79.4] * N,
            },
        }
    )

    # 3 - merchant winter arbitrage: bare-spot symmetric pricing (the pre-P1
    # special case), deep spreads, backup reserve.
    out.append(
        {
            "name": "merchant-arbitrage-winter",
            "description": (
                "Merchant site on a winter spread day (bare-spot symmetric "
                "pricing - the pre-P1 special case): 20 kWh / 10 kW battery "
                "with a 20% backup reserve, household load, marginal PV."
            ),
            "battery": battery(20.0, 10.0, 10.0, backup_reserve=20.0),
            "initial_soc_kwh": 10.0,
            "netzladen_erlaubt": True,
            "series": {
                "prices_eur_mwh": hourly(WINTER_SPREAD_24),
                "load_kw": household_day(16.0, DAY),
                "pv_kw": diurnal_pv(1.8, sunrise_h=8.0, sunset_h=16.5),
            },
        }
    )

    # 4 - C&I peak shaving: Leistungspreis epigraph + ratchet + peak reserve.
    out.append(
        {
            "name": "peak-shaving-ci",
            "description": (
                "RLM C&I site with the peak-shaving module active: 140 "
                "EUR/kW Jahres-Leistungspreis, 60 kW period anchor, 40% peak "
                "reserve, 90 kWh / 50 kW battery, business-day load with a "
                "95 kW noon peak, 30 kWp PV, dynamic tariff import."
            ),
            "battery": battery(90.0, 50.0, 50.0, peak_reserve=40.0),
            "initial_soc_kwh": 30.0,
            "netzladen_erlaubt": True,
            "leistungspreis_eur_kw": 140.0,
            "peak_so_far_kw": 60.0,
            "series": {
                "prices_eur_mwh": hourly(SUMMER_DUCK_24),
                "load_kw": ci_business_load(),
                "pv_kw": diurnal_pv(24.0),
                "import_price_eur_mwh": [
                    p + 150.0 for p in hourly(SUMMER_DUCK_24)
                ],
                "export_value_eur_mwh": hourly(SUMMER_DUCK_24),
            },
        }
    )

    # 5 - Direktvermarktung at negative prices: curtailment engages (premium
    # suspended below zero), DV-konform solar-only charging, feed-in cap.
    duck = hourly(SUMMER_DUCK_24)
    out.append(
        {
            "name": "dv-negative-prices",
            "description": (
                "Direktvermarktung plant on the negative-midday duck day: "
                "export value = spot + 30 premium, suspended (bare spot) in "
                "negative slots -> curtailment engages; solar-only charging "
                "(DV-konform), 60 kW feed-in cap, 30 kWh / 15 kW battery "
                "starting nearly full, 70 kWp PV, modest load."
            ),
            "battery": battery(30.0, 15.0, 15.0),
            "initial_soc_kwh": 25.0,
            "netzladen_erlaubt": False,
            "max_feed_in_kw": 60.0,
            "series": {
                "prices_eur_mwh": duck,
                "load_kw": [10.0] * N,
                "pv_kw": diurnal_pv(62.0),
                "import_price_eur_mwh": [p + 170.0 for p in duck],
                "export_value_eur_mwh": [
                    p if p < 0.0 else p + 30.0 for p in duck
                ],
            },
        }
    )

    # 6 - a binding section-14a envelope: the dimmed site must dispatch the
    # battery to keep import under the cap.
    out.append(
        {
            "name": "grid-limit-14a",
            "description": (
                "Section-14a dimming envelope of 11 kW on a site whose "
                "evening load peaks near 14 kW: the battery must cover the "
                "residual - the grid-limit module binds (feasibly). "
                "Merchant, bare spot, 10 kWh / 5 kW battery."
            ),
            "battery": battery(10.0, 5.0, 5.0),
            "initial_soc_kwh": 8.0,
            "netzladen_erlaubt": True,
            "grid_limit_kw": 11.0,
            "series": {
                "prices_eur_mwh": hourly(WINTER_SPREAD_24),
                "load_kw": [
                    round(9.0 + 5.0 * math.exp(-((i / 4.0 - 19.0) ** 2) / 3.0), 4)
                    for i in range(N)
                ],
                "pv_kw": diurnal_pv(2.5, sunrise_h=8.0, sunset_h=16.5),
            },
        }
    )

    # 7 - custom SoC band + backup reserve (the admin-tuned battery).
    out.append(
        {
            "name": "custom-soc-band-reserves",
            "description": (
                "Admin-tuned battery: 10-90% usable band, 30% backup "
                "reserve, EEG solar-only charging, dynamic tariff import, "
                "feste Verguetung export - a moderate spring day."
            ),
            "battery": battery(
                15.0, 6.0, 6.0, soc_min=0.10, soc_max=0.90,
                backup_reserve=30.0, wear_ct=8.0,
            ),
            "initial_soc_kwh": 6.0,
            "netzladen_erlaubt": False,
            "series": {
                "prices_eur_mwh": hourly(SUMMER_DUCK_24),
                "load_kw": household_day(14.0, DAY),
                "pv_kw": diurnal_pv(5.5, sunrise_h=6.5, sunset_h=20.0),
                "import_price_eur_mwh": [
                    p + 190.0 for p in hourly(SUMMER_DUCK_24)
                ],
                "export_value_eur_mwh": [62.0] * N,
            },
        }
    )

    # 8 - kitchen sink: every module at once (EEG + section-14a + feed-in cap
    # + peak shaving + both reserves + asymmetric pricing + negative dip).
    out.append(
        {
            "name": "kitchen-sink-all-modules",
            "description": (
                "Every module in one model: EEG solar-only charge, 15 kW "
                "section-14a envelope, 12 kW feed-in cap, 90 EUR/kW "
                "Leistungspreis with a 9 kW anchor, 20%/35% backup/peak "
                "reserves, asymmetric pricing over the negative-dip duck "
                "day - the maximal interaction surface."
            ),
            "battery": battery(
                12.0, 6.0, 6.0, backup_reserve=20.0, peak_reserve=35.0,
            ),
            "initial_soc_kwh": 5.0,
            "netzladen_erlaubt": False,
            "grid_limit_kw": 15.0,
            "max_feed_in_kw": 12.0,
            "leistungspreis_eur_kw": 90.0,
            "peak_so_far_kw": 9.0,
            "series": {
                "prices_eur_mwh": hourly(SUMMER_DUCK_24),
                "load_kw": household_day(20.0, DAY),
                "pv_kw": diurnal_pv(14.0),
                "import_price_eur_mwh": [
                    p + 160.0 for p in hourly(SUMMER_DUCK_24)
                ],
                "export_value_eur_mwh": [
                    p if p < 0.0 else p + 12.0 for p in hourly(SUMMER_DUCK_24)
                ],
            },
        }
    )

    for scenario in out:
        scenario.setdefault("start", DAY.isoformat().replace("+00:00", "Z"))
        for key, default in (
            ("netzladen_erlaubt", None),
            ("grid_limit_kw", None),
            ("max_feed_in_kw", None),
            ("leistungspreis_eur_kw", None),
            ("peak_so_far_kw", 0.0),
            ("terminal_value_eur_per_kwh", None),
        ):
            scenario.setdefault(key, default)
        scenario["series"].setdefault("import_price_eur_mwh", None)
        scenario["series"].setdefault("export_value_eur_mwh", None)
    return out


def main() -> None:
    for scenario in scenarios():
        path = HERE / f"{scenario['name']}.json"
        path.write_text(
            json.dumps(scenario, indent=2, sort_keys=True) + "\n"
        )
        print(f"wrote {path.name}")


if __name__ == "__main__":
    main()

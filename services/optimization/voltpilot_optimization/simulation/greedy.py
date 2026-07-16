"""Scenario (b): the greedy standard battery, exactly per design report §5.

Goal of the spec: (b)-(a) isolates the value of the BATTERY, (c)-(b) isolates
VoltPilot's value. So: **identical physics, zero intelligence** - what a
standard hybrid inverter does in self-consumption mode.

Same as (c): capacity, power caps, sqrt-split round-trip efficiency, SoC band
(incl. asset override + backup reserve as the floor), start SoC = floor, and
the SAME import/export price series for the valuation.

Different from (c), deliberately: no price knowledge, no lookahead, no
curtailment, no §14a, no wear in dispatch - every PV surplus charges
immediately, every deficit discharges immediately. Greedy never grid-charges
by construction (EEG-conform), consistent with valuing its export at the EEG
remuneration like scenario (c) in EEG mode.

Wear fairness: (b) is charged the SAME preset wear rate POST-HOC
(throughput x ct/2 per direction) so the "netto" comparison is one currency;
the measured pointe is that greedy cycles MORE than the optimizer.
"""

from __future__ import annotations

from dataclasses import dataclass

from voltpilot_optimization.domain import BatteryParams

SLOT_HOURS = 0.25


@dataclass(frozen=True)
class GreedyResult:
    """Slot-aligned dispatch of the greedy standard battery."""

    battery_kw: list[float]  # + charge / - discharge (AC side)
    grid_kw: list[float]  # + import / - export
    soc_kwh: list[float]  # at slot END

    @property
    def charge_kwh(self) -> float:
        return sum(b for b in self.battery_kw if b > 0) * SLOT_HOURS

    @property
    def discharge_kwh(self) -> float:
        return sum(-b for b in self.battery_kw if b < 0) * SLOT_HOURS


def greedy_dispatch(
    battery: BatteryParams,
    load_kw: list[float],
    pv_kw: list[float],
    initial_soc_kwh: float | None = None,
) -> GreedyResult:
    """Simulate the standard self-consumption battery over the whole series.

    ``initial_soc_kwh`` defaults to the SoC floor (report §5: Start-SoC =
    floor; the floor is the technical minimum raised by any backup reserve).
    """
    eta = battery.one_way_efficiency
    dt = SLOT_HOURS
    soc_floor = battery.soc_floor_kwh(battery.soc_max_kwh)
    soc_max = battery.soc_max_kwh
    soc = soc_floor if initial_soc_kwh is None else min(
        max(initial_soc_kwh, soc_floor), soc_max
    )

    battery_series: list[float] = []
    grid_series: list[float] = []
    soc_series: list[float] = []
    for load, pv in zip(load_kw, pv_kw):
        surplus = pv - load
        charge = 0.0
        discharge = 0.0
        if surplus > 0:
            charge = min(surplus, battery.max_charge_kw, (soc_max - soc) / (eta * dt))
            soc += eta * charge * dt
        elif surplus < 0:
            discharge = min(
                -surplus, battery.max_discharge_kw, (soc - soc_floor) * eta / dt
            )
            soc -= discharge / eta * dt
        battery_series.append(charge - discharge)
        grid_series.append(load - pv + charge - discharge)
        soc_series.append(soc)
    return GreedyResult(
        battery_kw=battery_series, grid_kw=grid_series, soc_kwh=soc_series
    )

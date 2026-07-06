"""Core optimizer domain types (framework-free, dependency-free).

The vocabulary shared by the solver, the input gathering, the persistence layer
and the MQTT publisher. Plain dataclasses, mirroring the style of the forecast
service's ``domain.py`` - the optimizer is the *predict-then-optimize* consumer:
forecasts and prices come in as plain slot-aligned series, and a deterministic
MILP turns them into a :class:`SchedulePlan`. No ML, no learned logic.

Conventions (match the platform):
- All timestamps are timezone-aware UTC ``datetime`` objects.
- Power in kW; battery power is signed **+charge / -discharge** (the frozen
  schedule contract ``docs/contracts/mqtt-schedule.schema.json``); grid power is
  signed **+import / -export** (the telemetry contract).
- Prices in EUR/MWh (native day-ahead unit); costs in EUR.
- The optimization grid is 15-min slots (architecture section 11).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from uuid import UUID

SLOT_MINUTES = 15
SLOTS_24H = 96

# Usable SoC window as fractions of nameplate capacity. The asset master data
# carries capacity/power/efficiency; the reserve band is a platform default
# (protects battery life, keeps headroom for the edge's self-consumption
# fallback) until it becomes per-asset master data.
DEFAULT_SOC_MIN_FRACTION = 0.05
DEFAULT_SOC_MAX_FRACTION = 0.95


@dataclass(frozen=True)
class BatteryParams:
    """Per-site battery master data (the ``asset`` table row).

    ``roundtrip_efficiency`` is the AC round-trip fraction (0..1]; the solver
    splits it symmetrically (sqrt each way) between charge and discharge.
    """

    capacity_kwh: float
    max_charge_kw: float
    max_discharge_kw: float
    roundtrip_efficiency: float = 0.92
    soc_min_fraction: float = DEFAULT_SOC_MIN_FRACTION
    soc_max_fraction: float = DEFAULT_SOC_MAX_FRACTION

    def __post_init__(self) -> None:
        if self.capacity_kwh <= 0:
            raise ValueError("capacity_kwh must be positive")
        if self.max_charge_kw <= 0 or self.max_discharge_kw <= 0:
            raise ValueError("charge/discharge power limits must be positive")
        if not 0.0 < self.roundtrip_efficiency <= 1.0:
            raise ValueError("roundtrip_efficiency must be within (0, 1]")
        if not 0.0 <= self.soc_min_fraction < self.soc_max_fraction <= 1.0:
            raise ValueError("SoC fractions must satisfy 0 <= min < max <= 1")

    @property
    def one_way_efficiency(self) -> float:
        """Symmetric per-direction efficiency: sqrt of the round trip."""
        return math.sqrt(self.roundtrip_efficiency)

    @property
    def soc_min_kwh(self) -> float:
        return self.capacity_kwh * self.soc_min_fraction

    @property
    def soc_max_kwh(self) -> float:
        return self.capacity_kwh * self.soc_max_fraction

    def clamp_soc_kwh(self, soc_kwh: float) -> float:
        """Clamp a measured SoC into the usable window (keeps the model feasible
        when telemetry reports a SoC outside the reserve band)."""
        return min(max(soc_kwh, self.soc_min_kwh), self.soc_max_kwh)


@dataclass(frozen=True)
class OptimizationInput:
    """Everything one solver run needs, slot-aligned over the horizon.

    ``slot_starts``/``prices_eur_mwh``/``load_kw``/``pv_kw`` are parallel lists
    (one entry per 15-min slot, ascending, contiguous). ``grid_limit_kw`` is the
    observed §14a envelope applied as a hard cap on net import AND export;
    ``None`` means unconstrained. ``initial_soc_kwh`` is the battery state at
    the start of the first slot.
    """

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    battery: BatteryParams
    slot_starts: list[datetime]
    prices_eur_mwh: list[float]
    load_kw: list[float]
    pv_kw: list[float]
    initial_soc_kwh: float
    grid_limit_kw: float | None = None
    slot_minutes: int = SLOT_MINUTES

    def __post_init__(self) -> None:
        n = len(self.slot_starts)
        if n == 0:
            raise ValueError("horizon must contain at least one slot")
        for name in ("prices_eur_mwh", "load_kw", "pv_kw"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        if self.slot_minutes <= 0:
            raise ValueError("slot_minutes must be positive")
        if self.grid_limit_kw is not None and self.grid_limit_kw <= 0:
            raise ValueError("grid_limit_kw must be positive when set")

    @property
    def slots(self) -> int:
        return len(self.slot_starts)

    @property
    def slot_hours(self) -> float:
        return self.slot_minutes / 60.0

    def baseline_cost_eur(self, index: int) -> float:
        """Projected cost of one slot with the battery idle (the no-battery
        baseline the headline savings are measured against)."""
        residual_kw = self.load_kw[index] - self.pv_kw[index]
        return self.prices_eur_mwh[index] * residual_kw * self.slot_hours / 1000.0


@dataclass(frozen=True)
class PlanSlot:
    """One optimized 15-min slot: the decision plus its projected economics."""

    start: datetime
    battery_kw: float  # + charge / - discharge
    grid_kw: float  # + import / - export
    soc_kwh: float  # state of charge at slot END
    load_kw: float  # load forecast input used
    pv_kw: float  # PV forecast input used
    price_eur_mwh: float
    cost_eur: float  # projected slot cost with the plan
    baseline_cost_eur: float  # projected slot cost with the battery idle
    # Planned PV curtailment (kW discarded, 0 <= curtail_kw <= pv_kw). Non-zero
    # only when feeding in would COST money (negative prices) - see solver.py.
    curtail_kw: float = 0.0

    @property
    def pv_limit_kw(self) -> float | None:
        """The inverter PV active-power cap implementing the curtailment
        (pv_kw - curtail_kw, never negative), or None when nothing is
        curtailed - the published schedule omits the field then."""
        if self.curtail_kw <= 0.0:
            return None
        return max(self.pv_kw - self.curtail_kw, 0.0)


@dataclass(frozen=True)
class SchedulePlan:
    """A full optimizer run for one site: the persisted + published artifact."""

    plan_id: UUID
    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    generated_at: datetime
    battery: BatteryParams
    slots: list[PlanSlot] = field(default_factory=list)
    slot_minutes: int = SLOT_MINUTES

    @property
    def cost_eur(self) -> float:
        return sum(s.cost_eur for s in self.slots)

    @property
    def baseline_cost_eur(self) -> float:
        return sum(s.baseline_cost_eur for s in self.slots)

    @property
    def savings_eur(self) -> float:
        """Projected savings vs. the no-battery baseline over the horizon."""
        return self.baseline_cost_eur - self.cost_eur

    def soc_pct(self, slot: PlanSlot) -> float:
        return 100.0 * slot.soc_kwh / self.battery.capacity_kwh

    def __len__(self) -> int:
        return len(self.slots)


def floor_to_slot(dt: datetime, slot_minutes: int = SLOT_MINUTES) -> datetime:
    """Floor ``dt`` down to the nearest slot boundary (UTC-safe)."""
    dt = ensure_utc(dt)
    discard = timedelta(
        minutes=dt.minute % slot_minutes,
        seconds=dt.second,
        microseconds=dt.microsecond,
    )
    return dt - discard


def horizon_slot_starts(
    now: datetime, slots: int, slot_minutes: int = SLOT_MINUTES
) -> list[datetime]:
    """The rolling-horizon slot grid: the first slot is the next boundary
    strictly after ``now`` (we plan the future, not the slot in progress)."""
    first = floor_to_slot(now, slot_minutes) + timedelta(minutes=slot_minutes)
    return [first + i * timedelta(minutes=slot_minutes) for i in range(slots)]


def ensure_utc(dt: datetime) -> datetime:
    """Return ``dt`` as timezone-aware UTC (naive datetimes are assumed UTC,
    the platform's storage/transport convention)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

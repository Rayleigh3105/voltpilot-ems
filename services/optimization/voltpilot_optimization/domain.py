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

from voltpilot_optimization.config import (
    DEFAULT_WEAR_COST_CT_PER_KWH,
    terminal_value_quantile,
)

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

    ``wear_cost_ct_per_kwh`` prices degradation per kWh CYCLED (one kWh charged
    and discharged again, AC side) - resolved by ``load_battery_sites`` from the
    nullable ``asset.wear_cost_ct_per_kwh`` override, falling back to the
    platform default (env ``OPTIMIZER_WEAR_COST_CT_PER_KWH``); derivation in
    :mod:`voltpilot_optimization.config`. 0 disables wear pricing.

    ``backup_reserve_pct`` is the customer-configured backup-reserve minimum
    SoC (P11; ``site.backup_reserve_soc_pct``, nullable): the plan never
    discharges below it - a HARD constraint, never a soft preference. ``None``
    (the default) means the platform 5% technical floor applies unchanged;
    a value below the technical floor is ineffective (the floor wins).

    ``peak_reserve_pct`` (PS-2; ``site.peak_reserve_soc_pct``, nullable) is
    the peak-shaving reserve: SoC headroom held back for shaving a load spike
    BEYOND the 24h horizon (the MPC never sees the whole billing period, so
    the epigraph term alone would let arbitrage drain the battery the evening
    before the expensive Monday-morning peak). It joins the reservation STACK
    (multi-use Stufe 2): each reservation is an ABSOLUTE SoC floor, ordered
    technical < backup < peak-reserve, and the highest configured floor binds
    (``max``, never additive - a peak reserve below the backup reserve is
    simply ineffective). Hard like the backup reserve, with the same
    below-floor-start relaxation.
    """

    capacity_kwh: float
    max_charge_kw: float
    max_discharge_kw: float
    roundtrip_efficiency: float = 0.92
    soc_min_fraction: float = DEFAULT_SOC_MIN_FRACTION
    soc_max_fraction: float = DEFAULT_SOC_MAX_FRACTION
    wear_cost_ct_per_kwh: float = DEFAULT_WEAR_COST_CT_PER_KWH
    backup_reserve_pct: float | None = None
    peak_reserve_pct: float | None = None

    def __post_init__(self) -> None:
        if self.capacity_kwh <= 0:
            raise ValueError("capacity_kwh must be positive")
        if self.max_charge_kw <= 0 or self.max_discharge_kw <= 0:
            raise ValueError("charge/discharge power limits must be positive")
        if not 0.0 < self.roundtrip_efficiency <= 1.0:
            raise ValueError("roundtrip_efficiency must be within (0, 1]")
        if not 0.0 <= self.soc_min_fraction < self.soc_max_fraction <= 1.0:
            raise ValueError("SoC fractions must satisfy 0 <= min < max <= 1")
        if not (
            math.isfinite(self.wear_cost_ct_per_kwh)
            and self.wear_cost_ct_per_kwh >= 0.0
        ):
            raise ValueError("wear_cost_ct_per_kwh must be finite and >= 0")
        for name in ("backup_reserve_pct", "peak_reserve_pct"):
            reserve = getattr(self, name)
            if reserve is not None and not (
                math.isfinite(reserve) and 0.0 <= reserve <= 100.0
            ):
                raise ValueError(f"{name} must be within [0, 100] when set")

    @property
    def one_way_efficiency(self) -> float:
        """Symmetric per-direction efficiency: sqrt of the round trip."""
        return math.sqrt(self.roundtrip_efficiency)

    @property
    def wear_cost_eur_per_kwh_each_way(self) -> float:
        """Wear cost per AC-side kWh of throughput in ONE direction.

        Half the per-cycle rate, so a full round trip of one kWh (one in, one
        out) costs exactly ``wear_cost_ct_per_kwh``; a partial move (charged
        within the horizon, not yet discharged) is charged half."""
        return self.wear_cost_ct_per_kwh / 100.0 / 2.0

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

    def soc_floor_kwh(self, initial_soc_kwh: float) -> float:
        """The effective SoC lower bound of a plan starting at
        ``initial_soc_kwh`` (already clamped into the technical band).

        The reservation STACK (P11 backup reserve + PS-2 peak-shaving
        reserve) raises the technical floor - hard, never soft: each
        configured reservation is an absolute SoC level and the highest one
        binds. The floor is RELAXED to the actual start when the battery
        currently sits below it: a below-reserve battery must still yield a
        feasible plan, and "never discharge any further" is the correct hard
        property there (recovery charging follows from the economics/PV; each
        15-min MPC re-plan then ratchets the floor back up as the battery
        recovers). Capped at ``soc_max_kwh`` so a 100% reserve pins the
        battery full instead of going infeasible."""
        floor = self.soc_min_kwh
        for reserve_pct in (self.backup_reserve_pct, self.peak_reserve_pct):
            if reserve_pct is not None:
                reserve_kwh = self.capacity_kwh * reserve_pct / 100.0
                floor = min(max(floor, reserve_kwh), self.soc_max_kwh)
        return min(floor, initial_soc_kwh)


@dataclass(frozen=True)
class OptimizationInput:
    """Everything one solver run needs, slot-aligned over the horizon.

    ``slot_starts``/``prices_eur_mwh``/``load_kw``/``pv_kw`` are parallel lists
    (one entry per 15-min slot, ascending, contiguous). ``grid_limit_kw`` is the
    observed §14a envelope applied as a hard cap on net import AND export;
    ``None`` means unconstrained. ``initial_soc_kwh`` is the battery state at
    the start of the first slot.

    ``max_feed_in_kw`` (FK1, the Excel reference spec's "Max Einspeisung am
    Netzpunkt") is the site's STATIC feed-in cap at the grid connection point
    (``site.max_feed_in_kw`` master data): a hard cap on EXPORT ONLY - import
    is never limited by it. It is separate from (and composes with) the
    telemetry-driven §14a ``grid_limit_kw``: when both exist the tighter one
    wins on export. ``None`` means no connection-point limit.

    ``netzladen_erlaubt`` mirrors ``site.netzladen_erlaubt`` (the per-site
    grid-charging switch, captain decision 2026-07-07): ``True`` = merchant
    mode, the battery may charge from the grid (price arbitrage); ``False`` =
    EEG mode, the battery charges ONLY from PV the site actually produces
    (``charge <= pv - curtail``, PV-bus Bilanzierung per FK3, captain decision
    2026-07-16; the house may import its load in parallel) - the
    Ausschliesslichkeitsprinzip for EEG-funded plants. The field is REQUIRED
    (no default) on purpose: every caller must decide, so a forgotten wire-up
    can never silently put an EEG plant into grid arbitrage.

    **Asymmetric pricing (P1, Stage 2 of the optimizer redesign):**
    ``import_price_eur_mwh``/``export_value_eur_mwh`` are the per-slot cost of
    an imported kWh and value of an exported kWh, built from the site's tariff
    and remuneration by :mod:`voltpilot_optimization.pricing`. ``None`` (the
    default) means bare spot on that side - the pre-P1 symmetric model, so
    un-wired callers and pure-market sites behave exactly as before.
    ``prices_eur_mwh`` stays the SPOT series (persisted per slot for the
    portal's price curve; also the §51 sign signal the pricing layer already
    folded into the export values).

    **Terminal energy value (P3, Stage 3):** ``terminal_value_eur_per_kwh`` is
    the value the objective credits per kWh left in the battery at the horizon
    end (EUR per STORED kWh). ``None`` (the default) derives it from the
    horizon's own prices (:meth:`effective_terminal_value_eur_per_kwh`);
    ``gather_inputs`` sets an explicit value only when the platform override
    ``OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH`` is configured.

    **Peak shaving (PS-1):** ``leistungspreis_eur_kw`` is the site's
    Leistungspreis (EUR per kW per billing period, ``site.leistungspreis_eur_kw``);
    ``None`` (the default) = the module is off and the model is byte-identical
    to before. ``peak_so_far_kw`` is the billing period's highest 15-min mean
    grid import measured SO FAR (computed fresh per cycle by
    ``inputs._peak_so_far_kw``; 0 at period start) - the anchor the epigraph
    term charges the Leistungspreis above (see solver.py).
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
    netzladen_erlaubt: bool
    grid_limit_kw: float | None = None
    max_feed_in_kw: float | None = None
    slot_minutes: int = SLOT_MINUTES
    import_price_eur_mwh: list[float] | None = None
    export_value_eur_mwh: list[float] | None = None
    terminal_value_eur_per_kwh: float | None = None
    leistungspreis_eur_kw: float | None = None
    peak_so_far_kw: float = 0.0

    def __post_init__(self) -> None:
        n = len(self.slot_starts)
        if n == 0:
            raise ValueError("horizon must contain at least one slot")
        for name in ("prices_eur_mwh", "load_kw", "pv_kw"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        for name in ("import_price_eur_mwh", "export_value_eur_mwh"):
            series = getattr(self, name)
            if series is not None and len(series) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        if self.slot_minutes <= 0:
            raise ValueError("slot_minutes must be positive")
        if self.grid_limit_kw is not None and self.grid_limit_kw <= 0:
            raise ValueError("grid_limit_kw must be positive when set")
        if self.max_feed_in_kw is not None and self.max_feed_in_kw <= 0:
            raise ValueError("max_feed_in_kw must be positive when set")
        if self.terminal_value_eur_per_kwh is not None and not (
            math.isfinite(self.terminal_value_eur_per_kwh)
            and self.terminal_value_eur_per_kwh >= 0.0
        ):
            raise ValueError(
                "terminal_value_eur_per_kwh must be finite and >= 0 when set"
            )
        if self.leistungspreis_eur_kw is not None and not (
            math.isfinite(self.leistungspreis_eur_kw)
            and self.leistungspreis_eur_kw >= 0.0
        ):
            raise ValueError("leistungspreis_eur_kw must be finite and >= 0 when set")
        if not (math.isfinite(self.peak_so_far_kw) and self.peak_so_far_kw >= 0.0):
            raise ValueError("peak_so_far_kw must be finite and >= 0")

    @property
    def slots(self) -> int:
        return len(self.slot_starts)

    @property
    def slot_hours(self) -> float:
        return self.slot_minutes / 60.0

    @property
    def import_prices(self) -> list[float]:
        """Per-slot import price, falling back to bare spot (symmetric model)."""
        return (
            self.import_price_eur_mwh
            if self.import_price_eur_mwh is not None
            else self.prices_eur_mwh
        )

    @property
    def export_values(self) -> list[float]:
        """Per-slot export value, falling back to bare spot (symmetric model)."""
        return (
            self.export_value_eur_mwh
            if self.export_value_eur_mwh is not None
            else self.prices_eur_mwh
        )

    def effective_terminal_value_eur_per_kwh(self, env=None) -> float:
        """The terminal energy value the solver credits per stored kWh at the
        horizon end (P3): the explicit override when set, else derived from
        the horizon's own prices.

        Derivation (see the P3 section of :mod:`voltpilot_optimization.config`
        for the reasoning): ``eta * (P_q - wear)``, floored at 0, where
        ``P_q`` is a conservative low quantile (default the 30th percentile)
        of the per-slot best-use price ``max(import_price_t, export_value_t)``,
        ``eta`` the one-way efficiency (a stored kWh only delivers ``eta`` AC
        kWh) and ``wear`` the per-AC-kWh wear the eventual discharge will
        cost. Because the same ``eta``/``wear`` price the in-horizon discharge,
        a slot priced exactly at ``P_q`` ties with holding (the epsilon
        tie-breaks then prefer holding) - flat curves stay idle by
        construction.
        """
        if self.terminal_value_eur_per_kwh is not None:
            return self.terminal_value_eur_per_kwh
        best_use = [
            max(imp, exp)
            for imp, exp in zip(self.import_prices, self.export_values)
        ]
        quantile = terminal_value_quantile(env)
        anchor = sorted(best_use)[int(quantile * (len(best_use) - 1))]
        eta = self.battery.one_way_efficiency
        wear_eur_mwh = self.battery.wear_cost_eur_per_kwh_each_way * 1000.0
        return max(0.0, eta * (anchor - wear_eur_mwh) / 1000.0)

    def cashflow_cost_eur(self, index: int, grid_kw: float) -> float:
        """Projected cost of one slot at the given net grid power under the
        asymmetric pricing: import paid at the import price, export credited
        at the export value (negative = revenue)."""
        import_kw = max(grid_kw, 0.0)
        export_kw = max(-grid_kw, 0.0)
        return (
            (
                self.import_prices[index] * import_kw
                - self.export_values[index] * export_kw
            )
            * self.slot_hours
            / 1000.0
        )

    def baseline_cost_eur(self, index: int) -> float:
        """Projected cost of one slot with the battery idle (the no-battery
        baseline the headline savings are measured against), under the same
        asymmetric pricing as the plan - the unregulated plant imports its
        residual load at the tariff and feeds its PV surplus in at the
        remuneration (mirroring EarningsRepository's baseline semantics)."""
        residual_kw = self.load_kw[index] - self.pv_kw[index]
        return self.cashflow_cost_eur(index, residual_kw)


@dataclass(frozen=True)
class PlanSlot:
    """One optimized 15-min slot: the decision plus its projected economics."""

    start: datetime
    battery_kw: float  # + charge / - discharge
    grid_kw: float  # + import / - export
    soc_kwh: float  # state of charge at slot END
    load_kw: float  # load forecast input used
    pv_kw: float  # PV forecast input used
    price_eur_mwh: float  # the day-ahead SPOT price (portal price curve)
    cost_eur: float  # projected slot cashflow with the plan (asymmetric pricing)
    baseline_cost_eur: float  # projected slot cashflow with the battery idle
    # Planned PV curtailment (kW discarded, 0 <= curtail_kw <= pv_kw). Non-zero
    # only when feeding in would COST money (negative EXPORT VALUE, e.g. a
    # Direktvermarktung plant at negative spot) - see solver.py.
    curtail_kw: float = 0.0
    # Priced battery degradation of this slot's throughput (EUR, >= 0) - the
    # wear the plan spends to earn its grid savings. NOT included in cost_eur
    # (which stays the projected grid cashflow): the honest slot economics are
    # baseline_cost_eur - cost_eur - wear_cost_eur. Persisted alongside the
    # other economics (schedule.wear_cost_eur); consumers (portal/admin "why"
    # view) read it in a later stage.
    wear_cost_eur: float = 0.0

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
    # Mirrors site.netzladen_erlaubt at plan time; published as the OPTIONAL
    # grid_charge_allowed contract field (P5) so the EDGE enforces the EEG
    # solar-only-charge rule against MEASURED pv/load. None = omit the field
    # (legacy payload shape, edge behaves exactly as before).
    grid_charge_allowed: bool | None = None
    # The terminal energy value the run's objective credited per stored kWh at
    # the horizon end (P3; :meth:`OptimizationInput.effective_terminal_value_eur_per_kwh`).
    # Only the solver knows the derived value, so it is stamped here and
    # persisted per run (schedule.terminal_value_eur_per_kwh) - the portal
    # shows the banked value ``V_end * (soc_end - soc_start)`` as its own line
    # on bank days (FK2), where savings_eur alone would look broken. None =
    # unknown (pre-FK2 plans); the display then degrades gracefully.
    terminal_value_eur_per_kwh: float | None = None
    # PS-1: the solved peak variable = the run's planned billing-period peak
    # target (max of the horizon's planned import and peak_so_far, kW).
    # Published as the OPTIONAL grid_import_limit_kw contract field (the edge
    # peak-guard's target, PS-3 sibling task) and persisted per run
    # (schedule.peak_target_kw) for the reporting increment. None = the peak
    # module is off (site.leistungspreis_eur_kw NULL) - both consumers then
    # omit/NULL the field, never a fabricated number.
    peak_target_kw: float | None = None

    @property
    def cost_eur(self) -> float:
        return sum(s.cost_eur for s in self.slots)

    @property
    def baseline_cost_eur(self) -> float:
        return sum(s.baseline_cost_eur for s in self.slots)

    @property
    def wear_cost_eur(self) -> float:
        """Priced battery degradation the plan spends over the horizon."""
        return sum(s.wear_cost_eur for s in self.slots)

    @property
    def savings_eur(self) -> float:
        """Projected GRID savings vs. the no-battery baseline over the horizon
        (gross of battery wear - subtract :attr:`wear_cost_eur` for the honest
        net figure; the persisted per-slot columns carry both). Since P3
        (terminal energy value) this may include realizing energy the battery
        already held at the plan start - the realized-earnings engine, not the
        planned figure, remains the honest money number."""
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
    """The rolling-horizon slot grid: the first slot is the one IN PROGRESS at
    ``now`` (floored to the slot boundary), so the published plan always has a
    slot covering ``now``. The edge activates a slot only once ``now >= start``
    (plan.go ``ActiveSetpoint``); a grid starting at the NEXT boundary left it
    with no active slot - self-consumption fallback instead of the optimizer's
    dispatch - from every publish until the boundary (B1). Prices and forecasts
    cover the in-progress slot and the live SoC is valid for its remainder."""
    first = floor_to_slot(now, slot_minutes)
    return [first + i * timedelta(minutes=slot_minutes) for i in range(slots)]


def ensure_utc(dt: datetime) -> datetime:
    """Return ``dt`` as timezone-aware UTC (naive datetimes are assumed UTC,
    the platform's storage/transport convention)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

"""Multi-entity co-optimizer vocabulary (E4-Basis, v2 track).

Generalizes the single-battery :class:`~voltpilot_optimization.domain.OptimizationInput`
to N entities per site - storage[], producer[], controllable load[] - each with
its own params and limits, per plan-draft §2.3 ("Solver-Generalisierung"). The
v1 single-battery shape becomes the exact N=1 special case via
:func:`from_v1_input`; the golden suite (``tests/golden/``) proves the
generalized solver reproduces the v1 solver's decisions and objective on that
adapter, slot by slot - the cutover acceptance basis.

Same conventions as :mod:`voltpilot_optimization.domain`: UTC datetimes, kW
power (+charge/-discharge for storage, +import/-export for grid), EUR/MWh
prices, EUR costs, 15-min slots.

Entity ids are MQTT-topic-safe strings (the mqtt-schedule-2.0 contract's
``entity_id`` pattern). Until the E1a entity registry exists, the v1 adapter
uses the deterministic well-known ids ``storage-main``/``pv-main``; registry
wiring replaces those when it lands.

**DV-konformer Modus** (plan-draft §2.7 "DV-konformer Modus"; geförderte
Direktvermarktung: the battery must never charge from the grid): the site-level
``dv_konform`` flag hard-disables grid-charge arbitrage for EVERY storage
entity - most-restrictive-wins over any per-entity
``charge_from_grid_allowed`` - while consumption-side strategies (self-
consumption routing, peak shaving, curtailment, reserves) stay fully active.
Mapping to the existing machinery, documented here once:

===========================  ==================================================
v1 (single battery)          v2 (co-optimizer)
===========================  ==================================================
``netzladen_erlaubt=False``  every storage's effective grid-charge permission
(EEG mode)                   is False -> the SAME solar-only-charge constraint
                             (``charge <= pv - curtail``, PV-bus Bilanzierung
                             per FK3) selected by the SolarOnlyCharge module
``netzladen_erlaubt=True``   per-entity ``charge_from_grid_allowed=True`` AND
(merchant mode)              ``dv_konform=False``
DV-konformer Modus           ``dv_konform=True``: forces effective permission
(new, per-site)              False for ALL storages regardless of per-entity
                             config - byte-identical constraint machinery to
                             EEG mode, selected per entity subset
===========================  ==================================================

The v2 publisher emits the EFFECTIVE per-entity permission explicitly (the
contract's D-8 rule: absent = NOT allowed, so the field is always present).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    SLOT_MINUTES,
    derive_terminal_value_eur_per_kwh,
)

# The mqtt-schedule-2.0 contract's entity_id pattern (MQTT-topic-safe).
ENTITY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Deterministic well-known entity ids for the v1 N=1 adapter, until the E1a
# entity registry provides real ids.
V1_STORAGE_ENTITY_ID = "storage-main"
V1_PRODUCER_ENTITY_ID = "pv-main"


def _require_entity_id(entity_id: str) -> None:
    if not ENTITY_ID_PATTERN.match(entity_id):
        raise ValueError(
            f"entity_id must match {ENTITY_ID_PATTERN.pattern!r}: {entity_id!r}"
        )


@dataclass(frozen=True)
class StorageEntity:
    """One storage entity (battery) with its own params and limits.

    ``params`` reuses :class:`BatteryParams` unchanged - capacity, power caps,
    efficiency, wear cost, SoC band and the reservation stack (backup + peak
    reserve) are all per-entity already.

    ``charge_from_grid_allowed`` is the per-entity grid-charge permission
    (the v2 contract vocabulary; v1's site-level ``netzladen_erlaubt`` maps
    onto it 1:1 for the single battery). The EFFECTIVE permission additionally
    honors the site-level DV-konform mode - read it via
    :meth:`CoOptimizationInput.grid_charge_allowed`, never this field directly.
    """

    entity_id: str
    params: BatteryParams
    initial_soc_kwh: float
    charge_from_grid_allowed: bool

    def __post_init__(self) -> None:
        _require_entity_id(self.entity_id)
        if not math.isfinite(self.initial_soc_kwh):
            raise ValueError("initial_soc_kwh must be finite")


@dataclass(frozen=True)
class ProducerEntity:
    """One generation entity (PV string/roof/park) with its per-slot forecast.

    ``curtailable`` producers get a per-slot curtailment decision (bounded by
    their own forecast - a limit only ever REDUCES generation, the safety
    property the edge re-clamps); non-curtailable producers are must-run.
    """

    entity_id: str
    generation_kw: list[float]
    curtailable: bool = True

    def __post_init__(self) -> None:
        _require_entity_id(self.entity_id)


@dataclass(frozen=True)
class ControllableLoadEntity:
    """A controllable consumer (wallbox, heat rod, ...) - DECLARED but not yet
    dispatched: the E4-Basis solver accepts only an empty list (the follow-up
    E4 features add flexible-load dispatch semantics - HLZF windows, energy
    demands - once their contracts exist). The dataclass exists so the input
    shape is final and callers can already thread the (empty) list through.
    """

    entity_id: str
    max_power_kw: float

    def __post_init__(self) -> None:
        _require_entity_id(self.entity_id)
        if not (math.isfinite(self.max_power_kw) and self.max_power_kw > 0):
            raise ValueError("max_power_kw must be finite and positive")


@dataclass(frozen=True)
class CoOptimizationInput:
    """Everything one co-optimizer run needs: N entities on one shared slot
    grid behind one grid connection point.

    Site-level fields keep their v1 semantics verbatim (they are properties of
    the connection point, not of an entity - the mqtt-schedule-2.0 table):
    ``grid_limit_kw`` (§14a, import AND export), ``max_feed_in_kw`` (FK1,
    export only), ``leistungspreis_eur_kw``/``peak_so_far_kw`` (PS-1) and the
    asymmetric ``import_price_eur_mwh``/``export_value_eur_mwh`` series.

    ``base_load_kw`` is the UNCONTROLLABLE site load forecast (v1's
    ``load_kw``); controllable consumers are separate entities.

    ``dv_konform`` is the per-site DV-konformer Modus (see the module
    docstring for the mapping onto the netzladen_erlaubt machinery).
    """

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    slot_starts: list[datetime]
    prices_eur_mwh: list[float]
    base_load_kw: list[float]
    storages: tuple[StorageEntity, ...]
    producers: tuple[ProducerEntity, ...] = ()
    controllable_loads: tuple[ControllableLoadEntity, ...] = ()
    grid_limit_kw: float | None = None
    max_feed_in_kw: float | None = None
    slot_minutes: int = SLOT_MINUTES
    import_price_eur_mwh: list[float] | None = None
    export_value_eur_mwh: list[float] | None = None
    terminal_value_eur_per_kwh: float | None = None
    leistungspreis_eur_kw: float | None = None
    peak_so_far_kw: float = 0.0
    dv_konform: bool = False

    def __post_init__(self) -> None:
        n = len(self.slot_starts)
        if n == 0:
            raise ValueError("horizon must contain at least one slot")
        if not self.storages and not self.producers:
            raise ValueError("at least one storage or producer entity required")
        for name in ("prices_eur_mwh", "base_load_kw"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        for name in ("import_price_eur_mwh", "export_value_eur_mwh"):
            series = getattr(self, name)
            if series is not None and len(series) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        for producer in self.producers:
            if len(producer.generation_kw) != n:
                raise ValueError(
                    f"producer {producer.entity_id!r} generation_kw must have "
                    f"one entry per slot ({n})"
                )
        ids = [e.entity_id for e in self.entities]
        if len(set(ids)) != len(ids):
            raise ValueError(f"entity ids must be unique: {sorted(ids)}")
        if self.controllable_loads:
            raise NotImplementedError(
                "controllable_loads dispatch is not part of E4-Basis - the "
                "list must be empty until the flexible-load feature lands"
            )
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
    def entities(self) -> tuple:
        return self.storages + self.producers + self.controllable_loads

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

    def grid_charge_allowed(self, storage: StorageEntity) -> bool:
        """The storage's EFFECTIVE grid-charge permission: its own
        ``charge_from_grid_allowed`` AND'd with the site-level DV-konform mode
        (most-restrictive-wins). This is the single decision point the solver
        modules AND the v2 publisher read."""
        return storage.charge_from_grid_allowed and not self.dv_konform

    def total_pv_kw(self, t: int) -> float:
        """Total site generation forecast in slot ``t`` (all producers)."""
        return sum(p.generation_kw[t] for p in self.producers)

    def effective_terminal_value_eur_per_kwh(
        self, storage: StorageEntity, env=None
    ) -> float:
        """The P3 terminal energy value PER STORAGE ENTITY: the explicit
        override when set (one platform value for all entities), else THE SAME
        :func:`~voltpilot_optimization.domain.derive_terminal_value_eur_per_kwh`
        the v1 input uses, fed the ENTITY's efficiency, wear, usable band and
        EFFECTIVE grid-charge permission - so the N=1 adapter reproduces the v1
        value bit for bit by sharing the derivation, not by duplicating it."""
        if self.terminal_value_eur_per_kwh is not None:
            return self.terminal_value_eur_per_kwh
        p = storage.params
        soc0 = p.clamp_soc_kwh(storage.initial_soc_kwh)
        return derive_terminal_value_eur_per_kwh(
            import_prices=self.import_prices,
            export_values=self.export_values,
            pv_kw=[self.total_pv_kw(t) for t in range(self.slots)],
            load_kw=self.base_load_kw,
            slot_hours=self.slot_hours,
            max_charge_kw=p.max_charge_kw,
            usable_band_kwh=p.soc_max_kwh - p.soc_floor_kwh(soc0),
            one_way_efficiency=p.one_way_efficiency,
            wear_eur_per_kwh_each_way=p.wear_cost_eur_per_kwh_each_way,
            grid_charge_allowed=self.grid_charge_allowed(storage),
            env=env,
        )

    def cashflow_cost_eur(self, index: int, grid_kw: float) -> float:
        """Projected cost of one slot at the given net grid power under the
        asymmetric pricing (v1 semantics verbatim)."""
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
        """Projected cost of one slot with every storage idle and nothing
        curtailed (the no-battery baseline, v1 semantics verbatim)."""
        residual_kw = self.base_load_kw[index] - self.total_pv_kw(index)
        return self.cashflow_cost_eur(index, residual_kw)


def from_v1_input(
    inp: OptimizationInput,
    storage_entity_id: str = V1_STORAGE_ENTITY_ID,
    producer_entity_id: str = V1_PRODUCER_ENTITY_ID,
) -> CoOptimizationInput:
    """Adapt today's single-battery :class:`OptimizationInput` into the exact
    N=1 co-optimizer special case: one storage entity (the site battery, its
    grid-charge permission = ``netzladen_erlaubt``), one producer entity (the
    aggregated site PV forecast), no controllable loads. Every site-level
    field carries over verbatim. The golden suite pins that
    ``co_optimize(from_v1_input(x))`` reproduces ``optimize(x)``."""
    return CoOptimizationInput(
        tenant_id=inp.tenant_id,
        site_id=inp.site_id,
        device_id=inp.device_id,
        slot_starts=inp.slot_starts,
        prices_eur_mwh=inp.prices_eur_mwh,
        base_load_kw=inp.load_kw,
        storages=(
            StorageEntity(
                entity_id=storage_entity_id,
                params=inp.battery,
                initial_soc_kwh=inp.initial_soc_kwh,
                charge_from_grid_allowed=inp.netzladen_erlaubt,
            ),
        ),
        producers=(
            ProducerEntity(
                entity_id=producer_entity_id,
                generation_kw=inp.pv_kw,
                curtailable=True,
            ),
        ),
        grid_limit_kw=inp.grid_limit_kw,
        max_feed_in_kw=inp.max_feed_in_kw,
        slot_minutes=inp.slot_minutes,
        import_price_eur_mwh=inp.import_price_eur_mwh,
        export_value_eur_mwh=inp.export_value_eur_mwh,
        terminal_value_eur_per_kwh=inp.terminal_value_eur_per_kwh,
        leistungspreis_eur_kw=inp.leistungspreis_eur_kw,
        peak_so_far_kw=inp.peak_so_far_kw,
    )


# --------------------------------------------------------------------------
# The multi-entity plan artifact (what the co-optimizer produces and the
# schedule-2.0 publisher consumes).
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class StorageSlot:
    """One storage entity's dispatch in one slot."""

    start: datetime
    setpoint_kw: float  # + charge / - discharge (contract sign convention)
    soc_kwh: float  # state of charge at slot END
    wear_cost_eur: float  # priced degradation of this slot's throughput


@dataclass(frozen=True)
class StorageDispatch:
    """One storage entity's full-horizon dispatch."""

    entity_id: str
    params: BatteryParams
    charge_from_grid_allowed: bool  # EFFECTIVE permission (post DV-konform)
    slots: list[StorageSlot] = field(default_factory=list)
    terminal_value_eur_per_kwh: float = 0.0

    @property
    def reserve_soc_pct(self) -> float | None:
        """The PS-2 peak reserve the v2 payload carries per entity."""
        return self.params.peak_reserve_pct

    @property
    def wear_cost_eur(self) -> float:
        return sum(s.wear_cost_eur for s in self.slots)


@dataclass(frozen=True)
class ProducerSlot:
    """One producer entity's (potential) curtailment in one slot."""

    start: datetime
    generation_kw: float  # forecast input used
    curtail_kw: float  # planned reduction (0 <= curtail <= generation)

    @property
    def limit_kw(self) -> float | None:
        """The generation cap implementing the curtailment (generation -
        curtail, never negative), or None when nothing is curtailed - the
        published plan omits the limit then (absent = no limit, clears)."""
        if self.curtail_kw <= 0.0:
            return None
        return max(self.generation_kw - self.curtail_kw, 0.0)


@dataclass(frozen=True)
class ProducerDispatch:
    """One producer entity's full-horizon curtailment plan."""

    entity_id: str
    slots: list[ProducerSlot] = field(default_factory=list)

    @property
    def curtails(self) -> bool:
        return any(s.curtail_kw > 0.0 for s in self.slots)


@dataclass(frozen=True)
class SiteSlot:
    """Site-level flows and economics of one slot."""

    start: datetime
    grid_kw: float  # + import / - export
    base_load_kw: float
    price_eur_mwh: float  # day-ahead SPOT (portal price curve)
    cost_eur: float  # projected slot cashflow with the plan
    baseline_cost_eur: float  # projected slot cashflow, storages idle


@dataclass(frozen=True)
class SitePlan:
    """A full co-optimizer run for one site: N entity dispatches plus the
    site-level flows - the artifact the mqtt-schedule-2.0 publisher consumes.

    ``objective_eur`` is the SOLVED objective value (the golden suite's
    strongest equivalence anchor against the v1 model's objective)."""

    plan_id: UUID
    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    generated_at: datetime
    storages: list[StorageDispatch] = field(default_factory=list)
    producers: list[ProducerDispatch] = field(default_factory=list)
    site_slots: list[SiteSlot] = field(default_factory=list)
    slot_minutes: int = SLOT_MINUTES
    peak_target_kw: float | None = None
    objective_eur: float = 0.0

    @property
    def cost_eur(self) -> float:
        return sum(s.cost_eur for s in self.site_slots)

    @property
    def baseline_cost_eur(self) -> float:
        return sum(s.baseline_cost_eur for s in self.site_slots)

    @property
    def wear_cost_eur(self) -> float:
        return sum(s.wear_cost_eur for s in self.storages)

    @property
    def savings_eur(self) -> float:
        return self.baseline_cost_eur - self.cost_eur

    def __len__(self) -> int:
        return len(self.site_slots)

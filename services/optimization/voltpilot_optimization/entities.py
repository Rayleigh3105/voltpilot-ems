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
    ANCHOR_VORGABE,
    BatteryParams,
    OptimizationInput,
    SLOT_MINUTES,
    TerminalValue,
    derive_terminal_value,
)
from voltpilot_optimization.night_reserve import NightErrorQuantiles

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


CONTROL_KINDS = ("on_off", "stepped", "continuous")
GRID_ENERGY_POLICIES = ("allow", "avoid", "forbid")
STORAGE_RELATIONS = ("consumer_first", "storage_first")
REQUIREMENT_KINDS = ("fixed_window", "flexible_task")
ENFORCEMENTS = ("must_run", "required_by_deadline")

# The plan-slot / requirement reason vocabulary (§15). The portal translates
# these through a pure, tested TS map - never by scanning German sentences.
REASON_FIXED_WINDOW = "fixed_window"
REASON_PRICE_WINDOW = "price_below_threshold"
REASON_OPTIMIZER = "optimizer_selected_low_cost"
REASON_FLEX_DEADLINE = "flex_deadline"
REASON_GRID_LIMIT = "guard_grid_limit"
REASON_NO_PERMITTED_ENERGY = "no_permitted_energy"

# A compiled requirement id: the policy document's stable id, optionally with
# an ``@YYYY-MM-DD`` instance suffix (flexible tasks split per recurrence
# instance) - persisted as TEXT, never an MQTT topic segment.
REQUIREMENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,80}$")


@dataclass(frozen=True)
class LoadRequirement:
    """One COMPILED operating requirement of a controllable consumer.

    This is the solver-facing half of the policy compiler (D1): the cloud has
    already expanded recurrences and price/time conditions into concrete slot
    indices of THIS horizon (``window_slots``), so the solver never evaluates
    a price or a timezone - it only sees windows. Reactive requirements with
    LOCAL signals never reach this shape (they are edge work, Inkrement 4).

    ``kind``:

    - ``fixed_window``: the target power must hold in EVERY window slot
      (Pflichtlauf §5.2, or a compiled price/conditional window §5.3/D1) -
      with an honest fulfilment slack that only ever engages below harder
      protection layers (§12.3), minimized lexicographically BEFORE economics.
    - ``flexible_task``: a runtime and/or energy demand due within the window
      (§5.4); the optimizer picks the timing. ``contiguous`` keeps the user's
      choice - it is never re-interpreted (E5).

    ``reason_code`` is the §15 vocabulary word served slots of this
    requirement carry in the persisted plan (``fixed_window`` vs
    ``price_below_threshold`` vs ``optimizer_selected_low_cost``).

    ``service_rank`` orders MANDATORY requirements between consumers in the
    stage-1 slack lexicography (E9: binding min-runs are operational
    constraints, then rank, then the earlier deadline, then the stable
    requirement id). It is NEVER an edge arbitration class.

    ``allow_storage_discharge`` / ``grid_energy_policy`` are per-requirement
    overrides (E10/§10); ``None`` inherits the consumer default. A compiled
    ``must_run`` requirement always carries ``grid_energy_policy="allow"``
    (E2 - the compiler stamps it, the model never re-derives it).
    """

    requirement_id: str
    kind: str
    window_slots: tuple[int, ...]
    target_kw: float | None = None
    required_minutes: int | None = None
    required_kwh: float | None = None
    contiguous: bool = False
    enforcement: str = "must_run"
    service_rank: int | None = None
    allow_storage_discharge: bool | None = None
    grid_energy_policy: str | None = None
    reason_code: str = REASON_FIXED_WINDOW

    def __post_init__(self) -> None:
        if not REQUIREMENT_ID_PATTERN.match(self.requirement_id):
            raise ValueError(
                f"requirement_id must match {REQUIREMENT_ID_PATTERN.pattern!r}: "
                f"{self.requirement_id!r}"
            )
        if self.kind not in REQUIREMENT_KINDS:
            raise ValueError(f"unknown requirement kind: {self.kind!r}")
        if self.enforcement not in ENFORCEMENTS:
            raise ValueError(f"unknown enforcement: {self.enforcement!r}")
        if not self.window_slots:
            raise ValueError(
                f"requirement {self.requirement_id!r} needs at least one "
                "window slot (empty windows are dropped by the compiler)"
            )
        if list(self.window_slots) != sorted(set(self.window_slots)):
            raise ValueError(
                f"requirement {self.requirement_id!r} window_slots must be "
                "sorted and unique"
            )
        if any(t < 0 for t in self.window_slots):
            raise ValueError("window_slots must be non-negative indices")
        if self.kind == "fixed_window":
            if self.target_kw is None or not (
                math.isfinite(self.target_kw) and self.target_kw > 0
            ):
                raise ValueError(
                    f"fixed_window requirement {self.requirement_id!r} needs "
                    "a positive target_kw"
                )
        else:  # flexible_task
            if self.required_minutes is None and self.required_kwh is None:
                raise ValueError(
                    f"flexible_task {self.requirement_id!r} needs "
                    "required_minutes and/or required_kwh"
                )
            if self.required_minutes is not None and self.required_minutes <= 0:
                raise ValueError("required_minutes must be positive")
            if self.required_kwh is not None and not (
                math.isfinite(self.required_kwh) and self.required_kwh > 0
            ):
                raise ValueError("required_kwh must be finite and positive")
        if self.grid_energy_policy is not None and (
            self.grid_energy_policy not in GRID_ENERGY_POLICIES
        ):
            raise ValueError(
                f"unknown grid_energy_policy: {self.grid_energy_policy!r}"
            )
        if self.enforcement == "must_run" and self.grid_energy_policy == "forbid":
            raise ValueError(
                "must_run implies grid allow (E2) - forbid is contradictory"
            )

    @property
    def deadline_slot(self) -> int:
        """The last window slot - the requirement's in-horizon deadline
        (orders colliding mandatory requirements, E9)."""
        return self.window_slots[-1]

    @property
    def mandatory(self) -> bool:
        """Both compiled enforcements are obligations whose shortfall is a
        stage-1 slack (a Pflichtlauf immediately, a flexible task by its
        deadline); opportunistic requirements never reach the solver."""
        return True


@dataclass(frozen=True)
class ControllableLoadEntity:
    """A controllable consumer (wallbox, heat rod, pump, ...) with its control
    profile and COMPILED operating requirements (§12.1).

    Control coupling per ``control_kind`` (§12.2):

    - ``on_off``: power is 0 or ``max_power_kw``.
    - ``stepped``: power is one of ``levels_kw`` (explicit ascending list
      including 0 - uneven manufacturer levels stay representable, §4.3).
    - ``continuous``: ``min_power_kw <= power <= max_power_kw`` while on,
      optionally restricted to the D4 non-convex ``power_ranges_kw`` (one
      binary per range, at most one active, e.g. 1-/3-phase charging).

    ``storage_relation`` (E1/D6) is an ENERGY PREFERENCE inside the joint
    optimization - a deterministic epsilon-class tie-break, never a safety or
    grid priority and never a stage of its own (D2). ``grid_energy_policy`` /
    ``allow_storage_discharge`` are the consumer DEFAULTS; requirements may
    override per §10.

    ``min_on_slots``/``min_off_slots``/``max_starts_per_horizon``/
    ``ramp_kw_per_slot`` are the unit-commitment invariants (§12.2); the
    stateful edge cycle guard (Inkrement 3) enforces them a second time at
    the device - the solver plans within them so plans are executable.

    A consumer runs ONLY to serve its requirements: outside every compiled
    window it is planned OFF. Opportunistic operation (§5.5) is a later,
    explicitly opted-in feature - without it the optimizer must not switch a
    device on just because energy is momentarily cheap.

    ``has_local_source`` is the K2 flag (Verbrauchsmanagement v1 / P5): this
    consumer's policy ALSO carries a requirement whose condition is a LOCAL
    signal, which only the edge can evaluate (``compile_condition_slots``
    returned ``None``). The solver is unaffected - it plans the compiled
    windows exactly as before -, but the PUBLISHER then omits every slot the
    plan does not dispatch: where the plan is SILENT, the local rule governs.
    Publishing an explicit off there would be the plan overruling a rule the
    customer chose, every quarter hour, for the whole horizon.
    """

    entity_id: str
    max_power_kw: float
    control_kind: str = "on_off"
    min_power_kw: float = 0.0
    levels_kw: tuple[float, ...] = ()
    power_ranges_kw: tuple[tuple[float, float], ...] = ()
    storage_relation: str = "consumer_first"
    grid_energy_policy: str = "allow"
    allow_storage_discharge: bool = False
    min_on_slots: int = 0
    min_off_slots: int = 0
    max_starts_per_horizon: int | None = None
    ramp_kw_per_slot: float | None = None
    requirements: tuple[LoadRequirement, ...] = ()
    initially_on: bool = False
    has_local_source: bool = False

    def __post_init__(self) -> None:
        _require_entity_id(self.entity_id)
        if not (math.isfinite(self.max_power_kw) and self.max_power_kw > 0):
            raise ValueError("max_power_kw must be finite and positive")
        if self.control_kind not in CONTROL_KINDS:
            raise ValueError(f"unknown control_kind: {self.control_kind!r}")
        if self.storage_relation not in STORAGE_RELATIONS:
            raise ValueError(f"unknown storage_relation: {self.storage_relation!r}")
        if self.grid_energy_policy not in GRID_ENERGY_POLICIES:
            raise ValueError(
                f"unknown grid_energy_policy: {self.grid_energy_policy!r}"
            )
        if self.control_kind == "stepped":
            if len(self.levels_kw) < 2 or self.levels_kw[0] != 0.0:
                raise ValueError(
                    "stepped consumers need an explicit ascending levels_kw "
                    "list starting at 0 (§4.3)"
                )
            if list(self.levels_kw) != sorted(set(self.levels_kw)):
                raise ValueError("levels_kw must strictly ascend")
            if self.levels_kw[-1] > self.max_power_kw + 1e-9:
                raise ValueError("levels_kw must stay within max_power_kw")
        elif self.levels_kw:
            raise ValueError("levels_kw is only valid for stepped consumers")
        if self.power_ranges_kw:
            if self.control_kind != "continuous":
                raise ValueError(
                    "power_ranges_kw is only valid for continuous consumers (D4)"
                )
            prev_max = 0.0
            for lo, hi in self.power_ranges_kw:
                if not (0.0 < lo <= hi <= self.max_power_kw + 1e-9):
                    raise ValueError(
                        "each power range must satisfy 0 < min <= max <= rated"
                    )
                if lo < prev_max:
                    raise ValueError(
                        "power_ranges_kw must be disjoint and ascending (D4)"
                    )
                prev_max = hi
        if self.control_kind == "continuous" and not self.power_ranges_kw:
            if not (0.0 <= self.min_power_kw <= self.max_power_kw):
                raise ValueError(
                    "continuous consumers need 0 <= min_power_kw <= max_power_kw"
                )
        if self.min_on_slots < 0 or self.min_off_slots < 0:
            raise ValueError("min_on/off_slots must be >= 0")
        if self.max_starts_per_horizon is not None and self.max_starts_per_horizon < 0:
            raise ValueError("max_starts_per_horizon must be >= 0 when set")
        if self.ramp_kw_per_slot is not None and not (
            math.isfinite(self.ramp_kw_per_slot) and self.ramp_kw_per_slot > 0
        ):
            raise ValueError("ramp_kw_per_slot must be finite and positive when set")
        seen: set[str] = set()
        for req in self.requirements:
            if req.requirement_id in seen:
                raise ValueError(
                    f"duplicate requirement window id: {req.requirement_id!r}"
                )
            seen.add(req.requirement_id)

    def effective_storage_discharge(self, req: LoadRequirement) -> bool:
        """E10: the requirement override when present, else the consumer
        default."""
        if req.allow_storage_discharge is not None:
            return req.allow_storage_discharge
        return self.allow_storage_discharge

    def effective_grid_policy(self, req: LoadRequirement) -> str:
        """E2/§10: must_run is always allow; else the requirement override,
        else the consumer default."""
        if req.enforcement == "must_run":
            return "allow"
        if req.grid_energy_policy is not None:
            return req.grid_energy_policy
        return self.grid_energy_policy


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
    #: Die Nacht-Fehlerverteilung dieser Anlage (P3) - die v1-Semantik
    #: verbatim (siehe
    #: :attr:`~voltpilot_optimization.domain.OptimizationInput.night_error_quantiles`);
    #: sie ist eine Eigenschaft des STANDORTS, nicht eines Speichers, und der
    #: Term laeuft deshalb ueber die SUMME der Ladestaende.
    night_error_quantiles: NightErrorQuantiles | None = None

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
        for load in self.controllable_loads:
            for req in load.requirements:
                if req.window_slots[-1] >= n:
                    raise ValueError(
                        f"load {load.entity_id!r} requirement "
                        f"{req.requirement_id!r} references slot "
                        f"{req.window_slots[-1]} outside the horizon ({n})"
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
        return self.effective_terminal_value(storage, env).v_end

    def effective_terminal_value(
        self, storage: StorageEntity, env=None
    ) -> TerminalValue:
        """The per-entity twin of
        :meth:`~voltpilot_optimization.domain.OptimizationInput.effective_terminal_value`
        - the same number plus the Erklaerbarkeit-Stufe-1 facts, inherited from
        the ONE shared derivation."""
        if self.terminal_value_eur_per_kwh is not None:
            return TerminalValue(
                v_end=self.terminal_value_eur_per_kwh,
                anchor_kind=ANCHOR_VORGABE,
                refill_free_pct=None,
                guard_capped=False,
            )
        p = storage.params
        soc0 = p.clamp_soc_kwh(storage.initial_soc_kwh)
        return derive_terminal_value(
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
            max_feed_in_kw=self.max_feed_in_kw,
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
        night_error_quantiles=inp.night_error_quantiles,
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
class LoadSlot:
    """One controllable consumer's dispatch in one slot.

    ``reason_code``/``requirement_id`` name WHY the slot runs (§15 vocabulary,
    resolved deterministically from the served requirement windows) - ``None``
    on an off slot. The portal renders them through its pure reason map; no
    surface scans German sentences.
    """

    start: datetime
    on: bool
    power_kw: float
    reason_code: str | None = None
    requirement_id: str | None = None


@dataclass(frozen=True)
class UnservedRequirement:
    """An honest shortfall: the solver kept the model feasible by NOT fully
    serving this requirement (stage-1 slack > 0). ``shortfall`` is in
    ``unit`` (``kw_slots`` for fixed windows = Σ missing kW over window
    slots, ``minutes`` / ``kwh`` for flexible demands); ``reason_code`` names
    the cause honestly (§17: grid limit vs. no permitted energy source)."""

    requirement_id: str
    shortfall: float
    unit: str
    reason_code: str


@dataclass(frozen=True)
class LoadDispatch:
    """One controllable consumer's full-horizon dispatch."""

    entity_id: str
    control_kind: str
    slots: list[LoadSlot] = field(default_factory=list)
    unserved: tuple[UnservedRequirement, ...] = ()
    # K2 (P5): this consumer's source is evaluated AT THE EDGE, so the
    # publisher may only carry the slots the plan really dispatches - see
    # ControllableLoadEntity.has_local_source.
    has_local_source: bool = False

    @property
    def energy_kwh(self) -> float:
        """Planned consumption over the horizon (15-min slots assumed by the
        caller via SitePlan.slot_minutes)."""
        return sum(s.power_kw for s in self.slots)


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
    loads: list[LoadDispatch] = field(default_factory=list)
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

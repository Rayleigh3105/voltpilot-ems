"""Policy -> solver input: the CLOUD half of the consumer policy compiler.

Verbrauchssteuerung Inkrement 2 (docs/verbrauchssteuerung.md §8.1/§12.1, D1):
per site, every ACTIVE ``consumer_policy`` document plus its
``consumer_profile`` row is translated DETERMINISTICALLY into a
:class:`~voltpilot_optimization.entities.ControllableLoadEntity` with compiled
:class:`~voltpilot_optimization.entities.LoadRequirement` windows. The solver
never evaluates a price, a timezone or a condition tree - it only ever sees
concrete slot indices of THIS horizon.

Compilation rules (all deterministic, all unit-tested offline):

- **Time windows (E7):** recurrences are authored in the site's IANA zone and
  expanded wall-clock-correct across DST: a slot belongs to a window iff its
  LOCAL start time lies inside ``[from, to)`` on a matching day. ``24:00`` is
  only a window END and normalizes to "until end of day" (= 00:00 of the next
  day); over-midnight windows (``from > to``) split into the evening and
  morning halves, the morning half belonging to the PREVIOUS day's instance.
  Durations stay elapsed time by construction - demand is minutes/kWh over
  real 15-min slots, so a DST day never stretches or shrinks a task.
- **Price conditions (D1):** a reactive requirement whose condition tree
  references ONLY cloud signals (``market.spot_price_ct_kwh`` /
  ``market.import_price_ct_kwh`` - the ONE price truth of ``pricing.py``)
  compiles to the slot set where the tree is true and becomes a fixed-window
  requirement with reason ``price_below_threshold``. A tree touching ANY
  local signal (SoC, PV surplus, availability, ...) is edge work
  (Inkrement 4) and is SKIPPED here - never half-compiled.
- **Skipped honestly, never guessed:** ``opportunistic`` requirements
  (§5.5, later increment), ``mode`` targets (not plannable), off-targets and
  inactive requirements compile to nothing.
- **Flexible tasks split per INSTANCE:** a recurring demand yields one
  requirement per recurrence instance inside the horizon (id suffixed with
  the instance date), each owing its full demand within its remaining
  in-horizon window - a partially elapsed instance keeps its full demand and
  degrades to an honest stage-1 slack when no longer servable (fulfilment
  accounting is a later increment, §9.4).

The DB loader reads with the trusted backend role (the weather-collector
pattern); only ENABLED profiles of CONNECTED entities (an edge source or a
device) enter the solver - §17: an unconnected consumer is never planned.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from voltpilot_optimization.entities import (
    ControllableLoadEntity,
    LoadRequirement,
    REASON_FIXED_WINDOW,
    REASON_OPTIMIZER,
    REASON_PRICE_WINDOW,
)

logger = logging.getLogger("voltpilot.optimization.consumer_inputs")

# The cloud-signal half of the ConsumerSignalCatalog (services/api
# .../consumers/ConsumerSignalCatalog.java + frontend signals.ts - the shared
# consumer-policy-vectors pin the catalog; this set mirrors its `cloud` class).
CLOUD_SIGNALS = frozenset(
    {"market.spot_price_ct_kwh", "market.import_price_ct_kwh"}
)

DEFAULT_TIMEZONE = "Europe/Berlin"


@dataclass(frozen=True)
class ConsumerProfileRow:
    """The ``consumer_profile`` master data the compiler needs (§9.2)."""

    entity_id: str
    control_kind: str
    rated_power_kw: float
    min_power_kw: float | None = None
    levels_kw: tuple[float, ...] | None = None
    power_ranges_kw: tuple[tuple[float, float], ...] | None = None
    storage_relation: str = "consumer_first"
    default_grid_energy_policy: str = "allow"
    allow_storage_discharge: bool = False
    default_service_rank: int | None = None
    min_on_seconds: int | None = None
    min_off_seconds: int | None = None
    max_starts_per_day: int | None = None


def _parse_hhmm(text: str) -> int:
    """Minutes since local midnight; ``24:00`` -> 1440 (window end only)."""
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def _day_matches(local: datetime, days: str) -> bool:
    if days == "daily":
        return True
    if days == "weekdays":
        return local.weekday() < 5
    if days == "weekend":
        return local.weekday() >= 5
    raise ValueError(f"unknown recurrence days: {days!r}")


def expand_recurrence(
    recurrence: dict,
    slot_starts: list[datetime],
    timezone: str,
) -> list[tuple[int, str]]:
    """Slot indices inside the recurring local window, each with the LOCAL
    DATE of the window instance it belongs to (ISO string - the flexible-task
    instance key). Wall-clock membership per slot start makes the expansion
    DST-correct by construction: a nonexistent spring-forward hour simply has
    no slots, a repeated fall-back hour has twice as many - and a demand in
    minutes stays elapsed time either way (E7)."""
    zone = ZoneInfo(timezone)
    frm = _parse_hhmm(recurrence["from"])
    to = _parse_hhmm(recurrence["to"])
    days = recurrence["days"]
    members: list[tuple[int, str]] = []
    for i, start in enumerate(slot_starts):
        local = start.astimezone(zone)
        minute = local.hour * 60 + local.minute
        if frm < to:
            if frm <= minute < to and _day_matches(local, days):
                members.append((i, local.date().isoformat()))
        elif frm > to:
            # Over-midnight window: evening half [frm, 24:00) on the instance
            # day, morning half [00:00, to) belonging to the PREVIOUS day.
            if minute >= frm and _day_matches(local, days):
                members.append((i, local.date().isoformat()))
            elif minute < to:
                instance_day = local - timedelta(days=1)
                if _day_matches(instance_day, days):
                    members.append((i, instance_day.date().isoformat()))
        # frm == to: a zero-length window matches nothing.
    return members


def compile_condition_slots(
    condition: dict,
    spot_ct_kwh: list[float],
    import_ct_kwh: list[float],
) -> tuple[int, ...] | None:
    """Evaluate a CLOUD-ONLY condition tree per slot (D1). Returns the slot
    indices where the tree is true, or ``None`` when any leaf references a
    local signal - the whole requirement is then edge work (Inkrement 4),
    never half-compiled."""

    def eval_node(node: dict, t: int) -> bool | None:
        if "any" in node:
            parts = [eval_node(child, t) for child in node["any"]]
            if any(p is None for p in parts):
                return None
            return any(parts)
        if "all" in node:
            parts = [eval_node(child, t) for child in node["all"]]
            if any(p is None for p in parts):
                return None
            return all(parts)
        if "not" in node:
            inner = eval_node(node["not"], t)
            return None if inner is None else not inner
        signal = node["signal"]
        if signal not in CLOUD_SIGNALS:
            return None
        series = (
            spot_ct_kwh
            if signal == "market.spot_price_ct_kwh"
            else import_ct_kwh
        )
        v = series[t]
        threshold = node["value"]
        op = node["operator"]
        if op == "lt":
            return v < threshold
        if op == "lte":
            return v <= threshold
        if op == "gt":
            return v > threshold
        if op == "gte":
            return v >= threshold
        if op == "eq":
            return v == threshold
        if op == "ne":
            return v != threshold
        raise ValueError(f"unknown operator: {op!r}")

    slots: list[int] = []
    for t in range(len(spot_ct_kwh)):
        result = eval_node(condition, t)
        if result is None:
            return None
        if result:
            slots.append(t)
    return tuple(slots)


def _resolve_target_kw(target: dict, profile: ConsumerProfileRow) -> float | None:
    """The target power a compiled window holds, resolved against the control
    profile (E8: never above the effective rated power). ``None`` = not a
    plannable run target (off-target / mode / zero) - skip the requirement."""
    kind = target["kind"]
    value = target["value"]
    rated = profile.rated_power_kw
    if kind == "on_off":
        return rated if value is True else None
    if kind == "percent":
        kw = rated * float(value) / 100.0
        return kw if kw > 0 else None
    if kind == "kw":
        kw = min(float(value), rated)
        return kw if kw > 0 else None
    return None  # mode: not plannable in the solver


def _slots_per_minute_ceil(seconds: int | None, slot_minutes: int) -> int:
    if not seconds or seconds <= 0:
        return 0
    return math.ceil(seconds / (slot_minutes * 60))


def compile_consumer(
    profile: ConsumerProfileRow,
    document: dict,
    slot_starts: list[datetime],
    slot_minutes: int,
    spot_ct_kwh: list[float],
    import_ct_kwh: list[float],
) -> ControllableLoadEntity | None:
    """Compile one active policy document into a solver entity, or ``None``
    when nothing in it is solver-relevant for this horizon (empty windows,
    only local-reactive/opportunistic requirements, ...)."""
    timezone = document.get("timezone") or DEFAULT_TIMEZONE
    requirements: list[LoadRequirement] = []
    for req in document.get("requirements", []):
        if req.get("active") is False:
            continue
        kind = req["kind"]
        enforcement = req.get("enforcement", "must_run")
        if kind == "opportunistic" or enforcement == "opportunistic":
            continue  # §5.5: a later, explicitly opted-in feature
        target_kw = _resolve_target_kw(req.get("target", {}), profile)
        rank = (
            req.get("service_rank")
            if req.get("service_rank") is not None
            else profile.default_service_rank
        )
        storage_override = req.get("allow_storage_discharge")
        grid_override = req.get("grid_energy_policy")

        if kind == "fixed_window":
            if target_kw is None:
                continue
            members = expand_recurrence(req["recurrence"], slot_starts, timezone)
            window = tuple(sorted({i for i, _day in members}))
            if not window:
                continue
            requirements.append(
                LoadRequirement(
                    requirement_id=req["id"],
                    kind="fixed_window",
                    window_slots=window,
                    target_kw=target_kw,
                    enforcement=(
                        "must_run"
                        if enforcement == "must_run"
                        else "required_by_deadline"
                    ),
                    service_rank=rank,
                    allow_storage_discharge=storage_override,
                    grid_energy_policy=(
                        "allow" if enforcement == "must_run" else grid_override
                    ),
                    reason_code=REASON_FIXED_WINDOW,
                )
            )
        elif kind == "reactive":
            if target_kw is None:
                continue
            condition = req.get("condition")
            if condition is None:
                continue
            window = compile_condition_slots(condition, spot_ct_kwh, import_ct_kwh)
            if window is None:
                # Local signals: reactive edge work (Inkrement 4), never
                # half-compiled into the plan.
                continue
            if not window:
                continue  # the condition is never true in this horizon
            requirements.append(
                LoadRequirement(
                    requirement_id=req["id"],
                    kind="fixed_window",
                    window_slots=window,
                    target_kw=target_kw,
                    enforcement=(
                        "must_run"
                        if enforcement == "must_run"
                        else "required_by_deadline"
                    ),
                    service_rank=rank,
                    allow_storage_discharge=storage_override,
                    grid_energy_policy=(
                        "allow" if enforcement == "must_run" else grid_override
                    ),
                    reason_code=REASON_PRICE_WINDOW,
                )
            )
        elif kind == "flexible_task":
            demand = req.get("demand") or {}
            runtime = demand.get("runtime_minutes")
            energy = demand.get("energy_kwh")
            if runtime is None and energy is None:
                continue
            members = expand_recurrence(req["recurrence"], slot_starts, timezone)
            instances: dict[str, list[int]] = {}
            for i, day in members:
                instances.setdefault(day, []).append(i)
            for day, indices in sorted(instances.items()):
                requirements.append(
                    LoadRequirement(
                        requirement_id=f"{req['id']}@{day}",
                        kind="flexible_task",
                        window_slots=tuple(sorted(indices)),
                        required_minutes=runtime,
                        required_kwh=energy,
                        contiguous=bool(demand.get("contiguous", False)),
                        enforcement="required_by_deadline",
                        service_rank=rank,
                        allow_storage_discharge=storage_override,
                        grid_energy_policy=grid_override,
                        reason_code=REASON_OPTIMIZER,
                    )
                )
        else:
            logger.warning(
                "consumer.unknown_requirement_kind",
                extra={"context": {"kind": kind, "id": req.get("id")}},
            )
    if not requirements:
        return None
    return ControllableLoadEntity(
        entity_id=profile.entity_id,
        max_power_kw=profile.rated_power_kw,
        control_kind=profile.control_kind,
        min_power_kw=profile.min_power_kw or 0.0,
        levels_kw=tuple(profile.levels_kw or ()),
        power_ranges_kw=tuple(
            (float(lo), float(hi)) for lo, hi in (profile.power_ranges_kw or ())
        ),
        storage_relation=profile.storage_relation,
        grid_energy_policy=profile.default_grid_energy_policy,
        allow_storage_discharge=profile.allow_storage_discharge,
        min_on_slots=_slots_per_minute_ceil(profile.min_on_seconds, slot_minutes),
        min_off_slots=_slots_per_minute_ceil(profile.min_off_seconds, slot_minutes),
        max_starts_per_horizon=profile.max_starts_per_day,
        requirements=tuple(requirements),
    )


# ---------------------------------------------------------------------------
# DB loader (trusted backend role, weather-collector pattern).
# ---------------------------------------------------------------------------

_CONSUMER_SQL = """
SELECT cp.entity_id::text,
       cp.control_kind,
       cp.rated_power_kw,
       cp.min_power_kw,
       cp.levels_kw,
       cp.power_ranges_kw,
       cp.storage_relation,
       cp.default_grid_energy_policy,
       cp.allow_storage_discharge,
       cp.default_service_rank,
       cp.min_on_seconds,
       cp.min_off_seconds,
       cp.max_starts_per_day,
       pol.document
FROM consumer_profile cp
JOIN consumer_policy pol
  ON pol.entity_id = cp.entity_id AND pol.lifecycle = 'active'
JOIN measurement_point mp ON mp.id = cp.entity_id
WHERE cp.site_id = %s
  AND cp.enabled
  AND (mp.edge_source_id IS NOT NULL OR mp.device_id IS NOT NULL)
ORDER BY cp.entity_id
"""


def load_consumer_entities(
    dsn: str,
    site_id: UUID,
    slot_starts: list[datetime],
    slot_minutes: int,
    spot_ct_kwh: list[float],
    import_ct_kwh: list[float],
) -> tuple[ControllableLoadEntity, ...]:
    """Every solver-relevant consumer of one site: ENABLED profile, ACTIVE
    policy, CONNECTED entity (§17) - compiled against this horizon. One bad
    document never sinks the cycle (log + skip, the engine's discipline)."""
    import psycopg  # lazy: optional [db] extra

    entities: list[ControllableLoadEntity] = []
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(_CONSUMER_SQL, (site_id,)).fetchall()
    for row in rows:
        (
            entity_id,
            control_kind,
            rated,
            min_power,
            levels,
            ranges,
            storage_relation,
            grid_policy,
            allow_discharge,
            rank,
            min_on_s,
            min_off_s,
            max_starts,
            document,
        ) = row
        try:
            if isinstance(document, str):
                document = json.loads(document)
            profile = ConsumerProfileRow(
                entity_id=entity_id,
                control_kind=control_kind,
                rated_power_kw=float(rated),
                min_power_kw=float(min_power) if min_power is not None else None,
                levels_kw=tuple(float(v) for v in levels) if levels else None,
                power_ranges_kw=(
                    tuple((float(lo), float(hi)) for lo, hi in ranges)
                    if ranges
                    else None
                ),
                storage_relation=storage_relation,
                default_grid_energy_policy=grid_policy,
                allow_storage_discharge=bool(allow_discharge),
                default_service_rank=rank,
                min_on_seconds=min_on_s,
                min_off_seconds=min_off_s,
                max_starts_per_day=max_starts,
            )
            entity = compile_consumer(
                profile,
                document,
                slot_starts,
                slot_minutes,
                spot_ct_kwh,
                import_ct_kwh,
            )
        except Exception as exc:  # one bad policy never sinks the site
            logger.warning(
                "consumer.compile_failed",
                extra={"context": {"entity_id": entity_id, "error": str(exc)}},
            )
            continue
        if entity is not None:
            entities.append(entity)
    return tuple(entities)

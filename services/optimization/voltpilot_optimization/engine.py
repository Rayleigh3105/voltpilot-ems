"""The rolling-plan engine: one optimization cycle over every battery site.

Per site: gather inputs (prices, forecasts, SoC, params) -> solve the dispatch
MILP -> persist the plan to the ``schedule`` hypertable -> publish it retained
to the device's schedule topic. One bad site never sinks the cycle (log +
continue, mirroring the weather collector), and an infeasible §14a cap degrades
to a plan without the grid constraint (the physical limit is enforced by the
grid operator and the edge guards regardless - an advisory plan beats none).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import uuid4

from voltpilot_optimization.co_solver import (
    co_optimize,
    co_optimize_ignoring_grid_limit,
)
from voltpilot_optimization.config import v2_plan_site_ids
from voltpilot_optimization.domain import SchedulePlan, SLOTS_24H
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.inputs import (
    BatterySite,
    SkipSite,
    gather_inputs,
    load_battery_sites,
)
from voltpilot_optimization.persistence import ScheduleRepository
from voltpilot_optimization.publisher import SchedulePublisher
from voltpilot_optimization.publisher_v2 import PlanV2Publisher
from voltpilot_optimization.solver import (
    InfeasiblePlanError,
    optimize,
    optimize_ignoring_grid_limit,
)

logger = logging.getLogger("voltpilot.optimization.engine")


@dataclass
class CycleSummary:
    planned: list[SchedulePlan] = field(default_factory=list)
    skipped: list[tuple[BatterySite, str]] = field(default_factory=list)

    def line(self) -> str:
        parts = [
            f"voltpilot-optimization: {len(self.planned)} plan(s)"
            + (f", {len(self.skipped)} site(s) skipped" if self.skipped else "")
        ]
        for plan in self.planned:
            parts.append(
                f"  site={plan.site_id} slots={len(plan.slots)} "
                f"savings={plan.savings_eur:.2f} EUR vs. no-battery baseline"
            )
        return "\n".join(parts)


def plan_site(
    dsn: str,
    site: BatterySite,
    repository: ScheduleRepository | None,
    publisher: SchedulePublisher | None,
    now: datetime,
    horizon_slots: int = SLOTS_24H,
    v2_publisher: PlanV2Publisher | None = None,
    v2_sites: frozenset | None = None,
) -> SchedulePlan:
    """Plan one site end to end. Raises :class:`SkipSite` when un-plannable.

    ``v2_sites`` (default: the ``VOLTPILOT_V2_PLAN_SITES`` env flag) selects
    the sites that ADDITIONALLY get a co-optimized multi-entity plan published
    per mqtt-schedule 2.0 on the retained v2 topic - the E13a shadow phase.
    The v1 path above stays byte-identical for every site (flagged ones
    dual-publish); a v2 shadow failure only logs, never sinks the v1 plan.
    """
    inp = gather_inputs(dsn, site, now, horizon_slots)
    plan_id = uuid4()
    try:
        plan = optimize(inp, plan_id, now)
    except InfeasiblePlanError as exc:
        logger.warning(
            "solve.grid_limit_infeasible",
            extra={"context": {"site_id": str(site.site_id), "error": str(exc)}},
        )
        plan = optimize_ignoring_grid_limit(inp, plan_id, now)

    if repository is not None:
        repository.upsert_plan(plan)
    if publisher is not None:
        if plan.device_id is not None:
            publisher.publish(plan)
        else:
            logger.info(
                "publish.no_device",
                extra={"context": {"site_id": str(site.site_id)}},
            )
    _shadow_publish_v2(site, inp, now, v2_publisher, v2_sites)
    return plan


def _shadow_publish_v2(
    site: BatterySite,
    inp,
    now: datetime,
    v2_publisher: PlanV2Publisher | None,
    v2_sites: frozenset | None,
) -> None:
    """Co-optimize + publish the v2 plan for a flagged site (best-effort).

    Its own solve on the N=1 adapter, deliberately: the shadow publishes what
    the CO-optimizer plans (the golden suite pins it equivalent to v1 today;
    once entities multiply, the v2 plan is the richer one). Never raises - the
    v1 plan already persisted/published and the shadow must stay harmless.
    """
    if v2_publisher is None or site.device_id is None:
        return
    flagged = v2_plan_site_ids() if v2_sites is None else v2_sites
    if site.site_id not in flagged:
        return
    try:
        co_inp = from_v1_input(inp)
        v2_plan_id = uuid4()
        try:
            site_plan = co_optimize(co_inp, v2_plan_id, now)
        except InfeasiblePlanError:
            site_plan = co_optimize_ignoring_grid_limit(co_inp, v2_plan_id, now)
        v2_publisher.publish(site_plan)
    except Exception as exc:  # shadow only - never sink the v1 cycle
        logger.warning(
            "publish_v2.shadow_failed",
            extra={"context": {"site_id": str(site.site_id), "error": str(exc)}},
        )


def run_cycle(
    dsn: str,
    repository: ScheduleRepository | None,
    publisher: SchedulePublisher | None,
    now: datetime | None = None,
    horizon_slots: int = SLOTS_24H,
    v2_publisher: PlanV2Publisher | None = None,
) -> CycleSummary:
    """One full optimization pass over every battery site."""
    now = now if now is not None else datetime.now(timezone.utc)
    summary = CycleSummary()
    sites = load_battery_sites(dsn)
    if not sites:
        logger.warning("cycle.no_battery_sites", extra={"context": {}})
        return summary
    v2_sites = v2_plan_site_ids()
    for site in sites:
        try:
            plan = plan_site(
                dsn,
                site,
                repository,
                publisher,
                now,
                horizon_slots,
                v2_publisher=v2_publisher,
                v2_sites=v2_sites,
            )
            summary.planned.append(plan)
        except SkipSite as exc:
            summary.skipped.append((site, str(exc)))
            logger.info(
                "site.skipped",
                extra={"context": {"site_id": str(site.site_id), "reason": str(exc)}},
            )
        except Exception as exc:  # one bad site must not sink the cycle
            summary.skipped.append((site, str(exc)))
            logger.warning(
                "site.failed",
                extra={"context": {"site_id": str(site.site_id), "error": str(exc)}},
            )
    return summary

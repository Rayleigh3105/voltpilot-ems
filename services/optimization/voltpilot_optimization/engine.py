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

from voltpilot_optimization.domain import SchedulePlan, SLOTS_24H
from voltpilot_optimization.inputs import (
    BatterySite,
    SkipSite,
    gather_inputs,
    load_battery_sites,
)
from voltpilot_optimization.persistence import ScheduleRepository
from voltpilot_optimization.publisher import SchedulePublisher
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
) -> SchedulePlan:
    """Plan one site end to end. Raises :class:`SkipSite` when un-plannable."""
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
    return plan


def run_cycle(
    dsn: str,
    repository: ScheduleRepository | None,
    publisher: SchedulePublisher | None,
    now: datetime | None = None,
    horizon_slots: int = SLOTS_24H,
) -> CycleSummary:
    """One full optimization pass over every battery site."""
    now = now if now is not None else datetime.now(timezone.utc)
    summary = CycleSummary()
    sites = load_battery_sites(dsn)
    if not sites:
        logger.warning("cycle.no_battery_sites", extra={"context": {}})
        return summary
    for site in sites:
        try:
            plan = plan_site(dsn, site, repository, publisher, now, horizon_slots)
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

"""Persist optimizer plans into the TimescaleDB ``schedule`` hypertable.

Every run's full plan is stored per slot - planned battery/grid power, the SoC
trajectory, the forecast inputs used and the projected cost vs. the no-battery
baseline. This is the ML groundwork (architecture section 10 "Fahrpläne"):
plan-vs-actual against ``telemetry`` becomes a plain join later.

Schema is owned by the api Flyway migration
``V20260701020000__battery_params_and_schedule.sql`` (see AGENTS.md); the table
carries ``tenant_id`` and is RLS-scoped for the portal read. The optimizer
writes as the trusted backend role (bypasses RLS, stamps each row's tenant) -
the same pattern as the weather collector.

The repository is a small protocol so the engine (and tests) can swap in an
in-memory fake; the psycopg implementation lazy-imports the driver (optional
``db`` extra), mirroring the sibling services.
"""

from __future__ import annotations

import logging
from typing import Protocol

from voltpilot_optimization.domain import SchedulePlan

logger = logging.getLogger("voltpilot.optimization.persistence")


class ScheduleRepository(Protocol):
    """Sink for optimizer plans."""

    def upsert_plan(self, plan: SchedulePlan) -> int:
        """Persist every slot of the plan idempotently; return rows written."""
        ...


class InMemoryScheduleRepository:
    """Test/double repository: keeps every plan, latest-run lookup per site."""

    def __init__(self) -> None:
        self.plans: list[SchedulePlan] = []

    def upsert_plan(self, plan: SchedulePlan) -> int:
        # Idempotent like the DB upsert: replace a plan with the same identity.
        self.plans = [
            p
            for p in self.plans
            if not (p.site_id == plan.site_id and p.generated_at == plan.generated_at)
        ]
        self.plans.append(plan)
        return len(plan.slots)

    def latest_for_site(self, site_id) -> SchedulePlan | None:
        candidates = [p for p in self.plans if p.site_id == site_id]
        return max(candidates, key=lambda p: p.generated_at) if candidates else None


_UPSERT_SQL = """
INSERT INTO schedule
    (time, tenant_id, site_id, device_id, plan_id, generated_at,
     battery_kw, grid_kw, soc_pct, load_kw, pv_kw,
     price_eur_mwh, cost_eur, baseline_cost_eur, curtail_kw, wear_cost_eur,
     terminal_value_eur_per_kwh)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (site_id, generated_at, time)
DO UPDATE SET
    device_id         = EXCLUDED.device_id,
    plan_id           = EXCLUDED.plan_id,
    battery_kw        = EXCLUDED.battery_kw,
    grid_kw           = EXCLUDED.grid_kw,
    soc_pct           = EXCLUDED.soc_pct,
    load_kw           = EXCLUDED.load_kw,
    pv_kw             = EXCLUDED.pv_kw,
    price_eur_mwh     = EXCLUDED.price_eur_mwh,
    cost_eur          = EXCLUDED.cost_eur,
    baseline_cost_eur = EXCLUDED.baseline_cost_eur,
    curtail_kw        = EXCLUDED.curtail_kw,
    wear_cost_eur     = EXCLUDED.wear_cost_eur,
    terminal_value_eur_per_kwh = EXCLUDED.terminal_value_eur_per_kwh;
"""


def plan_rows(plan: SchedulePlan) -> list[tuple]:
    """The per-slot parameter tuples for :data:`_UPSERT_SQL` (one per slot).

    ``terminal_value_eur_per_kwh`` is a RUN-level fact (the P3 credit per
    stored kWh at the horizon end, FK2) repeated on every slot row of the run -
    the schedule table has no run-level sibling, and the existing upsert keeps
    working unchanged. NULL on plans that predate the field.
    """
    return [
        (
            slot.start,
            plan.tenant_id,
            plan.site_id,
            plan.device_id,
            plan.plan_id,
            plan.generated_at,
            slot.battery_kw,
            slot.grid_kw,
            round(plan.soc_pct(slot), 2),
            slot.load_kw,
            slot.pv_kw,
            slot.price_eur_mwh,
            slot.cost_eur,
            slot.baseline_cost_eur,
            slot.curtail_kw,
            slot.wear_cost_eur,
            plan.terminal_value_eur_per_kwh,
        )
        for slot in plan.slots
    ]


class TimescaleScheduleRepository:
    """psycopg-backed repository writing into ``schedule``.

    ``dsn`` is a libpq connection string built from the same ``POSTGRES_*`` env
    the rest of the stack uses (the trusted backend role - see module docstring).
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_plan(self, plan: SchedulePlan) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = plan_rows(plan)
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        logger.info(
            "persist.ok",
            extra={
                "context": {
                    "site_id": str(plan.site_id),
                    "plan_id": str(plan.plan_id),
                    "rows": len(rows),
                }
            },
        )
        return len(rows)

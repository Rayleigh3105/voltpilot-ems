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
     terminal_value_eur_per_kwh, peak_target_kw,
     slot_role, slot_flags, stored_value_ct_kwh, grid_value_ct_kwh,
     peak_pressure_eur_kw, fallback_14a,
     cover_load_from_battery, charge_from_surplus_only,
     why_terminal_anchor, why_refill_free_pct,
     why_next_best, why_next_best_margin_ct)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
    terminal_value_eur_per_kwh = EXCLUDED.terminal_value_eur_per_kwh,
    peak_target_kw    = EXCLUDED.peak_target_kw,
    slot_role         = EXCLUDED.slot_role,
    slot_flags        = EXCLUDED.slot_flags,
    stored_value_ct_kwh = EXCLUDED.stored_value_ct_kwh,
    grid_value_ct_kwh = EXCLUDED.grid_value_ct_kwh,
    peak_pressure_eur_kw = EXCLUDED.peak_pressure_eur_kw,
    fallback_14a      = EXCLUDED.fallback_14a,
    cover_load_from_battery = EXCLUDED.cover_load_from_battery,
    charge_from_surplus_only = EXCLUDED.charge_from_surplus_only,
    why_terminal_anchor = EXCLUDED.why_terminal_anchor,
    why_refill_free_pct = EXCLUDED.why_refill_free_pct,
    why_next_best = EXCLUDED.why_next_best,
    why_next_best_margin_ct = EXCLUDED.why_next_best_margin_ct;
"""


def plan_rows(plan: SchedulePlan) -> list[tuple]:
    """The per-slot parameter tuples for :data:`_UPSERT_SQL` (one per slot).

    ``terminal_value_eur_per_kwh``, ``peak_target_kw`` and ``fallback_14a``
    are RUN-level facts (the P3 credit per stored kWh at the horizon end, FK2;
    the PS-1 planned billing-period peak target; the Fahrplan-Warum
    advisory-build marker) repeated on every slot row of the run - the
    schedule table has no run-level sibling, and the existing upsert keeps
    working unchanged. NULL on plans that predate the fields (peak_target_kw
    also NULL whenever the site's peak-shaving module is off).

    The Fahrplan-Warum slot fields (``slot_role``, ``slot_flags`` as CSV,
    ``stored_value_ct_kwh``, ``grid_value_ct_kwh``, ``peak_pressure_eur_kw``,
    migration V20260723030000) are NULL whenever the explain layer was off or
    failed - the api/portal then degrade to today's view, never a fabricated
    explanation. An EMPTY flags tuple also persists as NULL ("keine Bindung
    erfasst", data contract §5.1).

    The two IN-SLOT DUTIES (``cover_load_from_battery`` /
    ``charge_from_surplus_only``, api migration V20260802010000) ride along so
    the portal can preview the duty IN THE PLAN - today the customer only
    learns inside the running slot that the box follows the measured house.
    They are the SAME per-slot booleans the MQTT payload carries (see
    :mod:`voltpilot_optimization.slot_trim`); persistence keeps them TRI-STATE
    on purpose: ``None`` = not evaluated (the duty/explain switch is off, or a
    pre-feature run) and ``False`` = evaluated, no duty. The portal marks a
    phase only on an explicit ``True``, so both non-true states render exactly
    today's view.

    The Erklaerbarkeit-Stufe-1 facts (api migration V20260824000000) follow the
    same two patterns: ``why_terminal_anchor``/``why_refill_free_pct`` are
    RUN-level (repeated per row, like ``terminal_value_eur_per_kwh``) and say
    WHERE the value of stored energy came from; ``why_next_best``/
    ``why_next_best_margin_ct`` are per-slot and only ever set on a RESTING
    slot. NULL everywhere means the explain layer was off or the run predates
    the columns - the surfaces then stay observational, which is exactly the
    Stufe-0 behaviour, never a fabricated cause.
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
            plan.peak_target_kw,
            slot.slot_role,
            ",".join(slot.slot_flags) if slot.slot_flags else None,
            slot.stored_value_ct_kwh,
            slot.grid_value_ct_kwh,
            slot.peak_pressure_eur_kw,
            plan.fallback_14a,
            slot.cover_load_from_battery,
            slot.charge_from_surplus_only,
            plan.why_terminal_anchor,
            plan.why_refill_free_pct,
            slot.why_next_best,
            slot.why_next_best_margin_ct,
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

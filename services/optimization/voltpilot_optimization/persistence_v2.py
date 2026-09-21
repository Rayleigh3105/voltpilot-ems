"""Persist co-optimizer plans into ``site_plan_run`` + ``entity_plan_slot``.

Verbrauchssteuerung Inkrement 2 (§9.5): every co-optimized run of a
shadow-flagged site stores its metadata plus one row per CONSUMER entity slot
- command (``on_off`` | ``setpoint_kw``), target value, §15 ``reason_code``
and the served ``requirement_id`` - so the Fahrplan and "Warum läuft die
Pumpe jetzt?" read from the DB, never from an MQTT payload. Storage/producer
per-entity persistence deliberately waits for the v2 cutover (their truth
stays the v1 ``schedule`` table, which every surface reads today).

Schema owner: api migration ``V20260810010000__consumer_plan_persistence.sql``
(RLS + FORCE, 180-day retention, SkipScan index). The optimizer writes as the
trusted backend role and stamps ``tenant_id`` - the weather-collector pattern,
byte-for-byte the discipline of :mod:`voltpilot_optimization.persistence`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Protocol
from uuid import UUID

from voltpilot_optimization.entities import SitePlan

logger = logging.getLogger("voltpilot.optimization.persistence_v2")


class SitePlanRepository(Protocol):
    """Sink for co-optimizer plans (the v2 shadow persistence)."""

    def upsert_site_plan(self, plan: SitePlan) -> int:
        """Persist the run + every consumer slot idempotently; return rows."""
        ...

    def record_publication(
        self, plan: SitePlan, device_id: UUID, published_at: datetime
    ) -> None:
        """AP-15 IP-10 (P3): note "veröffentlicht" for the box that got the plan."""
        ...


class InMemorySitePlanRepository:
    """Test double: keeps every plan, latest-run lookup per site."""

    def __init__(self) -> None:
        self.plans: list[SitePlan] = []
        self.publications: list[tuple[UUID, UUID, datetime, datetime]] = []

    def upsert_site_plan(self, plan: SitePlan) -> int:
        self.plans = [
            p
            for p in self.plans
            if not (p.site_id == plan.site_id and p.generated_at == plan.generated_at)
        ]
        self.plans.append(plan)
        return sum(len(d.slots) for d in plan.loads)

    def record_publication(
        self, plan: SitePlan, device_id: UUID, published_at: datetime
    ) -> None:
        self.publications.append(
            (device_id, plan.plan_id, plan.generated_at, published_at)
        )

    def latest_for_site(self, site_id) -> SitePlan | None:
        candidates = [p for p in self.plans if p.site_id == site_id]
        return max(candidates, key=lambda p: p.generated_at) if candidates else None


_RUN_UPSERT_SQL = """
INSERT INTO site_plan_run
    (plan_id, tenant_id, site_id, generated_at, horizon_slots, slot_minutes,
     objective_eur, cost_eur, baseline_cost_eur)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (plan_id, generated_at)
DO UPDATE SET
    horizon_slots     = EXCLUDED.horizon_slots,
    slot_minutes      = EXCLUDED.slot_minutes,
    objective_eur     = EXCLUDED.objective_eur,
    cost_eur          = EXCLUDED.cost_eur,
    baseline_cost_eur = EXCLUDED.baseline_cost_eur;
"""

_SLOT_UPSERT_SQL = """
INSERT INTO entity_plan_slot
    (time, tenant_id, site_id, plan_id, generated_at, entity_id,
     command, target_value, reason_code, requirement_id)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (entity_id, generated_at, time)
DO UPDATE SET
    plan_id        = EXCLUDED.plan_id,
    command        = EXCLUDED.command,
    target_value   = EXCLUDED.target_value,
    reason_code    = EXCLUDED.reason_code,
    requirement_id = EXCLUDED.requirement_id;
"""


# AP-15 IP-10: "veröffentlicht" je Box und Plan (api migration
# V20260921130000__plan_zustellung.sql). The api writes the box's verdict into
# the same row when the receipt arrives - whoever comes first inserts; this
# side owns generated_at and keeps the FIRST publication time.
_PUBLICATION_UPSERT_SQL = """
INSERT INTO plan_zustellung
    (device_id, plan_id, tenant_id, site_id, generated_at, veroeffentlicht_um)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (device_id, plan_id)
DO UPDATE SET
    generated_at       = EXCLUDED.generated_at,
    veroeffentlicht_um = COALESCE(plan_zustellung.veroeffentlicht_um,
                                  EXCLUDED.veroeffentlicht_um);
"""


def consumer_slot_rows(plan: SitePlan) -> list[tuple]:
    """Per-consumer-slot parameter tuples for :data:`_SLOT_UPSERT_SQL`.

    ``command`` follows the control kind exactly like the v2 payload builder
    (:mod:`voltpilot_optimization.publisher_v2`), so the persisted plan and
    the published plan can never tell different stories about a slot.
    ``target_value`` is ALWAYS the planned power in kW (an on/off consumer
    persists its rated power when on, 0 when off - the payload's boolean is
    the edge-command form, the kW is what every read surface stacks/renders).
    """
    rows: list[tuple] = []
    for dispatch in plan.loads:
        on_off = dispatch.control_kind == "on_off"
        for slot in dispatch.slots:
            rows.append(
                (
                    slot.start,
                    plan.tenant_id,
                    plan.site_id,
                    plan.plan_id,
                    plan.generated_at,
                    dispatch.entity_id,
                    "on_off" if on_off else "setpoint_kw",
                    slot.power_kw if slot.on else 0.0,
                    slot.reason_code,
                    slot.requirement_id,
                )
            )
    return rows


class TimescaleSitePlanRepository:
    """psycopg-backed repository writing run + consumer slots in one
    transaction (``dsn`` = the trusted backend role, see module docstring)."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_site_plan(self, plan: SitePlan) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = consumer_slot_rows(plan)
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _RUN_UPSERT_SQL,
                    (
                        plan.plan_id,
                        plan.tenant_id,
                        plan.site_id,
                        plan.generated_at,
                        len(plan.site_slots),
                        plan.slot_minutes,
                        round(plan.objective_eur, 6),
                        round(plan.cost_eur, 6),
                        round(plan.baseline_cost_eur, 6),
                    ),
                )
                if rows:
                    cur.executemany(_SLOT_UPSERT_SQL, rows)
            conn.commit()
        logger.info(
            "persist_v2.ok",
            extra={
                "context": {
                    "site_id": str(plan.site_id),
                    "plan_id": str(plan.plan_id),
                    "consumer_rows": len(rows),
                }
            },
        )
        return len(rows)

    def record_publication(
        self, plan: SitePlan, device_id: UUID, published_at: datetime
    ) -> None:
        import psycopg  # lazy: optional [db] extra

        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _PUBLICATION_UPSERT_SQL,
                    (
                        device_id,
                        plan.plan_id,
                        plan.tenant_id,
                        plan.site_id,
                        plan.generated_at,
                        published_at,
                    ),
                )
            conn.commit()

"""On-demand single-site replan (D8, docs/verbrauchssteuerung.md §13.4).

The THIRD endpoint of the solve surface (``simulate-serve``): a REAL planning
cycle ``gather → optimize → persist → publish`` for exactly ONE site, run
synchronously in the request thread, semaphore-bounded like the simulation
jobs and the what-if. The api's replan trigger listener calls it when an edge
event (Pflichtregel aktiv/inaktiv, Verbraucher nicht verfügbar, Aufgabe
vorzeitig erfüllt, Readback dauerhaft abweichend) makes waiting for the
15-minute tick wasteful - the tick loop stays the Grundschlag and is
completely untouched by this module.

DELIBERATE CONTRAST to :mod:`voltpilot_optimization.whatif`: the what-if is
EPHEMERAL BY CONSTRUCTION (its AST import guard forbids persistence/publisher
imports and stays untouched); a replan is the OPPOSITE - it exists to write
the schedule and push the retained plan, so it reuses the engine's
:func:`~voltpilot_optimization.engine.plan_site` verbatim. One cycle
implementation, two callers (tick loop + this endpoint) - never a second
planning path.

The service still knows neither tenants nor tokens: the Java api resolves the
site through its RLS-scoped datasource BEFORE forwarding the id here (the
ingest JdbcDeviceDirectory trust pattern).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional
from uuid import UUID

from voltpilot_optimization.engine import plan_site
from voltpilot_optimization.inputs import BatterySite, SkipSite


class InvalidReplanRequest(ValueError):
    """The request body is unusable (no/garbage site_id)."""


class UnknownReplanSite(LookupError):
    """The site does not resolve to a plannable battery site."""


class ReplanUnavailable(RuntimeError):
    """A real, nameable reason the site cannot be planned right now."""


@dataclass(frozen=True)
class ReplanDeps:
    """Injected collaborators (production wiring lives in cli._replan_handler)."""

    load_site: Callable[[UUID], Optional[BatterySite]]
    plan: Callable[[BatterySite], object]  # -> SchedulePlan (engine.plan_site)
    publishes: bool = False  # whether a publisher is wired at all
    persists: bool = False  # whether a repository is wired at all


def parse_request(doc: object) -> UUID:
    """Validate the request body; returns the site id."""
    if not isinstance(doc, dict):
        raise InvalidReplanRequest("Ungültige Anfrage: kein JSON-Objekt.")
    raw = doc.get("site_id") or doc.get("siteId")
    if not isinstance(raw, str):
        raise InvalidReplanRequest("Ungültige Anfrage: site_id fehlt.")
    try:
        return UUID(raw)
    except ValueError as exc:
        raise InvalidReplanRequest("Ungültige Anfrage: site_id ist keine UUID.") from exc


def run_replan(site_id: UUID, deps: ReplanDeps) -> dict:
    """One real cycle for one site. Raises the module's honest errors."""
    site = deps.load_site(site_id)
    if site is None:
        raise UnknownReplanSite(
            "Diese Anlage ist dem Optimierer unbekannt (kein Speicher konfiguriert)."
        )
    try:
        plan = deps.plan(site)
    except SkipSite as exc:
        # e.g. insufficient price coverage - a nameable condition, never a 500.
        raise ReplanUnavailable(
            f"Die Anlage kann gerade nicht neu geplant werden: {exc}"
        ) from exc
    generated_at = getattr(plan, "generated_at", None) or datetime.now(timezone.utc)
    device_id = getattr(plan, "device_id", None)
    return {
        "siteId": str(site_id),
        "planId": str(getattr(plan, "plan_id", "")),
        "generatedAt": generated_at.isoformat(),
        "slots": len(getattr(plan, "slots", []) or []),
        "persisted": deps.persists,
        # plan_site publishes only when a publisher is wired AND the site's
        # battery has a claimed device - report exactly that, never a guess.
        "published": bool(deps.publishes and device_id is not None),
    }

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
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from uuid import uuid4

from voltpilot_optimization.co_solver import (
    co_optimize,
    co_optimize_ignoring_grid_limit,
)
from voltpilot_optimization.config import (
    controllable_loads_enabled,
    horizon_slots as configured_horizon_slots,
    v2_plan_site_ids,
)
from voltpilot_optimization.consumer_inputs import load_consumer_entities
from voltpilot_optimization.domain import SchedulePlan
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.persistence_v2 import SitePlanRepository
from voltpilot_optimization.inputs import (
    BatterySite,
    SkipSite,
    gather_inputs,
    load_battery_sites,
    load_battery_claims,
    load_model_choices,
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
            # Das Log nennt IMMER die Messlatte (Haus-Regel). Zwei Zahlen, zwei
            # Fragen: savings = der Wert des Speichers SAMT Steuerung gegen eine
            # Anlage ohne Speicher (die Admin-/Optimierer-Sicht, unveraendert),
            # steuerung = der Mehrwert der STEUERUNG gegen denselben Speicher
            # ohne sie (die Kunden-Zahl seit Captain 04.09.2026). Fehlt die
            # Messlatte, wird sie weggelassen statt mit 0,00 behauptet.
            line = f"  site={plan.site_id} slots={len(plan.slots)}"
            savings = plan.savings_eur
            if savings is None:
                # P7: ein Lauf ohne Ladestand hat keinen Speicher geplant, also
                # gibt es keine Ersparnis - auch nicht im Log. Der GRUND steht
                # da, damit ein stiller Ruhe-Plan im Betrieb sofort auffaellt.
                line += f" RUHE ({plan.soc_source}) - kein Ladestand, kein Speicher geplant"
            else:
                line += f" savings={savings:.2f} EUR vs. no-battery baseline"
            steuerung = plan.steuerung_savings_eur
            if steuerung is not None:
                line += f", steuerung={steuerung:.2f} EUR vs. stur battery"
            parts.append(line)
        return "\n".join(parts)


def plan_site(
    dsn: str,
    site: BatterySite,
    repository: ScheduleRepository | None,
    publisher: SchedulePublisher | None,
    now: datetime,
    horizon_slots: int | None = None,
    v2_publisher: PlanV2Publisher | None = None,
    v2_sites: frozenset | None = None,
    v2_repository: SitePlanRepository | None = None,
    model_choices=None,
    battery_claims=None,
) -> SchedulePlan:
    """Plan one site end to end. Raises :class:`SkipSite` when un-plannable.

    ``v2_sites`` (default: the ``VOLTPILOT_V2_PLAN_SITES`` env flag) selects
    the sites that ADDITIONALLY get a co-optimized multi-entity plan published
    per mqtt-schedule 2.0 on the retained v2 topic - the E13a shadow phase.
    The v1 path above stays byte-identical for every site (flagged ones
    dual-publish); a v2 shadow failure only logs, never sinks the v1 plan.

    ``model_choices`` is the cycle's ONE read of the portal's active forecast
    models (:func:`voltpilot_optimization.inputs.load_model_choices`, platform
    default + the per-site choices); ``None`` lets ``gather_inputs`` load them
    itself, which is what the single-site on-demand replan does.

    ``battery_claims`` is the same convention for the customer-rule claims
    (:func:`voltpilot_optimization.inputs.load_battery_claims`, Stufe 3 §3.7 A4).

    ``horizon_slots`` is a REQUEST (``None`` = the platform default,
    ``OPTIMIZER_HORIZON_SLOTS``, 192 = 48 h). ``gather_inputs`` truncates it to
    what day-ahead prices and real forecasts cover, so the planned window is
    always ``min(request, known prices, real forecasts)``.
    """
    if horizon_slots is None:
        horizon_slots = configured_horizon_slots()
    inp = gather_inputs(dsn, site, now, horizon_slots, model_choices=model_choices,
                        battery_claims=battery_claims)
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
    _shadow_publish_v2(dsn, site, inp, now, v2_publisher, v2_sites, v2_repository)
    return plan


def _shadow_publish_v2(
    dsn: str,
    site: BatterySite,
    inp,
    now: datetime,
    v2_publisher: PlanV2Publisher | None,
    v2_sites: frozenset | None,
    v2_repository: SitePlanRepository | None = None,
) -> None:
    """Co-optimize + persist + publish the v2 plan for a flagged site
    (best-effort).

    Its own solve on the N=1 adapter, deliberately: the shadow publishes what
    the CO-optimizer plans (the golden suite pins it equivalent to v1 today;
    once entities multiply, the v2 plan is the richer one). Since
    Verbrauchssteuerung Inkrement 2 the flagged site's ACTIVE consumer
    policies join the co-optimization (SHADOW: planned, persisted into
    ``site_plan_run``/``entity_plan_slot`` and published on the v2 topic -
    but nothing controls a device, the v1 path executes unchanged). An
    unflagged site never reaches any of it; a consumer-less flagged site
    co-optimizes exactly the pre-consumer model. Never raises - the v1 plan
    already persisted/published and the shadow must stay harmless.
    """
    if v2_publisher is None or site.device_id is None:
        return
    flagged = v2_plan_site_ids() if v2_sites is None else v2_sites
    if site.site_id not in flagged:
        return
    # P7: ohne Ladestand entsteht auch kein SCHATTEN-Plan. Der Co-Optimizer
    # bekaeme ueber `from_v1_input` nur den Modell-Platzhalter als Start-SoC
    # und wuerde daraus einen vollen Speicher-Fahrplan rechnen, persistieren
    # (site_plan_run/entity_plan_slot) und auf dem v2-Topic veroeffentlichen -
    # also genau die Erfindung, die der v1-Pfad eine Zeile weiter oben gerade
    # verweigert hat, nur eine Etage tiefer. Ein ausgelassener Schatten kostet
    # nichts: er wird nie ausgefuehrt.
    if inp.soc_unbekannt:
        logger.info(
            "publish_v2.shadow_skipped_no_soc",
            extra={
                "context": {
                    "site_id": str(site.site_id),
                    "reason": "kein Ladestand",
                }
            },
        )
        return
    try:
        co_inp = from_v1_input(inp)
        # Consumer policies join the co-optimization best-effort: a failed
        # load (DB blip) degrades the SHADOW to a consumer-less plan with a
        # loud warning instead of dropping the whole shadow run.
        loads = ()
        try:
            # §19 Inkrement 5: the master gate. OFF (default) => the shadow plan
            # stays consumer-less and byte-identical to the pre-Inkrement-2 model,
            # even for a flagged site. Turned on per the runbook after the pilot.
            if controllable_loads_enabled():
                loads = load_consumer_entities(
                    dsn,
                    site.site_id,
                    inp.slot_starts,
                    inp.slot_minutes,
                    [p / 10.0 for p in inp.prices_eur_mwh],
                    [p / 10.0 for p in co_inp.import_prices],
                )
        except Exception as exc:
            logger.warning(
                "consumer.load_failed",
                extra={
                    "context": {"site_id": str(site.site_id), "error": str(exc)}
                },
            )
        if loads:
            co_inp = replace(co_inp, controllable_loads=loads)
        v2_plan_id = uuid4()
        try:
            site_plan = co_optimize(co_inp, v2_plan_id, now)
        except InfeasiblePlanError:
            site_plan = co_optimize_ignoring_grid_limit(co_inp, v2_plan_id, now)
        if v2_repository is not None:
            v2_repository.upsert_site_plan(site_plan)
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
    horizon_slots: int | None = None,
    v2_publisher: PlanV2Publisher | None = None,
    v2_repository: SitePlanRepository | None = None,
) -> CycleSummary:
    """One full optimization pass over every battery site.

    ``horizon_slots`` ``None`` = the platform default (``OPTIMIZER_HORIZON_SLOTS``,
    192 = 48 h); resolved ONCE here so every site of a cycle asks for the same
    window and a mid-cycle env edit cannot split it.
    """
    now = now if now is not None else datetime.now(timezone.utc)
    if horizon_slots is None:
        horizon_slots = configured_horizon_slots()
    summary = CycleSummary()
    sites = load_battery_sites(dsn)
    if not sites:
        logger.warning("cycle.no_battery_sites", extra={"context": {}})
        return summary
    v2_sites = v2_plan_site_ids()
    # ONE read of the portal's active-model choices for the whole cycle: the
    # platform default plus every site that carries its own (Captain
    # 19.08.2026). Both are small indexed reads; re-reading them per site would
    # be N identical queries. `gather_inputs` resolves them PER SITE.
    model_choices = load_model_choices(dsn)
    # ONE read of the customer-rule claims for the whole cycle (Stufe 3 §3.7
    # A4) - same reasoning as the model choices above, and fail-soft: without
    # the table every battery is planned exactly as before.
    battery_claims = load_battery_claims(dsn)
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
                v2_repository=v2_repository,
                model_choices=model_choices,
                battery_claims=battery_claims,
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

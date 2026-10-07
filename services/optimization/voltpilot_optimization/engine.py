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
    night_reserve_enabled,
    storage_release_enabled,
    storage_release_forecast_max_age,
    v2_plan_site_ids,
)
from voltpilot_optimization.consumer_inputs import load_consumer_entities
from voltpilot_optimization.domain import SchedulePlan
from voltpilot_optimization.entities import from_v1_input
from voltpilot_optimization.persistence_v2 import SitePlanRepository
from voltpilot_optimization.inputs import (
    BatterySite,
    SkipSite,
    active_model,
    gather_inputs,
    load_battery_controls,
    load_battery_sites,
    load_battery_claims,
    load_model_choices,
    site_model_choices,
)
from voltpilot_optimization.night_reserve import night_error_quantiles
from voltpilot_optimization.persistence import ScheduleRepository
from voltpilot_optimization.publisher import SchedulePublisher
from voltpilot_optimization.publisher_v2 import PlanV2Publisher
from voltpilot_optimization.solver import (
    InfeasiblePlanError,
    optimize,
    optimize_ignoring_grid_limit,
)
from voltpilot_optimization.storage_release import (
    load_release_settings,
    plan_storage_release,
    pv_day_error_quantiles,
    release_forecast,
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
            if plan.battery_observed:
                # Steuerstand: die Box steuert den Speicher nicht - der Plan
                # ist seine Eigenverbrauchsregelung, keine Steuerung.
                line += " EIGENVERBRAUCH (Speicher nicht gesteuert)"
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
    release_settings=None,
    battery_controls=None,
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

    ``battery_controls`` is the same convention for the reported steering
    states (:func:`voltpilot_optimization.inputs.load_battery_controls`): a
    battery its box freshly reports as NOT commanded is planned as
    self-consumption, never traded.

    ``release_settings`` is the cycle's ONE read of the „Sonne + Speicher"
    sites (:func:`voltpilot_optimization.storage_release.load_release_settings`),
    same convention: ``None`` = load it here. Only a site in it gets a battery
    floor (:attr:`SchedulePlan.storage_release`); every other plan is
    byte-identical.
    """
    if horizon_slots is None:
        horizon_slots = configured_horizon_slots()
    inp = gather_inputs(dsn, site, now, horizon_slots, model_choices=model_choices,
                        battery_claims=battery_claims, battery_controls=battery_controls)
    plan_id = uuid4()
    plan = _solve_site(inp, plan_id, now, site)

    release = _storage_release(dsn, site, inp, plan, now, model_choices, release_settings)
    if release is not None:
        plan = replace(plan, storage_release=release)

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


def _solve_site(inp, plan_id, now, site) -> SchedulePlan:
    """Solve one site: the full model, else without the §14a cap.

    Steuerstand: the self-consumption path of a battery VoltPilot does not
    command is a fixed bound. Should it ever be infeasible even without the
    §14a cap, the site is planned as commanded instead - the behaviour before
    the box reported its steering state. A steering fact never costs a plan.
    """
    try:
        return optimize(inp, plan_id, now)
    except InfeasiblePlanError as exc:
        logger.warning(
            "solve.grid_limit_infeasible",
            extra={"context": {"site_id": str(site.site_id), "error": str(exc)}},
        )
        try:
            return optimize_ignoring_grid_limit(inp, plan_id, now)
        except InfeasiblePlanError:
            if not inp.battery_observed:
                raise
            logger.warning(
                "battery_control.self_consumption_infeasible",
                extra={"context": {"site_id": str(site.site_id)}},
            )
            return _solve_site(replace(inp, battery_observed=False), plan_id, now, site)


def _storage_release(dsn, site, inp, plan, now, model_choices, release_settings):
    """Die „Sonne + Speicher"-Untergrenze dieses Laufs, oder ``None``.

    ``None`` heißt „diese Anlage fährt die Quelle nicht" (oder der Schalter
    ``OPTIMIZER_STORAGE_RELEASE_ENABLED`` ist aus) - dann bleibt der Fahrplan
    byte-identisch. FAIL-SOFT wie die Nacht-Wertfunktion: ein Fehler hier
    kostet die Anlage ihre Freigabe (die Box fährt „Nur Sonne"), nie den Plan.
    """
    if not storage_release_enabled():
        return None
    try:
        settings = (
            release_settings if release_settings is not None
            else load_release_settings(dsn)
        )
        setting = settings.get(str(site.site_id))
        if setting is None:
            return None
        if model_choices is None:
            model_choices = load_model_choices(dsn)
        choices = site_model_choices(model_choices, site.site_id)
        load_model = active_model("load", choices=choices)
        pv_model = active_model("pv", choices=choices)
        # Frische UND Verlängerung über das Planende hinaus: vor der
        # Day-Ahead-Veröffentlichung endet der Plan um Mitternacht, die Nacht
        # danach liegt nur in der Prognose (storage_release, Moduldoku).
        forecast = release_forecast(
            dsn, site.site_id, load_model, pv_model, now,
            storage_release_forecast_max_age(), plan,
        )
        night = inp.night_error_quantiles
        if night is None and not night_reserve_enabled():
            # Die Nacht-Wertfunktion ist aus, ihre Verteilung bleibt trotzdem
            # die gemessene Unsicherheit dieser Anlage.
            night = night_error_quantiles(dsn, site, now, load_model)
        pv_errors = pv_day_error_quantiles(dsn, site.site_id, now, pv_model)
        release = plan_storage_release(
            plan,
            reserve_kwh=setting.reserve_kwh,
            night_errors=night,
            pv_errors=pv_errors,
            forecasts_fresh=forecast.fresh,
            battery_held=inp.battery_held,
            battery_observed=plan.battery_observed,
            tail_load_kw=forecast.tail_load_kw,
            tail_pv_kw=forecast.tail_pv_kw,
        )
    except Exception:
        logger.warning(
            "storage_release.failed",
            extra={"context": {"site_id": str(site.site_id)}},
            exc_info=True,
        )
        return None
    u = release.unsicherheit
    logger.info(
        "storage_release.planned",
        extra={
            "context": {
                "site_id": str(site.site_id),
                "slots": sum(1 for v in release.floor_soc_pct if v is not None),
                "floor_now_pct": release.floor_soc_pct[0] if release.floor_soc_pct else None,
                "reserve_kwh": release.reserve_kwh,
                "grund": release.grund,
                "battery_observed": plan.battery_observed,
                "forecast_tail_slots": len(forecast.tail_load_kw),
                "last_aufschlag": u.last_aufschlag if u else None,
                "pv_abschlag": u.pv_abschlag if u else None,
            }
        },
    )
    return release


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
    # Steuerstand: derselbe Gedanke fuer einen Speicher, den VoltPilot nicht
    # steuert. Der Co-Optimizer kennt keine Eigenverbrauchs-Bahn und wuerde ihn
    # handeln lassen - die Erfindung, die der v1-Pfad gerade vermieden hat.
    if inp.battery_observed:
        logger.info(
            "publish_v2.shadow_skipped_battery_observed",
            extra={"context": {"site_id": str(site.site_id)}},
        )
        return
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
    # ONE read of the „Sonne + Speicher" sites (06.10.2026), fail-soft: without
    # the columns no site gets a floor and every plan is byte-identical.
    release_settings = load_release_settings(dsn) if storage_release_enabled() else {}
    # ONE read of the reported steering states (07.10.2026), fail-soft: without
    # the table every battery is planned as commanded, as before.
    battery_controls = load_battery_controls(dsn)
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
                release_settings=release_settings,
                battery_controls=battery_controls,
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

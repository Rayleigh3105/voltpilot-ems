"""Gather one site's optimization inputs from the shared TimescaleDB.

The *predict* side of predict-then-optimize, assembled - the optimizer only
consumes what other layers produced:

- battery master data from ``asset`` (+ ``site`` for the bidding zone),
- day-ahead prices from ``day_ahead_prices`` (services/market-data),
- load/PV forecasts from the ``forecast`` hypertable (services/forecast) when a
  fresh run covers the horizon, else the persistence-baseline **fallback**
  computed from recent telemetry by REUSING ``voltpilot_forecast`` (see
  :mod:`voltpilot_optimization.fallback` - no duplicated forecasting logic),
- current SoC and the observed §14a ``grid_limit_kw`` from latest telemetry,
  each behind a FRESHNESS window (:mod:`voltpilot_optimization.config`): a
  stale §14a reading means "no active limit" (a dimming event is temporary and
  re-asserts itself in live telemetry - one old reading must never cap every
  future plan), a stale SoC falls back to the neutral default instead of
  silently planning from yesterday's value,
- the per-site backup-reserve SoC floor (``site.backup_reserve_soc_pct``, P11)
  and the grid-charging switch from ``site``,
- the pricing master data for the P1 asymmetric objective: ``site.plant_kind``,
  ``site.tarif_art``/``tarif_param_ct_kwh``, ``site.anzulegender_wert_ct_kwh``,
  the PV asset's ``commissioned_on``/``pv_capacity_kwp`` (MaStR) and the
  ``monthly_market_value`` Monatsmarktwert rows - turned into per-slot
  import/export price series by :mod:`voltpilot_optimization.pricing`.

Reads run as the trusted backend role (cross-tenant, like the weather
collector); psycopg is a lazy import behind the optional ``db`` extra.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from voltpilot_optimization.config import (
    PEAK_SPIKE_FACTOR,
    default_wear_cost_ct_per_kwh,
    grid_limit_max_age,
    soc_max_age,
    terminal_value_override_eur_per_kwh,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    DEFAULT_SOC_MAX_FRACTION,
    DEFAULT_SOC_MIN_FRACTION,
    OptimizationInput,
    SLOT_MINUTES,
    SLOTS_24H,
    ensure_utc,
    floor_to_slot,
    horizon_slot_starts,
)
from voltpilot_optimization.fallback import night_floor_pv, persistence_forecast
from voltpilot_optimization.pricing import (
    SiteTariff,
    SupplyPriceComponents,
    berlin_month,
    export_values,
    import_prices,
    needs_market_values,
)

logger = logging.getLogger("voltpilot.optimization.inputs")

# Sites need at least this many priced slots (4h) for a meaningful plan;
# shorter price coverage skips the site until the next collector run.
MIN_HORIZON_SLOTS = 16

# Telemetry history window feeding the persistence fallback (>= 2 full days so
# "same slot yesterday" always has a candidate).
FALLBACK_HISTORY = timedelta(days=3)

DEFAULT_SOC_PCT = 50.0

# Billing-period boundaries for the Leistungspreis peak follow the platform
# timezone discipline (Europe/Berlin calendar periods, the HistoryRange.ZONE
# rule on the api side).
BERLIN = ZoneInfo("Europe/Berlin")

# Shadow-mode forecasting (docs/forecasting.md): the forecast hypertable holds
# every model's runs, tagged with a model id; the optimizer consumes ONLY the
# ACTIVE model's rows. Promotion is a deliberate env flip (set the same values
# on the forecast collector); the defaults are the baselines, which mirror
# voltpilot_forecast.registry.BASELINE_MODELS - so out of the box nothing
# changes behaviorally. Read per cycle (not at import) so a restart with new
# env is the only deployment step a promotion needs.
ACTIVE_LOAD_MODEL_ENV = "VOLTPILOT_ACTIVE_LOAD_MODEL"
ACTIVE_PV_MODEL_ENV = "VOLTPILOT_ACTIVE_PV_MODEL"
BASELINE_MODEL_BY_KIND = {"load": "load-persistence", "pv": "pv-physical"}


def load_model_choices(dsn: str) -> dict:
    """The stored PORTAL choice per kind (empty = never promoted in the portal).

    Since the promotion switch (Captain 18.08.2026) the active model is DATA:
    the append-only ``forecast_model_choice`` table (api migration
    V20260825000000) carries the newest decision per kind. Reading it is one
    cheap indexed row per kind, and the CYCLE reads it ONCE
    (:func:`voltpilot_optimization.engine.run_cycle`) and hands the result to
    every site - never once per site.

    Never raises: a missing table or an unreachable DB degrades to "no choice",
    i.e. exactly the pre-switch env behaviour (see
    :mod:`voltpilot_forecast.model_choice`).
    """
    from voltpilot_forecast import model_choice

    return {kind.value: model for kind, model in model_choice.load_choices_dsn(dsn).items()}


def active_model(kind: str, env=None, choices=None) -> str:
    """The forecast model id whose rows this optimizer consumes for ``kind``.

    **Precedence (the binding contract, worded identically in migration
    V20260825000000, the api's ForecastModelService and
    :mod:`voltpilot_forecast.model_choice`): the stored portal choice wins,
    else the environment variable, else the registry default (the baseline).**
    The env variable therefore stays the DEFAULT, not a competitor - a fleet
    that never touches the switch is indistinguishable from before it existed.

    ``choices`` is the per-cycle read of :func:`load_model_choices` (``None`` =
    env only). A stored id is already validated on the write path AND
    re-validated when loaded (an unknown one is discarded there, never adopted),
    so anything arriving here is a known id of the right kind.

    The env branch delegates to :func:`voltpilot_forecast.registry.active_model`,
    the sibling that feeds the collector/portal, so both sides validate the
    configured id identically: an unknown or wrong-kind id (a promotion typo
    like ``load_xgb`` or a PV id under the load env) raises ``ValueError`` here
    instead of being silently accepted - which would find zero stored rows and
    quietly revert the optimizer to its persistence baseline while the portal
    still shows the challenger as "live" (a promotion that is a no-op with no
    error). Imported lazily, mirroring :mod:`voltpilot_optimization.fallback`,
    so solver-only installs without the forecast package are unaffected.
    """
    if choices:
        chosen = choices.get(kind)
        if chosen:
            return chosen

    from voltpilot_forecast import registry
    from voltpilot_forecast.domain import ForecastKind

    env = os.environ if env is None else env
    fkind = ForecastKind.LOAD if kind == "load" else ForecastKind.PV
    return registry.active_model(fkind, env)


class SkipSite(Exception):
    """This site cannot be planned right now (reason in the message)."""


@dataclass(frozen=True)
class BatterySite:
    """A site that owns a battery asset (one optimizer subject).

    ``netzladen_erlaubt`` is the per-site grid-charging switch
    (``site.netzladen_erlaubt``, DB default FALSE): False = EEG mode, the
    battery charges only from produced PV (charge <= pv - curtail, PV-bus
    Bilanzierung per FK3); True = merchant mode (arbitrage).

    ``max_feed_in_kw`` (FK1) is the site's static feed-in cap at the grid
    connection point (``site.max_feed_in_kw``, nullable master data) - a hard
    EXPORT-ONLY cap in the MILP, separate from the telemetry-driven §14a
    ``grid_limit_kw``.

    ``latitude``/``longitude`` are the site's WGS84 coordinates
    (``site.latitude``/``site.longitude``, nullable) - used to night-floor the
    PV input so the persistence fallback can never fabricate night "solar" (see
    :func:`voltpilot_optimization.fallback.night_floor_pv`).

    ``tariff`` carries the pricing-relevant master data (P1: plant_kind,
    tarif_art/param, anzulegender Wert, the PV asset's commissioning date +
    kWp, plus the structured ``site_supply_price`` sheet as
    ``tariff.supply_price`` - ``None`` when no row is maintained, which keeps
    the legacy import model byte-identically) feeding the asymmetric
    import/export pricing; the default reproduces the symmetric bare-spot
    model.

    ``leistungspreis_eur_kw`` (PS-1; ``site.leistungspreis_eur_kw``, nullable)
    is the RLM Leistungspreis in EUR per kW per billing period - non-NULL IS
    the peak-shaving module flag (the max_feed_in philosophy: one knob).
    ``abrechnung_leistung`` (``site.abrechnung_leistung``, ``jahr``/``monat``)
    picks the billing period the peak anchor is computed over. The PS-2
    ``site.peak_reserve_soc_pct`` reserve lives on :class:`BatteryParams`
    (``peak_reserve_pct``) with the rest of the SoC-floor machinery.
    """

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    bidding_zone: str
    battery: BatteryParams
    netzladen_erlaubt: bool
    latitude: float | None = None
    longitude: float | None = None
    max_feed_in_kw: float | None = None
    tariff: SiteTariff = SiteTariff()
    leistungspreis_eur_kw: float | None = None
    abrechnung_leistung: str = "jahr"


def load_battery_sites(dsn: str, site_id: UUID | None = None) -> list[BatterySite]:
    """Every site with a battery asset, with full parameters resolved.

    ``site_id`` narrows the load to ONE site (the admin what-if re-optimize,
    :mod:`voltpilot_optimization.whatif`) - deliberately the same resolution
    path as the tick loop, so a preview can never disagree with the plan that
    will actually run.
    """
    import psycopg  # lazy: optional [db] extra

    # Platform default for assets without a per-asset wear override (NULL
    # column); resolved once per cycle so an env change needs only a restart.
    default_wear_ct = default_wear_cost_ct_per_kwh()
    sites: list[BatterySite] = []
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.tenant_id, a.site_id, a.device_id, s.bidding_zone,
                   a.capacity_kwh, a.max_charge_kw, a.max_discharge_kw,
                   a.roundtrip_efficiency_pct, s.netzladen_erlaubt,
                   s.latitude, s.longitude, a.wear_cost_ct_per_kwh,
                   s.plant_kind, s.tarif_art, s.tarif_param_ct_kwh,
                   s.anzulegender_wert_ct_kwh,
                   pv.commissioned_on, pv.pv_capacity_kwp,
                   s.backup_reserve_soc_pct,
                   a.soc_min_pct, a.soc_max_pct,
                   s.max_feed_in_kw,
                   s.leistungspreis_eur_kw, s.abrechnung_leistung,
                   s.peak_reserve_soc_pct,
                   ssp.site_id AS ssp_site_id,
                   ssp.netzentgelt_arbeitspreis_ct, ssp.stromsteuer_ct,
                   ssp.konzessionsabgabe_ct, ssp.umlagen_ct,
                   ssp.vertriebsaufschlag_ct, ssp.ust_pct,
                   ssp.komponenten_stand
            FROM asset a
            JOIN site s ON s.id = a.site_id
            LEFT JOIN asset pv ON pv.site_id = a.site_id AND pv.type = 'pv' AND pv.is_primary
            LEFT JOIN site_supply_price ssp ON ssp.site_id = a.site_id
            WHERE a.type = 'battery' AND a.is_primary
              AND (%(site_id)s::uuid IS NULL OR a.site_id = %(site_id)s::uuid)
            ORDER BY a.site_id
            """,
            {"site_id": str(site_id) if site_id is not None else None},
        )
        for row in cur.fetchall():
            (
                tenant_id, site_id, device_id, zone, cap, chg, dis, eff,
                netzladen, lat, lon, wear_ct,
                plant_kind, tarif_art, tarif_param, anzulegender_wert,
                commissioned_on, pv_kwp, backup_reserve,
                soc_min_pct, soc_max_pct, max_feed_in,
                leistungspreis, abrechnung, peak_reserve,
                ssp_site_id, ssp_netzentgelt, ssp_stromsteuer,
                ssp_konzession, ssp_umlagen, ssp_vertrieb, ssp_ust,
                ssp_stand,
            ) = row
            if cap is None or chg is None or dis is None:
                logger.warning(
                    "site.skipped_missing_params",
                    extra={"context": {"site_id": str(site_id)}},
                )
                continue
            soc_min_fraction, soc_max_fraction = _soc_band(
                site_id, soc_min_pct, soc_max_pct
            )
            sites.append(
                BatterySite(
                    tenant_id=tenant_id,
                    site_id=site_id,
                    device_id=device_id,
                    bidding_zone=zone,
                    battery=BatteryParams(
                        capacity_kwh=float(cap),
                        max_charge_kw=float(chg),
                        max_discharge_kw=float(dis),
                        roundtrip_efficiency=(
                            float(eff) / 100.0 if eff is not None else 0.92
                        ),
                        soc_min_fraction=soc_min_fraction,
                        soc_max_fraction=soc_max_fraction,
                        wear_cost_ct_per_kwh=(
                            float(wear_ct) if wear_ct is not None
                            else default_wear_ct
                        ),
                        backup_reserve_pct=(
                            float(backup_reserve)
                            if backup_reserve is not None
                            else None
                        ),
                        peak_reserve_pct=(
                            float(peak_reserve)
                            if peak_reserve is not None
                            else None
                        ),
                    ),
                    netzladen_erlaubt=bool(netzladen),
                    latitude=float(lat) if lat is not None else None,
                    longitude=float(lon) if lon is not None else None,
                    max_feed_in_kw=(
                        float(max_feed_in) if max_feed_in is not None else None
                    ),
                    leistungspreis_eur_kw=(
                        float(leistungspreis) if leistungspreis is not None else None
                    ),
                    abrechnung_leistung=(
                        str(abrechnung) if abrechnung is not None else "jahr"
                    ),
                    tariff=SiteTariff(
                        plant_kind=(
                            str(plant_kind) if plant_kind is not None
                            else "eigenverbrauch"
                        ),
                        tarif_art=str(tarif_art) if tarif_art is not None else "ohne",
                        tarif_param_ct_kwh=(
                            float(tarif_param) if tarif_param is not None else None
                        ),
                        anzulegender_wert_ct_kwh=(
                            float(anzulegender_wert)
                            if anzulegender_wert is not None
                            else None
                        ),
                        commissioned_on=commissioned_on,
                        pv_capacity_kwp=float(pv_kwp) if pv_kwp is not None else None,
                        # No site_supply_price row = None = the legacy import
                        # model, byte-identically (report §3.1 rollout rule).
                        supply_price=(
                            SupplyPriceComponents(
                                netzentgelt_arbeitspreis_ct=_opt_float(ssp_netzentgelt),
                                stromsteuer_ct=_opt_float(ssp_stromsteuer),
                                konzessionsabgabe_ct=_opt_float(ssp_konzession),
                                umlagen_ct=_opt_float(ssp_umlagen),
                                vertriebsaufschlag_ct=_opt_float(ssp_vertrieb),
                                ust_pct=(
                                    float(ssp_ust) if ssp_ust is not None else 19.0
                                ),
                                komponenten_stand=ssp_stand,
                            )
                            if ssp_site_id is not None
                            else None
                        ),
                    ),
                )
            )
    return sites


def _opt_float(value) -> float | None:
    return float(value) if value is not None else None


def _soc_band(site_id, soc_min_pct, soc_max_pct) -> tuple[float, float]:
    """Resolve the per-asset usable SoC band (``asset.soc_min_pct``/
    ``soc_max_pct``, api migration V20260710020000, admin-tuned) into
    :class:`BatteryParams` fractions.

    NULL columns keep the platform defaults (5-95%). An inconsistent band
    (effective min >= effective max - possible when only one side is set and
    it crosses the other side's default) falls back to the platform defaults
    with a loud warning instead of crashing the site's every run: master data
    to fix, never a dead optimizer.
    """
    soc_min = (
        float(soc_min_pct) / 100.0
        if soc_min_pct is not None
        else DEFAULT_SOC_MIN_FRACTION
    )
    soc_max = (
        float(soc_max_pct) / 100.0
        if soc_max_pct is not None
        else DEFAULT_SOC_MAX_FRACTION
    )
    if not 0.0 <= soc_min < soc_max <= 1.0:
        logger.warning(
            "site.invalid_soc_band",
            extra={
                "context": {
                    "site_id": str(site_id),
                    "soc_min_pct": str(soc_min_pct),
                    "soc_max_pct": str(soc_max_pct),
                    "reason": (
                        "configured SoC band is inconsistent - falling back "
                        "to the platform default 5-95%"
                    ),
                }
            },
        )
        return DEFAULT_SOC_MIN_FRACTION, DEFAULT_SOC_MAX_FRACTION
    return soc_min, soc_max


def gather_inputs(
    dsn: str,
    site: BatterySite,
    now: datetime,
    horizon_slots: int = SLOTS_24H,
    model_choices: dict | None = None,
) -> OptimizationInput:
    """Assemble the slot-aligned :class:`OptimizationInput` for one site.

    The horizon is ``horizon_slots`` 15-min slots starting with the slot in
    progress at ``now`` (B1: the edge needs a slot covering now), truncated to the
    contiguous prefix covered by day-ahead prices (prices are the binding
    input - without a price a slot cannot be optimized). Raises
    :class:`SkipSite` when coverage is below :data:`MIN_HORIZON_SLOTS`.

    ``model_choices`` is the cycle's ONE read of the portal's active-model
    choice (:func:`load_model_choices`); ``None`` means "load it here", which
    is what the single-site callers (what-if, on-demand replan) do.
    """
    if model_choices is None:
        model_choices = load_model_choices(dsn)
    now = ensure_utc(now)
    slot_starts = horizon_slot_starts(now, horizon_slots)
    prices = _load_prices(dsn, site.bidding_zone, slot_starts)

    covered = 0
    for start in slot_starts:
        if start not in prices:
            break
        covered += 1
    if covered < MIN_HORIZON_SLOTS:
        raise SkipSite(
            f"only {covered} priced slots for zone {site.bidding_zone} "
            f"(need {MIN_HORIZON_SLOTS}); waiting for the market-data collector"
        )
    slot_starts = slot_starts[:covered]

    load_kw, _ = _forecast_or_fallback(
        dsn, site, "load", "load_kw", slot_starts, now, model_choices
    )
    pv_kw, pv_used_fallback = _forecast_or_fallback(
        dsn, site, "pv", "pv_power_kw", slot_starts, now, model_choices
    )
    pv_kw = _night_floor_pv_input(site, slot_starts, pv_kw, pv_used_fallback)

    # Both live readings sit behind a freshness window (F4/P4): a stale
    # section-14a reading must NOT become a standing envelope over every future
    # plan, and a stale SoC must not plan from yesterday's value.
    soc_pct = _fresh_measurement(
        dsn, site.site_id, "soc_pct", now, soc_max_age()
    )
    if soc_pct is None:
        soc_pct = DEFAULT_SOC_PCT
    grid_limit = _fresh_measurement(
        dsn, site.site_id, "grid_limit_kw", now, grid_limit_max_age()
    )

    # P1 asymmetric pricing: build the per-slot import/export series from the
    # site's tariff/remuneration master data (missing data degrades that side
    # to bare spot inside the pricing layer - never a skipped site).
    spot = [prices[s] for s in slot_starts]
    market_values: dict = {}
    if needs_market_values(site.tariff, site.netzladen_erlaubt):
        market_values = _load_market_values(
            dsn, sorted({berlin_month(s) for s in slot_starts})
        )
    import_series = import_prices(site.tariff, spot, site_id=site.site_id)
    export_series = export_values(
        site.tariff,
        site.netzladen_erlaubt,
        spot,
        slot_starts,
        market_values,
        site_id=site.site_id,
    )

    # PS-1: the billing period's measured import peak anchors the
    # Leistungspreis epigraph. Computed fresh per cycle (never a stored
    # column - the freshness principle), and only for module-active sites so
    # everyone else pays zero extra queries.
    peak_so_far = 0.0
    if site.leistungspreis_eur_kw is not None:
        peak_so_far = _peak_so_far_kw(
            dsn, site.site_id, now, site.abrechnung_leistung
        )

    return OptimizationInput(
        tenant_id=site.tenant_id,
        site_id=site.site_id,
        device_id=site.device_id,
        battery=site.battery,
        slot_starts=slot_starts,
        prices_eur_mwh=spot,
        load_kw=load_kw,
        pv_kw=pv_kw,
        initial_soc_kwh=float(soc_pct) / 100.0 * site.battery.capacity_kwh,
        netzladen_erlaubt=site.netzladen_erlaubt,
        grid_limit_kw=float(grid_limit) if grid_limit is not None else None,
        max_feed_in_kw=site.max_feed_in_kw,
        import_price_eur_mwh=import_series,
        export_value_eur_mwh=export_series,
        # P3: None = derive the terminal energy value from the horizon's own
        # prices; only an explicit platform override pins it.
        terminal_value_eur_per_kwh=terminal_value_override_eur_per_kwh(),
        leistungspreis_eur_kw=site.leistungspreis_eur_kw,
        peak_so_far_kw=peak_so_far,
    )


def billing_period_start(now: datetime, abrechnung_leistung: str) -> datetime:
    """The UTC start of the Leistungspreis billing period containing ``now``.

    Periods are Europe/Berlin calendar periods (the platform's timezone
    discipline, api ``HistoryRange.ZONE``): ``jahr`` = the calendar year,
    ``monat`` = the calendar month. Any unexpected value falls back to
    ``jahr`` (the DB default and the conservative choice - a longer period
    can only RAISE the anchor, never fabricate peak headroom).
    """
    local = ensure_utc(now).astimezone(BERLIN)
    if abrechnung_leistung == "monat":
        start_local = local.replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
    else:
        start_local = local.replace(
            month=1, day=1, hour=0, minute=0, second=0, microsecond=0
        )
    return start_local.astimezone(timezone.utc)


def plausible_peak(buckets_desc: list[float]) -> tuple[float, bool]:
    """The plausibility-gated period peak from the top import buckets
    (descending kW). Returns ``(peak_kw, spike_discarded)``.

    One poisoned 15-min bucket (an unfiltered telemetry spike from an old
    edge build) must not anchor the whole billing period's peak term - so
    when the highest bucket exceeds :data:`PEAK_SPIKE_FACTOR` times the
    second-highest, the second-highest is used instead. A REAL recurring peak
    produces similar top buckets and always survives; with a single bucket
    there is nothing to compare against, so it is trusted (the 15-min rollup
    averaging already damps single-sample spikes strongly).
    """
    positive = [b for b in buckets_desc if b > 0.0]
    if not positive:
        return 0.0, False
    top = positive[0]
    if len(positive) >= 2 and top > PEAK_SPIKE_FACTOR * positive[1]:
        return positive[1], True
    return top, False


def _peak_so_far_kw(
    dsn: str, site_id: UUID, now: datetime, abrechnung_leistung: str
) -> float:
    """The billing period's highest 15-min mean grid import so far (kW).

    Sources, blended by max: (a) the completed 15-min buckets from
    ``telemetry_rollup_15m`` - ``grid_import_kwh * 4.0`` is the bucket's mean
    import power, exactly the RLM billing quantity - gated through
    :func:`plausible_peak`; (b) the RUNNING quarter hour's mean import from
    raw telemetry (``avg(greatest(power_kw, 0))`` over the slot in progress,
    the same per-sample import split the rollups use), because the rollup
    refresh lags up to 15 min and the plan must never look "under" a peak
    that is forming right now. The raw blend is ungated - a spike there
    distorts at most ONE cycle (peak_so_far is recomputed fresh every 15 min,
    and the completed bucket is gated on the next cycle).
    """
    import psycopg  # lazy: optional [db] extra

    now = ensure_utc(now)
    period_start = billing_period_start(now, abrechnung_leistung)
    slot_start = floor_to_slot(now)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT grid_import_kwh * 4.0 FROM telemetry_rollup_15m
            WHERE site_id = %s AND bucket >= %s AND grid_import_kwh IS NOT NULL
            ORDER BY grid_import_kwh DESC LIMIT 2
            """,
            (site_id, period_start),
        )
        buckets = [float(r[0]) for r in cur.fetchall()]
        cur.execute(
            """
            SELECT avg(greatest(power_kw, 0)) FROM telemetry
            WHERE site_id = %s AND power_kw IS NOT NULL
              AND time >= %s AND time <= %s
            """,
            (site_id, max(slot_start, period_start), now),
        )
        row = cur.fetchone()
        running = float(row[0]) if row is not None and row[0] is not None else 0.0
    rollup_peak, spiked = plausible_peak(buckets)
    if spiked:
        logger.warning(
            "peak_so_far.spike_bucket_discarded",
            extra={
                "context": {
                    "site_id": str(site_id),
                    "top_bucket_kw": round(buckets[0], 3),
                    "used_kw": round(rollup_peak, 3),
                    "factor": PEAK_SPIKE_FACTOR,
                }
            },
        )
    return max(rollup_peak, running, 0.0)


def _load_prices(
    dsn: str, zone: str, slot_starts: list[datetime]
) -> dict[datetime, float]:
    """Day-ahead prices per 15-min slot start over the horizon.

    ``PT15M`` rows map 1:1; ``PT60M`` rows are expanded to the four quarter
    hours they cover (a flat intra-hour price - exact for hourly products).
    15-min prices win where both resolutions are stored.
    """
    import psycopg  # lazy: optional [db] extra

    start, end = slot_starts[0], slot_starts[-1]
    by_slot: dict[datetime, float] = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT ts, resolution, price_eur_mwh
            FROM day_ahead_prices
            WHERE bidding_zone = %s AND ts >= %s AND ts <= %s
            ORDER BY ts
            """,
            (zone, start - timedelta(minutes=45), end),
        )
        rows = cur.fetchall()
    for resolution_pass in ("PT60M", "PT15M"):  # 15-min wins
        for ts, resolution, price in rows:
            if resolution != resolution_pass:
                continue
            ts = ensure_utc(ts)
            slots_covered = 4 if resolution == "PT60M" else 1
            for i in range(slots_covered):
                by_slot[ts + i * timedelta(minutes=SLOT_MINUTES)] = float(price)
    return by_slot


def _load_market_values(dsn: str, months: list) -> dict:
    """Monatsmarktwert Solar (ct/kWh) for the given German calendar months
    (first-of-month dates) - the ``monthly_market_value`` table fed by
    services/market-data. Absent months simply stay absent (no premium for
    their slots; the pricing layer flags them)."""
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT month, value_ct_kwh FROM monthly_market_value
            WHERE technology = 'solar' AND month = ANY(%s)
            """,
            (months,),
        )
        return {month: float(value) for month, value in cur.fetchall()}


def _forecast_or_fallback(
    dsn: str,
    site: BatterySite,
    kind: str,
    telemetry_column: str,
    slot_starts: list[datetime],
    now: datetime,
    model_choices: dict | None = None,
) -> tuple[list[float], bool]:
    """The ACTIVE model's latest stored forecast run when it covers the
    horizon, else the persistence baseline over recent telemetry (never fails:
    with no telemetry at all it degrades to zeros, i.e. a pure price-arbitrage
    plan). Shadow challengers' rows are never consumed here.

    Returns ``(series, used_fallback)`` so the PV caller can flag a fallback-fed
    night-floor distinctly (the collector<->optimizer 15-min race, §4a of the
    scout report - visible in monitoring before it silently degrades plans)."""
    stored = _load_forecast(
        dsn, site.site_id, kind, active_model(kind, choices=model_choices), slot_starts[0]
    )
    if all(s in stored for s in slot_starts):
        return [stored[s] for s in slot_starts], False

    history = _load_history(dsn, site.site_id, telemetry_column, now)
    missing = sum(1 for s in slot_starts if s not in stored)
    logger.info(
        "forecast.fallback",
        extra={
            "context": {
                "site_id": str(site.site_id),
                "kind": kind,
                "horizon_slots": len(slot_starts),
                "stored_slots": len(stored),
                "missing_slots": missing,
                "history_points": len(history),
            }
        },
    )
    return persistence_forecast(history, slot_starts), True


def _night_floor_pv_input(
    site: BatterySite,
    slot_starts: list[datetime],
    pv_kw: list[float],
    used_fallback: bool,
) -> list[float]:
    """Apply the night-zero floor to the site's PV input and log any fabrication.

    Defensive: applied to the FINAL PV series regardless of source (a night-zero
    floor can never be physically wrong - the stored physical model is already 0
    at night, so it is a no-op there), so no phantom night PV from any current or
    future PV path reaches the MILP. See
    :func:`voltpilot_optimization.fallback.night_floor_pv`.
    """
    floored, zeroed = night_floor_pv(
        pv_kw, slot_starts, site.latitude, site.longitude
    )
    if site.latitude is None or site.longitude is None:
        if used_fallback:
            logger.warning(
                "forecast.pv_fallback.no_coordinates",
                extra={
                    "context": {
                        "site_id": str(site.site_id),
                        "kind": "pv",
                        "reason": (
                            "PV persistence fallback fired but the site has no "
                            "latitude/longitude - cannot night-floor; a daytime "
                            "value may be smeared across night slots"
                        ),
                    }
                },
            )
        return floored
    if zeroed:
        logger.warning(
            "forecast.pv.night_floor_applied",
            extra={
                "context": {
                    "site_id": str(site.site_id),
                    "kind": "pv",
                    "used_fallback": used_fallback,
                    "night_slots_zeroed": len(zeroed),
                    "max_fabricated_kw": round(max(pv_kw[i] for i in zeroed), 4),
                    "reason": (
                        "PV persistence fallback fabricated non-zero night PV"
                        if used_fallback
                        else "stored PV forecast reported non-zero night values"
                    ),
                }
            },
        )
    return floored


def _load_forecast(
    dsn: str, site_id: UUID, kind: str, model: str, since: datetime
) -> dict[datetime, float]:
    """Per-slot FRESHEST prediction of ONE model (the active one) from
    ``since`` on - shadow rows stay invisible.

    Freshest-per-slot instead of latest-run-only because the horizon includes
    the slot IN PROGRESS (B1) while a collector run covers only slots strictly
    after its ``run_at`` (``Horizon.slot_starts``): the in-progress slot's
    prediction exists only in the PREVIOUS run. Latest-run-only would miss it
    and silently discard the whole stored forecast in favor of the persistence
    fallback whenever the collector fired earlier in the same slot. This is
    the evaluation's "freshest prediction issued for the slot" rule; for every
    strictly-future slot the newest run still wins."""
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (time) time, value_kw FROM forecast
            WHERE site_id = %s AND kind = %s AND model = %s AND time >= %s
            ORDER BY time, run_at DESC
            """,
            (site_id, kind, model, since),
        )
        return {ensure_utc(ts): float(v) for ts, v in cur.fetchall()}


def _load_history(
    dsn: str, site_id: UUID, column: str, now: datetime
) -> list[tuple[datetime, float]]:
    # Fixed set, never user input - a hard raise (not assert, which is
    # stripped under python -O) keeps the f-string interpolation safe (S15).
    if column not in ("load_kw", "pv_power_kw"):
        raise ValueError(f"unsupported telemetry column: {column}")
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT time, {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL AND time >= %s
            ORDER BY time
            """,
            (site_id, now - FALLBACK_HISTORY),
        )
        return [(ensure_utc(ts), float(v)) for ts, v in cur.fetchall()]


def _fresh_measurement(
    dsn: str,
    site_id: UUID,
    column: str,
    now: datetime,
    max_age: timedelta,
) -> float | None:
    """The newest telemetry value for ``column`` IF it is fresh, else ``None``.

    Deliberately reads the newest row WITHOUT a time bound and applies the
    window here, so a discarded stale reading is FLAGGED with its age (F4: the
    silent-poisoning failure mode was invisible) instead of just vanishing
    from the query result.
    """
    # Fixed set, never user input - a hard raise (not assert, which is
    # stripped under python -O) keeps the f-string interpolation safe (S15).
    if column not in ("soc_pct", "grid_limit_kw"):
        raise ValueError(f"unsupported telemetry column: {column}")
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT time, {column} FROM telemetry
            WHERE site_id = %s AND {column} IS NOT NULL
            ORDER BY time DESC LIMIT 1
            """,
            (site_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    observed_at, val = ensure_utc(row[0]), float(row[1])
    age = now - observed_at
    if age > max_age:
        logger.warning(
            "telemetry.stale_reading_ignored",
            extra={
                "context": {
                    "site_id": str(site_id),
                    "column": column,
                    "value": val,
                    "age_minutes": round(age.total_seconds() / 60.0, 1),
                    "max_age_minutes": round(max_age.total_seconds() / 60.0, 1),
                }
            },
        )
        return None
    return val

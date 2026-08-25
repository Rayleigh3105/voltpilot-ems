"""Core optimizer domain types (framework-free, dependency-free).

The vocabulary shared by the solver, the input gathering, the persistence layer
and the MQTT publisher. Plain dataclasses, mirroring the style of the forecast
service's ``domain.py`` - the optimizer is the *predict-then-optimize* consumer:
forecasts and prices come in as plain slot-aligned series, and a deterministic
MILP turns them into a :class:`SchedulePlan`. No ML, no learned logic.

Conventions (match the platform):
- All timestamps are timezone-aware UTC ``datetime`` objects.
- Power in kW; battery power is signed **+charge / -discharge** (the frozen
  schedule contract ``docs/contracts/mqtt-schedule.schema.json``); grid power is
  signed **+import / -export** (the telemetry contract).
- Prices in EUR/MWh (native day-ahead unit); costs in EUR.
- The optimization grid is 15-min slots (architecture section 11).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from uuid import UUID

from voltpilot_optimization.config import (
    DEFAULT_WEAR_COST_CT_PER_KWH,
    TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH,
    TERMINAL_VALUE_MARGIN_EUR_PER_KWH,
    terminal_value_quantile,
)

SLOT_MINUTES = 15
SLOTS_24H = 96

# Usable SoC window as fractions of nameplate capacity. The asset master data
# carries capacity/power/efficiency; the reserve band is a platform default
# (protects battery life, keeps headroom for the edge's self-consumption
# fallback) until it becomes per-asset master data.
DEFAULT_SOC_MIN_FRACTION = 0.05
DEFAULT_SOC_MAX_FRACTION = 0.95


@dataclass(frozen=True)
class BatteryParams:
    """Per-site battery master data (the ``asset`` table row).

    ``roundtrip_efficiency`` is the AC round-trip fraction (0..1]; the solver
    splits it symmetrically (sqrt each way) between charge and discharge.

    ``wear_cost_ct_per_kwh`` prices degradation per kWh CYCLED (one kWh charged
    and discharged again, AC side) - resolved by ``load_battery_sites`` from the
    nullable ``asset.wear_cost_ct_per_kwh`` override, falling back to the
    platform default (env ``OPTIMIZER_WEAR_COST_CT_PER_KWH``); derivation in
    :mod:`voltpilot_optimization.config`. 0 disables wear pricing.

    ``backup_reserve_pct`` is the customer-configured backup-reserve minimum
    SoC (P11; ``site.backup_reserve_soc_pct``, nullable): the plan never
    discharges below it - a HARD constraint, never a soft preference. ``None``
    (the default) means the platform 5% technical floor applies unchanged;
    a value below the technical floor is ineffective (the floor wins).

    ``peak_reserve_pct`` (PS-2; ``site.peak_reserve_soc_pct``, nullable) is
    the peak-shaving reserve: SoC headroom held back for shaving a load spike
    BEYOND the 24h horizon (the MPC never sees the whole billing period, so
    the epigraph term alone would let arbitrage drain the battery the evening
    before the expensive Monday-morning peak). It joins the reservation STACK
    (multi-use Stufe 2): each reservation is an ABSOLUTE SoC floor, ordered
    technical < backup < peak-reserve, and the highest configured floor binds
    (``max``, never additive - a peak reserve below the backup reserve is
    simply ineffective). Hard like the backup reserve, with the same
    below-floor-start relaxation.
    """

    capacity_kwh: float
    max_charge_kw: float
    max_discharge_kw: float
    roundtrip_efficiency: float = 0.92
    soc_min_fraction: float = DEFAULT_SOC_MIN_FRACTION
    soc_max_fraction: float = DEFAULT_SOC_MAX_FRACTION
    wear_cost_ct_per_kwh: float = DEFAULT_WEAR_COST_CT_PER_KWH
    backup_reserve_pct: float | None = None
    peak_reserve_pct: float | None = None

    def __post_init__(self) -> None:
        if self.capacity_kwh <= 0:
            raise ValueError("capacity_kwh must be positive")
        if self.max_charge_kw <= 0 or self.max_discharge_kw <= 0:
            raise ValueError("charge/discharge power limits must be positive")
        if not 0.0 < self.roundtrip_efficiency <= 1.0:
            raise ValueError("roundtrip_efficiency must be within (0, 1]")
        if not 0.0 <= self.soc_min_fraction < self.soc_max_fraction <= 1.0:
            raise ValueError("SoC fractions must satisfy 0 <= min < max <= 1")
        if not (
            math.isfinite(self.wear_cost_ct_per_kwh)
            and self.wear_cost_ct_per_kwh >= 0.0
        ):
            raise ValueError("wear_cost_ct_per_kwh must be finite and >= 0")
        for name in ("backup_reserve_pct", "peak_reserve_pct"):
            reserve = getattr(self, name)
            if reserve is not None and not (
                math.isfinite(reserve) and 0.0 <= reserve <= 100.0
            ):
                raise ValueError(f"{name} must be within [0, 100] when set")

    @property
    def one_way_efficiency(self) -> float:
        """Symmetric per-direction efficiency: sqrt of the round trip."""
        return math.sqrt(self.roundtrip_efficiency)

    @property
    def wear_cost_eur_per_kwh_each_way(self) -> float:
        """Wear cost per AC-side kWh of throughput in ONE direction.

        Half the per-cycle rate, so a full round trip of one kWh (one in, one
        out) costs exactly ``wear_cost_ct_per_kwh``; a partial move (charged
        within the horizon, not yet discharged) is charged half."""
        return self.wear_cost_ct_per_kwh / 100.0 / 2.0

    @property
    def soc_min_kwh(self) -> float:
        return self.capacity_kwh * self.soc_min_fraction

    @property
    def soc_max_kwh(self) -> float:
        return self.capacity_kwh * self.soc_max_fraction

    def clamp_soc_kwh(self, soc_kwh: float) -> float:
        """Clamp a measured SoC into the usable window (keeps the model feasible
        when telemetry reports a SoC outside the reserve band)."""
        return min(max(soc_kwh, self.soc_min_kwh), self.soc_max_kwh)

    def soc_floor_kwh(self, initial_soc_kwh: float) -> float:
        """The effective SoC lower bound of a plan starting at
        ``initial_soc_kwh`` (already clamped into the technical band).

        The reservation STACK (P11 backup reserve + PS-2 peak-shaving
        reserve) raises the technical floor - hard, never soft: each
        configured reservation is an absolute SoC level and the highest one
        binds. The floor is RELAXED to the actual start when the battery
        currently sits below it: a below-reserve battery must still yield a
        feasible plan, and "never discharge any further" is the correct hard
        property there (recovery charging follows from the economics/PV; each
        15-min MPC re-plan then ratchets the floor back up as the battery
        recovers). Capped at ``soc_max_kwh`` so a 100% reserve pins the
        battery full instead of going infeasible."""
        floor = self.soc_min_kwh
        for reserve_pct in (self.backup_reserve_pct, self.peak_reserve_pct):
            if reserve_pct is not None:
                reserve_kwh = self.capacity_kwh * reserve_pct / 100.0
                floor = min(max(floor, reserve_kwh), self.soc_max_kwh)
        return min(floor, initial_soc_kwh)


#: The anchor a terminal value came from - the closed vocabulary of
#: :attr:`TerminalValue.anchor_kind` (Erklaerbarkeit Stufe 1 §4.2 A). It is the
#: CUSTOMER-relevant half of the derivation: whether the stored kWh is priced
#: against the feed-in it forgoes, against the grid import it avoids (the
#: trueb-horizon case that froze Herzogau), against the cheapest purchase, or
#: not derived at all.
ANCHOR_EINSPEISEWERT = "einspeisewert"  # surplus slot: the forgone feed-in
ANCHOR_BEZUGSPREIS = "bezugspreis"  # deficit slot: the avoided grid import
ANCHOR_MARKTPREIS = "marktpreis"  # grid charging allowed: cheapest refill
ANCHOR_VORGABE = "vorgabe"  # env-pinned override, nothing derived


@dataclass(frozen=True)
class TerminalValue:
    """The terminal energy value AND the facts that produced it.

    The Erklaerbarkeit-Stufe-1 answer to the §3.3 export gap: the derivation
    knew everything the 17.08. customer needed - which branch supplied the
    anchor, how much free PV refill the horizon offers, whether the dispersion
    guard capped it - and returned only a float, so every driver was discarded
    and the surfaces filled the hole with plausibility.

    ``anchor_kind`` is one of the ``ANCHOR_*`` constants. ``refill_free_pct``
    is step 2's free-refill share of the usable band in percent (0-100), or
    ``None`` when the band is not evaluable (a zero/negative usable band) -
    never a fabricated 0. ``guard_capped`` records whether step 3 bound; it is
    a solver-internal fact and deliberately NOT persisted (the anchor carries
    the customer-relevant statement, cf. §4.2 "Nicht exportiert").
    """

    v_end: float
    anchor_kind: str
    refill_free_pct: float | None
    guard_capped: bool


def derive_terminal_value_eur_per_kwh(**kwargs) -> float:
    """The P3 terminal energy value per STORED kWh (the number the objective
    credits) - :func:`derive_terminal_value` reduced to its value.

    Kept as the callers' entry point so the solver, the co-optimizer twin and
    the golden suite are untouched by the Stufe-1 export: there is still ONE
    derivation, it just also RETURNS what it knew all along.
    """
    return derive_terminal_value(**kwargs).v_end


def derive_terminal_value(
    *,
    import_prices: list[float],
    export_values: list[float],
    pv_kw: list[float],
    load_kw: list[float],
    slot_hours: float,
    max_charge_kw: float,
    usable_band_kwh: float,
    one_way_efficiency: float,
    wear_eur_per_kwh_each_way: float,
    grid_charge_allowed: bool,
    max_feed_in_kw: float | None = None,
    env=None,
) -> TerminalValue:
    """The P3 terminal energy value per STORED kWh, derived from the horizon.

    THE ONE derivation, shared by the v1 :class:`OptimizationInput` and the
    per-storage co-optimizer twin (``CoOptimizationInput``), so the N=1 adapter
    reproduces the v1 value bit for bit by construction rather than by two
    copies agreeing.

    **``V_end`` is a REPLACEMENT cost, not a use value** (scout
    ``vp-fahrplan-idle-n7``). The question it answers is "what would it cost to
    put this kWh back after the horizon?", NOT "what is it worth to use?". The
    old derivation anchored on ``max(import_t, export_t)`` - the best USE - and
    that is what froze the pilot plant:

      A flat retail tariff (``tarif_art='fest'``) makes ``import_t`` a
      CONSTANT, and German retail (25-42 ct) exceeds any realistic spot peak,
      so ``max(import_t, export_t)`` was constant over the whole horizon. With
      zero dispersion ANY quantile returned retail, ``V_end`` came out at
      28.3 ct against a 20 ct evening peak, the discharge gradient was exactly
      0.000, and selling into the peak was STRICTLY rejected - the spot curve
      never entered the decision. Every ``fest`` plant planned a fully idle
      battery on essentially every day of the year.

    Three steps, each of which only ever LOWERS the value:

    1. **Charge-side anchor.** The marginal cost of refilling one AC kWh is
       ``min(import_t, export_t)`` when the battery may charge from the grid
       (buy it, or forgo exporting your own PV - whichever is cheaper). In EEG
       mode only PV may charge, so the per-slot entry splits on whether the
       slot actually OFFERS a PV refill (S2, scout ``vp-nacht-bezug-e7`` §1.5):
       in a SURPLUS slot (``pv_t > load_t``) the refill channel exists and its
       cost is the forgone feed-in ``export_t``; in a DEFICIT slot there is
       nothing to refill from - the marginal stored kWh serves the HOUSE
       instead, and its worth is the avoided import ``import_t``
       (Bezugsvermeidung - the value of storing for the house, not for the
       grid). The pre-S2 form (``export_t`` in every slot) under-valued stored
       energy on exactly the winter/bad-weather horizons where refilling is
       impossible, and the plan then sold the battery into a cheap tail (0.4-6
       ct) that real all-in import (~30 ct) makes a plain loss. The share of
       deficit slots decides how much the quantile feels this: on a sunny
       horizon the low quantile still lands in the surplus/export range
       (behavior unchanged), on a no-surplus day the whole series is import and
       the anchor honestly carries the avoided Bezug. A conservative low
       quantile (default the 30th percentile) of that series is the anchor;
       ``eta``/``wear`` discount it exactly as before. Under symmetric pricing
       (import == export == spot, the ``ohne`` model) every branch coincides,
       so this is a no-op - the change bites precisely where import and export
       diverge, which is where the old formula was wrong.

       **Feed-in-cap awareness** (scout ``vp-verkauf-praemisse-s8`` §1.4, the
       Pilsting 10.08. plant): with a maintained ``max_feed_in_kw`` a surplus
       slot can only feed in up to the cap - surplus BEYOND it is not
       exportable at all, so the marginal refill there costs nothing (it would
       be curtailed otherwise). A beyond-cap surplus slot's entry is therefore
       ``min(export_t, 0)`` in EEG mode (at negative prices absorbing the
       below-cap export is still a gain, unchanged) and gains the free ``0``
       channel in the merchant ``min`` too. The solver's ``feed_in_cap``
       constraint already made lambda/explain cap-honest automatically; this
       makes the terminal anchor tell the same story instead of pricing a
       refill against feed-in the connection point cannot carry. Without a cap
       (``max_feed_in_kw is None``) every branch is byte-identical to before.
    2. **Free-PV refill cap.** Surplus generation in slots whose export value
       is <= 0 costs the plant NOTHING to store (feeding it in earns nothing or
       less). Energy the battery could actually absorb from such slots is
       compared with its usable band: once the horizon offers enough free
       surplus to refill the band outright, stored energy carries no scarcity
       value at all and ``V_end`` scales to 0. This is the "tomorrow's PV
       refills it for free" truth a 70 kWp plant in July needs, and it is why a
       full battery must not sit on its charge through an evening peak.

       With a maintained feed-in cap the beyond-cap share of a surplus slot is
       equally free to store at POSITIVE prices (it cannot be fed in, so
       storing it forgoes nothing) and counts toward ``free_kwh`` too - only
       the beyond-cap PORTION, the below-cap share still earns its feed-in.
    3. **Strict-dispersion guard.** ``V_end`` is finally held strictly below
       ``eta * (best in-horizon use value - wear - margin)``, so the plan can
       ALWAYS realize stored energy in at least its single best slot: the
       "``V_end`` above every price, discharge structurally impossible" state
       is unreachable by construction, whatever future pricing does.

       NOTE this deliberately caps against the horizon's BEST use value, where
       the scout report suggested its WORST (``min(best_use)``). The min-form
       is unsafe: on a curve with a midday trough it pins ``V_end`` to the
       trough and the plan then dumps its battery into any mediocre tail above
       it - re-introducing the dump-to-earn behaviour P3 exists to prevent.
       The max-form gives the same "equality can never null the gradient"
       guarantee without stripping the quantile of meaning.

    The margin is smaller than the throughput tie-break (see
    ``TERMINAL_VALUE_MARGIN_EUR_PER_KWH``), so a genuinely flat curve is still
    decided by the tie-break and still plans an idle battery - that protection
    is untouched.
    """
    n = len(import_prices)
    eta = one_way_efficiency
    wear = wear_eur_per_kwh_each_way  # EUR per AC kWh

    def beyond_cap(t: int) -> bool:
        """Does slot ``t``'s surplus exceed the connection-point feed-in cap?

        The marginal kWh of such a slot cannot be exported (the pipe is full
        before the battery does anything), so its refill via the forgone-
        feed-in channel is FREE. Always false without a maintained cap."""
        return max_feed_in_kw is not None and pv_kw[t] - load_kw[t] > max_feed_in_kw

    # 1. Charge-side (replacement) anchor.
    if grid_charge_allowed:
        refill_eur_mwh = [
            # Beyond-cap surplus adds the free refill channel to the merchant
            # min (store what the connection point cannot carry, cost 0).
            min(imp, exp, 0.0) if beyond_cap(t) else min(imp, exp)
            for t, (imp, exp) in enumerate(zip(import_prices, export_values))
        ]
        # The refill channel is the market either way (buy, or forgo selling) -
        # ONE customer statement, so the per-slot split below is not made here.
        anchor_kinds = [ANCHOR_MARKTPREIS] * n
    else:
        # S2: surplus slot -> refill = forgone feed-in; deficit slot -> no PV
        # to refill from, the stored kWh's worth is the avoided import - MINUS
        # the cover-now discount: covering a LATER night is worth a hair less
        # than covering TONIGHT, else a flat tariff makes the two an exact tie
        # that the prefer-idle tie-break freezes into "hold forever while the
        # house imports" (Herzogau 17.08.2026; see config).
        # Discount only where der Bezug wirklich teurer ist als der
        # Einspeisewert (die Tie-Klasse); bei imp <= exp (symmetrisches
        # `ohne`) bleibt der Branch ein exaktes No-op wie vor S2 dokumentiert.
        # Beyond-cap surplus slot: the marginal kWh cannot be fed in, so the
        # forgone feed-in is 0 - min(exp, 0) keeps the negative-price case
        # (absorbing the below-cap export remains a gain) byte-identical.
        refill_eur_mwh = [
            (min(exp, 0.0) if beyond_cap(t) else exp)
            if pv_kw[t] > load_kw[t]
            else (
                imp - TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH
                if imp > exp
                else imp
            )
            for t, (imp, exp) in enumerate(zip(import_prices, export_values))
        ]
        # WHICH branch a slot's entry came from - carried alongside the price so
        # the quantile pick below names its own origin instead of re-deriving it
        # from a value that both branches can produce.
        anchor_kinds = [
            ANCHOR_EINSPEISEWERT if pv_kw[t] > load_kw[t] else ANCHOR_BEZUGSPREIS
            for t in range(n)
        ]
    quantile = terminal_value_quantile(env)
    # Sorted TOGETHER, so the reported kind belongs to the very entry that
    # became the anchor. Ties sort by kind name, which is arbitrary but stable -
    # and where two branches priced the same, either statement is true.
    ordered = sorted(zip(refill_eur_mwh, anchor_kinds))
    anchor, anchor_kind = ordered[int(quantile * (n - 1))]
    v_end = max(0.0, eta * (anchor / 1000.0 - wear))

    # 2. Free-PV refill cap: surplus the battery could absorb in slots where
    #    feeding in earns nothing (or costs money), so storing it is free. With
    #    a maintained feed-in cap, the beyond-cap PORTION of a surplus slot is
    #    free at positive prices too - it cannot be exported either way.
    refill_free_pct: float | None = None
    if usable_band_kwh > 0.0:
        free_kwh = 0.0
        for t in range(n):
            surplus_kw = max(pv_kw[t] - load_kw[t], 0.0)
            if export_values[t] <= 0.0:
                free_surplus_kw = surplus_kw
            elif max_feed_in_kw is not None:
                free_surplus_kw = max(surplus_kw - max_feed_in_kw, 0.0)
            else:
                free_surplus_kw = 0.0
            free_kwh += min(free_surplus_kw, max_charge_kw) * slot_hours
        free_share = min(1.0, free_kwh / usable_band_kwh)
        refill_free_pct = 100.0 * free_share
        v_end *= 1.0 - free_share

    # 3. Strict-dispersion guard: never at or above the best in-horizon use.
    best_use = max(max(imp, exp) for imp, exp in zip(import_prices, export_values))
    guard = eta * (best_use / 1000.0 - wear - TERMINAL_VALUE_MARGIN_EUR_PER_KWH)
    guard_capped = guard < v_end
    v_end = min(v_end, guard)
    return TerminalValue(
        v_end=max(0.0, v_end),
        anchor_kind=anchor_kind,
        refill_free_pct=refill_free_pct,
        guard_capped=guard_capped,
    )


@dataclass(frozen=True)
class OptimizationInput:
    """Everything one solver run needs, slot-aligned over the horizon.

    ``slot_starts``/``prices_eur_mwh``/``load_kw``/``pv_kw`` are parallel lists
    (one entry per 15-min slot, ascending, contiguous). ``grid_limit_kw`` is the
    observed §14a envelope applied as a hard cap on net import AND export;
    ``None`` means unconstrained. ``initial_soc_kwh`` is the battery state at
    the start of the first slot.

    ``max_feed_in_kw`` (FK1, the Excel reference spec's "Max Einspeisung am
    Netzpunkt") is the site's STATIC feed-in cap at the grid connection point
    (``site.max_feed_in_kw`` master data): a hard cap on EXPORT ONLY - import
    is never limited by it. It is separate from (and composes with) the
    telemetry-driven §14a ``grid_limit_kw``: when both exist the tighter one
    wins on export. ``None`` means no connection-point limit.

    ``netzladen_erlaubt`` mirrors ``site.netzladen_erlaubt`` (the per-site
    grid-charging switch, captain decision 2026-07-07): ``True`` = merchant
    mode, the battery may charge from the grid (price arbitrage); ``False`` =
    EEG mode, the battery charges ONLY from PV the site actually produces
    (``charge <= pv - curtail``, PV-bus Bilanzierung per FK3, captain decision
    2026-07-16; the house may import its load in parallel) - the
    Ausschliesslichkeitsprinzip for EEG-funded plants. The field is REQUIRED
    (no default) on purpose: every caller must decide, so a forgotten wire-up
    can never silently put an EEG plant into grid arbitrage.

    **Asymmetric pricing (P1, Stage 2 of the optimizer redesign):**
    ``import_price_eur_mwh``/``export_value_eur_mwh`` are the per-slot cost of
    an imported kWh and value of an exported kWh, built from the site's tariff
    and remuneration by :mod:`voltpilot_optimization.pricing`. ``None`` (the
    default) means bare spot on that side - the pre-P1 symmetric model, so
    un-wired callers and pure-market sites behave exactly as before.
    ``prices_eur_mwh`` stays the SPOT series (persisted per slot for the
    portal's price curve; also the §51 sign signal the pricing layer already
    folded into the export values).

    **Terminal energy value (P3, Stage 3):** ``terminal_value_eur_per_kwh`` is
    the value the objective credits per kWh left in the battery at the horizon
    end (EUR per STORED kWh). ``None`` (the default) derives it from the
    horizon's own prices (:meth:`effective_terminal_value_eur_per_kwh`);
    ``gather_inputs`` sets an explicit value only when the platform override
    ``OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH`` is configured.

    **Peak shaving (PS-1):** ``leistungspreis_eur_kw`` is the site's
    Leistungspreis (EUR per kW per billing period, ``site.leistungspreis_eur_kw``);
    ``None`` (the default) = the module is off and the model is byte-identical
    to before. ``peak_so_far_kw`` is the billing period's highest 15-min mean
    grid import measured SO FAR (computed fresh per cycle by
    ``inputs._peak_so_far_kw``; 0 at period start) - the anchor the epigraph
    term charges the Leistungspreis above (see solver.py).

    **PV nowcast anchor (Morgenprognose, 2026-08-24):** ``pv_anchor_ratio`` /
    ``pv_anchor_slots`` are DIAGNOSTICS - the measured-over-predicted ratio the
    site's own recent slots established and how many slots it rests on
    (:mod:`voltpilot_optimization.nowcast`). The correction itself is ALREADY
    inside ``pv_kw``; these two only travel so the persisted run and the admin
    optimizer readout can say what was corrected. ``None`` = no anchor was
    established (too little evidence, or the kill switch is off).
    """

    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    battery: BatteryParams
    slot_starts: list[datetime]
    prices_eur_mwh: list[float]
    load_kw: list[float]
    pv_kw: list[float]
    initial_soc_kwh: float
    netzladen_erlaubt: bool
    grid_limit_kw: float | None = None
    max_feed_in_kw: float | None = None
    slot_minutes: int = SLOT_MINUTES
    import_price_eur_mwh: list[float] | None = None
    export_value_eur_mwh: list[float] | None = None
    terminal_value_eur_per_kwh: float | None = None
    leistungspreis_eur_kw: float | None = None
    peak_so_far_kw: float = 0.0
    pv_anchor_ratio: float | None = None
    pv_anchor_slots: int = 0
    #: An ACTIVE customer rule claims the battery (Steuerung Stufe 3, Konzept
    #: vp-steuerung-konzept-b3 §3.7 A4). The battery is then NOT the plan's to
    #: command: charge and discharge are bounded to 0, so the plan holds the
    #: SoC path flat and claims no savings on a battery the rule owns. The
    #: physical asset is unchanged - this is a per-RUN fact about WHO may
    #: dispatch it, never battery master data. Default False = byte-identical
    #: to every run before Stufe 3.
    battery_held: bool = False

    def __post_init__(self) -> None:
        n = len(self.slot_starts)
        if n == 0:
            raise ValueError("horizon must contain at least one slot")
        for name in ("prices_eur_mwh", "load_kw", "pv_kw"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        for name in ("import_price_eur_mwh", "export_value_eur_mwh"):
            series = getattr(self, name)
            if series is not None and len(series) != n:
                raise ValueError(f"{name} must have one entry per slot ({n})")
        if self.slot_minutes <= 0:
            raise ValueError("slot_minutes must be positive")
        if self.grid_limit_kw is not None and self.grid_limit_kw <= 0:
            raise ValueError("grid_limit_kw must be positive when set")
        if self.max_feed_in_kw is not None and self.max_feed_in_kw <= 0:
            raise ValueError("max_feed_in_kw must be positive when set")
        if self.terminal_value_eur_per_kwh is not None and not (
            math.isfinite(self.terminal_value_eur_per_kwh)
            and self.terminal_value_eur_per_kwh >= 0.0
        ):
            raise ValueError(
                "terminal_value_eur_per_kwh must be finite and >= 0 when set"
            )
        if self.leistungspreis_eur_kw is not None and not (
            math.isfinite(self.leistungspreis_eur_kw)
            and self.leistungspreis_eur_kw >= 0.0
        ):
            raise ValueError("leistungspreis_eur_kw must be finite and >= 0 when set")
        if not (math.isfinite(self.peak_so_far_kw) and self.peak_so_far_kw >= 0.0):
            raise ValueError("peak_so_far_kw must be finite and >= 0")
        if self.pv_anchor_ratio is not None and not (
            math.isfinite(self.pv_anchor_ratio) and self.pv_anchor_ratio > 0.0
        ):
            raise ValueError("pv_anchor_ratio must be finite and > 0 when set")

    @property
    def slots(self) -> int:
        return len(self.slot_starts)

    @property
    def slot_hours(self) -> float:
        return self.slot_minutes / 60.0

    @property
    def import_prices(self) -> list[float]:
        """Per-slot import price, falling back to bare spot (symmetric model)."""
        return (
            self.import_price_eur_mwh
            if self.import_price_eur_mwh is not None
            else self.prices_eur_mwh
        )

    @property
    def export_values(self) -> list[float]:
        """Per-slot export value, falling back to bare spot (symmetric model)."""
        return (
            self.export_value_eur_mwh
            if self.export_value_eur_mwh is not None
            else self.prices_eur_mwh
        )

    def effective_terminal_value_eur_per_kwh(self, env=None) -> float:
        """The terminal energy value the solver credits per stored kWh at the
        horizon end (P3): the explicit override when set, else derived from
        the horizon's own prices by
        :func:`derive_terminal_value_eur_per_kwh` (see there, and the P3
        section of :mod:`voltpilot_optimization.config`, for the derivation).
        """
        return self.effective_terminal_value(env).v_end

    def effective_terminal_value(self, env=None) -> TerminalValue:
        """The same number PLUS the facts that produced it (Erklaerbarkeit
        Stufe 1): which anchor priced it, how much free PV refill the horizon
        offers, whether the dispersion guard bound. An env-pinned override
        derives nothing, so it honestly reports :data:`ANCHOR_VORGABE`."""
        if self.terminal_value_eur_per_kwh is not None:
            return TerminalValue(
                v_end=self.terminal_value_eur_per_kwh,
                anchor_kind=ANCHOR_VORGABE,
                refill_free_pct=None,
                guard_capped=False,
            )
        p = self.battery
        soc0 = p.clamp_soc_kwh(self.initial_soc_kwh)
        return derive_terminal_value(
            import_prices=self.import_prices,
            export_values=self.export_values,
            pv_kw=self.pv_kw,
            load_kw=self.load_kw,
            slot_hours=self.slot_hours,
            max_charge_kw=p.max_charge_kw,
            usable_band_kwh=p.soc_max_kwh - p.soc_floor_kwh(soc0),
            one_way_efficiency=p.one_way_efficiency,
            wear_eur_per_kwh_each_way=p.wear_cost_eur_per_kwh_each_way,
            grid_charge_allowed=self.netzladen_erlaubt,
            max_feed_in_kw=self.max_feed_in_kw,
            env=env,
        )

    def cashflow_cost_eur(self, index: int, grid_kw: float) -> float:
        """Projected cost of one slot at the given net grid power under the
        asymmetric pricing: import paid at the import price, export credited
        at the export value (negative = revenue)."""
        import_kw = max(grid_kw, 0.0)
        export_kw = max(-grid_kw, 0.0)
        return (
            (
                self.import_prices[index] * import_kw
                - self.export_values[index] * export_kw
            )
            * self.slot_hours
            / 1000.0
        )

    def baseline_cost_eur(self, index: int) -> float:
        """Projected cost of one slot with the battery idle (the no-battery
        baseline the headline savings are measured against), under the same
        asymmetric pricing as the plan - the unregulated plant imports its
        residual load at the tariff and feeds its PV surplus in at the
        remuneration (mirroring EarningsRepository's baseline semantics)."""
        residual_kw = self.load_kw[index] - self.pv_kw[index]
        return self.cashflow_cost_eur(index, residual_kw)


@dataclass(frozen=True)
class PlanSlot:
    """One optimized 15-min slot: the decision plus its projected economics."""

    start: datetime
    battery_kw: float  # + charge / - discharge
    grid_kw: float  # + import / - export
    soc_kwh: float  # state of charge at slot END
    load_kw: float  # load forecast input used
    pv_kw: float  # PV forecast input used
    price_eur_mwh: float  # the day-ahead SPOT price (portal price curve)
    cost_eur: float  # projected slot cashflow with the plan (asymmetric pricing)
    baseline_cost_eur: float  # projected slot cashflow with the battery idle
    # Planned PV curtailment (kW discarded, 0 <= curtail_kw <= pv_kw). Non-zero
    # only when feeding in would COST money (negative EXPORT VALUE, e.g. a
    # Direktvermarktung plant at negative spot) - see solver.py.
    curtail_kw: float = 0.0
    # Priced battery degradation of this slot's throughput (EUR, >= 0) - the
    # wear the plan spends to earn its grid savings. NOT included in cost_eur
    # (which stays the projected grid cashflow): the honest slot economics are
    # baseline_cost_eur - cost_eur - wear_cost_eur. Persisted alongside the
    # other economics (schedule.wear_cost_eur); consumers (portal/admin "why"
    # view) read it in a later stage.
    wear_cost_eur: float = 0.0
    # ---- Fahrplan-Warum facts (design scout vp-fahrplan-why-design §5.1) ----
    # Stamped POST-HOC by the explain layer (voltpilot_optimization.explain)
    # after the plan is extracted - purely additive, never part of the decision.
    # All None when the explain layer is off/failed or on pre-feature plans;
    # the portal/api degrade to today's view then (null discipline). These
    # fields NEVER reach the MQTT schedule payload (publisher builds its
    # payload field-by-field) - the flow is optimizer -> schedule table -> api.
    slot_role: str | None = None  # §6 vocabulary (warten, pv_speichern, ...)
    slot_flags: tuple[str, ...] | None = None  # binding codes (soc_max, ...)
    stored_value_ct_kwh: float | None = None  # lambda: value of a stored kWh
    grid_value_ct_kwh: float | None = None  # pi: energy value at the grid point
    peak_pressure_eur_kw: float | None = None  # mu: Leistungspreis allocation
    # ---- Erklaerbarkeit Stufe 1: the KNAPPHEIT of a resting decision --------
    # (Konzept vp-warum-erklaerbar-e2 §4.2 C.) The best action this RESTING
    # slot rejected and its disadvantage in ct/kWh (<= 0), so a surface can
    # say WHY it rests instead of filling the role's several possible drivers
    # with plausibility - and can call an exact tie a tie. Both None on active
    # slots (their marginal benefit is 0 at the optimum) and whenever the
    # explain layer is off. Vocabulary: voltpilot_optimization.explain
    # NEXT_BEST_*.
    why_next_best: str | None = None
    why_next_best_margin_ct: float | None = None
    # ---- Price-aware in-slot trim (2026-07-30) --------------------------------
    # True = grid-charging in THIS slot is uneconomic (the slot's import price
    # exceeds the marginal value of one more stored kWh), so the edge must clamp
    # commanded CHARGE to the MEASURED surplus max(pv - load, 0) instead of
    # covering a forecast shortfall from the grid. Derived from the same
    # persisted lambda the why-fields carry - see
    # :mod:`voltpilot_optimization.slot_trim` for the rule and why a plain price
    # threshold was rejected. UNLIKE the why-fields this one DOES reach the MQTT
    # payload (as the optional per-slot contract field
    # ``charge_from_surplus_only``): it is a DUTY of the executor, not
    # presentation. None/False = no restriction = pre-feature behavior.
    charge_from_surplus_only: bool | None = None
    # ---- In-slot load following (2026-07-30) ----------------------------------
    # True = covering the house from the battery in THIS slot is economic (the
    # slot's import price exceeds lambda/eta + wear), so the edge may RAISE the
    # commanded discharge to the MEASURED deficit max(load - pv, 0) instead of
    # executing this slot's forecast-derived watt value rigidly and letting the
    # difference be bought at the full import price. The DISCHARGE-side mirror of
    # charge_from_surplus_only, from the same persisted lambda - see
    # :mod:`voltpilot_optimization.slot_trim`. Like its twin it DOES reach the
    # MQTT payload (as the optional per-slot ``cover_load_from_battery``): it is
    # an executor duty, not presentation. None/False = pre-feature behavior.
    cover_load_from_battery: bool | None = None
    # ---- In-slot surplus absorption (2026-08-02) ------------------------------
    # True = storing one more kWh beats selling it in THIS slot (eta*lambda -
    # wear above the slot's export value), so the edge may RAISE the commanded
    # CHARGE to the MEASURED surplus max(pv - load, 0) instead of leaving an
    # unforecast surplus to be exported - at a negative price, paid away. The
    # charge-side counterpart that RAISES, completing the pair with
    # charge_from_surplus_only (which only ever LOWERS); same persisted lambda,
    # see :mod:`voltpilot_optimization.slot_trim`. Like its two siblings it DOES
    # reach the MQTT payload (as the optional per-slot
    # ``charge_surplus_to_battery``): an executor duty, not presentation.
    # None/False = pre-feature behavior.
    charge_surplus_to_battery: bool | None = None

    @property
    def pv_limit_kw(self) -> float | None:
        """The inverter PV active-power cap implementing the curtailment
        (pv_kw - curtail_kw, never negative), or None when nothing is
        curtailed - the published schedule omits the field then."""
        if self.curtail_kw <= 0.0:
            return None
        return max(self.pv_kw - self.curtail_kw, 0.0)


@dataclass(frozen=True)
class SchedulePlan:
    """A full optimizer run for one site: the persisted + published artifact."""

    plan_id: UUID
    tenant_id: UUID
    site_id: UUID
    device_id: UUID | None
    generated_at: datetime
    battery: BatteryParams
    slots: list[PlanSlot] = field(default_factory=list)
    slot_minutes: int = SLOT_MINUTES
    # Mirrors site.netzladen_erlaubt at plan time; published as the OPTIONAL
    # grid_charge_allowed contract field (P5) so the EDGE enforces the EEG
    # solar-only-charge rule against MEASURED pv/load. None = omit the field
    # (legacy payload shape, edge behaves exactly as before).
    grid_charge_allowed: bool | None = None
    # The terminal energy value the run's objective credited per stored kWh at
    # the horizon end (P3; :meth:`OptimizationInput.effective_terminal_value_eur_per_kwh`).
    # Only the solver knows the derived value, so it is stamped here and
    # persisted per run (schedule.terminal_value_eur_per_kwh) - the portal
    # shows the banked value ``V_end * (soc_end - soc_start)`` as its own line
    # on bank days (FK2), where savings_eur alone would look broken. None =
    # unknown (pre-FK2 plans); the display then degrades gracefully.
    terminal_value_eur_per_kwh: float | None = None
    # PS-1: the solved peak variable = the run's planned billing-period peak
    # target (max of the horizon's planned import and peak_so_far, kW).
    # Published as the OPTIONAL grid_import_limit_kw contract field (the edge
    # peak-guard's target, PS-3 sibling task) and persisted per run
    # (schedule.peak_target_kw) for the reporting increment. None = the peak
    # module is off (site.leistungspreis_eur_kw NULL) - both consumers then
    # omit/NULL the field, never a fabricated number.
    peak_target_kw: float | None = None
    # FK1 mirrored to the EDGE (2026-08-06): the site's static feed-in limit at
    # the grid connection point (``site.max_feed_in_kw``), published as the
    # OPTIONAL ``grid_export_limit_kw`` contract field. The solver already
    # applies it as a hard EXPORT cap, but a 15-min plan cannot HOLD a
    # connection-point limit - it is shared with the house, so unplugging a
    # wallbox raises the feed-in within the slot. The edge therefore regulates it
    # in real time against the measured connection point
    # (``guards.ExportLimiter``). None = no limit configured; the field is
    # omitted and the edge behaves exactly as before.
    max_feed_in_kw: float | None = None
    # Fahrplan-Warum run-level fact (repeated per slot row in persistence, the
    # terminal_value pattern): True = this plan is the advisory §14a-fallback
    # build (the grid-limit constraint was dropped as infeasible - the edge
    # guards + the grid operator enforce it physically). Stamped by the
    # explain layer together with the per-slot why-fields; None = explain
    # off/failed or a pre-feature plan.
    fallback_14a: bool | None = None
    # ---- Erklaerbarkeit Stufe 1: WHERE the stored-energy value comes from ---
    # (Konzept vp-warum-erklaerbar-e2 §4.2 A/B, run-level facts repeated per
    # slot row in persistence - the terminal_value pattern.) The anchor branch
    # (domain ANCHOR_*) and the horizon's free-PV refill share of the usable
    # band in percent. Together they are the sentence the 17.08. customer
    # needed and nobody could say: "der Speicher hebt die Ladung auf, weil
    # morgen kaum Sonne gemeldet ist". None = explain off / pre-feature plan /
    # not evaluable - the surfaces then stay observational.
    why_terminal_anchor: str | None = None
    why_refill_free_pct: float | None = None
    # PV nowcast anchor (Morgenprognose 2026-08-24), a RUN-level fact repeated
    # per slot row in persistence like terminal_value_eur_per_kwh: the
    # measured-over-predicted ratio the run corrected its near-horizon PV
    # forecast by (:mod:`voltpilot_optimization.nowcast`). Pure pass-through of
    # an INPUT fact - never a solved value - so the admin optimizer readout can
    # name the correction next to the active model that needed it. None = no
    # anchor established (too little evidence / kill switch off / pre-feature
    # plan); the readout then says nothing rather than "1,0".
    pv_anchor_ratio: float | None = None

    @property
    def cost_eur(self) -> float:
        return sum(s.cost_eur for s in self.slots)

    @property
    def baseline_cost_eur(self) -> float:
        return sum(s.baseline_cost_eur for s in self.slots)

    @property
    def wear_cost_eur(self) -> float:
        """Priced battery degradation the plan spends over the horizon."""
        return sum(s.wear_cost_eur for s in self.slots)

    @property
    def savings_eur(self) -> float:
        """Projected GRID savings vs. the no-battery baseline over the horizon
        (gross of battery wear - subtract :attr:`wear_cost_eur` for the honest
        net figure; the persisted per-slot columns carry both). Since P3
        (terminal energy value) this may include realizing energy the battery
        already held at the plan start - the realized-earnings engine, not the
        planned figure, remains the honest money number."""
        return self.baseline_cost_eur - self.cost_eur

    def soc_pct(self, slot: PlanSlot) -> float:
        return 100.0 * slot.soc_kwh / self.battery.capacity_kwh

    def __len__(self) -> int:
        return len(self.slots)


def floor_to_slot(dt: datetime, slot_minutes: int = SLOT_MINUTES) -> datetime:
    """Floor ``dt`` down to the nearest slot boundary (UTC-safe)."""
    dt = ensure_utc(dt)
    discard = timedelta(
        minutes=dt.minute % slot_minutes,
        seconds=dt.second,
        microseconds=dt.microsecond,
    )
    return dt - discard


def horizon_slot_starts(
    now: datetime, slots: int, slot_minutes: int = SLOT_MINUTES
) -> list[datetime]:
    """The rolling-horizon slot grid: the first slot is the one IN PROGRESS at
    ``now`` (floored to the slot boundary), so the published plan always has a
    slot covering ``now``. The edge activates a slot only once ``now >= start``
    (plan.go ``ActiveSetpoint``); a grid starting at the NEXT boundary left it
    with no active slot - self-consumption fallback instead of the optimizer's
    dispatch - from every publish until the boundary (B1). Prices and forecasts
    cover the in-progress slot and the live SoC is valid for its remainder."""
    first = floor_to_slot(now, slot_minutes)
    return [first + i * timedelta(minutes=slot_minutes) for i in range(slots)]


def ensure_utc(dt: datetime) -> datetime:
    """Return ``dt`` as timezone-aware UTC (naive datetimes are assumed UTC,
    the platform's storage/transport convention)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

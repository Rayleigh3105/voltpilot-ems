"""Per-slot asymmetric import/export pricing (P1, the Stage-2 core).

Turns the day-ahead SPOT series into the two price series the market-revenue
objective consumes (:mod:`voltpilot_optimization.solver`):

- **import_price_t** - what one imported kWh really costs the site, per its
  supply tariff (``site.tarif_art``/``tarif_param_ct_kwh`` plus the structured
  ``site_supply_price`` sheet, report vp-nacht-bezug-e7 §3.1): ``fest`` = the
  flat all-in retail price (a maintained sheet is ignored - nothing is
  double-counted); ``dynamisch``/``ohne`` with a maintained sheet =
  ``(spot + Σ Komponenten netto) × (1 + USt)``; ``dynamisch`` without a sheet
  = the legacy spot + Aufschlag; ``ohne``/NULL-Aufschlag without a sheet =
  bare spot (legacy), optionally replaced by the researched default component
  set behind the OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag. See
  :func:`import_prices` for the exact precedence.
- **export_value_t** - what one exported kWh really earns, per the plant's
  remuneration (``site.plant_kind``): ``direktvermarktung`` = spot + the
  dynamic Marktprämie (``GREATEST(anzulegender_wert - monatsmarktwert, 0)``,
  suspended in negative-price slots - byte-for-byte the EarningsRepository
  rule); ``eigenverbrauch`` = the feste EEG-Einspeisevergütung derived from
  the PV asset's MaStR commissioning date + kWp (the schedule in
  :mod:`voltpilot_optimization.config`); anything unknown/unconfigured = spot.

**EEG remuneration enters the objective only in EEG mode (netzladen_erlaubt =
False), deliberately.** Both EEG revenues (feste Vergütung, Marktprämie) are
subject to the Ausschließlichkeitsprinzip: energy charged from the grid may
never be remunerated as EEG energy. In EEG mode the solver's solar-only-charge
constraint (``charge <= pv - curtail``, PV-bus Bilanzierung since FK3 - via
the grid balance a charging slot's import never exceeds the load, so grid
energy can never enter the battery) makes the battery content provably solar,
so crediting the premium/rate on ALL export is correct. In merchant mode (grid charging allowed) the battery mixes
grid energy, and crediting EEG revenue on its export would let the optimizer
"farm" the premium with grid-charged energy - a money pump the law forbids
(and a real objective exploit whenever the premium clears wear + round-trip
losses). A merchant site therefore exports at bare spot; a site configured
with both grid charging AND an EEG remuneration is flagged in the logs as an
inconsistency to fix in master data.

Every unknown degrades to bare spot (today's symmetric model), never to an
invented price - so the worst rollout case is "no regression", and the log
line names what was missing (target report §4 Stage 1 rollout rule).

Units: spot is EUR/MWh (the native day-ahead unit); tariff/remuneration
parameters are ct/kWh; 1 ct/kWh = 10 EUR/MWh.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from voltpilot_optimization.config import (
    FEST_GRID_CHARGE_HURDLE_CT_PER_KWH,
    EegRateBand,
    SOLARSPITZENGESETZ_CUTOFF,
    default_supply_components_enabled,
    eeg_rate_schedule,
)

logger = logging.getLogger("voltpilot.optimization.pricing")

BERLIN = ZoneInfo("Europe/Berlin")

CT_PER_KWH_TO_EUR_PER_MWH = 10.0

PLANT_KIND_DIREKTVERMARKTUNG = "direktvermarktung"
PLANT_KIND_EIGENVERBRAUCH = "eigenverbrauch"

TARIF_DYNAMISCH = "dynamisch"
TARIF_FEST = "fest"
TARIF_OHNE = "ohne"


@dataclass(frozen=True)
class SupplyPriceComponents:
    """One site's structured supply-price sheet (the ``site_supply_price``
    row, report vp-nacht-bezug-e7 §3.1): the volumetric Bezugspreis components
    the operator reads off the grid operator's Preisblatt and the electricity
    bill, all ct/kWh NETTO, all nullable (NULL = unknown, contributes 0 to the
    sum). ``ust_pct`` is the multiplicative USt on EVERYTHING incl. the spot
    share (household 19, C&I with Vorsteuer-Abzug 0). ``komponenten_stand`` is
    the "Preisblatt gültig ab" date (display/maintenance metadata - never
    enters the price math).
    """

    netzentgelt_arbeitspreis_ct: float | None = None
    stromsteuer_ct: float | None = None
    konzessionsabgabe_ct: float | None = None
    umlagen_ct: float | None = None
    vertriebsaufschlag_ct: float | None = None
    ust_pct: float = 19.0
    komponenten_stand: date | None = None

    def components_ct_kwh(self) -> float:
        """Σ of the maintained (non-NULL) volumetric components, ct netto."""
        return sum(
            c
            for c in (
                self.netzentgelt_arbeitspreis_ct,
                self.stromsteuer_ct,
                self.konzessionsabgabe_ct,
                self.umlagen_ct,
                self.vertriebsaufschlag_ct,
            )
            if c is not None
        )

    def has_components(self) -> bool:
        """Whether at least one component is maintained. Load-bearing gate: a
        degenerate all-NULL row composes nothing (it would tax bare spot with
        USt and nothing else), so it behaves exactly like NO row - only an
        explicitly maintained sheet activates the structured composition."""
        return any(
            c is not None
            for c in (
                self.netzentgelt_arbeitspreis_ct,
                self.stromsteuer_ct,
                self.konzessionsabgabe_ct,
                self.umlagen_ct,
                self.vertriebsaufschlag_ct,
            )
        )


#: The researched household default set (report vp-nacht-bezug-e7 Teil 2,
#: Stand 2026: Netzentgelt-AP ~7,6 / Stromsteuer 2,05 / Konzession 1,59 (Stadt
#: <= 100k EW) / Umlagen KWKG+Offshore+§19 2,946 / Vertrieb 1,5 ct netto
#: = 15,686 ct netto + 19 % USt). Applied ONLY behind the
#: OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag (default ON since captain decision
#: 2026-07-29; env `false` is the opt-out Notbremse) and only where the site
#: has neither a maintained supply-price row
#: nor an operator Sammelaufschlag; bare spot as a household Bezugspreis is
#: always MORE wrong than this set (§3.1).
DEFAULT_SUPPLY_COMPONENTS = SupplyPriceComponents(
    netzentgelt_arbeitspreis_ct=7.6,
    stromsteuer_ct=2.05,
    konzessionsabgabe_ct=1.59,
    umlagen_ct=2.946,
    vertriebsaufschlag_ct=1.5,
    ust_pct=19.0,
)


@dataclass(frozen=True)
class SiteTariff:
    """The pricing-relevant site master data (all customer-maintained; every
    field's absence degrades that side of the pricing to bare spot).

    ``commissioned_on``/``pv_capacity_kwp`` come from the site's PV asset
    (MaStR link or manual entry) and drive the feste-Vergütung lookup for
    ``eigenverbrauch`` plants. ``supply_price`` is the site's structured
    supply-price sheet (``site_supply_price`` row; ``None`` = no row = the
    legacy import model, byte-identically). The defaults reproduce today's
    symmetric-spot model exactly, so an un-wired caller can never invent a
    price.
    """

    plant_kind: str = PLANT_KIND_EIGENVERBRAUCH
    tarif_art: str = TARIF_OHNE
    tarif_param_ct_kwh: float | None = None
    anzulegender_wert_ct_kwh: float | None = None
    commissioned_on: date | None = None
    pv_capacity_kwp: float | None = None
    supply_price: SupplyPriceComponents | None = None


def structured_import_prices(
    supply: SupplyPriceComponents, spot_eur_mwh: list[float]
) -> list[float]:
    """The structured Bezugspreis composition (report §3.1):
    ``(spot + Σ Komponenten netto) × (1 + USt)`` per slot, EUR/MWh. The USt
    factor deliberately covers the SPOT share too (at 15 ct spot that alone is
    2,85 ct the legacy model ignored)."""
    components_eur_mwh = supply.components_ct_kwh() * CT_PER_KWH_TO_EUR_PER_MWH
    ust_factor = 1.0 + supply.ust_pct / 100.0
    return [(p + components_eur_mwh) * ust_factor for p in spot_eur_mwh]


def import_prices(
    tariff: SiteTariff, spot_eur_mwh: list[float], site_id=None
) -> list[float]:
    """The per-slot cost of one imported kWh under the site's supply tariff
    (EUR/MWh).

    Precedence per ``tarif_art`` (report vp-nacht-bezug-e7 §3.1):

    - ``fest``: the flat all-in retail price, UNCHANGED - a maintained
      supply-price sheet is IGNORED with a warning (fest wins, nothing is ever
      double-counted).
    - ``dynamisch``: a maintained sheet (>= 1 component) replaces the
      Sammelaufschlag with the structured composition; else the legacy
      ``spot + tarif_param`` Aufschlag; else (NULL Aufschlag) the researched
      default set behind the OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag; else
      bare spot with a LOUD warning (the S1 fix - this silent +0 was the
      night-discharge symptom).
    - ``ohne``: semantically "dynamisch with components" - a maintained sheet
      composes, the flag-gated default set stands in, otherwise bare spot
      (today's spot-settled special case, unchanged).

    Rollout invariance: without a maintained ``site_supply_price`` row and with
    the flag off, every branch is byte-identical to the legacy model.
    """
    ctx = {"site_id": str(site_id)} if site_id is not None else {}
    supply = tariff.supply_price
    maintained = supply is not None and supply.has_components()
    if tariff.tarif_art == TARIF_FEST:
        if maintained:
            logger.warning(
                "pricing.fest_ignores_supply_components",
                extra={
                    "context": {
                        **ctx,
                        "reason": (
                            "tarif_art='fest' with a maintained "
                            "site_supply_price sheet - fest is the all-in "
                            "price and wins, the components are ignored so "
                            "nothing is double-counted"
                        ),
                    }
                },
            )
        if tariff.tarif_param_ct_kwh is None:
            logger.warning(
                "pricing.fest_tariff_without_price",
                extra={
                    "context": {
                        **ctx,
                        "reason": (
                            "tarif_art='fest' but tarif_param_ct_kwh is NULL - "
                            "import degrades to bare spot"
                        ),
                    }
                },
            )
            return list(spot_eur_mwh)
        flat = tariff.tarif_param_ct_kwh * CT_PER_KWH_TO_EUR_PER_MWH
        return [flat] * len(spot_eur_mwh)
    if tariff.tarif_art in (TARIF_DYNAMISCH, TARIF_OHNE):
        if maintained:
            if (
                tariff.tarif_art == TARIF_DYNAMISCH
                and tariff.tarif_param_ct_kwh is not None
            ):
                # Documented §3.1 semantics, not an error: the structured
                # sheet REPLACES the one-pot Sammelaufschlag (its margin now
                # lives in vertriebsaufschlag_ct).
                logger.info(
                    "pricing.supply_components_replace_aufschlag",
                    extra={
                        "context": {
                            **ctx,
                            "reason": (
                                "dynamisch with both a Sammelaufschlag and a "
                                "maintained site_supply_price sheet - the "
                                "structured sheet wins, tarif_param_ct_kwh "
                                "is ignored"
                            ),
                        }
                    },
                )
            return structured_import_prices(supply, spot_eur_mwh)
        if (
            tariff.tarif_art == TARIF_DYNAMISCH
            and tariff.tarif_param_ct_kwh is not None
        ):
            aufschlag = tariff.tarif_param_ct_kwh * CT_PER_KWH_TO_EUR_PER_MWH
            return [p + aufschlag for p in spot_eur_mwh]
        if default_supply_components_enabled():
            logger.warning(
                "pricing.default_supply_components_applied",
                extra={
                    "context": {
                        **ctx,
                        "components_ct_kwh": round(
                            DEFAULT_SUPPLY_COMPONENTS.components_ct_kwh(), 3
                        ),
                        "reason": (
                            "no maintained supply-price sheet and no "
                            "Aufschlag - import priced with the researched "
                            "default components (Vorschlagswerte, bitte "
                            "Preisblatt prüfen)"
                        ),
                    }
                },
            )
            return structured_import_prices(DEFAULT_SUPPLY_COMPONENTS, spot_eur_mwh)
        if tariff.tarif_art == TARIF_DYNAMISCH:
            # S1 fix: this silent NULL -> +0 was the night-discharge symptom
            # (report §1.5) - same loudness as the fest+NULL warning above.
            logger.warning(
                "pricing.dynamisch_tariff_without_aufschlag",
                extra={
                    "context": {
                        **ctx,
                        "reason": (
                            "tarif_art='dynamisch' but tarif_param_ct_kwh is "
                            "NULL and no site_supply_price sheet is "
                            "maintained - import degrades to bare spot, "
                            "which under-prices the real Bezugspreis by "
                            "~15-19 ct/kWh (Netzentgelte/Steuern/Umlagen)"
                        ),
                    }
                },
            )
        return list(spot_eur_mwh)
    # Anything unknown: bare spot.
    return list(spot_eur_mwh)


def export_values(
    tariff: SiteTariff,
    netzladen_erlaubt: bool,
    spot_eur_mwh: list[float],
    slot_starts: list[datetime],
    market_value_ct_by_month: dict[date, float],
    schedule: tuple[EegRateBand, ...] | None = None,
    site_id=None,
) -> list[float]:
    """The per-slot value of one exported kWh (EUR/MWh).

    ``market_value_ct_by_month`` maps the first day of a German (Europe/Berlin)
    calendar month to that month's Monatsmarktwert Solar in ct/kWh (the
    ``monthly_market_value`` table); an absent month means no premium for its
    slots, mirroring EarningsRepository. ``schedule`` overrides the feste-
    Vergütung table (tests); the default is env-resolved per call.
    """
    ctx = {"site_id": str(site_id)} if site_id is not None else {}
    if not netzladen_erlaubt:
        if tariff.plant_kind == PLANT_KIND_DIREKTVERMARKTUNG:
            return _direktvermarktung_values(
                tariff, spot_eur_mwh, slot_starts, market_value_ct_by_month, ctx
            )
        if tariff.plant_kind == PLANT_KIND_EIGENVERBRAUCH:
            return _feste_verguetung_values(
                tariff, spot_eur_mwh, slot_starts, schedule, ctx
            )
        return list(spot_eur_mwh)
    # Merchant mode: EEG remuneration never enters the objective (see module
    # docstring - the Ausschließlichkeitsprinzip guard against premium farming
    # with grid-charged energy). Flag the inconsistent configuration.
    if tariff.plant_kind == PLANT_KIND_DIREKTVERMARKTUNG and (
        tariff.anzulegender_wert_ct_kwh is not None
    ):
        logger.warning(
            "pricing.eeg_remuneration_ignored_in_merchant_mode",
            extra={
                "context": {
                    **ctx,
                    "reason": (
                        "netzladen_erlaubt=true with an anzulegender Wert "
                        "configured - a grid-charging plant cannot claim the "
                        "Marktprämie (Ausschliesslichkeitsprinzip); export is "
                        "priced at bare spot"
                    ),
                }
            },
        )
    if tariff.plant_kind == PLANT_KIND_EIGENVERBRAUCH and (
        tariff.commissioned_on is not None
    ):
        # B5: the same inconsistency on an EEG-remunerated eigenverbrauch
        # plant was previously silent. Warning only - whether physical PV
        # export keeps its feste Vergütung in merchant mode is a pending
        # captain decision; pricing stays bare spot either way.
        logger.warning(
            "pricing.eeg_remuneration_ignored_in_merchant_mode",
            extra={
                "context": {
                    **ctx,
                    "reason": (
                        "netzladen_erlaubt=true on an eigenverbrauch plant "
                        "with a commissioning date - a grid-charging plant "
                        "cannot claim the feste Einspeisevergütung "
                        "(Ausschliesslichkeitsprinzip); export is priced at "
                        "bare spot"
                    ),
                }
            },
        )
    return list(spot_eur_mwh)


def _direktvermarktung_values(
    tariff: SiteTariff,
    spot: list[float],
    slot_starts: list[datetime],
    market_value_ct_by_month: dict[date, float],
    ctx: dict,
) -> list[float]:
    """spot + Marktprämie in non-negative-price slots (the EarningsRepository
    rule: premium = GREATEST(anzulegender_wert - monatsmarktwert, 0), only when
    the month's Monatsmarktwert is known, suspended when spot < 0 - the
    simplified §51 rule)."""
    aw = tariff.anzulegender_wert_ct_kwh
    if aw is None:
        return list(spot)
    values = []
    missing_months: set[date] = set()
    for price, start in zip(spot, slot_starts):
        month = berlin_month(start)
        mv = market_value_ct_by_month.get(month)
        if mv is None:
            missing_months.add(month)
            values.append(price)
            continue
        premium_eur_mwh = max(aw - mv, 0.0) * CT_PER_KWH_TO_EUR_PER_MWH
        values.append(price + premium_eur_mwh if price >= 0 else price)
    if missing_months:
        logger.warning(
            "pricing.market_value_missing",
            extra={
                "context": {
                    **ctx,
                    "months": sorted(m.isoformat() for m in missing_months),
                    "reason": (
                        "no Monatsmarktwert Solar stored for these months - "
                        "their slots earn no premium in the plan"
                    ),
                }
            },
        )
    return values


def _feste_verguetung_values(
    tariff: SiteTariff,
    spot: list[float],
    slot_starts: list[datetime],
    schedule: tuple[EegRateBand, ...] | None,
    ctx: dict,
) -> list[float]:
    """The feste Einspeisevergütung as a flat export value; spot fallback when
    the commissioning date is unknown or the 20-year remuneration has expired.
    Post-Solarspitzengesetz plants earn 0 in negative-price slots (§51a) -
    never a negative export value (a feste-Vergütung plant is not settled at
    spot, so feeding in never COSTS it money)."""
    if tariff.commissioned_on is None:
        logger.info(
            "pricing.no_commissioning_date",
            extra={
                "context": {
                    **ctx,
                    "reason": (
                        "eigenverbrauch plant without asset.commissioned_on "
                        "(no MaStR link) - export degrades to bare spot"
                    ),
                }
            },
        )
        return list(spot)
    # B10: expiry is evaluated PER SLOT (like the §51a check below), so a
    # horizon crossing Dec 31 of the expiry year prices the pre-midnight
    # slots at the rate and the post-midnight slots at spot.
    expired = [
        _remuneration_expired(tariff.commissioned_on, start)
        for start in slot_starts
    ]
    if any(expired):
        logger.info(
            "pricing.feste_verguetung_expired",
            extra={
                "context": {
                    **ctx,
                    "commissioned_on": tariff.commissioned_on.isoformat(),
                    "reason": (
                        "the 20-year EEG remuneration has ended - export "
                        "degrades to bare spot (Marktwert-adjacent)"
                        if all(expired)
                        else "the 20-year EEG remuneration ends within this "
                        "horizon - export degrades to bare spot from the "
                        "expiry boundary (Marktwert-adjacent)"
                    ),
                }
            },
        )
        if all(expired):
            return list(spot)
    rate_eur_mwh = (
        feste_verguetung_ct_per_kwh(
            tariff.commissioned_on, tariff.pv_capacity_kwp, schedule
        )
        * CT_PER_KWH_TO_EUR_PER_MWH
    )
    suspend_negative = tariff.commissioned_on >= SOLARSPITZENGESETZ_CUTOFF
    return [
        price
        if is_expired
        else (0.0 if suspend_negative and price < 0 else rate_eur_mwh)
        for price, is_expired in zip(spot, expired)
    ]


def feste_verguetung_ct_per_kwh(
    commissioned_on: date,
    pv_capacity_kwp: float | None,
    schedule: tuple[EegRateBand, ...] | None = None,
) -> float:
    """The blended (capacity-weighted, tranche-wise) feste Teileinspeisung rate
    for a plant of the given size and commissioning date, ct/kWh.

    Unknown capacity assumes the <= 10 kWp band (the common residential case -
    and the highest rate, so an unknown size never under-values export into a
    curtailment decision). Commissioning dates before the first schedule band
    use that first band (a documented under-approximation for pre-2012 plants,
    whose sign/magnitude - "far above spot's negative tail" - is what matters).
    """
    bands = eeg_rate_schedule() if schedule is None else schedule
    band = bands[0]
    for candidate in bands:
        if candidate.valid_from <= commissioned_on:
            band = candidate
        else:
            break
    if pv_capacity_kwp is None or pv_capacity_kwp <= 10.0:
        return band.le10_ct
    kwp = pv_capacity_kwp
    tranche10 = min(kwp, 10.0)
    tranche40 = min(max(kwp - 10.0, 0.0), 30.0)
    tranche_rest = max(kwp - 40.0, 0.0)
    return (
        tranche10 * band.le10_ct
        + tranche40 * band.le40_ct
        + tranche_rest * band.le100_ct
    ) / kwp


def _remuneration_expired(commissioned_on: date, at: datetime) -> bool:
    """EEG remuneration runs for 20 years plus the commissioning year: it ends
    on Dec 31 of the 20th year after the commissioning year."""
    return at.astimezone(BERLIN).year > commissioned_on.year + 20


def berlin_month(at: datetime) -> date:
    """First day of the German calendar month containing ``at`` (the
    ``monthly_market_value.month`` key, mirroring MARKET_VALUE_JOIN)."""
    local = at.astimezone(BERLIN)
    return date(local.year, local.month, 1)


def needs_market_values(tariff: SiteTariff, netzladen_erlaubt: bool) -> bool:
    """Whether pricing this site requires Monatsmarktwert rows (so the input
    gatherer only queries the table when the premium can actually apply)."""
    return (
        not netzladen_erlaubt
        and tariff.plant_kind == PLANT_KIND_DIREKTVERMARKTUNG
        and tariff.anzulegender_wert_ct_kwh is not None
    )


def grid_charge_hurdle_ct_kwh(tariff: SiteTariff) -> float:
    """The ehrliche Marge a grid-sourced charge must earn at this site (ct per
    AC kWh, Captain-Entscheid E6 A): :data:`FEST_GRID_CHARGE_HURDLE_CT_PER_KWH`
    on a fixed tariff, 0 everywhere else (spot-priced import keeps today's
    model byte-identically). Keyed on ``tarif_art`` alone - a ``fest`` site
    without a maintained price still IS a flat-tariff site, whatever its
    import degrades to."""
    if tariff.tarif_art == TARIF_FEST:
        return FEST_GRID_CHARGE_HURDLE_CT_PER_KWH
    return 0.0

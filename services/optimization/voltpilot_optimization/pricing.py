"""Per-slot asymmetric import/export pricing (P1, the Stage-2 core).

Turns the day-ahead SPOT series into the two price series the market-revenue
objective consumes (:mod:`voltpilot_optimization.solver`):

- **import_price_t** - what one imported kWh really costs the site, per its
  supply tariff (``site.tarif_art``/``tarif_param_ct_kwh``, the customer-
  maintained model the api's ``EarningsRepository`` already values reporting
  with): ``dynamisch`` = spot + Aufschlag, ``fest`` = the flat retail price,
  ``ohne`` = bare spot (spot-settled / pure-market load - avoiding an import
  then has no retail premium, target report §2.3).
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
never be remunerated as EEG energy. In EEG mode the solver's constraint pair
makes the battery content provably solar, so crediting the premium/rate on ALL
export is correct. In merchant mode (grid charging allowed) the battery mixes
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
    EegRateBand,
    SOLARSPITZENGESETZ_CUTOFF,
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
class SiteTariff:
    """The pricing-relevant site master data (all customer-maintained; every
    field's absence degrades that side of the pricing to bare spot).

    ``commissioned_on``/``pv_capacity_kwp`` come from the site's PV asset
    (MaStR link or manual entry) and drive the feste-Vergütung lookup for
    ``eigenverbrauch`` plants. The defaults reproduce today's symmetric-spot
    model exactly, so an un-wired caller can never invent a price.
    """

    plant_kind: str = PLANT_KIND_EIGENVERBRAUCH
    tarif_art: str = TARIF_OHNE
    tarif_param_ct_kwh: float | None = None
    anzulegender_wert_ct_kwh: float | None = None
    commissioned_on: date | None = None
    pv_capacity_kwp: float | None = None


def import_prices(tariff: SiteTariff, spot_eur_mwh: list[float]) -> list[float]:
    """The per-slot cost of one imported kWh under the site's supply tariff
    (EUR/MWh). See the module docstring for the per-``tarif_art`` rule."""
    if tariff.tarif_art == TARIF_DYNAMISCH:
        aufschlag = (tariff.tarif_param_ct_kwh or 0.0) * CT_PER_KWH_TO_EUR_PER_MWH
        return [p + aufschlag for p in spot_eur_mwh]
    if tariff.tarif_art == TARIF_FEST:
        if tariff.tarif_param_ct_kwh is None:
            logger.warning(
                "pricing.fest_tariff_without_price",
                extra={
                    "context": {
                        "reason": (
                            "tarif_art='fest' but tarif_param_ct_kwh is NULL - "
                            "import degrades to bare spot"
                        )
                    }
                },
            )
            return list(spot_eur_mwh)
        flat = tariff.tarif_param_ct_kwh * CT_PER_KWH_TO_EUR_PER_MWH
        return [flat] * len(spot_eur_mwh)
    # 'ohne' (spot-settled) and anything unknown: bare spot.
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
    if _remuneration_expired(tariff.commissioned_on, slot_starts[0]):
        logger.info(
            "pricing.feste_verguetung_expired",
            extra={
                "context": {
                    **ctx,
                    "commissioned_on": tariff.commissioned_on.isoformat(),
                    "reason": (
                        "the 20-year EEG remuneration has ended - export "
                        "degrades to bare spot (Marktwert-adjacent)"
                    ),
                }
            },
        )
        return list(spot)
    rate_eur_mwh = (
        feste_verguetung_ct_per_kwh(
            tariff.commissioned_on, tariff.pv_capacity_kwp, schedule
        )
        * CT_PER_KWH_TO_EUR_PER_MWH
    )
    if tariff.commissioned_on >= SOLARSPITZENGESETZ_CUTOFF:
        return [rate_eur_mwh if p >= 0 else 0.0 for p in spot]
    return [rate_eur_mwh] * len(spot)


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

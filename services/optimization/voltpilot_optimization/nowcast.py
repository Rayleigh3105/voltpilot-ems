"""PV nowcast anchor: the run's OWN recent error corrects its NEAR horizon.

Why this exists (Live-Fall Pilsting/Herzogau, 23.08.2026, scout report
``vp-negativpreis-herzogau-g3`` section 5.1). The 09:36 plan run had the 09:30
measurement in the database - the plant was producing 38,9 kW - and still
planned a 0,5 kW *discharge* for 09:30/09:45, because its PV forecast for those
slots sat BELOW the house load (~5-7 kW). During a negative-price window that
turned ~30 kW of production into a paid export instead of a battery charge. Two
independent glass walls between the plan and reality:

* **the model has one array per site.** ``forecast_collect.load_sites`` reads
  exactly ONE ``asset`` row of type ``pv`` per site and hands
  :class:`~voltpilot_forecast.domain.PlantSpec` a SINGLE ``azimuth_deg`` /
  ``tilt_deg`` (south/30 deg when the registry has none). Herzogau is Deye +
  Fronius West + Fronius **Ost**, and the east array carries the morning (83 %
  of production at 08:25 measured). A south curve is structurally low every
  morning on an east-heavy roof, and no amount of weather data fixes that.
* **nothing looks at what the plant is doing RIGHT NOW.** The optimizer
  consumes the stored forecast verbatim (``inputs._forecast_or_fallback``);
  live telemetry is read only for SoC / the section-14a envelope, and only as a
  *fallback* input when the stored run does not cover the horizon. So a
  too-cloudy morning outlook survives every 15-min replan untouched.

The correction here closes BOTH with one generic, master-data-free mechanism:
compare, over the last completed slots, what the ACTIVE model PREDICTED against
what the site MEASURED, and carry that ratio into the near horizon, decaying
back to the untouched forecast. An east-heavy roof shows a morning ratio > 1
and an afternoon ratio < 1 without anyone maintaining an azimuth; a systematically
too-cloudy outlook shows a ratio > 1 all day; genuinely worse weather than
forecast shows a ratio < 1 and the plan stops expecting a charge that is not
coming. It is the classic clear-sky-index (kt) persistence nowcast, with the
site's own active model in the place of the clear-sky reference.

Four properties make it safe to run on every plant:

1. **Ratio, never difference.** A ratio carries the sun's geometric ramp; a kW
   offset would still be sitting there at midnight.
2. **Evidence or nothing.** Below :data:`DEFAULT_MIN_SLOTS` usable slots there
   is no ratio and the forecast is passed through UNCHANGED - the house rule
   that what cannot be established is not claimed. A silent plant (no telemetry
   rows) yields no usable slot at all, so a dead device can never zero a plan.
3. **Bounded twice.** The ratio is clamped symmetrically (``1/max .. max``), and
   the anchored series may not exceed the plant's nameplate - a physics bound,
   not a tuning knob.
4. **It expires.** The factor decays linearly to 1.0 over
   :data:`DEFAULT_DECAY_SLOTS`, because beyond a couple of hours a bias and a
   passing cloud are indistinguishable and the weather model is the better
   witness. That is enough: the optimizer replans every 15 min, so the slot that
   is actually EXECUTED always sits in the first, fully-anchored slot.

Pure by construction (no DB, no clock, no I/O - the ``Tagesprotokoll`` /
``FleetPflege`` pattern): :mod:`voltpilot_optimization.inputs` does the two
narrow reads and hands plain lists over. Applied to the FINAL PV series before
:func:`voltpilot_optimization.fallback.night_floor_pv`, exactly like that other
defensive correction, so it covers whichever model is active today
(``pv-physical``) and tomorrow (a promoted ``pv-residual-xgb`` composes with it
rather than competing).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: A slot only carries evidence when at least one side claims meaningful sun.
#: Dawn/dusk slots where BOTH sides are near zero say nothing about the model's
#: bias and would otherwise let sensor noise mint a ratio.
DEFAULT_MIN_SLOT_KW = 0.5

#: Fewest usable slots before a ratio is established at all.
DEFAULT_MIN_SLOTS = 3

#: Symmetric clamp on the ratio (``1/max .. max``). Sized from what the two
#: error sources can physically compound to, not from one case: a due-east
#: array read by a due-south model is off by ~2-3x around 09:00 in August, and
#: a wrong cloud outlook by another ~2-3x - the Herzogau 23.08. morning measured
#: ~6x. Beyond ~5x a "bias" is a broken model or a broken measurement, and
#: refusing to follow it further is the conservative choice. The clamp is the
#: BELT; the hard physical bound is the plant's nameplate (see
#: :func:`apply_anchor`).
DEFAULT_MAX_RATIO = 5.0

#: Slots over which the factor decays linearly back to 1.0 (8 = 2 h).
DEFAULT_DECAY_SLOTS = 8

#: Reason slugs (log/diagnostic vocabulary, never customer copy).
REASON_ESTABLISHED = "established"
REASON_TOO_FEW_SLOTS = "too_few_slots"
REASON_NO_EVIDENCE = "no_evidence"


@dataclass(frozen=True)
class AnchorEvidence:
    """What the site's own recent slots say about the active model's PV bias.

    ``ratio`` is ``None`` whenever nothing could be established - the caller
    then passes the forecast through untouched. ``raw_ratio`` keeps the
    unclamped value for diagnostics (a raw 7,8 clamped to 3,0 is a very
    different story from a raw 1,1), and ``slots_used`` is the count the ratio
    actually rests on.
    """

    ratio: float | None
    raw_ratio: float | None
    slots_used: int
    measured_kwh: float
    predicted_kwh: float
    reason: str

    @property
    def established(self) -> bool:
        return self.ratio is not None


NO_EVIDENCE = AnchorEvidence(
    ratio=None,
    raw_ratio=None,
    slots_used=0,
    measured_kwh=0.0,
    predicted_kwh=0.0,
    reason=REASON_NO_EVIDENCE,
)


def anchor_evidence(
    measured_kw: list[float | None],
    predicted_kw: list[float | None],
    *,
    min_slots: int = DEFAULT_MIN_SLOTS,
    min_slot_kw: float = DEFAULT_MIN_SLOT_KW,
    max_ratio: float = DEFAULT_MAX_RATIO,
) -> AnchorEvidence:
    """The measured-over-predicted ratio of the recent, already-finished slots.

    Both lists are parallel and slot-aligned; ``None`` means "this slot has no
    value on that side" (no telemetry row / the model never issued a prediction
    for it) and drops the slot from the evidence entirely. That is what makes a
    silent plant produce NO anchor rather than a zeroed forecast.

    The ratio is the ENERGY ratio ``sum(measured) / sum(predicted)``, not the
    mean of per-slot ratios: with per-slot ratios a single slot the model put at
    0,01 kW would dominate every well-behaved slot around it. When the model
    predicted essentially nothing while the plant produced (the exact 23.08.
    failure), the raw ratio is infinite and the clamp turns it into
    ``max_ratio`` - bounded, and still the whole difference between planning a
    discharge and planning a charge.
    """
    if min_slots < 1:
        raise ValueError("min_slots must be >= 1")
    if not (math.isfinite(max_ratio) and max_ratio > 1.0):
        raise ValueError("max_ratio must be finite and > 1")

    measured_sum = 0.0
    predicted_sum = 0.0
    used = 0
    for m, p in zip(measured_kw, predicted_kw):
        if m is None or p is None:
            continue
        if not (math.isfinite(m) and math.isfinite(p)) or m < 0.0 or p < 0.0:
            continue
        if max(m, p) < min_slot_kw:
            continue
        measured_sum += m
        predicted_sum += p
        used += 1

    if used < min_slots:
        return AnchorEvidence(
            ratio=None,
            raw_ratio=None,
            slots_used=used,
            measured_kwh=measured_sum,
            predicted_kwh=predicted_sum,
            reason=REASON_TOO_FEW_SLOTS if used else REASON_NO_EVIDENCE,
        )

    if predicted_sum <= 0.0:
        # The model saw no sun at all where the plant delivered: an infinite
        # raw ratio, reported honestly and clamped like any other.
        raw = math.inf if measured_sum > 0.0 else 1.0
    else:
        raw = measured_sum / predicted_sum

    ratio = min(max(raw, 1.0 / max_ratio), max_ratio)
    return AnchorEvidence(
        ratio=ratio,
        raw_ratio=raw,
        slots_used=used,
        measured_kwh=measured_sum,
        predicted_kwh=predicted_sum,
        reason=REASON_ESTABLISHED,
    )


def anchor_factors(
    slots: int, ratio: float, *, decay_slots: int = DEFAULT_DECAY_SLOTS
) -> list[float]:
    """Per-slot multiplier: ``ratio`` on the first slot, 1.0 from ``decay_slots``.

    The first slot is the one IN PROGRESS (the optimizer's horizon starts there,
    B1) and the evidence ends at most one slot before it, so it carries the full
    ratio. Linear decay - simple enough to reason about in a plan review, and it
    documents its own end ("after N slots the anchor is over").
    """
    if decay_slots < 1:
        raise ValueError("decay_slots must be >= 1")
    factors: list[float] = []
    for i in range(slots):
        weight = max(0.0, 1.0 - i / decay_slots)
        factors.append(1.0 + (ratio - 1.0) * weight)
    return factors


def apply_anchor(
    pv_kw: list[float],
    evidence: AnchorEvidence,
    *,
    decay_slots: int = DEFAULT_DECAY_SLOTS,
    capacity_kwp: float | None = None,
) -> tuple[list[float], list[float]]:
    """Scale the PV series by the decaying anchor; returns ``(series, factors)``.

    Without established evidence the series is returned UNCHANGED with all-1.0
    factors, so the caller never has to branch. A night slot is 0.0 and stays
    0.0 (a multiplier cannot fabricate sun); the night floor still runs after
    this as the final gate.

    ``capacity_kwp`` (the site's PV nameplate) caps the anchored value. A series
    that ALREADY exceeds the nameplate is left where it is - the anchor's job is
    to correct a bias, not to second-guess its input - so the cap is
    ``max(nameplate, unanchored value)``.
    """
    if not evidence.established:
        return list(pv_kw), [1.0] * len(pv_kw)

    factors = anchor_factors(len(pv_kw), evidence.ratio, decay_slots=decay_slots)
    out: list[float] = []
    for base, factor in zip(pv_kw, factors):
        scaled = max(0.0, base * factor)
        if capacity_kwp is not None and capacity_kwp > 0.0:
            scaled = min(scaled, max(capacity_kwp, base))
        out.append(scaled)
    return out, factors

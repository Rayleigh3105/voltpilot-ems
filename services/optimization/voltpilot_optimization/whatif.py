"""On-demand what-if re-optimize for ONE site (design vp-admin-optimizer-ui-design §4.3).

The admin surface's last piece: an operator moves a knob and gets a freshly
solved plan back to compare - WITHOUT touching the plant. Three properties
make that safe, and they are the whole design:

* **Ephemeral by construction.** This module imports neither
  :mod:`voltpilot_optimization.persistence` nor
  :mod:`voltpilot_optimization.publisher`; it only ever calls the pure
  ``gather_inputs`` -> ``optimize`` pair. Nothing is written to ``schedule``,
  nothing is published on MQTT, no plan is ever marked as in force. The
  15-minute tick loop (:mod:`voltpilot_optimization.engine`) runs in a
  DIFFERENT process and shares no state with it.
* **Two solves, one set of inputs.** A knob delta is only meaningful against
  the same prices/forecasts/SoC, so every run solves TWICE over ONE freshly
  gathered :class:`OptimizationInput`: ``baseline`` (the site's stored
  settings) and ``variant`` (with the overrides applied). Comparing the
  variant against the site's PERSISTED run would compare different horizons
  and different input vintages - an honest delta needs the shared basis.
  The persisted run stays what is in force; the portal labels it so.
* **Overrides are the admin panel's knobs only** (§2.8/§4.3): wear cost, the
  backup-reserve floor, the usable SoC band and the ``netzladen_erlaubt``
  posture. Everything else - prices, forecasts, tariff, §14a, feed-in cap -
  comes from the real site, so a preview can never be a fantasy plant.

The terminal energy value is deliberately NOT copied across: ``gather_inputs``
leaves ``terminal_value_eur_per_kwh`` at the env override (normally ``None``),
so :meth:`OptimizationInput.effective_terminal_value_eur_per_kwh` re-derives
V_end from the VARIANT's own posture - flipping ``netzladen_erlaubt`` changes
which slots may refill the battery, and a stale V_end would silently price the
variant with the baseline's refill assumption.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable
from uuid import UUID, uuid4

from voltpilot_optimization.domain import SLOTS_24H, OptimizationInput, SchedulePlan
from voltpilot_optimization.inputs import BatterySite, SkipSite
from voltpilot_optimization.solver import (
    InfeasiblePlanError,
    optimize,
    optimize_ignoring_grid_limit,
)

logger = logging.getLogger("voltpilot.optimization.whatif")

MIN_HORIZON_SLOTS = 4
MAX_HORIZON_SLOTS = 4 * 48  # two days - past that the price coverage runs out anyway


class InvalidWhatIfRequest(ValueError):
    """Request rejected; the message is operator-facing German (relayed as 400)."""


class WhatIfUnavailable(RuntimeError):
    """The site cannot be planned right now; message is operator-facing German."""


@dataclass(frozen=True)
class LoadShift:
    """Ein Verbraucher läuft in einem Fenster (Steuerung Stufe 7, §3.8).

    Das MODELL einer Verbraucher-Regel bzw. eines übernommenen Vorschlags: die
    Last des Fensters steigt um ``kw``. Mehr behauptet es nicht - insbesondere
    verschiebt es NICHTS von anderswo weg (der Name des Knopfes kommt aus dem
    Konzept; die ehrliche Frage, die er beantwortet, ist „was kostet es, wenn
    dieses Gerät DANN läuft?").
    """

    from_slot: int
    slots: int
    kw: float


@dataclass(frozen=True)
class WhatIfOverrides:
    """The admin knobs. ``None`` everywhere = "solve the site as configured".

    ``backup_reserve_soc_pct`` uses ``0`` for "no reserve" rather than a
    separate clear flag: a 0 % floor and no floor are the SAME constraint
    (:meth:`BatteryParams.soc_floor_kwh` starts at the technical minimum), so
    one number covers both without an ambiguous null.
    """

    wear_cost_ct_per_kwh: float | None = None
    backup_reserve_soc_pct: float | None = None
    soc_min_pct: float | None = None
    soc_max_pct: float | None = None
    netzladen_erlaubt: bool | None = None
    #: Steuerung Stufe 7 - die KUNDEN-Knöpfe (Konzept §3.8). Sie sind bewusst
    #: GROB und beschreiben je eine Handlung, die der Kunde wirklich treffen
    #: kann; die Admin-Regler darüber bleiben admin-only.
    #:
    #: ``soc_floor_now``      „Ladestand halten" - der Speicher geht nicht
    #:                        unter seinen JETZIGEN Stand.
    #:                        ⚠ Ein BODEN, keine Einfrierung: laden und wieder
    #:                        bis auf diesen Stand entladen bleibt erlaubt. Der
    #:                        Handeingriff selbst friert ein (Sollwert 0), die
    #:                        Vorschau UNTERSCHÄTZT seine Wirkung also eher, als
    #:                        sie zu überschätzen - und wird darum als Näherung
    #:                        ausgewiesen. Eine echte Einfrierung bräuchte eine
    #:                        eigene Bound-Paarung im Modell; ein Boden benutzt
    #:                        die vorhandene, geprüfte Reservierungs-Maschinerie.
    #: ``forced_charge_slots`` „Speicher jetzt laden" - so viele Viertelstunden
    #:                        lädt er mit voller Leistung (auf den Kopfraum
    #:                        gekappt, siehe :func:`apply_overrides`).
    #: ``consumer_load_shift`` „dieses Gerät läuft in diesem Fenster".
    soc_floor_now: bool | None = None
    forced_charge_slots: int | None = None
    consumer_load_shift: LoadShift | None = None

    def is_empty(self) -> bool:
        return all(
            getattr(self, f) is None
            for f in (
                "wear_cost_ct_per_kwh",
                "backup_reserve_soc_pct",
                "soc_min_pct",
                "soc_max_pct",
                "netzladen_erlaubt",
                "soc_floor_now",
                "forced_charge_slots",
                "consumer_load_shift",
            )
        )

    def as_document(self) -> dict:
        """The applied knobs, camelCase, omitting the untouched ones."""
        doc: dict = {}
        if self.wear_cost_ct_per_kwh is not None:
            doc["wearCostCtPerKwh"] = self.wear_cost_ct_per_kwh
        if self.backup_reserve_soc_pct is not None:
            doc["backupReserveSocPct"] = self.backup_reserve_soc_pct
        if self.soc_min_pct is not None:
            doc["socMinPct"] = self.soc_min_pct
        if self.soc_max_pct is not None:
            doc["socMaxPct"] = self.soc_max_pct
        if self.netzladen_erlaubt is not None:
            doc["netzladenErlaubt"] = self.netzladen_erlaubt
        if self.soc_floor_now is not None:
            doc["socFloorNow"] = self.soc_floor_now
        if self.forced_charge_slots is not None:
            doc["forcedChargeSlots"] = self.forced_charge_slots
        if self.consumer_load_shift is not None:
            doc["consumerLoadShift"] = {
                "fromSlot": self.consumer_load_shift.from_slot,
                "slots": self.consumer_load_shift.slots,
                "kw": self.consumer_load_shift.kw,
            }
        return doc


@dataclass(frozen=True)
class WhatIfRequest:
    site_id: UUID
    overrides: WhatIfOverrides
    horizon_slots: int = SLOTS_24H


# ---------------------------------------------------------------------------
# request parsing
# ---------------------------------------------------------------------------


def parse_request(doc: dict) -> WhatIfRequest:
    """Validate the api's JSON payload into a :class:`WhatIfRequest`."""
    if not isinstance(doc, dict):
        raise InvalidWhatIfRequest("Ungültige Anfrage: JSON-Objekt erwartet.")
    raw_site = doc.get("siteId")
    if not isinstance(raw_site, str) or not raw_site.strip():
        raise InvalidWhatIfRequest("Bitte die Anlage angeben (siteId).")
    try:
        site_id = UUID(raw_site.strip())
    except ValueError as exc:
        raise InvalidWhatIfRequest("Ungültige Anlagen-ID.") from exc

    horizon = doc.get("horizonSlots")
    if horizon is None:
        horizon_slots = SLOTS_24H
    else:
        try:
            horizon_slots = int(horizon)
        except (TypeError, ValueError) as exc:
            raise InvalidWhatIfRequest("Ungültiger Planungshorizont.") from exc
        if not MIN_HORIZON_SLOTS <= horizon_slots <= MAX_HORIZON_SLOTS:
            raise InvalidWhatIfRequest(
                f"Der Planungshorizont muss zwischen {MIN_HORIZON_SLOTS} und "
                f"{MAX_HORIZON_SLOTS} Viertelstunden liegen."
            )

    raw_overrides = doc.get("overrides")
    if raw_overrides is None:
        raw_overrides = {}
    if not isinstance(raw_overrides, dict):
        raise InvalidWhatIfRequest("Ungültige Regler-Werte.")
    overrides = WhatIfOverrides(
        wear_cost_ct_per_kwh=_number(raw_overrides, "wearCostCtPerKwh",
                                    "die Verschleißkosten", 0.0, 100.0),
        backup_reserve_soc_pct=_number(raw_overrides, "backupReserveSocPct",
                                       "die Backup-Reserve", 0.0, 100.0),
        soc_min_pct=_number(raw_overrides, "socMinPct",
                            "die SoC-Untergrenze", 0.0, 100.0),
        soc_max_pct=_number(raw_overrides, "socMaxPct",
                            "die SoC-Obergrenze", 0.0, 100.0),
        netzladen_erlaubt=_bool(raw_overrides, "netzladenErlaubt"),
        soc_floor_now=_bool(raw_overrides, "socFloorNow"),
        forced_charge_slots=_slots(raw_overrides, "forcedChargeSlots", horizon_slots),
        consumer_load_shift=_load_shift(raw_overrides, horizon_slots),
    )
    _require_valid_band(overrides.soc_min_pct, overrides.soc_max_pct)
    return WhatIfRequest(site_id=site_id, overrides=overrides, horizon_slots=horizon_slots)


def _number(doc: dict, key: str, label: str, low: float, high: float) -> float | None:
    if doc.get(key) is None:
        return None
    try:
        value = float(doc[key])
    except (TypeError, ValueError) as exc:
        raise InvalidWhatIfRequest(f"Ungültiger Wert für {label}.") from exc
    if not math.isfinite(value) or not low <= value <= high:
        raise InvalidWhatIfRequest(
            f"Ungültiger Wert für {label} (erlaubt: {low:g} bis {high:g})."
        )
    return value


def _bool(doc: dict, key: str) -> bool | None:
    value = doc.get(key)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise InvalidWhatIfRequest("Ungültiger Wert für das Netzladen.")
    return value


def _slots(doc: dict, key: str, horizon: int) -> int | None:
    """Eine Zahl von Viertelstunden, immer INNERHALB des Horizonts."""
    if doc.get(key) is None:
        return None
    try:
        value = int(doc[key])
    except (TypeError, ValueError) as exc:
        raise InvalidWhatIfRequest("Ungültige Anzahl Viertelstunden.") from exc
    if not 1 <= value <= horizon:
        raise InvalidWhatIfRequest(
            f"Die Anzahl Viertelstunden muss zwischen 1 und {horizon} liegen."
        )
    return value


def _load_shift(doc: dict, horizon: int) -> LoadShift | None:
    """Das Fenster, in dem ein Gerät laufen soll - vollständig oder gar nicht.

    ⚠ Ein HALB gefülltes Fenster wird abgelehnt statt ergänzt: eine geratene
    Startzeit wäre eine Aussage über eine Kundenanlage, die niemand getroffen
    hat.
    """
    raw = doc.get("consumerLoadShift")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise InvalidWhatIfRequest("Ungültiges Verbraucher-Fenster.")
    try:
        from_slot = int(raw["fromSlot"])
        slots = int(raw["slots"])
        kw = float(raw["kw"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidWhatIfRequest(
            "Ungültiges Verbraucher-Fenster: Beginn, Länge und Leistung gehören zusammen."
        ) from exc
    if not 0 <= from_slot < horizon:
        raise InvalidWhatIfRequest("Der Beginn des Fensters liegt ausserhalb des Zeitraums.")
    if not 1 <= slots <= horizon - from_slot:
        raise InvalidWhatIfRequest("Die Länge des Fensters liegt ausserhalb des Zeitraums.")
    if not math.isfinite(kw) or not 0.0 < kw <= 1000.0:
        raise InvalidWhatIfRequest("Ungültige Leistung für das Verbraucher-Fenster.")
    return LoadShift(from_slot=from_slot, slots=slots, kw=kw)


def _require_valid_band(soc_min_pct: float | None, soc_max_pct: float | None) -> None:
    """Only checkable here when BOTH sides are overridden; a one-sided override
    is validated in :func:`apply_overrides` against the site's own other side."""
    if soc_min_pct is not None and soc_max_pct is not None and soc_min_pct >= soc_max_pct:
        raise InvalidWhatIfRequest(
            "Das SoC-Band ist ungültig: die Untergrenze muss unter der "
            "Obergrenze liegen."
        )


# ---------------------------------------------------------------------------
# the override application (pure - the piece worth unit-testing hardest)
# ---------------------------------------------------------------------------


def apply_overrides(inp: OptimizationInput, overrides: WhatIfOverrides) -> OptimizationInput:
    """Return a COPY of ``inp`` with the admin knobs applied.

    Everything not named in :class:`WhatIfOverrides` (prices, forecasts, SoC,
    §14a, feed-in cap, tariff-derived import/export series) passes through
    untouched, so the variant is the same plant on the same day.
    """
    if overrides.is_empty():
        return inp
    battery = inp.battery
    changes: dict = {}
    if overrides.wear_cost_ct_per_kwh is not None:
        changes["wear_cost_ct_per_kwh"] = overrides.wear_cost_ct_per_kwh
    if overrides.backup_reserve_soc_pct is not None:
        changes["backup_reserve_pct"] = overrides.backup_reserve_soc_pct
    if overrides.soc_min_pct is not None:
        changes["soc_min_fraction"] = overrides.soc_min_pct / 100.0
    if overrides.soc_max_pct is not None:
        changes["soc_max_fraction"] = overrides.soc_max_pct / 100.0
    if changes:
        try:
            battery = replace(battery, **changes)
        except ValueError as exc:
            # A one-sided band override can cross the site's own other side.
            raise InvalidWhatIfRequest(f"Ungültige Speicher-Regler: {exc}") from exc
    if overrides.soc_floor_now:
        # „Ladestand halten": der Boden ist der Stand von JETZT. Das benutzt
        # die vorhandene Reservierungs-Maschinerie (`soc_floor_kwh` kappt den
        # Boden ohnehin auf den Startwert), statt eine zweite Bodenlogik zu
        # bauen - und wirkt damit hart, wie jede andere Reservierung.
        capacity = battery.capacity_kwh
        if capacity > 0:
            stand = battery.clamp_soc_kwh(inp.initial_soc_kwh)
            pct = max(battery.backup_reserve_pct or 0.0, 100.0 * stand / capacity)
            battery = replace(battery, backup_reserve_pct=min(pct, 100.0))
    variant = replace(inp, battery=battery)
    if overrides.netzladen_erlaubt is not None:
        variant = replace(variant, netzladen_erlaubt=overrides.netzladen_erlaubt)
    if overrides.forced_charge_slots:
        variant = replace(variant, **_forced_charge(variant, overrides.forced_charge_slots))
    if overrides.consumer_load_shift is not None:
        variant = replace(variant, load_kw=_with_load(variant, overrides.consumer_load_shift))
    return variant


def _forced_charge(inp: OptimizationInput, slots: int) -> dict:
    """Die Untergrenze für „Speicher jetzt laden", auf den KOPFRAUM gekappt.

    ⚠ Ungekappt wäre das Modell auf einem fast vollen Speicher unlösbar - und
    eine unlösbare Vorschau ist keine Antwort, sondern ein Fehler. Die Kappung
    macht die Zahl zusätzlich ehrlich: mehr als der Kopfraum passt nicht hinein,
    egal was der Knopf sagt.
    """
    p = inp.battery
    n = max(min(slots, inp.slots), 0)
    kopfraum = p.soc_max_kwh - p.clamp_soc_kwh(inp.initial_soc_kwh)
    if n <= 0 or kopfraum <= 0:
        raise InvalidWhatIfRequest(
            "Der Speicher ist bereits voll - jetzt laden geht nicht."
        )
    # Die Ladung landet mit Wirkungsgrad im Speicher, die Untergrenze zählt
    # AC-seitig: was hineinpasst, geteilt durch Zeit und Wirkungsgrad.
    kw = kopfraum / (n * inp.slot_hours * p.one_way_efficiency)
    return {
        "forced_charge_slots": n,
        "forced_charge_kw": min(kw, p.max_charge_kw),
    }


def _with_load(inp: OptimizationInput, shift: LoadShift) -> list[float]:
    """Die Lastreihe MIT dem laufenden Gerät - alles Übrige bleibt, wie es ist."""
    load = list(inp.load_kw)
    for t in range(shift.from_slot, min(shift.from_slot + shift.slots, len(load))):
        load[t] = load[t] + shift.kw
    return load


def knob_document(inp: OptimizationInput) -> dict:
    """The knob values a solved input actually used (baseline vs. variant echo)."""
    p = inp.battery
    return {
        "wearCostCtPerKwh": p.wear_cost_ct_per_kwh,
        "backupReserveSocPct": p.backup_reserve_pct,
        "socMinPct": round(p.soc_min_fraction * 100.0, 4),
        "socMaxPct": round(p.soc_max_fraction * 100.0, 4),
        "netzladenErlaubt": inp.netzladen_erlaubt,
    }


# ---------------------------------------------------------------------------
# solving + shaping
# ---------------------------------------------------------------------------


def solve_ephemeral(inp: OptimizationInput, now: datetime) -> tuple[SchedulePlan, bool]:
    """Solve one input, mirroring the engine's §14a fallback. Returns the plan
    plus whether the grid-limit constraint had to be dropped."""
    plan_id = uuid4()
    try:
        return optimize(inp, plan_id, now), False
    except InfeasiblePlanError:
        return optimize_ignoring_grid_limit(inp, plan_id, now), True


def _round(value: float | None, digits: int = 3) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def plan_document(plan: SchedulePlan, inp: OptimizationInput, fallback_14a: bool) -> dict:
    """Shape a solved plan into the response's per-plan block.

    Absent stays absent: a slot field the solver did not produce is ``null``,
    never a fabricated 0 (the repo-wide null discipline the portal relies on).
    """
    slot_hours = inp.slot_hours
    capacity = plan.battery.capacity_kwh
    charged = sum(s.battery_kw for s in plan.slots if s.battery_kw > 0) * slot_hours
    discharged = -sum(s.battery_kw for s in plan.slots if s.battery_kw < 0) * slot_hours
    imported = sum(s.grid_kw for s in plan.slots if s.grid_kw > 0) * slot_hours
    exported = -sum(s.grid_kw for s in plan.slots if s.grid_kw < 0) * slot_hours
    curtailed = sum(s.curtail_kw for s in plan.slots) * slot_hours
    soc_start = inp.battery.clamp_soc_kwh(inp.initial_soc_kwh)
    soc_end = plan.slots[-1].soc_kwh if plan.slots else soc_start
    v_end = inp.effective_terminal_value_eur_per_kwh()
    return {
        "slotMinutes": inp.slot_minutes,
        "costEur": _round(plan.cost_eur, 4),
        "baselineCostEur": _round(plan.baseline_cost_eur, 4),
        "savingsEur": _round(plan.savings_eur, 4),
        "wearCostEur": _round(plan.wear_cost_eur, 4),
        # The honest net: gross grid savings minus the battery wear the plan
        # spends buying them (the persisted columns carry both, never folded).
        "netSavingsEur": _round(plan.savings_eur - plan.wear_cost_eur, 4),
        "terminalValueEurPerKwh": _round(v_end, 6),
        # What the plan banks into the next day, priced at its own V_end - on a
        # bank day savingsEur alone reads negative although real value moved.
        "bankedValueEur": _round(v_end * (soc_end - soc_start), 4),
        "chargedKwh": _round(charged),
        "dischargedKwh": _round(discharged),
        "gridImportKwh": _round(imported),
        "gridExportKwh": _round(exported),
        "curtailedKwh": _round(curtailed),
        # One "cycle" = one full usable-band round trip of throughput.
        "cycles": _round((charged + discharged) / (2.0 * capacity), 3) if capacity else None,
        "socStartPct": _round(100.0 * soc_start / capacity, 2) if capacity else None,
        "socEndPct": _round(100.0 * soc_end / capacity, 2) if capacity else None,
        "peakTargetKw": _round(plan.peak_target_kw),
        "fallback14a": fallback_14a,
        "knobs": knob_document(inp),
        "slots": [
            {
                "time": s.start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "batteryKw": _round(s.battery_kw),
                "gridKw": _round(s.grid_kw),
                "socPct": _round(100.0 * s.soc_kwh / capacity, 2) if capacity else None,
                "pvKw": _round(s.pv_kw),
                "loadKw": _round(s.load_kw),
                "curtailKw": _round(s.curtail_kw),
                "priceEurMwh": _round(s.price_eur_mwh, 4),
                "costEur": _round(s.cost_eur, 6),
                "baselineCostEur": _round(s.baseline_cost_eur, 6),
                "wearCostEur": _round(s.wear_cost_eur, 6),
                "slotRole": s.slot_role,
            }
            for s in plan.slots
        ],
    }


def delta_document(baseline: dict, variant: dict) -> dict:
    """Variant minus baseline for the headline numbers (both from the SAME
    inputs). A number the solver could not produce on either side stays
    ``null`` rather than being read as a zero difference."""
    keys = (
        "costEur",
        "savingsEur",
        "wearCostEur",
        "netSavingsEur",
        "bankedValueEur",
        "chargedKwh",
        "dischargedKwh",
        "gridImportKwh",
        "gridExportKwh",
        "curtailedKwh",
        "cycles",
        "socEndPct",
        "peakTargetKw",
    )
    doc: dict = {}
    for key in keys:
        a, b = baseline.get(key), variant.get(key)
        doc[key] = None if a is None or b is None else _round(b - a, 4)
    return doc


# ---------------------------------------------------------------------------
# the runner
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WhatIfDeps:
    """Injected data access so the runner is testable without a database."""

    load_site: Callable[[UUID], BatterySite | None]
    gather: Callable[[BatterySite, datetime, int], OptimizationInput]


def run_what_if(request: WhatIfRequest, deps: WhatIfDeps,
                now: datetime | None = None) -> dict:
    """Gather once, solve twice, return both plans + their delta.

    Never persists and never publishes - see the module docstring. Raises
    :class:`WhatIfUnavailable` when the site cannot be planned (unknown /
    no battery / no price coverage), :class:`InvalidWhatIfRequest` when the
    knobs are impossible for this battery.
    """
    now = now if now is not None else datetime.now(timezone.utc)
    site = deps.load_site(request.site_id)
    if site is None:
        raise WhatIfUnavailable(
            "Für diese Anlage gibt es keinen Batteriespeicher - der Optimierer "
            "plant sie nicht."
        )
    try:
        inp = deps.gather(site, now, request.horizon_slots)
    except SkipSite as exc:
        raise WhatIfUnavailable(
            f"Für diese Anlage lässt sich gerade kein Plan rechnen: {exc}"
        ) from exc

    variant_input = apply_overrides(inp, request.overrides)
    baseline_plan, baseline_fallback = solve_ephemeral(inp, now)
    variant_plan, variant_fallback = solve_ephemeral(variant_input, now)

    baseline_doc = plan_document(baseline_plan, inp, baseline_fallback)
    variant_doc = plan_document(variant_plan, variant_input, variant_fallback)
    logger.info(
        "whatif.solved",
        extra={
            "context": {
                "site_id": str(request.site_id),
                "slots": len(variant_plan.slots),
                "overrides": sorted(request.overrides.as_document()),
            }
        },
    )
    return {
        "siteId": str(request.site_id),
        "computedAt": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "horizonSlots": len(variant_plan.slots),
        "slotMinutes": inp.slot_minutes,
        "appliedOverrides": request.overrides.as_document(),
        "baseline": baseline_doc,
        "variant": variant_doc,
        "delta": delta_document(baseline_doc, variant_doc),
    }

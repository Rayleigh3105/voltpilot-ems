"""Load profiles for the simulation year.

Inkrement 1 ships the **synthetic household profile** (the design report's
formula): a deterministic double-hump day (morning/evening), weekend and
seasonal modulation, scaled EXACTLY to the requested annual consumption.
Honest label in the UI: "typisches Haushaltsprofil" - it is a plausible
shape, not a measured one.

The official BDEW H25 dynamic standard load profile stays behind an explicit
opt-in (``SIM_BDEW_H25_JSON`` pointing at a locally provided JSON file) -
BDEW publishes the profiles for free use but without an explicit
redistribution grant, so the repo must not bundle the data (captain
instruction 2026-07-16). The operator converts their own download of the
official publication with the shipped ``bdew-convert`` CLI (see
:mod:`voltpilot_optimization.simulation.bdew_convert`, which also documents
the publication structure, day-type mapping, Dynamisierung and DST
semantics). The adapter accepts ``{"slots": [w0, w1, ...]}`` with one weight
per WALL-CLOCK 15-min slot of the profile year (``(day_of_year - 1) * 96 +
quarter_of_day`` - that is what the same-tzinfo subtraction below computes),
scaled to the annual consumption like the synthetic profile.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")

PROFILE_HAUSHALT = "haushalt"
PROFILE_BDEW_H25 = "bdew-h25"

BDEW_H25_ENV = "SIM_BDEW_H25_JSON"

SLOT_HOURS = 0.25


class UnknownProfileError(ValueError):
    """The requested load profile id is not available."""


def load_series_kw(
    profile: str,
    slot_starts: list[datetime],
    annual_kwh: float,
    env: dict[str, str] | None = None,
) -> list[float]:
    """The load series (kW per 15-min slot) for the whole simulation year,
    scaled so the slot energies sum EXACTLY to ``annual_kwh``."""
    if annual_kwh <= 0 or not math.isfinite(annual_kwh):
        raise ValueError("annual_kwh must be positive")
    env = os.environ if env is None else env
    if profile == PROFILE_HAUSHALT:
        weights = [household_weight(s.astimezone(BERLIN)) for s in slot_starts]
    elif profile == PROFILE_BDEW_H25:
        weights = _bdew_h25_weights(slot_starts, env)
    else:
        raise UnknownProfileError(
            f"Unbekanntes Lastprofil '{profile}' - verfügbar: haushalt"
            + (", bdew-h25" if env.get(BDEW_H25_ENV) else "")
        )
    total_kwh = sum(weights) * SLOT_HOURS
    scale = annual_kwh / total_kwh
    return [w * scale for w in weights]


def household_weight(local: datetime) -> float:
    """The synthetic household shape at one Berlin-local instant (relative
    weight; absolute level comes from the annual-consumption scaling).

    Double hump (morning ~7:30, evening ~19:30) over a flat base with a small
    midday shoulder; weekends shift the morning later and lift the day;
    winter days run ~18 % above summer (heating-adjacent usage). Deliberately
    deterministic and noise-free - a year of it is a shape, not a forecast.
    """
    hour = local.hour + local.minute / 60.0
    weekend = local.weekday() >= 5
    morning_center = 9.0 if weekend else 7.5
    base = 0.25
    morning = 0.9 * _gauss(hour, morning_center, 1.5)
    midday = 0.35 * _gauss(hour, 13.0, 2.0)
    evening = 1.4 * _gauss(hour, 19.5, 2.0)
    weekend_factor = 1.12 if weekend else 1.0
    season = 1.0 + 0.18 * math.cos(
        2.0 * math.pi * (local.timetuple().tm_yday - 15) / 365.0
    )
    return (base + morning + midday + evening) * weekend_factor * season


def _gauss(x: float, center: float, width: float) -> float:
    return math.exp(-((x - center) ** 2) / (2.0 * width * width))


def _bdew_h25_weights(
    slot_starts: list[datetime], env: dict[str, str]
) -> list[float]:
    """Weights from a locally provided BDEW H25 JSON (see module docstring).

    The file carries one weight per WALL-CLOCK 15-min slot of a profile year:
    the same-tzinfo ``local - year_start`` subtraction below is naive, so the
    index is ``(day_of_year - 1) * 96 + quarter_of_day`` - on the DST
    spring-forward day the 02:00-02:45 entries are never read, on the
    fall-back day they are read twice (the converter emits exactly this
    layout). Simulation years of a different length (leap years) wrap the
    profile cyclically - a documented approximation.
    """
    path = env.get(BDEW_H25_ENV, "").strip()
    if not path:
        raise UnknownProfileError(
            "Das BDEW-H25-Profil ist nicht eingerichtet (SIM_BDEW_H25_JSON "
            "ist nicht gesetzt) - bitte 'haushalt' verwenden"
        )
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    slots = doc.get("slots")
    if not isinstance(slots, list) or len(slots) < 96:
        raise ValueError(
            f"BDEW-H25-Datei {path} hat kein brauchbares 'slots'-Array"
        )
    weights: list[float] = []
    year = slot_starts[0].astimezone(BERLIN).year
    year_start = datetime(year, 1, 1, tzinfo=BERLIN)
    for start in slot_starts:
        local = start.astimezone(BERLIN)
        slot_of_year = int((local - year_start).total_seconds() // 900)
        weights.append(float(slots[slot_of_year % len(slots)]))
    return weights

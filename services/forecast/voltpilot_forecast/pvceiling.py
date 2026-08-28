"""Clear-sky ceiling - the physical backstop under every PV forecast.

A PV forecast is a product of two things that can each be wrong: an irradiance
series from an external source, and a model that maps it onto a plant. Neither
knows where the sun is at the slot it is describing. This module is the guard
that does: whatever the active model says, a plant cannot beat the CLEAR-SKY
output of its own geometry at that instant.

It exists because the Pilsting dusk case (28.08.2026) had the forecast claim
5.9 kW from a 100 kWp plant at 1.9° sun elevation - a slot whose clear-sky
global horizontal irradiance is 6.1 W/m². The cause was an upstream alignment
error (see :class:`~voltpilot_forecast.openmeteo.OpenMeteoWeatherProvider`),
and that cause is fixed at its root. The ceiling is the structural reason the
CLASS of error cannot reach a plan again:

* it is a **no-op on a correctly aligned physical forecast** - the same geometry
  transposing real irradiance can never exceed itself transposing clear-sky
  irradiance - so it changes nothing in normal daytime operation;
* it bites exactly where a slot's irradiance does not belong to that slot's sun;
* and it is the ONLY thing bounding the residual challenger
  (:class:`~voltpilot_forecast.ml.PvResidualXgbForecaster`), whose prediction is
  ``physical + learned residual`` and was previously clipped only to nameplate -
  free to invent generation after sunset.

Two deliberate choices keep it from ever clipping real production:

* **The beam is bounded by a clear-sky DNI model** (:func:`clear_sky_dni`), not
  by ``GHI / cos(zenith)``. The latter is what :func:`poa_irradiance` falls back
  to, and at 1.9° elevation it turns 6 W/m² of GHI into a 156 W/m² beam - a
  ceiling computed that way would be no ceiling at all.
* **Never tighter than a horizontal plane.** A plant whose stored orientation is
  wrong (an east/west roof carrying the DACH south/30° default, which
  ``forecast_collect`` fills in when the registry has none) would otherwise be
  clipped in the evening for a reason that is our record-keeping, not physics.

``CEILING_HEADROOM`` is the margin for what the clear-sky model itself cannot
know: cloud enhancement briefly pushes real irradiance above the clear-sky
envelope, and Haurwitz is a mid-range model. It is a "cannot be real" threshold,
not a tuning dial.
"""

from __future__ import annotations

import os
from datetime import datetime

from voltpilot_forecast.domain import SiteForecastConfig
from voltpilot_forecast.solar import (
    clear_sky_dni,
    clear_sky_ghi,
    poa_irradiance,
    solar_position,
)

STC_IRRADIANCE_W_M2 = 1000.0

#: How far above the clear-sky envelope a value may still be believed.
DEFAULT_CEILING_HEADROOM = 1.25

CEILING_ENABLED_ENV = "VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED"
CEILING_HEADROOM_ENV = "VOLTPILOT_PV_CLEAR_SKY_HEADROOM"


def ceiling_enabled(env=None) -> bool:
    """Whether the ceiling clips. Default ON - the kill switch.

    Default-TRUE on purpose (the ``pv_anchor_enabled`` discipline): a
    default-OFF flag has to be pulled through the gitops repo to have any
    effect, which is the documented way features silently never run.
    """
    env = os.environ if env is None else env
    raw = env.get(CEILING_ENABLED_ENV)
    if raw is None or raw.strip() == "":
        return True
    value = raw.strip().lower()
    if value in ("true", "1", "yes", "on"):
        return True
    if value in ("false", "0", "no", "off"):
        return False
    raise ValueError(f"{CEILING_ENABLED_ENV} must be a boolean, got {raw!r}")


def ceiling_headroom(env=None) -> float:
    """Margin over the clear-sky envelope; must be >= 1 (never a discount)."""
    env = os.environ if env is None else env
    raw = env.get(CEILING_HEADROOM_ENV)
    if raw is None or raw.strip() == "":
        return DEFAULT_CEILING_HEADROOM
    value = float(raw)
    if not value >= 1.0:
        raise ValueError(f"{CEILING_HEADROOM_ENV} must be >= 1, got {raw!r}")
    return value


def clear_sky_ceiling_kw(
    config: SiteForecastConfig,
    when: datetime,
    *,
    headroom: float | None = None,
) -> float | None:
    """The most this plant could physically make at ``when`` (kW), or ``None``.

    ``None`` means "no opinion" - no plant on record, so nothing to bound. At or
    below the horizon the answer is exactly ``0.0``: the clear-sky envelope of a
    set sun is zero, and no headroom multiplies it back up.
    """
    plant = config.plant
    if plant is None or plant.capacity_kwp <= 0.0:
        return None
    factor = ceiling_headroom() if headroom is None else headroom

    position = solar_position(config.location, when)
    ghi = clear_sky_ghi(position)
    if ghi <= 0.0:
        return 0.0

    # A physical beam/diffuse split: bound the beam by the air-mass DNI model
    # and give the sky whatever GHI it does not account for.
    dni = clear_sky_dni(position)
    dhi = max(0.0, ghi - dni * position.cos_zenith)
    poa = poa_irradiance(
        position,
        ghi,
        tilt_deg=plant.tilt_deg,
        surface_azimuth_deg=plant.azimuth_deg,
        albedo=plant.albedo,
        diffuse_fraction=0.0,  # unused: dni/dhi are given
        dni_w_m2=dni,
        dhi_w_m2=dhi,
    )
    envelope = max(poa, ghi)  # never tighter than a horizontal plane

    kw = plant.capacity_kwp * (envelope / STC_IRRADIANCE_W_M2)
    kw *= 1.0 - plant.system_loss_fraction
    return min(kw * factor, plant.capacity_kwp)


def apply_clear_sky_ceiling(
    config: SiteForecastConfig,
    timestamps: list[datetime],
    values_kw: list[float],
    *,
    headroom: float | None = None,
) -> list[float]:
    """Clip a PV series to its per-slot clear-sky ceiling (never raises it)."""
    if not ceiling_enabled():
        return list(values_kw)
    factor = ceiling_headroom() if headroom is None else headroom
    out: list[float] = []
    for ts, kw in zip(timestamps, values_kw):
        ceiling = clear_sky_ceiling_kw(config, ts, headroom=factor)
        out.append(kw if ceiling is None else min(kw, ceiling))
    return out

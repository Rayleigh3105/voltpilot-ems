"""Solar geometry - the shared physical backbone of the PV forecast.

Pure ``math`` (no numpy) implementation of the NOAA solar-position algorithm plus
a clear-sky irradiance model and a plane-of-array (POA) transposition. Both the
default weather adapter (:mod:`voltpilot_forecast.weather`) and the physical PV
forecaster (:mod:`voltpilot_forecast.pv`) build on these functions, so the solar
trigonometry lives in exactly one place.

Accuracy target is "good enough for a v1 baseline" (~0.5° on position); this is
the physical model that architecture section 12 asks for, deliberately without
the later ML correction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

from voltpilot_forecast.domain import GeoLocation, ensure_utc

SOLAR_CONSTANT_W_M2 = 1361.0  # extraterrestrial irradiance at mean earth-sun distance


@dataclass(frozen=True)
class SolarPosition:
    """Sun position for a location/time. Angles in degrees, clockwise-from-North."""

    zenith_deg: float
    azimuth_deg: float

    @property
    def elevation_deg(self) -> float:
        return 90.0 - self.zenith_deg

    @property
    def cos_zenith(self) -> float:
        return math.cos(math.radians(self.zenith_deg))

    @property
    def is_daytime(self) -> bool:
        return self.zenith_deg < 90.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def solar_position(location: GeoLocation, when: datetime) -> SolarPosition:
    """Sun zenith/azimuth via the NOAA algorithm (Spencer/NOAA approximations).

    ``when`` may be naive (treated as UTC) or aware; it is normalised to UTC.
    """
    when = ensure_utc(when)
    day_of_year = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0 + when.second / 3600.0

    # Fractional year (radians).
    gamma = 2.0 * math.pi / 365.0 * (day_of_year - 1 + (hour - 12.0) / 24.0)

    # Equation of time (minutes) and solar declination (radians) - Spencer 1971.
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma)
        - 0.040849 * math.sin(2 * gamma)
    )
    decl = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma)
        + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma)
        + 0.001480 * math.sin(3 * gamma)
    )

    # True solar time -> hour angle (degrees). Longitude east-positive; UTC.
    time_offset = eqtime + 4.0 * location.longitude
    true_solar_time = hour * 60.0 + time_offset
    hour_angle = true_solar_time / 4.0 - 180.0
    ha_rad = math.radians(hour_angle)

    lat_rad = math.radians(location.latitude)
    cos_zenith = _clamp(
        math.sin(lat_rad) * math.sin(decl)
        + math.cos(lat_rad) * math.cos(decl) * math.cos(ha_rad),
        -1.0,
        1.0,
    )
    zenith = math.acos(cos_zenith)
    sin_zenith = math.sin(zenith)

    if sin_zenith < 1e-6:
        azimuth = 0.0
    else:
        sin_az = -math.cos(decl) * math.sin(ha_rad) / sin_zenith
        cos_az = (math.sin(decl) - math.sin(lat_rad) * cos_zenith) / (
            math.cos(lat_rad) * sin_zenith
        )
        azimuth = math.degrees(math.atan2(sin_az, cos_az)) % 360.0

    return SolarPosition(zenith_deg=math.degrees(zenith), azimuth_deg=azimuth)


def clear_sky_ghi(position: SolarPosition) -> float:
    """Clear-sky global horizontal irradiance (W/m²) via the Haurwitz model.

    Haurwitz (1945) needs only the solar zenith angle and gives a robust clear-sky
    GHI envelope - the right complexity for a v1 physical baseline. Returns 0 when
    the sun is at/below the horizon.
    """
    cos_z = position.cos_zenith
    if cos_z <= 0.0:
        return 0.0
    return 1098.0 * cos_z * math.exp(-0.059 / cos_z)


def angle_of_incidence_cos(
    position: SolarPosition, tilt_deg: float, surface_azimuth_deg: float
) -> float:
    """Cosine of the angle between the sun and a tilted surface's normal.

    ``surface_azimuth_deg`` is clockwise from North (180 = due South). Clamped at
    0 (sun behind the panel contributes no beam irradiance).
    """
    zenith = math.radians(position.zenith_deg)
    tilt = math.radians(tilt_deg)
    az_diff = math.radians(position.azimuth_deg - surface_azimuth_deg)
    cos_aoi = math.cos(zenith) * math.cos(tilt) + math.sin(zenith) * math.sin(
        tilt
    ) * math.cos(az_diff)
    return max(0.0, cos_aoi)


def poa_irradiance(
    position: SolarPosition,
    ghi_w_m2: float,
    tilt_deg: float,
    surface_azimuth_deg: float,
    albedo: float,
    diffuse_fraction: float,
    dni_w_m2: float | None = None,
    dhi_w_m2: float | None = None,
) -> float:
    """Transpose horizontal irradiance onto the plane of array (W/m²).

    Splits GHI into beam + diffuse (using measured DNI/DHI when the weather
    adapter supplies them, otherwise an isotropic ``diffuse_fraction`` split),
    then sums beam, isotropic-sky diffuse and ground-reflected components. This
    is the standard simple transposition used by PVWatts-class models.
    """
    cos_z = position.cos_zenith
    if cos_z <= 0.0 or ghi_w_m2 <= 0.0:
        return 0.0

    if dhi_w_m2 is None:
        dhi = diffuse_fraction * ghi_w_m2
    else:
        dhi = dhi_w_m2
    beam_horizontal = max(0.0, ghi_w_m2 - dhi)
    if dni_w_m2 is None:
        dni = beam_horizontal / cos_z
    else:
        dni = dni_w_m2

    cos_aoi = angle_of_incidence_cos(position, tilt_deg, surface_azimuth_deg)
    tilt = math.radians(tilt_deg)

    poa_beam = dni * cos_aoi
    poa_diffuse = dhi * (1.0 + math.cos(tilt)) / 2.0
    poa_reflected = ghi_w_m2 * albedo * (1.0 - math.cos(tilt)) / 2.0
    return max(0.0, poa_beam + poa_diffuse + poa_reflected)


def clear_sky_dni(position: SolarPosition) -> float:
    """Clear-sky DIRECT-NORMAL irradiance (W/m²) via air mass (Meinel & Meinel).

    ``1361 · 0.7^(AM^0.678)`` with the Kasten-Young air mass. Needed as its own
    model because the isotropic fallback in :func:`poa_irradiance` reconstructs
    DNI as ``beam_horizontal / cos(zenith)``, which EXPLODES at low sun: at 1.9°
    elevation a 6 W/m² clear-sky GHI turns into a 156 W/m² "beam", and a tilted
    plane pointed at it appears to make several kW at dusk. Every clear-sky
    ENVELOPE (:mod:`voltpilot_forecast.pvceiling`) therefore bounds the beam
    with this model instead. Returns 0 at/below the horizon.
    """
    cos_z = position.cos_zenith
    if cos_z <= 0.0:
        return 0.0
    zenith = min(position.zenith_deg, 90.0)
    # Kasten-Young (1989): finite at the horizon, unlike 1/cos(z).
    air_mass = 1.0 / (cos_z + 0.50572 * (96.07995 - zenith) ** -1.6364)
    return SOLAR_CONSTANT_W_M2 * 0.7 ** (air_mass**0.678)


def clear_sky_means(
    location: GeoLocation,
    start: datetime,
    end: datetime,
    samples: int = 5,
) -> tuple[float, float]:
    """Mean clear-sky ``(GHI, DNI)`` in W/m² over ``[start, end)``, sub-sampled.

    The shape function that turns an HOURLY irradiance mean into per-quarter
    values (:class:`~voltpilot_forecast.openmeteo.OpenMeteoWeatherProvider`).
    Sampling at sub-interval MIDPOINTS keeps it a proper Riemann mean, so the
    quarter means of an hour average back to the hour mean and the split
    conserves energy exactly whenever the slot divides the hour.

    Both components are returned because they need DIFFERENT shapes: GHI
    collapses as the sun sets while DNI, being per-normal-area, decays far more
    slowly, so shaping the beam with the GHI curve would understate it.

    Returns ``(0.0, 0.0)`` for an empty or reversed interval and whenever the
    sun stays below the horizon throughout - which is what makes a post-sunset
    quarter hour exactly 0 rather than a share of the hour it sits in.
    """
    if samples < 1:
        raise ValueError("samples must be positive")
    span = (end - start).total_seconds()
    if span <= 0.0:
        return 0.0, 0.0
    step = span / samples
    ghi = dni = 0.0
    for i in range(samples):
        position = solar_position(location, start + timedelta(seconds=step * (i + 0.5)))
        ghi += clear_sky_ghi(position)
        dni += clear_sky_dni(position)
    return ghi / samples, dni / samples

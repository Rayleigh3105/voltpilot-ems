"""Tests for the solar-geometry backbone of the PV model."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.solar import (
    angle_of_incidence_cos,
    clear_sky_dni,
    clear_sky_ghi,
    clear_sky_means,
    poa_irradiance,
    solar_position,
)

BERLIN = GeoLocation(latitude=52.52, longitude=13.405)


def test_sun_is_up_at_local_noon_and_down_at_midnight():
    noon = datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc)  # ~solar noon Berlin
    midnight = datetime(2026, 6, 21, 23, 0, tzinfo=timezone.utc)
    assert solar_position(BERLIN, noon).is_daytime
    assert solar_position(BERLIN, noon).elevation_deg > 50.0  # high summer sun
    assert not solar_position(BERLIN, midnight).is_daytime


def test_solar_noon_azimuth_is_roughly_south():
    noon = datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc)
    az = solar_position(BERLIN, noon).azimuth_deg
    assert 160.0 < az < 200.0  # due south is 180


def test_clear_sky_ghi_zero_at_night_positive_at_noon():
    noon = solar_position(BERLIN, datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc))
    night = solar_position(BERLIN, datetime(2026, 6, 21, 23, 0, tzinfo=timezone.utc))
    assert clear_sky_ghi(noon) > 700.0
    assert clear_sky_ghi(night) == 0.0


def test_summer_ghi_exceeds_winter_ghi_at_noon():
    summer = solar_position(BERLIN, datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc))
    winter = solar_position(BERLIN, datetime(2026, 12, 21, 11, 0, tzinfo=timezone.utc))
    assert clear_sky_ghi(summer) > clear_sky_ghi(winter)


def test_aoi_cos_is_one_when_sun_normal_to_horizontal_panel():
    # A flat (tilt=0) panel; AOI cosine equals cos(zenith).
    pos = solar_position(BERLIN, datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc))
    flat = angle_of_incidence_cos(pos, tilt_deg=0.0, surface_azimuth_deg=180.0)
    assert abs(flat - pos.cos_zenith) < 1e-9


def test_poa_zero_at_night_and_positive_by_day():
    day = solar_position(BERLIN, datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc))
    night = solar_position(BERLIN, datetime(2026, 6, 21, 23, 0, tzinfo=timezone.utc))
    poa_day = poa_irradiance(
        day, clear_sky_ghi(day), tilt_deg=30, surface_azimuth_deg=180,
        albedo=0.2, diffuse_fraction=0.15,
    )
    poa_night = poa_irradiance(
        night, clear_sky_ghi(night), tilt_deg=30, surface_azimuth_deg=180,
        albedo=0.2, diffuse_fraction=0.15,
    )
    assert poa_day > 0.0
    assert poa_night == 0.0


def test_poa_irradiance_winter_midday_true_dni_far_exceeds_mislabeled_horizontal():
    """N1 pin (report section 4.2, labor evidence): Open-Meteo's
    ``direct_radiation`` is HORIZONTAL direct irradiance, not beam-normal DNI.
    ``pv-physical`` fed it straight into ``dni_w_m2`` until the Captain's fix
    (11.11.2026: "Behebe den Lesefehler"), starving the beam at low winter sun -
    exactly the gap closed by feeding ``direct_normal_irradiance`` (the true
    DNI) instead. The old reading lives on only as ``pv-physical-legacy-dni``,
    a permanent, never-active comparison candidate.

    Winter midday evidence, 20.01.2026 12:00 UTC, 48.7N/12.65E: GHI 363.0 W/m2,
    the mislabeled horizontal reading 298.0 W/m2, the true DNI 826.7 W/m2
    (labor/cache/archiv_dni_2025-11-01.json). Same GHI/DHI, same plant - only
    the beam source differs, so every bit of the gap below traces to N1.
    """
    location = GeoLocation(48.7, 12.65)
    winter_noon = solar_position(location, datetime(2026, 1, 20, 12, 0, tzinfo=timezone.utc))
    assert 15.0 < winter_noon.elevation_deg < 25.0  # low winter sun, not dusk

    ghi, dhi = 363.0, 65.0
    mislabeled_horizontal_as_dni = 298.0  # today's bug: direct_radiation
    true_dni = 826.7  # direct_normal_irradiance

    poa_today = poa_irradiance(
        winter_noon, ghi, tilt_deg=30, surface_azimuth_deg=180,
        albedo=0.2, diffuse_fraction=0.15,
        dni_w_m2=mislabeled_horizontal_as_dni, dhi_w_m2=dhi,
    )
    poa_fixed = poa_irradiance(
        winter_noon, ghi, tilt_deg=30, surface_azimuth_deg=180,
        albedo=0.2, diffuse_fraction=0.15,
        dni_w_m2=true_dni, dhi_w_m2=dhi,
    )
    assert poa_today == pytest.approx(293.0148, abs=0.01)
    assert poa_fixed == pytest.approx(696.6465, abs=0.01)
    # The report's year-long finding: the fix roughly doubles to triples the
    # winter POA beam at a given sun angle - never a rounding-sized nudge.
    assert poa_fixed > 2.0 * poa_today


def test_south_beats_north_facing_poa_in_northern_hemisphere():
    pos = solar_position(BERLIN, datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc))
    ghi = clear_sky_ghi(pos)
    south = poa_irradiance(
        pos, ghi, tilt_deg=30, surface_azimuth_deg=180,
        albedo=0.2, diffuse_fraction=0.15,
    )
    north = poa_irradiance(
        pos, ghi, tilt_deg=30, surface_azimuth_deg=0,
        albedo=0.2, diffuse_fraction=0.15,
    )
    assert south > north


# ---- clear-sky DNI (the beam bound that does not explode) -----------------


def test_clear_sky_dni_stays_finite_where_ghi_over_cos_z_explodes():
    """The whole reason it exists: a low sun must not mint a huge beam.

    ``poa_irradiance``'s isotropic fallback reconstructs the beam as
    ``ghi / cos(zenith)``; two degrees above the horizon that turns a handful
    of W/m2 into a couple of hundred, which is what let a dusk forecast claim
    kilowatts. The air-mass model is bounded by the solar constant instead.
    """
    dusk = datetime(2026, 8, 28, 17, 45, tzinfo=timezone.utc)
    position = solar_position(GeoLocation(48.7, 12.65), dusk)
    assert 0.0 < position.elevation_deg < 3.0

    ghi = clear_sky_ghi(position)
    naive_beam = ghi / position.cos_zenith
    dni = clear_sky_dni(position)
    assert naive_beam > 100.0  # the trap
    assert dni < naive_beam
    assert dni < 200.0


def test_clear_sky_dni_is_zero_below_the_horizon_and_high_at_noon():
    location = GeoLocation(48.7, 12.65)
    night = datetime(2026, 8, 28, 23, 0, tzinfo=timezone.utc)
    noon = datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc)
    assert clear_sky_dni(solar_position(location, night)) == 0.0
    assert 700.0 < clear_sky_dni(solar_position(location, noon)) < 1000.0


# ---- the hour -> quarter shape function ----------------------------------


def test_clear_sky_hour_mean_is_the_mean_of_its_quarter_means():
    """Energy conservation: the shape can only MOVE energy inside the hour."""
    start = datetime(2026, 8, 28, 16, 0, tzinfo=timezone.utc)
    hour_ghi, hour_dni = clear_sky_means(
        BERLIN, start, start + timedelta(hours=1), samples=20
    )
    quarters = [
        clear_sky_means(
            BERLIN,
            start + timedelta(minutes=15 * i),
            start + timedelta(minutes=15 * (i + 1)),
            samples=5,
        )
        for i in range(4)
    ]
    assert sum(q[0] for q in quarters) / 4 == pytest.approx(hour_ghi, rel=1e-12)
    assert sum(q[1] for q in quarters) / 4 == pytest.approx(hour_dni, rel=1e-12)


def test_clear_sky_quarters_fall_across_a_dusk_hour_and_end_at_zero():
    location = GeoLocation(48.7, 12.65)
    start = datetime(2026, 8, 28, 17, 0, tzinfo=timezone.utc)  # sunset ~18:05 UTC
    ghi = [
        clear_sky_means(
            location,
            start + timedelta(minutes=15 * i),
            start + timedelta(minutes=15 * (i + 1)),
        )[0]
        for i in range(6)
    ]
    assert ghi == sorted(ghi, reverse=True)
    assert ghi[0] > 0.0
    assert ghi[-1] == 0.0  # fully after sunset


def test_clear_sky_means_reject_an_empty_interval_and_bad_sampling():
    at = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
    assert clear_sky_means(BERLIN, at, at) == (0.0, 0.0)
    assert clear_sky_means(BERLIN, at, at - timedelta(hours=1)) == (0.0, 0.0)
    with pytest.raises(ValueError):
        clear_sky_means(BERLIN, at, at + timedelta(hours=1), samples=0)

"""Tests for the solar-geometry backbone of the PV model."""

from __future__ import annotations

from datetime import datetime, timezone

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.solar import (
    angle_of_incidence_cos,
    clear_sky_ghi,
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

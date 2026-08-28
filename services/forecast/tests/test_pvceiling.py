"""The clear-sky ceiling: what it clips, what it must never clip, its knobs."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from voltpilot_forecast.domain import GeoLocation, PlantSpec, SiteForecastConfig
from voltpilot_forecast.pvceiling import (
    DEFAULT_CEILING_HEADROOM,
    apply_clear_sky_ceiling,
    ceiling_enabled,
    ceiling_headroom,
    clear_sky_ceiling_kw,
)

PILSTING = GeoLocation(latitude=48.7, longitude=12.65)
DUSK = datetime(2026, 8, 28, 17, 45, tzinfo=timezone.utc)  # 1.9 degrees of sun
NIGHT = datetime(2026, 8, 28, 22, 0, tzinfo=timezone.utc)
NOON = datetime(2026, 6, 21, 11, 0, tzinfo=timezone.utc)


def _config(**kwargs) -> SiteForecastConfig:
    return SiteForecastConfig(
        tenant_id="t",
        site_id="s",
        location=PILSTING,
        plant=PlantSpec(capacity_kwp=100.0, **kwargs),
    )


def test_a_set_sun_is_exactly_zero_and_headroom_cannot_lift_it():
    assert clear_sky_ceiling_kw(_config(), NIGHT, headroom=100.0) == 0.0


def test_dusk_ceiling_is_a_fraction_of_a_kilowatt_on_a_100_kwp_plant():
    assert 0.0 < clear_sky_ceiling_kw(_config(), DUSK) < 1.0


def test_noon_ceiling_leaves_a_real_plant_room_to_produce():
    ceiling = clear_sky_ceiling_kw(_config(), NOON)
    assert 60.0 < ceiling <= 100.0


def test_the_ceiling_never_exceeds_nameplate():
    assert clear_sky_ceiling_kw(_config(), NOON, headroom=10.0) == 100.0


def test_it_is_never_tighter_than_a_horizontal_plane():
    """A plant whose stored orientation is wrong must not be clipped for it.

    A north-facing array at dusk sees no beam at all through its configured
    geometry; the ceiling still allows what a flat panel would make, so a
    mis-recorded east/west roof is not punished for our book-keeping.
    """
    north = clear_sky_ceiling_kw(_config(azimuth_deg=0.0, tilt_deg=60.0), DUSK)
    assert north is not None and north > 0.0


def test_no_plant_means_no_opinion():
    config = SiteForecastConfig(
        tenant_id="t", site_id="s", location=PILSTING, plant=None
    )
    assert clear_sky_ceiling_kw(config, NOON) is None
    assert apply_clear_sky_ceiling(config, [NOON], [999.0]) == [999.0]


def test_apply_only_ever_lowers_a_series():
    config = _config()
    values = [999.0, 0.0, 5.0]
    stamps = [DUSK, DUSK, NIGHT]
    out = apply_clear_sky_ceiling(config, stamps, values)
    assert out[0] < 1.0  # clipped
    assert out[1] == 0.0  # untouched
    assert out[2] == 0.0  # night


def test_the_kill_switch_and_the_headroom_knob():
    assert ceiling_enabled({}) is True
    assert ceiling_enabled({"VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED": "false"}) is False
    assert ceiling_enabled({"VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED": " "}) is True
    with pytest.raises(ValueError):
        ceiling_enabled({"VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED": "maybe"})

    assert ceiling_headroom({}) == DEFAULT_CEILING_HEADROOM
    assert ceiling_headroom({"VOLTPILOT_PV_CLEAR_SKY_HEADROOM": "1.5"}) == 1.5
    with pytest.raises(ValueError):
        # Below 1 it would be a discount on physics, not a margin over it.
        ceiling_headroom({"VOLTPILOT_PV_CLEAR_SKY_HEADROOM": "0.9"})


def test_disabling_the_ceiling_returns_the_series_untouched(monkeypatch):
    monkeypatch.setenv("VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED", "false")
    assert apply_clear_sky_ceiling(_config(), [NIGHT], [42.0]) == [42.0]

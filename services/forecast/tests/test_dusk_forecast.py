"""The Pilsting dusk case (28.08.2026) and the two rules that close it.

Live finding, box ``edge-45gz7da`` at 19:37 local: the plan for 19:45 assumed a
3.04 kW PV SURPLUS while the plant was making 1.3 kW against a 2.7 kW house -
a real 1.4 kW deficit that went to the grid at 25 ct while the battery sat at
92 %. The forecast had claimed ~5.9 kW from a 100 kWp plant at a sun elevation
of 1.9°, where the clear-sky global horizontal irradiance is 6.1 W/m².

Two independent causes, both pinned here against the VERBATIM recorded weather
response (``fixtures/open_meteo_pilsting_2026-08-28.json``):

1. an hourly value labels the PRECEDING hour, and the adapter read the label
   ``floor(t)`` - serving a window centred 30 to 105 minutes in the past, which
   is too LOW every morning and too HIGH every evening;
2. one flat value per hour cannot fall, so the last quarter before sunset
   inherited the first quarter's sunshine.

The clear-sky ceiling (:mod:`voltpilot_forecast.pvceiling`) is the structural
backstop under both, and the only bound on the residual challenger.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from voltpilot_forecast.domain import (
    GeoLocation,
    PlantSpec,
    SiteForecastConfig,
)
from voltpilot_forecast.openmeteo import (
    OpenMeteoWeatherProvider,
    parse_forecast_response,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.pvceiling import clear_sky_ceiling_kw
from voltpilot_forecast.solar import clear_sky_ghi, solar_position

FIXTURE = (
    Path(__file__).parent / "fixtures" / "open_meteo_pilsting_2026-08-28.json"
)
PILSTING = GeoLocation(latitude=48.7, longitude=12.65)
TENANT = "00000000-0000-0000-0000-000000000001"
SITE = "00000000-0000-0000-0000-000000000002"
RUN_AT = datetime(2026, 8, 28, 17, 30, tzinfo=timezone.utc)
#: Local time that day was UTC+2 (MESZ); sunset ~20:05 local = 18:05 UTC.
MESZ = timedelta(hours=2)


def _provider() -> OpenMeteoWeatherProvider:
    body = FIXTURE.read_text(encoding="utf-8")
    return OpenMeteoWeatherProvider(
        forecast=parse_forecast_response(body, TENANT, SITE, RUN_AT)
    )


def _config(capacity_kwp: float = 100.0) -> SiteForecastConfig:
    return SiteForecastConfig(
        tenant_id=TENANT,
        site_id=SITE,
        location=PILSTING,
        plant=PlantSpec(capacity_kwp=capacity_kwp),
    )


def _slots(first_local_hhmm: str, count: int) -> list[datetime]:
    hh, mm = (int(x) for x in first_local_hhmm.split(":"))
    start = datetime(2026, 8, 28, hh, mm, tzinfo=timezone.utc) - MESZ
    return [start + timedelta(minutes=15 * i) for i in range(count)]


def _forecast(slots: list[datetime], capacity_kwp: float = 100.0) -> list[float]:
    return PhysicalPvForecaster(weather=_provider()).power_series(
        _config(capacity_kwp), slots
    )


# ---- the incident --------------------------------------------------------


def test_the_dusk_hour_never_exceeds_its_own_clear_sky_ceiling():
    """19:30-20:30 local: every quarter at or under what the sun can deliver."""
    slots = _slots("19:30", 5)
    config = _config()
    for ts, kw in zip(slots, _forecast(slots)):
        ceiling = clear_sky_ceiling_kw(config, ts)
        assert kw <= ceiling + 1e-9, (
            f"{(ts + MESZ):%H:%M} local: {kw:.3f} kW over a {ceiling:.3f} kW ceiling"
        )


def test_the_1945_slot_that_invented_a_surplus_is_now_a_deficit():
    """The exact slot from the incident, with its exact plant and weather.

    Before: ~5.9 kW forecast, i.e. a 3.0 kW surplus over the 2.7 kW house.
    After: far below the house load, so the plan sees the deficit that was real.
    """
    (slot,) = _slots("19:45", 1)
    position = solar_position(PILSTING, slot)
    assert position.elevation_deg == pytest.approx(1.9, abs=0.2)
    assert clear_sky_ghi(position) == pytest.approx(6.1, abs=0.5)

    (kw,) = _forecast([slot])
    house_kw = 2.7
    assert kw < 1.0, f"still claiming {kw:.2f} kW at 1.9 degrees of sun"
    assert kw - house_kw < 0.0, "the slot must read as a deficit, not a surplus"


def test_generation_is_exactly_zero_once_the_sun_is_down():
    """Sunset ~20:05 local; from 20:15 on the answer is 0, not a small share."""
    for ts, kw in zip(_slots("20:15", 6), _forecast(_slots("20:15", 6))):
        assert solar_position(PILSTING, ts).elevation_deg < 0.0
        assert kw == 0.0, f"{(ts + MESZ):%H:%M} local claimed {kw} kW after sunset"


def test_the_last_hour_before_sunset_falls_monotonically():
    """A flat hour mean cannot fall; a solar-shaped one must."""
    slots = _slots("19:00", 5)
    values = _forecast(slots)
    assert values[0] > 0.0
    for earlier, later in zip(values, values[1:]):
        assert later <= earlier + 1e-9, f"dusk rose: {values}"


# ---- cause 1: the hour label ---------------------------------------------


def test_the_hour_label_covers_the_preceding_hour_not_the_following_one():
    """A slot reads the bucket that CONTAINS it, whatever its label says.

    17:45 UTC lies in ``[17:00, 18:00)``, which the fixture labels ``18:00``
    (23 W/m²) - not ``17:00`` (87 W/m², the mean of 16:00-17:00 and the value
    the old adapter served).
    """
    provider = _provider()
    hourly = json.loads(FIXTURE.read_text(encoding="utf-8"))["hourly"]
    by_label = dict(zip(hourly["time"], hourly["shortwave_radiation"]))
    assert (by_label["2026-08-28T17:00"], by_label["2026-08-28T18:00"]) == (87.0, 23.0)

    quarters = [
        datetime(2026, 8, 28, 17, m, tzinfo=timezone.utc) for m in (0, 15, 30, 45)
    ]
    served = [s.ghi_w_m2 for s in provider.irradiance(PILSTING, quarters)]
    assert sum(served) / 4 == pytest.approx(23.0, abs=1e-9)
    assert max(served) < 87.0


def test_the_offset_bit_the_morning_in_the_opposite_direction():
    """Same bug, other sign: the old floor label starved sunrise.

    07:00-07:45 local sat on the 05:00 UTC label (12 W/m², a quarter hour of
    sun) while their own bucket is the 06:00 one (108 W/m²).
    """
    provider = _provider()
    slots = _slots("07:00", 4)
    served = [s.ghi_w_m2 for s in provider.irradiance(PILSTING, slots)]
    assert sum(served) / 4 == pytest.approx(108.0, abs=1e-9)
    assert min(served) > 12.0
    # And it climbs, because the sun does.
    assert served == sorted(served)


def test_a_naive_timestamp_is_read_as_utc_not_as_local_time():
    """The MESZ/UTC trap: nothing here may guess a wall-clock zone."""
    provider = _provider()
    aware = datetime(2026, 8, 28, 17, 45, tzinfo=timezone.utc)
    naive = datetime(2026, 8, 28, 17, 45)
    assert provider.irradiance(PILSTING, [naive])[0].ghi_w_m2 == pytest.approx(
        provider.irradiance(PILSTING, [aware])[0].ghi_w_m2
    )


# ---- cause 2 / the backstop ----------------------------------------------


def test_the_ceiling_would_have_caught_the_incident_on_its_own():
    """Even fed the old, misaligned irradiance, the plan cannot reach 5.9 kW."""
    (slot,) = _slots("19:45", 1)
    ceiling = clear_sky_ceiling_kw(_config(), slot)
    assert ceiling < 1.0, f"a {ceiling:.2f} kW ceiling would have let 5.88 kW through"


def test_the_ceiling_is_a_no_op_in_broad_daylight():
    """It must never clip real production - only impossible production."""
    slots = _slots("12:00", 8)
    config = _config()
    for ts, kw in zip(slots, _forecast(slots)):
        assert kw < clear_sky_ceiling_kw(config, ts)


def test_a_site_without_a_plant_gets_no_opinion():
    config = SiteForecastConfig(
        tenant_id=TENANT, site_id=SITE, location=PILSTING, plant=None
    )
    (slot,) = _slots("12:00", 1)
    assert clear_sky_ceiling_kw(config, slot) is None

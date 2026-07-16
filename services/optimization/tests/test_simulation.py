"""Unit tests for the Ersparnis-Simulation building blocks (offline, no DB,
no solver needed): load profiles, the greedy standard battery (§5 vectors),
price expansion/gap policy, archive weather parsing, request validation."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from voltpilot_optimization.domain import BatteryParams
from voltpilot_optimization.simulation import profiles
from voltpilot_optimization.simulation.archive import (
    ArchiveWeatherError,
    ArchiveWeatherProvider,
    ArchiveWeatherSource,
    cache_key,
    parse_archive_response,
)
from voltpilot_optimization.simulation.data import (
    MissingPricesError,
    expand_price_rows,
    year_slot_starts,
)
from voltpilot_optimization.simulation.greedy import greedy_dispatch
from voltpilot_optimization.simulation.request import (
    InvalidRequest,
    battery_for_size,
    default_year,
    parse_request,
)
from voltpilot_forecast.domain import GeoLocation


def make_battery(**overrides) -> BatteryParams:
    kwargs = dict(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
    )
    kwargs.update(overrides)
    return BatteryParams(**kwargs)


# ---------------------------------------------------------------------------
# Slot grid
# ---------------------------------------------------------------------------


def test_year_slot_grid_covers_the_berlin_calendar_year():
    slots = year_slot_starts(2025)
    assert len(slots) == 365 * 96  # DST cancels out within the Berlin year
    # Jan 1 00:00 Berlin = Dec 31 23:00 UTC (winter offset +1).
    assert slots[0] == datetime(2024, 12, 31, 23, 0, tzinfo=timezone.utc)
    assert len(year_slot_starts(2024)) == 366 * 96  # leap year


# ---------------------------------------------------------------------------
# Load profile
# ---------------------------------------------------------------------------


def test_household_profile_scales_exactly_and_has_the_double_hump():
    slots = year_slot_starts(2025)
    series = profiles.load_series_kw("haushalt", slots, 4500.0)
    assert sum(series) * 0.25 == pytest.approx(4500.0, rel=1e-9)
    assert all(v > 0 for v in series)
    # Evening beats 3 a.m. on a weekday (double-hump shape); index Jan 2.
    by_hour = {}
    for start, value in zip(slots[96:192], series[96:192]):
        by_hour[start.astimezone(profiles.BERLIN).hour] = value
    assert by_hour[19] > 2 * by_hour[3]
    assert by_hour[7] > by_hour[3]


def test_household_profile_has_seasonal_and_weekend_modulation():
    slots = year_slot_starts(2025)
    series = profiles.load_series_kw("haushalt", slots, 4500.0)
    january = [v for s, v in zip(slots, series) if s.astimezone(profiles.BERLIN).month == 1]
    june = [v for s, v in zip(slots, series) if s.astimezone(profiles.BERLIN).month == 6]
    assert sum(january) / len(january) > sum(june) / len(june)


def test_unknown_profile_is_rejected_in_german():
    slots = year_slot_starts(2025)[:96]
    with pytest.raises(profiles.UnknownProfileError, match="Lastprofil"):
        profiles.load_series_kw("gewerbe", slots, 4500.0, env={})


def test_bdew_h25_stays_behind_the_flag_until_licensing_is_settled(tmp_path):
    slots = year_slot_starts(2025)[:96]
    # Without the env flag the profile id is refused (never silently bundled).
    with pytest.raises(profiles.UnknownProfileError):
        profiles.load_series_kw("bdew-h25", slots, 4500.0, env={})
    # With an operator-provided file it becomes available and scales exactly.
    path = tmp_path / "h25.json"
    path.write_text(json.dumps({"slots": [1.0] * 96}), encoding="utf-8")
    series = profiles.load_series_kw(
        "bdew-h25", slots, 4500.0, env={"SIM_BDEW_H25_JSON": str(path)}
    )
    assert sum(series) * 0.25 == pytest.approx(4500.0)


# ---------------------------------------------------------------------------
# Greedy standard battery (§5 spec vectors)
# ---------------------------------------------------------------------------


def test_greedy_charges_surplus_with_efficiency_split():
    battery = make_battery()
    # One slot of 4 kW surplus: charge 4 kW, SoC gains eta*4*0.25 kWh.
    result = greedy_dispatch(battery, load_kw=[1.0], pv_kw=[5.0])
    eta = battery.one_way_efficiency
    floor = battery.soc_min_kwh
    assert result.battery_kw == [pytest.approx(4.0)]
    assert result.grid_kw == [pytest.approx(0.0)]
    assert result.soc_kwh == [pytest.approx(floor + eta * 4.0 * 0.25)]


def test_greedy_discharges_deficit_and_respects_the_floor():
    battery = make_battery()
    eta = battery.one_way_efficiency
    # Start at floor: nothing to discharge, the whole deficit imports.
    result = greedy_dispatch(battery, load_kw=[3.0], pv_kw=[0.0])
    assert result.battery_kw == [pytest.approx(0.0)]
    assert result.grid_kw == [pytest.approx(3.0)]
    # Charge a slot first, then the deficit discharges (bounded by content).
    result = greedy_dispatch(battery, load_kw=[0.0, 3.0], pv_kw=[8.0, 0.0])
    stored = eta * 5.0 * 0.25  # first slot charged at the 5-kW cap
    assert result.battery_kw[0] == pytest.approx(5.0)  # power cap binds
    assert result.grid_kw[0] == pytest.approx(-3.0)  # rest exports
    deliverable = stored * eta / 0.25
    assert result.battery_kw[1] == pytest.approx(-min(3.0, deliverable))


def test_greedy_never_grid_charges_and_respects_soc_ceiling():
    battery = make_battery(capacity_kwh=1.0, max_charge_kw=5.0, max_discharge_kw=5.0)
    load = [0.0] * 8
    pv = [5.0] * 8
    result = greedy_dispatch(battery, load, pv)
    # SoC never exceeds the 95% ceiling and charging only ever uses surplus.
    assert max(result.soc_kwh) <= battery.soc_max_kwh + 1e-9
    assert all(b <= 5.0 + 1e-9 for b in result.battery_kw)
    assert all(g <= 0.0 + 1e-9 for g in result.grid_kw)  # never imports to charge
    # Once full, the surplus exports fully.
    assert result.battery_kw[-1] == pytest.approx(0.0, abs=1e-9)
    assert result.grid_kw[-1] == pytest.approx(-5.0)


def test_greedy_honors_backup_reserve_as_floor():
    battery = make_battery(backup_reserve_pct=50.0)
    result = greedy_dispatch(battery, load_kw=[5.0] * 4, pv_kw=[0.0] * 4)
    # Start = floor = 5 kWh (50%); nothing may discharge below it.
    assert all(b == pytest.approx(0.0) for b in result.battery_kw)


# ---------------------------------------------------------------------------
# Price expansion + gap policy
# ---------------------------------------------------------------------------


def _slots(n: int, start: datetime | None = None):
    start = start or datetime(2025, 6, 1, tzinfo=timezone.utc)
    return [start + i * timedelta(minutes=15) for i in range(n)]


def test_expand_pt60m_rows_and_15min_wins():
    slots = _slots(8)
    rows = [
        (slots[0], "PT60M", 100.0),
        (slots[4], "PT60M", 200.0),
        (slots[4], "PT15M", 150.0),  # 15-min beats the hourly row
    ]
    prices = expand_price_rows(rows, slots)
    assert prices == [100.0] * 4 + [150.0, 200.0, 200.0, 200.0]


def test_small_gaps_fill_with_last_price_but_large_gaps_fail():
    slots = _slots(96)
    rows = [(s, "PT15M", 50.0) for i, s in enumerate(slots) if i != 10]
    prices = expand_price_rows(rows, slots)
    assert len(prices) == 96
    assert prices[10] == 50.0  # filled with the last known price
    # A 4-hour hole (16 slots) exceeds the 3-h gap policy even when overall
    # coverage stays above the threshold (10 days, one hole).
    slots = _slots(960)
    rows = [(s, "PT15M", 50.0) for i, s in enumerate(slots) if not 100 <= i < 116]
    with pytest.raises(MissingPricesError, match="Lücke"):
        expand_price_rows(rows, slots)


def test_insufficient_coverage_names_the_backfill_command():
    slots = _slots(96)
    rows = [(s, "PT15M", 50.0) for s in slots[:40]]
    with pytest.raises(MissingPricesError, match="backfill"):
        expand_price_rows(rows, slots)


# ---------------------------------------------------------------------------
# Archive weather
# ---------------------------------------------------------------------------


def _archive_body():
    return json.dumps(
        {
            "hourly": {
                "time": ["2025-06-01T10:00", "2025-06-01T11:00", "2025-06-01T12:00"],
                "shortwave_radiation": [500.0, None, 700.0],
                "direct_radiation": [400.0, 100.0, 550.0],
                "diffuse_radiation": [100.0, 50.0, 150.0],
            }
        }
    )


def test_parse_archive_maps_hours_and_skips_null_ghi():
    index = parse_archive_response(_archive_body())
    ten = datetime(2025, 6, 1, 10, tzinfo=timezone.utc)
    assert index[ten].ghi_w_m2 == 500.0
    assert index[ten].dni_w_m2 == 400.0
    assert datetime(2025, 6, 1, 11, tzinfo=timezone.utc) not in index


def test_archive_provider_repeats_hourly_sample_per_quarter_hour():
    provider = ArchiveWeatherProvider(index=parse_archive_response(_archive_body()))
    location = GeoLocation(52.5, 13.4)
    ts = [
        datetime(2025, 6, 1, 10, m, tzinfo=timezone.utc) for m in (0, 15, 30, 45)
    ] + [datetime(2025, 6, 1, 11, 15, tzinfo=timezone.utc)]
    samples = provider.irradiance(location, ts)
    assert [s.ghi_w_m2 for s in samples] == [500.0] * 4 + [0.0]


def test_archive_source_caches_per_rounded_coordinates():
    class CountingHttp:
        def __init__(self):
            self.calls = 0

        def get(self, url, params, timeout):
            self.calls += 1
            from voltpilot_forecast.http import HttpResponse

            return HttpResponse(200, _archive_body())

    http = CountingHttp()
    source = ArchiveWeatherSource(http_client=http)
    source.hourly_irradiance(52.52, 13.41, 2025)
    source.hourly_irradiance(52.48, 13.44, 2025)  # rounds to the same 0.1 deg cell
    assert http.calls == 1
    assert cache_key(52.52, 13.41, 2025) == cache_key(52.48, 13.44, 2025)
    source.hourly_irradiance(53.5, 10.0, 2025)
    assert http.calls == 2


def test_archive_garbage_rejected():
    with pytest.raises(ArchiveWeatherError):
        parse_archive_response("not json")
    with pytest.raises(ArchiveWeatherError):
        parse_archive_response(json.dumps({"hourly": {"time": []}}))


# ---------------------------------------------------------------------------
# Request validation
# ---------------------------------------------------------------------------


def _valid_doc():
    return {
        "year": 2025,
        "plant": {"pvKwp": 10.0, "latitude": 52.52, "longitude": 13.41},
        "consumption": {"annualKwh": 4500},
        "tariff": {"tarifArt": "dynamisch", "tarifParamCtKwh": 17.0},
        "battery": {"capacityKwh": 10.0, "maxChargeKw": 5.0, "maxDischargeKw": 5.0},
    }


def test_parse_request_defaults_and_sweep():
    request = parse_request(_valid_doc())
    assert request.year == 2025
    assert request.zone == "DE-LU"
    assert request.profile == "haushalt"
    assert request.battery.roundtrip_efficiency == pytest.approx(0.92)
    assert request.battery.wear_cost_ct_per_kwh == pytest.approx(4.0)
    assert request.netzladen_erlaubt is False
    # Default sweep: 0.5/1/1.5/2 x base capacity, base always included.
    assert request.size_sweep_kwh == (5.0, 10.0, 15.0, 20.0)


def test_parse_request_rejects_bad_inputs_in_german():
    doc = _valid_doc()
    doc["year"] = default_year() + 1  # the running year is not a full year
    with pytest.raises(InvalidRequest, match="Kalenderjahr"):
        parse_request(doc)
    doc = _valid_doc()
    del doc["consumption"]
    with pytest.raises(InvalidRequest, match="Jahresverbrauch"):
        parse_request(doc)
    doc = _valid_doc()
    doc["battery"]["socMinPct"] = 96.0
    with pytest.raises(InvalidRequest, match="SoC-Band"):
        parse_request(doc)
    doc = _valid_doc()
    doc["sizeSweep"] = [1, 2, 3, 4, 5, 6, 7]
    with pytest.raises(InvalidRequest, match="Höchstens"):
        parse_request(doc)


def test_cache_key_is_stable_and_input_sensitive():
    a = parse_request(_valid_doc()).cache_key()
    b = parse_request(_valid_doc()).cache_key()
    assert a == b
    doc = _valid_doc()
    doc["battery"]["capacityKwh"] = 12.0
    assert parse_request(doc).cache_key() != a


def test_battery_for_size_scales_power_but_keeps_base_asset():
    base = make_battery(wear_cost_ct_per_kwh=8.0)
    same = battery_for_size(base, 10.0)
    assert same is base
    bigger = battery_for_size(base, 20.0)
    assert bigger.capacity_kwh == 20.0
    assert bigger.max_charge_kw == pytest.approx(10.0)
    assert bigger.wear_cost_ct_per_kwh == pytest.approx(8.0)

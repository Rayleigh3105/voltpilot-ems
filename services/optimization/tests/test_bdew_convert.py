"""bdew-convert: the operator's official BDEW xlsx -> SIM_BDEW_H25_JSON.

All fixtures here are SYNTHETIC: they mimic the real publication's layout
(month-datetime header row, SA/FT/WT day-type row, 96 quarter-hour rows,
values normalized to ~1 Mio kWh/year) with made-up, uniquely decodable
numbers - no value from the real BDEW workbook is committed. The converter
WAS run against the captain-provided official file locally (H25/2025:
35,040 slots, 999,900 kWh pre-scale annual energy vs the 1-Mio-kWh
normalization; all five sheets within 0.4%) - that verification stays
outside the repo by design.
"""

from __future__ import annotations

import json
from datetime import date, datetime

import pytest

openpyxl = pytest.importorskip("openpyxl")

from voltpilot_optimization.cli import main as cli_main
from voltpilot_optimization.simulation import profiles
from voltpilot_optimization.simulation.bdew_convert import (
    BdewConvertError,
    ProfileTable,
    convert,
    day_type_for,
    dynamization_factor,
    expand_year,
    read_profile_table,
)
from voltpilot_optimization.simulation.data import year_slot_starts

DAY_TYPE_CODE = {"SA": 1.0, "FT": 2.0, "WT": 3.0}


def soy(day: date, quarter: int) -> int:
    """The adapter's wall-clock slot-of-year index (see bdew_convert's DST
    docstring): (day_of_year - 1) * 96 + quarter_of_day."""
    return (day.timetuple().tm_yday - 1) * 96 + quarter


def synthetic_value(month: int, day_type: str, quarter: int) -> float:
    """Uniquely decodable synthetic kWh value, mean ~28.6 so a synthetic year
    lands near the 1-Mio-kWh normalization the validation asserts."""
    return 28.0 + month * 0.02 + DAY_TYPE_CODE[day_type] * 0.15 + quarter * 0.002


def synthetic_workbook(path, sheet_names=("H25", "G25")) -> str:
    """A tiny workbook mimicking the real publication's layout."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name in sheet_names:
        ws = wb.create_sheet(name)
        ws.cell(row=1, column=1, value="Synthetisch")
        ws.cell(row=1, column=5, value="normiert auf 1 Mio kWh Jahresverbrauch")
        ws.cell(row=4, column=2, value="[kWh]")
        col = 3
        for month in range(1, 13):
            for day_type in ("SA", "FT", "WT"):
                ws.cell(row=3, column=col, value=datetime(2012, month, 1))
                ws.cell(row=4, column=col, value=day_type)
                for quarter in range(96):
                    ws.cell(
                        row=5 + quarter,
                        column=col,
                        value=synthetic_value(month, day_type, quarter),
                    )
                col += 1
        for quarter in range(96):
            start_h, start_m = quarter // 4, (quarter % 4) * 15
            end = (quarter + 1) % 96
            end_h, end_m = end // 4, (end % 4) * 15
            ws.cell(
                row=5 + quarter,
                column=2,
                value=f"{start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}",
            )
    wb.create_sheet("Dynamisierung").cell(row=1, column=1, value="Dynamisches Profil")
    out = str(path / "synthetic_bdew.xlsx")
    wb.save(out)
    return out


@pytest.fixture()
def xlsx(tmp_path) -> str:
    return synthetic_workbook(tmp_path)


def test_parse_recovers_the_month_daytype_quarter_structure(xlsx):
    table = read_profile_table(xlsx, "H25")
    assert set(table.values) == {(m, dt) for m in range(1, 13) for dt in ("SA", "FT", "WT")}
    assert all(len(v) == 96 for v in table.values.values())
    assert table.value(3, "WT", 40) == pytest.approx(synthetic_value(3, "WT", 40))
    assert table.value(12, "SA", 0) == pytest.approx(synthetic_value(12, "SA", 0))
    assert table.value(1, "FT", 95) == pytest.approx(synthetic_value(1, "FT", 95))


def test_parse_rejects_missing_sheet_and_unknown_profile(xlsx):
    with pytest.raises(BdewConvertError, match="Blatt 'P25' fehlt"):
        read_profile_table(xlsx, "P25")
    with pytest.raises(BdewConvertError, match="Unbekanntes Profil"):
        read_profile_table(xlsx, "H0")


def test_parse_rejects_negative_and_non_numeric_cells(tmp_path):
    path = synthetic_workbook(tmp_path, sheet_names=("H25",))
    wb = openpyxl.load_workbook(path)
    wb["H25"].cell(row=10, column=5, value=-1.0)
    wb.save(path)
    with pytest.raises(BdewConvertError, match="negativer Wert"):
        read_profile_table(path, "H25")
    wb = openpyxl.load_workbook(path)
    wb["H25"].cell(row=10, column=5, value="kaputt")
    wb.save(path)
    with pytest.raises(BdewConvertError, match="kein Zahlenwert"):
        read_profile_table(path, "H25")


def test_day_types_cover_weekday_saturday_sunday_holiday_and_silvester_rule():
    assert day_type_for(date(2025, 6, 16)) == "WT"  # ordinary Monday
    assert day_type_for(date(2025, 6, 7)) == "SA"  # Saturday
    assert day_type_for(date(2025, 6, 8)) == "FT"  # a Sunday
    assert day_type_for(date(2025, 6, 9)) == "FT"  # Pfingstmontag (a Monday)
    assert day_type_for(date(2025, 5, 1)) == "FT"  # Tag der Arbeit (a Thursday)
    assert day_type_for(date(2025, 4, 21)) == "FT"  # Ostermontag (Gauss Easter)
    # Classic VDEW rule: Dec 24/31 count as Saturday unless they are a Sunday.
    assert day_type_for(date(2025, 12, 24)) == "SA"  # a Wednesday
    assert day_type_for(date(2025, 12, 31)) == "SA"  # a Wednesday
    assert day_type_for(date(2023, 12, 24)) == "FT"  # a Sunday stays Sunday
    assert day_type_for(date(2022, 12, 24)) == "SA"  # a real Saturday stays SA


def test_dynamization_factor_is_the_published_h0_polynomial_rounded_to_4():
    for t in (1, 60, 183, 365, 366):
        raw = -3.92e-10 * t**4 + 3.20e-7 * t**3 - 7.02e-5 * t**2 + 2.10e-3 * t + 1.24
        assert dynamization_factor(t) == pytest.approx(round(raw, 4), abs=1e-12)
    assert dynamization_factor(1) > 1.2  # winter above average
    assert dynamization_factor(183) < 0.85  # summer below average


def test_expansion_maps_slots_by_wall_clock_date_and_quarter(xlsx):
    table = read_profile_table(xlsx, "G25")  # static: no factor arithmetic
    weights = expand_year(table, 2025)
    assert len(weights) == 365 * 96 == 35040
    # 2025-03-14 is an ordinary Friday (WT) in March.
    quarter = 12 * 4 + 2  # 12:30
    assert weights[soy(date(2025, 3, 14), quarter)] == pytest.approx(
        synthetic_value(3, "WT", quarter) / 0.25
    )
    # A Saturday and a holiday pick their day-type columns.
    assert weights[soy(date(2025, 3, 15), 0)] == pytest.approx(
        synthetic_value(3, "SA", 0) / 0.25
    )
    assert weights[soy(date(2025, 5, 1), 40)] == pytest.approx(
        synthetic_value(5, "FT", 40) / 0.25
    )


def test_dst_days_realize_92_and_100_slots_through_the_adapter(xlsx, tmp_path):
    """End to end with the shipped adapter: the wall-clock slots array yields
    92 physical slots on the spring-forward day (the 02:00-02:45 entries are
    never read) and 100 on the fall-back day (those entries read twice)."""
    out = tmp_path / "g25.json"
    assert cli_main(
        ["bdew-convert", xlsx, "--profile", "G25", "--year", "2025", "--out", str(out)]
    ) == 0
    slot_starts = year_slot_starts(2025)
    series = profiles.load_series_kw(
        "bdew-h25", slot_starts, 4500.0, env={"SIM_BDEW_H25_JSON": str(out)}
    )
    locals_ = [s.astimezone(profiles.BERLIN) for s in slot_starts]
    spring = [i for i, l in enumerate(locals_) if l.date() == date(2025, 3, 30)]
    fall = [i for i, l in enumerate(locals_) if l.date() == date(2025, 10, 26)]
    assert len(spring) == 92
    assert len(fall) == 100
    # Spring forward: local 02:00-02:45 never exists on the switch day, and
    # right across the gap the profile continues with the 03:00 row (quarter
    # 12) after the 01:45 row (quarter 7). 2025-03-30 is a Sunday -> FT.
    assert not [i for i in spring if locals_[i].hour == 2]
    i0145 = next(i for i in spring if locals_[i].hour == 1 and locals_[i].minute == 45)
    i0300 = next(i for i in spring if locals_[i].hour == 3 and locals_[i].minute == 0)
    assert i0300 == i0145 + 1
    assert series[i0300] / series[i0145] == pytest.approx(
        synthetic_value(3, "FT", 12) / synthetic_value(3, "FT", 7)
    )
    # Fall back: local 02:00-02:45 occur twice and read the same entries.
    two_oclock = [i for i in fall if locals_[i].hour == 2 and locals_[i].minute == 0]
    assert len(two_oclock) == 2
    assert series[two_oclock[0]] == pytest.approx(series[two_oclock[1]])
    # The rescaling is exact over the slots actually realized.
    assert sum(series) * 0.25 == pytest.approx(4500.0)


def test_leap_year_expands_feb29_from_the_february_columns(xlsx):
    static = read_profile_table(xlsx, "G25")
    weights = expand_year(static, 2024)
    assert len(weights) == 366 * 96 == 35136
    idx = soy(date(2024, 2, 29), 48)  # a Thursday -> WT, February columns
    assert weights[idx] == pytest.approx(synthetic_value(2, "WT", 48) / 0.25)
    # The dynamized twin multiplies the SAME lookup by the day-60 factor.
    dynamized = read_profile_table(xlsx, "H25")
    assert expand_year(dynamized, 2024)[idx] == pytest.approx(
        synthetic_value(2, "WT", 48) / 0.25 * dynamization_factor(60)
    )
    # Dec 31 of a leap year dynamizes with t = 366.
    last = soy(date(2024, 12, 31), 95)  # a Tuesday, but VDEW rule -> SA
    assert expand_year(dynamized, 2024)[last] == pytest.approx(
        synthetic_value(12, "SA", 95) / 0.25 * dynamization_factor(366)
    )


def test_dynamization_applies_to_h25_but_not_g25(xlsx):
    h25 = expand_year(read_profile_table(xlsx, "H25"), 2025)
    g25 = expand_year(read_profile_table(xlsx, "G25"), 2025)
    jan = soy(date(2025, 1, 14), 48)  # a Tuesday
    jul = soy(date(2025, 7, 15), 48)  # a Tuesday
    # Static profile: same day type + quarter differ only by the month delta.
    assert g25[jan] == pytest.approx(synthetic_value(1, "WT", 48) / 0.25)
    assert g25[jul] == pytest.approx(synthetic_value(7, "WT", 48) / 0.25)
    # Dynamized profile: the seasonal factor rides on top (winter > summer).
    assert h25[jan] == pytest.approx(
        synthetic_value(1, "WT", 48) / 0.25 * dynamization_factor(14)
    )
    assert h25[jul] == pytest.approx(
        synthetic_value(7, "WT", 48) / 0.25 * dynamization_factor(196)
    )
    assert h25[jan] / g25[jan] > h25[jul] / g25[jul]


def test_convert_validates_slot_count_energy_sum_and_reports(xlsx):
    document, report = convert(xlsx, "H25", 2025)
    assert len(document["slots"]) == 35040
    assert document["profile"] == "H25"
    assert document["year"] == 2025
    assert report.slots == 35040
    assert report.dynamized is True
    assert 0 < report.min_weight <= report.mean_weight <= report.max_weight
    assert report.annual_kwh_prescale == pytest.approx(1_000_000, rel=0.02)
    assert report.day_type_days["WT"] + report.day_type_days["SA"] + report.day_type_days["FT"] == 365
    assert report.weekday_sunday_ratio > 0


def test_validation_rejects_a_table_off_the_publication_normalization():
    from voltpilot_optimization.simulation.bdew_convert import _validate

    values = {
        (m, dt): [1000.0] * 96 for m in range(1, 13) for dt in ("SA", "FT", "WT")
    }
    table = ProfileTable(profile="G25", values=values)
    with pytest.raises(BdewConvertError, match="Jahresenergie"):
        _validate("G25", 2025, expand_year(table, 2025))
    with pytest.raises(BdewConvertError, match="Slot-Anzahl"):
        _validate("G25", 2025, [28.6] * 100)


def test_cli_round_trip_feeds_the_profiles_adapter(xlsx, tmp_path, capsys):
    out = tmp_path / "h25.json"
    rc = cli_main(["bdew-convert", xlsx, "--year", "2025", "--out", str(out)])
    assert rc == 0
    stderr = capsys.readouterr().err
    assert "slots: 35040" in stderr
    doc = json.loads(out.read_text())
    assert len(doc["slots"]) == 35040

    slots = year_slot_starts(2025)
    series = profiles.load_series_kw(
        "bdew-h25", slots, 4500.0, env={"SIM_BDEW_H25_JSON": str(out)}
    )
    assert len(series) == 35040
    assert sum(series) * 0.25 == pytest.approx(4500.0)
    # The adapter preserves the converter's shape exactly (pure rescaling by
    # wall-clock slot index): a winter and a summer instant scale identically.
    scale = series[0] / doc["slots"][0]
    summer = soy(date(2025, 8, 5), 60)  # a Tuesday 15:00, after the DST shift
    idx = next(
        i
        for i, s in enumerate(year_slot_starts(2025))
        if s.astimezone(profiles.BERLIN).month == 8
        and s.astimezone(profiles.BERLIN).day == 5
        and s.astimezone(profiles.BERLIN).hour == 15
        and s.astimezone(profiles.BERLIN).minute == 0
    )
    assert series[idx] == pytest.approx(doc["slots"][summer] * scale)


def test_cli_reports_a_clean_error_for_a_missing_file(tmp_path, capsys):
    rc = cli_main(
        ["bdew-convert", str(tmp_path / "fehlt.xlsx"), "--year", "2025", "--out", "-"]
    )
    assert rc == 2
    assert "bdew-convert:" in capsys.readouterr().err

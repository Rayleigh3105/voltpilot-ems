"""German nationwide holidays: fixed dates, Easter-derived movable feasts."""

from __future__ import annotations

from datetime import date

from voltpilot_forecast.holidays import (
    easter_sunday,
    german_holidays,
    is_german_holiday,
)


def test_easter_sunday_known_years():
    # Reference values from the Gregorian computus.
    assert easter_sunday(2024) == date(2024, 3, 31)
    assert easter_sunday(2025) == date(2025, 4, 20)
    assert easter_sunday(2026) == date(2026, 4, 5)
    assert easter_sunday(2027) == date(2027, 3, 28)


def test_movable_feasts_2026():
    holidays = german_holidays(2026)
    assert date(2026, 4, 3) in holidays    # Karfreitag
    assert date(2026, 4, 6) in holidays    # Ostermontag
    assert date(2026, 5, 14) in holidays   # Christi Himmelfahrt (Easter + 39)
    assert date(2026, 5, 25) in holidays   # Pfingstmontag (Easter + 50)


def test_fixed_holidays_and_ordinary_days():
    assert is_german_holiday(date(2026, 1, 1))     # Neujahr
    assert is_german_holiday(date(2026, 5, 1))     # Tag der Arbeit
    assert is_german_holiday(date(2026, 10, 3))    # Deutsche Einheit
    assert is_german_holiday(date(2026, 12, 25))
    assert is_german_holiday(date(2026, 12, 26))
    assert not is_german_holiday(date(2026, 7, 2))   # an ordinary Thursday
    assert not is_german_holiday(date(2026, 12, 24))  # Heiligabend is NOT statutory
    assert len(german_holidays(2026)) == 9

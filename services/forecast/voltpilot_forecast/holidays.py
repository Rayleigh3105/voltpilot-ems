"""German nationwide public holidays (dependency-free).

The load-challenger features include a holiday flag: German household/C&I load
on a public holiday behaves like a Sunday, which a pure calendar feature set
(slot-of-day, day-of-week) systematically misses. v1 covers the NINE holidays
that are law in every Bundesland; state-specific ones (Allerheiligen, Fronleichnam,
...) are future work alongside per-tenant regions.

Movable feasts derive from Easter via the Gauss/Anonymous Gregorian algorithm -
exact for the Gregorian calendar, no table, no dependency.
"""

from __future__ import annotations

from datetime import date, timedelta


def easter_sunday(year: int) -> date:
    """Easter Sunday (Gregorian) via the Anonymous Gregorian algorithm."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def german_holidays(year: int) -> frozenset[date]:
    """The nationwide German public holidays of ``year``."""
    easter = easter_sunday(year)
    return frozenset(
        {
            date(year, 1, 1),                      # Neujahr
            easter - timedelta(days=2),            # Karfreitag
            easter + timedelta(days=1),            # Ostermontag
            date(year, 5, 1),                      # Tag der Arbeit
            easter + timedelta(days=39),           # Christi Himmelfahrt
            easter + timedelta(days=50),           # Pfingstmontag
            date(year, 10, 3),                     # Tag der Deutschen Einheit
            date(year, 12, 25),                    # 1. Weihnachtstag
            date(year, 12, 26),                    # 2. Weihnachtstag
        }
    )


_CACHE: dict[int, frozenset[date]] = {}


def is_german_holiday(day: date) -> bool:
    """Whether ``day`` is a nationwide German public holiday."""
    holidays = _CACHE.get(day.year)
    if holidays is None:
        holidays = german_holidays(day.year)
        _CACHE[day.year] = holidays
    return day in holidays

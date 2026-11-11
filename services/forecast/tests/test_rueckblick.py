"""Tests for the S3 Rückblick pure helpers (am Vortag erwartet vs. gemessen)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from voltpilot_forecast.rueckblick import abendlauf_ziel, naechster_lauf, tageskwh
from voltpilot_forecast.rueckblick_repository import (
    InMemoryRueckblickRepository,
    RueckblickRecord,
)

BERLIN = ZoneInfo("Europe/Berlin")


def test_abendlauf_ziel_is_1745_berlin_of_the_day_before():
    tag_start = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)  # Berlin midnight (summer: 22:00 UTC Vortag)
    ziel = abendlauf_ziel(tag_start)
    lokal = ziel.astimezone(BERLIN)
    assert lokal.date() == date(2026, 6, 30)
    assert (lokal.hour, lokal.minute) == (17, 45)


def test_naechster_lauf_picks_the_closest_never_the_newer_on_a_tie():
    ziel = datetime(2026, 6, 30, 15, 45, tzinfo=timezone.utc)
    frueher = ziel - timedelta(minutes=5)
    spaeter = ziel + timedelta(minutes=5)
    # Gleicher Abstand (5 min) - der frühere gewinnt, nie der neuere.
    assert naechster_lauf([spaeter, frueher], ziel) == frueher
    # Außerhalb der Toleranz (15 min): kein Treffer.
    weit = ziel + timedelta(minutes=30)
    assert naechster_lauf([weit], ziel) is None
    assert naechster_lauf([], ziel) is None
    # Der näher gelegene gewinnt, auch wenn er nicht der neueste ist.
    nah = ziel + timedelta(minutes=2)
    fern = ziel - timedelta(minutes=10)
    assert naechster_lauf([fern, nah], ziel) == nah


def test_tageskwh_sums_only_paired_quarter_hours():
    t0 = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)
    predicted = {
        t0: 4.0,
        t0 + timedelta(minutes=15): 4.0,
        t0 + timedelta(minutes=30): 4.0,  # kein gemessener Gegenpart - zählt nicht
    }
    actual = {
        t0: 3.0,
        t0 + timedelta(minutes=15): 5.0,
        t0 + timedelta(minutes=45): 2.0,  # kein prognostizierter Gegenpart - zählt nicht
    }
    erwartet_kwh, gemessen_kwh, n_slots = tageskwh(predicted, actual)
    assert n_slots == 2
    assert abs(erwartet_kwh - (4.0 + 4.0) * 0.25) < 1e-9
    assert abs(gemessen_kwh - (3.0 + 5.0) * 0.25) < 1e-9


def test_tageskwh_clips_negative_values_at_zero():
    t0 = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)
    erwartet_kwh, gemessen_kwh, n_slots = tageskwh({t0: -2.0}, {t0: -1.0})
    assert n_slots == 1
    assert erwartet_kwh == 0.0
    assert gemessen_kwh == 0.0


def test_inmemory_repository_upserts_by_the_table_pk():
    repo = InMemoryRueckblickRepository()
    day = date(2026, 7, 1)
    first = RueckblickRecord(
        day=day, tenant_id="t", site_id="s", kind="load", model="load-persistence",
        lead_days=1, erwartet_kwh=10.0, gemessen_kwh=9.0, mae_kw=0.3, n_slots=90,
    )
    repo.upsert(first)
    again = RueckblickRecord(
        day=day, tenant_id="t", site_id="s", kind="load", model="load-persistence",
        lead_days=1, erwartet_kwh=11.0, gemessen_kwh=9.5, mae_kw=0.25, n_slots=91,
    )
    repo.upsert(again)
    assert len(repo.rows) == 1
    key = ("s", "load", "load-persistence", day, 1)
    assert repo.rows[key].erwartet_kwh == 11.0

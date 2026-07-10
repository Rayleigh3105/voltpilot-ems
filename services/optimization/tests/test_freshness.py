"""Telemetry freshness windows (F4 freshness half, proposal P4).

One stale ``grid_limit_kw`` reading used to become a PERMANENT symmetric cap on
every future plan (a single historical 4.2 kW section-14a event forced 67% PV
curtailment at positive prices in the critique's reproduction), and a battery
that stopped reporting kept planning from yesterday's SoC. These tests drive
the REAL ``gather_inputs`` SQL against a fake in-memory psycopg (the
test_active_model pattern) and prove: a stale reading is ignored (no cap /
default SoC) and flagged, a fresh one is used, and the windows are
env-configurable. Also covers the per-asset wear override resolution in
``load_battery_sites``.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.inputs import (
    BatterySite,
    DEFAULT_SOC_PCT,
    gather_inputs,
    load_battery_sites,
)

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
RUN_AT = NOW - timedelta(minutes=5)
SLOTS = 16  # == MIN_HORIZON_SLOTS, the smallest plannable horizon


class _FakeCursor:
    """Answers gather_inputs' actual queries from in-memory tables."""

    def __init__(self, readings: dict[str, tuple[datetime, float]]) -> None:
        self._readings = readings
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(NOW, SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 100.0) for ts in self.slot_starts]
        elif "max(run_at)" in sql and "FROM forecast" in sql:
            self._rows = [(RUN_AT,)]
        elif "FROM forecast" in sql:
            self._rows = [(ts, 1.0) for ts in self.slot_starts]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            # The _fresh_measurement latest-reading query: newest row that
            # carries the column, WITHOUT a time bound (windowing is in code).
            column = sql.split("SELECT time, ")[1].split(" FROM")[0]
            reading = self._readings.get(column)
            self._rows = [reading] if reading is not None else []
        elif "FROM telemetry" in sql:
            self._rows = []  # no fallback history
        else:  # pragma: no cover - unexpected query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def readings(monkeypatch) -> dict[str, tuple[datetime, float]]:
    table: dict[str, tuple[datetime, float]] = {}

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor(table)

    module = SimpleNamespace(connect=lambda dsn: _Conn())
    monkeypatch.setitem(sys.modules, "psycopg", module)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)
    monkeypatch.delenv("OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES", raising=False)
    monkeypatch.delenv("OPTIMIZER_SOC_MAX_AGE_MINUTES", raising=False)
    monkeypatch.delenv("OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH", raising=False)
    return table


def _site() -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0,
            max_charge_kw=5.0,
            max_discharge_kw=5.0,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=True,
    )


def test_fresh_grid_limit_is_applied(readings):
    readings["grid_limit_kw"] = (NOW - timedelta(minutes=5), 4.2)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.grid_limit_kw == 4.2


def test_stale_grid_limit_means_no_active_limit(readings, caplog):
    # The F4 poison: a 2-hour-old section-14a reading (default window 60 min)
    # must NOT cap the plan - and the discard is flagged, not silent.
    readings["grid_limit_kw"] = (NOW - timedelta(hours=2), 4.2)
    with caplog.at_level("WARNING"):
        inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.grid_limit_kw is None
    assert any("stale_reading_ignored" in r.message for r in caplog.records)


def test_grid_limit_window_is_env_configurable(readings, monkeypatch):
    readings["grid_limit_kw"] = (NOW - timedelta(hours=2), 4.2)
    monkeypatch.setenv("OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES", "240")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.grid_limit_kw == 4.2


def test_fresh_soc_is_used(readings):
    readings["soc_pct"] = (NOW - timedelta(minutes=30), 80.0)
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.initial_soc_kwh == pytest.approx(8.0)  # 80% of 10 kWh


def test_stale_soc_falls_back_to_the_default(readings, caplog):
    # 3 hours old vs. the 120-min default window: plan from the neutral 50%
    # default, never from yesterday's value - and flag it.
    readings["soc_pct"] = (NOW - timedelta(hours=3), 80.0)
    with caplog.at_level("WARNING"):
        inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.initial_soc_kwh == pytest.approx(DEFAULT_SOC_PCT / 100.0 * 10.0)
    assert any("stale_reading_ignored" in r.message for r in caplog.records)


def test_soc_window_is_env_configurable(readings, monkeypatch):
    readings["soc_pct"] = (NOW - timedelta(hours=3), 80.0)
    monkeypatch.setenv("OPTIMIZER_SOC_MAX_AGE_MINUTES", "360")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.initial_soc_kwh == pytest.approx(8.0)


def test_no_reading_at_all_keeps_the_old_defaults(readings):
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.grid_limit_kw is None
    assert inp.initial_soc_kwh == pytest.approx(5.0)


# ---- per-asset wear override resolution (load_battery_sites) -----------------


class _SitesCursor:
    def __init__(self, wear_ct, backup_reserve=None, soc_min=None, soc_max=None) -> None:
        self._wear_ct = wear_ct
        self._backup_reserve = backup_reserve
        self._soc_min = soc_min
        self._soc_max = soc_max
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        assert "FROM asset" in sql
        assert "a.wear_cost_ct_per_kwh" in sql
        assert "s.tarif_art" in sql  # the P1 pricing master data is read too
        assert "s.backup_reserve_soc_pct" in sql  # the P11 reserve is read too
        assert "a.soc_min_pct" in sql  # the admin-tunable SoC band is read too
        self._rows = [
            (
                TENANT, SITE, uuid4(), "DE-LU",
                10.0, 5.0, 5.0, 92.0, True, None, None, self._wear_ct,
                "eigenverbrauch", "ohne", None, None, None, None,
                self._backup_reserve,
                self._soc_min, self._soc_max,
            )
        ]

    def fetchall(self):
        return self._rows


def _wire_sites(monkeypatch, wear_ct, backup_reserve=None, soc_min=None, soc_max=None):
    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _SitesCursor(wear_ct, backup_reserve, soc_min, soc_max)

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )


def test_null_asset_wear_falls_back_to_the_platform_default(monkeypatch):
    _wire_sites(monkeypatch, None)
    monkeypatch.delenv("OPTIMIZER_WEAR_COST_CT_PER_KWH", raising=False)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.wear_cost_ct_per_kwh == 4.0

    monkeypatch.setenv("OPTIMIZER_WEAR_COST_CT_PER_KWH", "2.5")
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.wear_cost_ct_per_kwh == 2.5


def test_asset_wear_override_beats_the_platform_default(monkeypatch):
    _wire_sites(monkeypatch, 7.75)
    monkeypatch.setenv("OPTIMIZER_WEAR_COST_CT_PER_KWH", "2.5")
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.wear_cost_ct_per_kwh == 7.75


def test_backup_reserve_column_resolves_to_the_battery_params(monkeypatch):
    # NULL column -> no reserve (the 5% technical floor applies unchanged).
    _wire_sites(monkeypatch, None)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.backup_reserve_pct is None

    # A configured site.backup_reserve_soc_pct lands on the battery params.
    _wire_sites(monkeypatch, None, backup_reserve=40.0)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.backup_reserve_pct == 40.0


# ---- per-asset SoC band resolution (load_battery_sites) ----------------------


def test_null_soc_band_keeps_the_platform_defaults(monkeypatch):
    _wire_sites(monkeypatch, None)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.soc_min_fraction == 0.05
    assert site.battery.soc_max_fraction == 0.95


def test_configured_soc_band_lands_on_the_battery_params(monkeypatch):
    _wire_sites(monkeypatch, None, soc_min=10.0, soc_max=90.0)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.soc_min_fraction == pytest.approx(0.10)
    assert site.battery.soc_max_fraction == pytest.approx(0.90)

    # One-sided overrides compose with the other side's default.
    _wire_sites(monkeypatch, None, soc_min=20.0)
    [site] = load_battery_sites("postgresql://fake")
    assert site.battery.soc_min_fraction == pytest.approx(0.20)
    assert site.battery.soc_max_fraction == 0.95


def test_inconsistent_soc_band_falls_back_to_defaults_with_a_warning(
    monkeypatch, caplog
):
    # min above the default max (only min set) must not crash the site's run:
    # the platform band applies and the misconfiguration is logged loudly.
    import logging as _logging

    _wire_sites(monkeypatch, None, soc_min=96.0)
    with caplog.at_level(_logging.WARNING):
        [site] = load_battery_sites("postgresql://fake")
    assert site.battery.soc_min_fraction == 0.05
    assert site.battery.soc_max_fraction == 0.95
    assert any("invalid_soc_band" in r.message for r in caplog.records)

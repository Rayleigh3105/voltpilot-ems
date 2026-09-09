"""Telemetry freshness windows (F4 freshness half, proposal P4).

One stale ``grid_limit_kw`` reading used to become a PERMANENT symmetric cap on
every future plan (a single historical 4.2 kW section-14a event forced 67% PV
curtailment at positive prices in the critique's reproduction), and a battery
that stopped reporting kept planning from yesterday's SoC. These tests drive
the REAL ``gather_inputs`` SQL against a fake in-memory psycopg (the
test_active_model pattern) and prove: a stale reading is ignored (no cap / no
Ladestand) and flagged, a fresh one is used, and the windows are
env-configurable. Also covers the per-asset wear override resolution in
``load_battery_sites``.

⚠ Seit P7 (Scout ``vp-deye-diybms-luecke-l5`` §3.3, Captain-Entscheid E4=b)
faellt die SoC-Haelfte NICHT mehr auf ``DEFAULT_SOC_PCT`` zurueck: eine
verworfene Messung heisst „kein Ladestand", und der Optimierer plant den
Speicher dann gar nicht. Die Freschefenster-Regel selbst - die dieses Modul
prueft - ist unveraendert; nur ihre FOLGE ist eine andere. Die Folge selbst
wohnt in ``test_soc_source.py``.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.domain import SOC_SOURCE_UNBEKANNT
from voltpilot_optimization.inputs import (
    BatterySite,
    gather_inputs,
    load_battery_sites,
)

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
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


def test_stale_soc_means_no_ladestand_at_all(readings, caplog):
    # 3 hours old vs. the 120-min default window. Never yesterday's value -
    # and since P7 never the neutral 50% either: a discarded reading leaves
    # the run WITHOUT a Ladestand, so the battery is not planned at all.
    readings["soc_pct"] = (NOW - timedelta(hours=3), 80.0)
    with caplog.at_level("WARNING"):
        inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.soc_source == SOC_SOURCE_UNBEKANNT
    assert inp.initial_soc_kwh != pytest.approx(5.0)  # the old 50%-of-10-kWh
    assert any("stale_reading_ignored" in r.message for r in caplog.records)


def test_soc_window_is_env_configurable(readings, monkeypatch):
    readings["soc_pct"] = (NOW - timedelta(hours=3), 80.0)
    monkeypatch.setenv("OPTIMIZER_SOC_MAX_AGE_MINUTES", "360")
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.initial_soc_kwh == pytest.approx(8.0)


def test_no_reading_at_all_means_no_limit_and_no_ladestand(readings):
    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.grid_limit_kw is None
    # The two halves differ ON PURPOSE. An absent §14a reading means "no limit
    # is active" - a statement the plant's physics backs up. An absent SoC
    # means "we do not know", which is NOT a number (P7).
    assert inp.soc_source == SOC_SOURCE_UNBEKANNT


def test_site_max_feed_in_flows_into_the_optimization_input(readings):
    # FK1: the static connection-point feed-in cap is master data, not
    # telemetry - it flows through gather_inputs unconditionally (no
    # freshness window) and stays None when unconfigured.
    import dataclasses

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)
    assert inp.max_feed_in_kw is None

    capped = dataclasses.replace(_site(), max_feed_in_kw=75.0)
    inp = gather_inputs("postgresql://fake", capped, NOW, SLOTS)
    assert inp.max_feed_in_kw == 75.0


# ---- per-asset wear override resolution (load_battery_sites) -----------------


class _SitesCursor:
    def __init__(
        self, wear_ct, backup_reserve=None, soc_min=None, soc_max=None,
        max_feed_in=None, leistungspreis=None, abrechnung="jahr",
        peak_reserve=None, supply_row=None,
    ) -> None:
        self._wear_ct = wear_ct
        self._backup_reserve = backup_reserve
        self._soc_min = soc_min
        self._soc_max = soc_max
        self._max_feed_in = max_feed_in
        self._leistungspreis = leistungspreis
        self._abrechnung = abrechnung
        self._peak_reserve = peak_reserve
        # None = no site_supply_price row (the LEFT JOIN yields NULLs);
        # else a 7-tuple (netzentgelt, stromsteuer, konzession, umlagen,
        # vertrieb, ust, komponenten_stand).
        self._supply_row = supply_row
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
        assert "s.max_feed_in_kw" in sql  # the FK1 feed-in cap is read too
        assert "s.leistungspreis_eur_kw" in sql  # the PS-1 module is read too
        assert "s.peak_reserve_soc_pct" in sql  # the PS-2 reserve is read too
        # The structured Bezugspreis sheet is read too (site_supply_price):
        assert "LEFT JOIN site_supply_price ssp" in sql
        assert "ssp.netzentgelt_arbeitspreis_ct" in sql
        supply = (
            (SITE,) + self._supply_row
            if self._supply_row is not None
            else (None,) * 8
        )
        self._rows = [
            (
                TENANT, SITE, uuid4(), "DE-LU",
                10.0, 5.0, 5.0, 92.0, True, None, None, self._wear_ct,
                "eigenverbrauch", "ohne", None, None, None, None,
                self._backup_reserve,
                self._soc_min, self._soc_max,
                self._max_feed_in,
                self._leistungspreis, self._abrechnung, self._peak_reserve,
            )
            + supply
        ]

    def fetchall(self):
        return self._rows


def _wire_sites(
    monkeypatch, wear_ct, backup_reserve=None, soc_min=None, soc_max=None,
    max_feed_in=None, leistungspreis=None, abrechnung="jahr", peak_reserve=None,
    supply_row=None,
):
    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _SitesCursor(
                wear_ct, backup_reserve, soc_min, soc_max, max_feed_in,
                leistungspreis, abrechnung, peak_reserve, supply_row,
            )

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


def test_max_feed_in_column_resolves_to_the_battery_site(monkeypatch):
    # NULL column -> no connection-point feed-in cap (FK1).
    _wire_sites(monkeypatch, None)
    [site] = load_battery_sites("postgresql://fake")
    assert site.max_feed_in_kw is None

    # A configured site.max_feed_in_kw lands on the BatterySite.
    _wire_sites(monkeypatch, None, max_feed_in=75.0)
    [site] = load_battery_sites("postgresql://fake")
    assert site.max_feed_in_kw == 75.0


def test_peak_shaving_columns_resolve_to_site_and_battery_params(monkeypatch):
    # NULL leistungspreis -> module off, defaults everywhere (PS-1/PS-2).
    _wire_sites(monkeypatch, None)
    [site] = load_battery_sites("postgresql://fake")
    assert site.leistungspreis_eur_kw is None
    assert site.abrechnung_leistung == "jahr"
    assert site.battery.peak_reserve_pct is None

    # Configured module: LP + billing period on the site, the PS-2 reserve
    # on the BatteryParams (the SoC-floor machinery).
    _wire_sites(
        monkeypatch, None,
        leistungspreis=120.0, abrechnung="monat", peak_reserve=40.0,
    )
    [site] = load_battery_sites("postgresql://fake")
    assert site.leistungspreis_eur_kw == 120.0
    assert site.abrechnung_leistung == "monat"
    assert site.battery.peak_reserve_pct == 40.0


def test_supply_price_row_resolves_to_the_site_tariff(monkeypatch):
    from datetime import date as _date

    # No site_supply_price row (LEFT JOIN NULLs) -> supply_price is None =
    # the legacy import model, byte-identically (rollout rule).
    _wire_sites(monkeypatch, None)
    [site] = load_battery_sites("postgresql://fake")
    assert site.tariff.supply_price is None

    # A maintained row lands on the SiteTariff with every component + USt.
    stand = _date(2026, 1, 1)
    _wire_sites(
        monkeypatch, None,
        supply_row=(7.6, 2.05, 1.59, 2.946, 1.5, 19.0, stand),
    )
    [site] = load_battery_sites("postgresql://fake")
    supply = site.tariff.supply_price
    assert supply is not None
    assert supply.netzentgelt_arbeitspreis_ct == 7.6
    assert supply.stromsteuer_ct == 2.05
    assert supply.konzessionsabgabe_ct == 1.59
    assert supply.umlagen_ct == 2.946
    assert supply.vertriebsaufschlag_ct == 1.5
    assert supply.ust_pct == 19.0
    assert supply.komponenten_stand == stand
    assert supply.components_ct_kwh() == pytest.approx(15.686)

    # A row with partial NULL components maps them as None (contribute 0).
    _wire_sites(
        monkeypatch, None,
        supply_row=(7.6, None, None, 2.946, None, 0.0, None),
    )
    [site] = load_battery_sites("postgresql://fake")
    supply = site.tariff.supply_price
    assert supply.stromsteuer_ct is None
    assert supply.ust_pct == 0.0
    assert supply.components_ct_kwh() == pytest.approx(10.546)


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


def test_sql_column_guards_raise_instead_of_asserting():
    # S15: the f-string column interpolation is guarded by a hard raise, not
    # an assert (which python -O strips) - and it fires before any DB connect.
    from voltpilot_optimization.inputs import _fresh_measurement, _load_history

    with pytest.raises(ValueError, match="DROP TABLE"):
        _load_history("dsn://unused", SITE, "load_kw; DROP TABLE t", NOW)
    with pytest.raises(ValueError, match="load_kw"):
        _fresh_measurement(
            "dsn://unused", SITE, "load_kw", NOW, timedelta(hours=1)
        )

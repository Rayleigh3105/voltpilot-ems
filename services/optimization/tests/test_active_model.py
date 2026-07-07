"""Shadow-mode regression: the optimizer consumes ONLY the active model's rows.

The forecast hypertable now holds every model's runs (baselines + shadow
challengers) tagged with a model id. These tests drive the REAL
``gather_inputs`` SQL against a fake in-memory psycopg that honors the query
parameters, and prove:

* with the default env, the baselines' values reach the optimizer while the
  challengers' (deliberately absurd) values do not - a challenger can never
  influence a plan while in shadow;
* flipping ``VOLTPILOT_ACTIVE_LOAD_MODEL`` (the promotion act) switches the
  consumed rows - and nothing else.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.inputs import BatterySite, gather_inputs

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
RUN_AT = NOW - timedelta(minutes=5)
SLOTS = 16  # == MIN_HORIZON_SLOTS, the smallest plannable horizon

#: value_kw per model - absurd challenger values so leakage is unmistakable.
MODEL_VALUES = {
    ("load", "load-persistence"): 1.0,
    ("load", "load-xgb"): 999.0,
    ("pv", "pv-physical"): 0.5,
    ("pv", "pv-residual-xgb"): 888.0,
}


class _FakeCursor:
    """Answers gather_inputs' actual queries from in-memory tables."""

    def __init__(self) -> None:
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
            site_id, kind, model = params
            assert model, "forecast query must filter on a model id"
            has = (kind, model) in MODEL_VALUES and site_id == SITE
            self._rows = [(RUN_AT if has else None,)]
        elif "FROM forecast" in sql:
            site_id, kind, model, run_at = params
            value = MODEL_VALUES[(kind, model)]
            self._rows = [(ts, value) for ts in self.slot_starts]
        elif "FROM telemetry" in sql:
            self._rows = []  # no fallback history, no soc/grid readings
        else:  # pragma: no cover - unexpected query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor()


@pytest.fixture()
def fake_psycopg(monkeypatch):
    module = SimpleNamespace(connect=lambda dsn: _FakeConnection())
    monkeypatch.setitem(sys.modules, "psycopg", module)
    return module


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


def test_default_env_consumes_only_the_baselines(fake_psycopg, monkeypatch):
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    # Baseline values reach the plan input; challenger values (999/888) never.
    assert inp.load_kw == [1.0] * SLOTS
    assert inp.pv_kw == [0.5] * SLOTS


def test_promotion_flip_switches_the_consumed_model(fake_psycopg, monkeypatch):
    monkeypatch.setenv("VOLTPILOT_ACTIVE_LOAD_MODEL", "load-xgb")
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    assert inp.load_kw == [999.0] * SLOTS  # the promoted challenger
    assert inp.pv_kw == [0.5] * SLOTS      # PV stays on its baseline


def test_typoed_active_model_fails_loudly_instead_of_reverting_to_baseline(
    fake_psycopg, monkeypatch
):
    # A promotion typo (wrong hyphen/underscore) must NOT silently find zero rows
    # and drop back to the persistence baseline while the portal shows the
    # challenger as live - it must raise, exactly like the forecast-side sibling.
    monkeypatch.setenv("VOLTPILOT_ACTIVE_LOAD_MODEL", "load_xgb")
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)

    with pytest.raises(ValueError, match="load_xgb"):
        gather_inputs("postgresql://fake", _site(), NOW, SLOTS)


def test_wrong_kind_active_model_is_rejected(fake_psycopg, monkeypatch):
    # A PV model id configured under the LOAD env is a misconfiguration, not a
    # silent baseline fallback.
    monkeypatch.setenv("VOLTPILOT_ACTIVE_LOAD_MODEL", "pv-physical")
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)

    with pytest.raises(ValueError):
        gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

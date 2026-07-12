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
        elif "FROM forecast" in sql:
            # Per-slot freshest of ONE model (B1: the in-progress first slot
            # exists only in the previous run, so latest-run-only is wrong).
            assert "DISTINCT ON (time)" in sql
            site_id, kind, model, since = params
            assert model, "forecast query must filter on a model id"
            value = MODEL_VALUES.get((kind, model))
            has = value is not None and site_id == SITE
            self._rows = (
                [(ts, value) for ts in self.slot_starts if ts >= since]
                if has
                else []
            )
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


def test_in_progress_first_slot_still_consumes_the_stored_forecast(monkeypatch):
    """B1 companion: since the horizon includes the slot IN PROGRESS, whose
    prediction exists only in the PREVIOUS collector run (a run covers slots
    strictly after its run_at), the read must be freshest-PER-SLOT across
    runs - latest-run-only would miss the first slot and silently drop the
    whole stored forecast to the persistence fallback (zeros here)."""
    slot_starts = horizon_slot_starts(NOW, SLOTS)
    prev_run = NOW - timedelta(minutes=15)
    latest_run = NOW - timedelta(minutes=5)
    # The forecast table: (time, run_at, value) rows for the active models.
    # prev_run covers the whole grid; latest_run starts strictly after NOW,
    # so ONLY prev_run holds the in-progress slot_starts[0].
    table: dict[tuple[str, str], list[tuple]] = {}
    for kind, model, prev_v, latest_v in (
        ("load", "load-persistence", 2.0, 1.0),
        ("pv", "pv-physical", 0.25, 0.5),
    ):
        rows = [(ts, prev_run, prev_v) for ts in slot_starts]
        rows += [(ts, latest_run, latest_v) for ts in slot_starts[1:]]
        table[(kind, model)] = rows

    class _Cursor(_FakeCursor):
        def execute(self, sql, params=()):
            sql_flat = " ".join(sql.split())
            if "FROM forecast" in sql_flat:
                assert "DISTINCT ON (time)" in sql_flat
                site_id, kind, model, since = params
                freshest: dict = {}
                for ts, run_at, value in table.get((kind, model), []):
                    if ts < since:
                        continue
                    if ts not in freshest or run_at > freshest[ts][0]:
                        freshest[ts] = (run_at, value)
                self._rows = sorted(
                    (ts, value) for ts, (_, value) in freshest.items()
                )
            else:
                super().execute(sql, params)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    # First slot covers NOW (B1) and carries the PREVIOUS run's prediction;
    # every future slot carries the latest run's. No fallback zeros anywhere.
    assert inp.slot_starts[0] <= NOW
    assert inp.load_kw == [2.0] + [1.0] * (SLOTS - 1)
    assert inp.pv_kw == [0.25] + [0.5] * (SLOTS - 1)

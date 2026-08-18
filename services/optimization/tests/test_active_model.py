"""Shadow-mode regression: the optimizer consumes ONLY the active model's rows.

The forecast hypertable now holds every model's runs (baselines + shadow
challengers) tagged with a model id. These tests drive the REAL
``gather_inputs`` SQL against a fake in-memory psycopg that honors the query
parameters, and prove:

* with the default env, the baselines' values reach the optimizer while the
  challengers' (deliberately absurd) values do not - a challenger can never
  influence a plan while in shadow;
* flipping ``VOLTPILOT_ACTIVE_LOAD_MODEL`` switches the consumed rows - and
  nothing else;
* since the PORTAL promotion switch (Captain 18.08.2026) a stored row in
  ``forecast_model_choice`` beats the env, and NO row leaves every path
  byte-identical to before the switch existed.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.inputs import BatterySite, SkipSite, gather_inputs

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


#: The stored portal choice the fake DB answers with (rows of (kind, model)).
#: Empty = the pre-switch world: nothing stored, the env decides.
STORED_CHOICE: list[tuple[str, str]] = []


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
        if "FROM forecast_model_choice" in sql:
            CHOICE_QUERIES.append(sql)
            self._rows = list(STORED_CHOICE)
        elif "FROM day_ahead_prices" in sql:
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


#: Every choice query the fake saw - the "read once per cycle" proof.
CHOICE_QUERIES: list[str] = []


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor()

    def rollback(self):  # pragma: no cover - only on the degradation path
        pass


@pytest.fixture()
def fake_psycopg(monkeypatch):
    STORED_CHOICE.clear()
    CHOICE_QUERIES.clear()
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


# ---------------------------------------------------------------------------
# Der Portal-Schalter (Captain 18.08.2026): die Wahl ist ein DATENSATZ.
# Präzedenz: gespeicherte Zeile > Umgebungsvariable > Registry-Default.
# ---------------------------------------------------------------------------

def test_without_a_stored_row_the_plan_input_is_byte_identical(fake_psycopg, monkeypatch):
    """Die Rückwärts-Sicherheit: ohne Zeile ist der Schalter unsichtbar."""
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)
    assert STORED_CHOICE == []

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    assert inp.load_kw == [1.0] * SLOTS
    assert inp.pv_kw == [0.5] * SLOTS


def test_a_stored_choice_beats_the_environment(fake_psycopg, monkeypatch):
    """Genau richtig herum: ein späterer Env-Edit darf die bewusste
    Portal-Entscheidung nicht stillschweigend zurücknehmen."""
    monkeypatch.setenv("VOLTPILOT_ACTIVE_LOAD_MODEL", "load-persistence")
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)
    STORED_CHOICE.extend([("load", "load-xgb"), ("pv", "pv-residual-xgb")])

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    assert inp.load_kw == [999.0] * SLOTS  # der befoerderte Kandidat
    assert inp.pv_kw == [888.0] * SLOTS


def test_a_hand_written_unusable_row_never_reaches_the_plan(fake_psycopg, monkeypatch):
    """Sie wird verworfen, nicht uebernommen - und der Lauf faellt auf die
    Umgebung zurueck statt auf null gespeicherte Prognosezeilen."""
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)
    STORED_CHOICE.append(("load", "pv-physical"))  # art-fremd

    inp = gather_inputs("postgresql://fake", _site(), NOW, SLOTS)

    assert inp.load_kw == [1.0] * SLOTS  # das Basismodell, nie 888/999


def test_the_cycle_reads_the_choice_once_for_the_whole_fleet(fake_psycopg, monkeypatch):
    """Die Wahl ist plattformweit (die Semantik der abgeloesten Env-Variablen),
    also waere ein Read je Anlage N identische Abfragen."""
    from voltpilot_optimization import engine
    from voltpilot_optimization.inputs import load_model_choices

    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)
    STORED_CHOICE.append(("load", "load-xgb"))

    sites = [_site(), _site(), _site()]
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: sites)
    seen: list = []

    def gather(dsn, site, now, horizon_slots, model_choices=None):
        seen.append(model_choices)
        raise SkipSite("nicht plannbar - wir pruefen nur die Weitergabe")

    monkeypatch.setattr(engine, "gather_inputs", gather)
    monkeypatch.setattr(engine, "SkipSite", SkipSite)

    engine.run_cycle("postgresql://fake", None, None, now=NOW)

    assert len(CHOICE_QUERIES) == 1, "eine Abfrage je LAUF, nicht je Anlage"
    assert seen == [{"load": "load-xgb"}] * 3
    # ... und der Einzel-Aufrufer (what-if / on-demand replan) laedt sie selbst.
    assert load_model_choices("postgresql://fake") == {"load": "load-xgb"}

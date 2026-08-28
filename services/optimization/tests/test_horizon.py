"""The 48h planning horizon (Captain-Entscheid 28.08.2026, "Option A").

The window used to be a hard 96 slots. A plan made at 18:30 therefore ended at
18:15 the NEXT day, so the following evening did not exist for it: stored energy
was worth something only in the last 90 minutes of the window, the plan charged
a few kWh, and it curtailed a negative-price midday surplus it could have banked
for an evening it could not see (Pilsting, 28.08.2026). Tomorrow's day-ahead
prices publish around 12:45 and sit in the table long before the horizon needs
them - the data was there, the window was not.

These tests pin the three halves of the fix:

* the LEVER (``OPTIMIZER_HORIZON_SLOTS``, 96 = exact rollback),
* the TRUNCATION rule (``inputs.real_forecast_horizon``) that keeps the window
  on real prices AND real forecasts,
* the EDGE CONTRACT (``publisher.EDGE_PLAN_SLOTS``) staying at 24 h, so a 48h
  plan reaches a device byte-identically to a 24h one.

The economic proof of the whole thing lives in ``test_pilsting_evening.py``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from voltpilot_optimization.config import (
    DEFAULT_HORIZON_SLOTS,
    LEGACY_HORIZON_HOURS_ENV,
    MAX_HORIZON_SLOTS,
    MIN_HORIZON_SLOTS,
    horizon_slots,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    PlanSlot,
    SchedulePlan,
    SLOTS_24H,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import real_forecast_horizon
from voltpilot_optimization.publisher import (
    EDGE_PLAN_SLOTS,
    build_schedule_payload,
)

NOW = datetime(2026, 8, 28, 16, 30, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# The lever
# ---------------------------------------------------------------------------

def test_the_default_horizon_is_48h_and_96_is_the_exact_rollback():
    assert DEFAULT_HORIZON_SLOTS == 192  # 48 h
    assert horizon_slots({}) == 192
    assert horizon_slots({"OPTIMIZER_HORIZON_SLOTS": ""}) == 192
    # The one value an operator needs to restore the pre-28.08. behaviour.
    assert horizon_slots({"OPTIMIZER_HORIZON_SLOTS": "96"}) == SLOTS_24H


@pytest.mark.parametrize(
    "raw",
    ["0", "15", "193", "1000", "-96", "abc", "96.5", "nan", "inf"],
)
def test_a_garbage_horizon_raises_loudly_instead_of_defaulting(raw):
    """The active-model-typo discipline: a value we cannot honour is an error,
    never a silent fallback to the default."""
    with pytest.raises(ValueError, match="OPTIMIZER_HORIZON_SLOTS"):
        horizon_slots({"OPTIMIZER_HORIZON_SLOTS": raw})


def test_the_bounds_are_the_documented_ones():
    assert horizon_slots({"OPTIMIZER_HORIZON_SLOTS": str(MIN_HORIZON_SLOTS)}) == 16
    assert horizon_slots({"OPTIMIZER_HORIZON_SLOTS": str(MAX_HORIZON_SLOTS)}) == 192


# ---------------------------------------------------------------------------
# The truncation rule (pure)
# ---------------------------------------------------------------------------

def _starts(n: int) -> list[datetime]:
    return horizon_slot_starts(NOW, n)


def _covering(starts, n) -> dict:
    return {s: 1.0 for s in starts[:n]}


def test_full_coverage_plans_the_whole_requested_window():
    starts = _starts(192)
    full = _covering(starts, 192)
    assert real_forecast_horizon(starts, full, full) == 192


def test_the_window_ends_where_the_real_forecasts_end():
    """The brief's rule: "wo echte Prognosen enden, endet das Fenster"."""
    starts = _starts(192)
    load = _covering(starts, 192)
    pv = _covering(starts, 140)  # weather feed reaches only 35 h
    assert real_forecast_horizon(starts, load, pv) == 140
    # symmetric - whichever series is shorter decides
    assert real_forecast_horizon(starts, pv, load) == 140


def test_the_intersection_decides_not_the_longer_series():
    starts = _starts(192)
    assert real_forecast_horizon(starts, _covering(starts, 120), _covering(starts, 150)) == 120


def test_the_first_24h_are_never_truncated_so_a_forecastless_site_still_plans():
    """The shipped degradation stays: without stored forecasts the first 96
    slots fall back to the persistence baseline, exactly as before. Truncating
    there would turn a documented degradation into a skipped site."""
    starts = _starts(192)
    assert real_forecast_horizon(starts, {}, {}) == SLOTS_24H
    assert real_forecast_horizon(starts, _covering(starts, 4), {}) == SLOTS_24H


def test_a_gap_ends_the_window_at_the_gap_not_after_it():
    """Contiguity, like the price truncation: a hole is the end of the window,
    never something to plan across."""
    starts = _starts(192)
    holed = {s: 1.0 for i, s in enumerate(starts) if i != 130}
    assert real_forecast_horizon(starts, holed, holed) == 130


def test_the_rule_is_a_provable_no_op_at_the_legacy_request():
    """With a 96-slot request the rule cannot shorten anything - the exact
    rollback property, independent of what the forecasts cover."""
    for covered in (0, 1, 50, 96):
        starts = _starts(96)
        stored = _covering(starts, covered)
        assert real_forecast_horizon(starts, stored, stored) == 96


def test_a_short_priced_window_is_never_extended_by_forecasts():
    """Prices remain the first binding input: forecasts can only SHORTEN."""
    starts = _starts(40)  # prices covered 10 h only
    long_forecast = {s: 1.0 for s in horizon_slot_starts(NOW, 192)}
    assert real_forecast_horizon(starts, long_forecast, long_forecast) == 40


# ---------------------------------------------------------------------------
# The edge contract
# ---------------------------------------------------------------------------

def _plan(n_slots: int) -> SchedulePlan:
    starts = _starts(n_slots)
    return SchedulePlan(
        plan_id=UUID("11111111-1111-1111-1111-111111111111"),
        tenant_id=UUID("33333333-3333-3333-3333-333333333333"),
        site_id=UUID("44444444-4444-4444-4444-444444444444"),
        device_id=UUID("22222222-2222-2222-2222-222222222222"),
        generated_at=NOW,
        battery=BatteryParams(capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0),
        slots=[
            PlanSlot(
                start=s,
                battery_kw=1.0 + i,
                grid_kw=0.0,
                soc_kwh=30.0,
                load_kw=4.0,
                pv_kw=0.0,
                price_eur_mwh=100.0,
                cost_eur=0.0,
                baseline_cost_eur=0.0,
            )
            for i, s in enumerate(starts)
        ],
    )


def test_a_48h_plan_reaches_the_edge_as_a_byte_identical_24h_payload():
    """The contract toward the box is UNCHANGED: same slot count, same bytes.

    This is the whole compatibility argument of the increment - no edge
    release, no schema change, no rollout.
    """
    import json

    long_payload = build_schedule_payload(_plan(192))
    short_payload = build_schedule_payload(_plan(96))
    assert long_payload["horizon_slots"] == EDGE_PLAN_SLOTS == 96
    assert len(long_payload["slots"]) == 96
    assert json.dumps(long_payload, sort_keys=True) == json.dumps(
        short_payload, sort_keys=True
    )


def test_the_published_slots_are_the_first_ones_never_a_sample():
    payload = build_schedule_payload(_plan(192))
    starts = _starts(192)
    assert payload["slots"][0]["start"].startswith(
        starts[0].isoformat().replace("+00:00", "Z")[:16]
    )
    # contiguous quarter hours, no gaps
    stamps = [s["start"] for s in payload["slots"]]
    assert stamps == sorted(stamps)
    first = datetime.fromisoformat(stamps[0].replace("Z", "+00:00"))
    last = datetime.fromisoformat(stamps[-1].replace("Z", "+00:00"))
    assert last - first == timedelta(minutes=15 * 95)


def test_a_short_plan_is_published_whole():
    payload = build_schedule_payload(_plan(40))
    assert payload["horizon_slots"] == 40
    assert len(payload["slots"]) == 40


# ---------------------------------------------------------------------------
# The truncation END TO END, through the real gather_inputs SQL
# ---------------------------------------------------------------------------

import sys  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from voltpilot_optimization.domain import BatteryParams  # noqa: E402
from voltpilot_optimization.inputs import BatterySite, gather_inputs  # noqa: E402

TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")


class _Cursor:
    """Answers gather_inputs' real queries from in-memory coverage counts
    (the ``test_freshness`` fake-psycopg pattern)."""

    def __init__(self, priced: int, forecast: dict[str, int]) -> None:
        self._priced = priced
        self._forecast = forecast
        self._rows: list = []
        self._starts = horizon_slot_starts(NOW, 192)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM day_ahead_prices" in sql:
            self._rows = [
                (ts, "PT15M", 100.0) for ts in self._starts[: self._priced]
            ]
        elif "FROM forecast" in sql:
            kind = params[1]
            self._rows = [
                (ts, 1.0) for ts in self._starts[: self._forecast.get(kind, 0)]
            ]
        elif "FROM telemetry" in sql:
            self._rows = []
        else:  # pragma: no cover - an unhandled query means the SQL changed
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def coverage(monkeypatch):
    """Set ``coverage['priced']`` / ``coverage['load']`` / ``coverage['pv']``."""
    table = {"priced": 192, "load": 192, "pv": 192}

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor(table["priced"], {"load": table["load"], "pv": table["pv"]})

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    for name in (
        "VOLTPILOT_ACTIVE_LOAD_MODEL",
        "VOLTPILOT_ACTIVE_PV_MODEL",
        "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH",
    ):
        monkeypatch.delenv(name, raising=False)
    # The PV anchor issues extra reads this fake does not model; it is a
    # correction, not a horizon input, and it is fail-soft by design.
    monkeypatch.setenv("OPTIMIZER_PV_ANCHOR_ENABLED", "false")
    return table


def _site() -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0
        ),
        netzladen_erlaubt=True,
    )


def _gather(slots: int = 192):
    return gather_inputs("postgresql://fake", _site(), NOW, slots)


def test_full_coverage_plans_48h_end_to_end(coverage):
    assert len(_gather().slot_starts) == 192


def test_prices_30h_forecast_24h_yields_a_24h_window(coverage, caplog):
    """The brief's case (c): the prices reach further than the forecasts, so
    the FORECASTS decide - and the truncation is logged, never silent."""
    coverage["priced"] = 120  # 30 h of day-ahead prices
    coverage["load"] = 96
    coverage["pv"] = 96
    with caplog.at_level("INFO"):
        inp = _gather()
    assert len(inp.slot_starts) == SLOTS_24H
    assert any("horizon.truncated_to_forecast" in r.message for r in caplog.records)


def test_prices_are_still_the_first_binding_input(coverage):
    """Forecasts can only SHORTEN a window, never extend one past its prices."""
    coverage["priced"] = 100
    assert len(_gather().slot_starts) == 100


def test_a_site_without_any_stored_forecast_still_plans_its_24h(coverage):
    """The shipped degradation is untouched: no forecast rows at all means the
    persistence baseline over the first 24 h, not a skipped site."""
    coverage["load"] = 0
    coverage["pv"] = 0
    inp = _gather()
    assert len(inp.slot_starts) == SLOTS_24H
    assert len(inp.load_kw) == SLOTS_24H and len(inp.pv_kw) == SLOTS_24H


def test_a_96_slot_request_is_unaffected_by_forecast_coverage(coverage):
    """The rollback lever end to end: with the legacy request the new
    truncation cannot fire, whatever the forecasts look like."""
    for load_cov, pv_cov in ((0, 0), (40, 96), (96, 96)):
        coverage["load"], coverage["pv"] = load_cov, pv_cov
        assert len(_gather(96).slot_starts) == 96


def test_every_series_of_the_window_has_the_windows_length(coverage):
    """Whatever the truncation lands on, the input stays internally consistent -
    a series shorter than the window would index-error in the solver."""
    coverage["priced"] = 150
    coverage["pv"] = 130
    inp = _gather()
    n = len(inp.slot_starts)
    assert n == 130
    for series in (
        inp.prices_eur_mwh,
        inp.load_kw,
        inp.pv_kw,
        inp.import_price_eur_mwh,
        inp.export_value_eur_mwh,
    ):
        assert len(series) == n


# ---------------------------------------------------------------------------
# The CLI entry point (the productive serve loop's actual resolution)
# ---------------------------------------------------------------------------

from voltpilot_optimization.cli import _resolve_horizon_slots  # noqa: E402


def _args(horizon_hours=None):
    return SimpleNamespace(horizon_hours=horizon_hours)


def test_the_serve_loop_asks_for_the_platform_default():
    assert _resolve_horizon_slots(_args(), {}) == 192
    assert _resolve_horizon_slots(_args(), {"OPTIMIZER_HORIZON_SLOTS": "96"}) == 96


def test_the_cli_flag_stays_the_per_invocation_override():
    assert _resolve_horizon_slots(_args(24.0), {}) == 96
    assert _resolve_horizon_slots(_args(12.0), {"OPTIMIZER_HORIZON_SLOTS": "192"}) == 48


def test_the_cli_delegates_the_alias_to_the_one_resolver():
    """The alias rule lives in ``config.horizon_slots``, not here - the replan
    container reaches the horizon through ``engine.plan_site``, never through
    this CLI, and the two must not be able to disagree."""
    assert _resolve_horizon_slots(_args(), {LEGACY_HORIZON_HOURS_ENV: "24"}) == 96


# ---------------------------------------------------------------------------
# The DEPRECATED OPTIMIZER_HORIZON_HOURS alias
#
# ⚠ Accepted, not refused - and that is a deliberate reversal. The k8s
# manifests carry it TODAY (apps/voltpilot/base/optimization/optimization.env);
# refusing it would have crash-looped the optimization container at the next
# deploy and left the WHOLE fleet without a Fahrplan. A config name is not
# worth a fleet-wide planning outage.
# ---------------------------------------------------------------------------

def test_the_alias_alone_is_honoured_and_warns(caplog):
    with caplog.at_level("WARNING"):
        assert horizon_slots({LEGACY_HORIZON_HOURS_ENV: "24"}) == 96
    assert any(
        "horizon_hours_deprecated" in r.message for r in caplog.records
    ), "an accepted-but-retired name must be LOUD, or nobody ever migrates it"


def test_both_set_and_agreeing_takes_the_slots_value_and_still_warns(caplog):
    env = {LEGACY_HORIZON_HOURS_ENV: "48", "OPTIMIZER_HORIZON_SLOTS": "192"}
    with caplog.at_level("WARNING"):
        assert horizon_slots(env) == 192
    assert any("horizon_hours_deprecated" in r.message for r in caplog.records)


def test_both_set_and_contradicting_aborts_loudly_naming_both():
    """Here refusing IS right: two operators' intents disagree, and silently
    picking one would plan a real fleet on a window nobody chose."""
    env = {LEGACY_HORIZON_HOURS_ENV: "24", "OPTIMIZER_HORIZON_SLOTS": "192"}
    with pytest.raises(ValueError) as exc:
        horizon_slots(env)
    assert LEGACY_HORIZON_HOURS_ENV in str(exc.value)
    assert "OPTIMIZER_HORIZON_SLOTS" in str(exc.value)
    assert "96" in str(exc.value) and "192" in str(exc.value)


@pytest.mark.parametrize("raw", ["abc", "0", "2", "99", "-24", "nan", "24.1"])
def test_garbage_in_the_alias_still_aborts_loudly(raw):
    """Being deprecated does not make a value we cannot honour acceptable -
    it only means the NAME is on its way out. (``2`` h = 8 slots is below the
    16-slot floor; ``24.1`` h = 96.4 is not a whole slot count.)"""
    with pytest.raises(ValueError, match=LEGACY_HORIZON_HOURS_ENV):
        horizon_slots({LEGACY_HORIZON_HOURS_ENV: raw})


def test_a_blank_alias_is_not_set_and_never_bricks_a_boot():
    """An empty passthrough (``${VAR:-}``) is absence, not a contradiction."""
    assert horizon_slots({LEGACY_HORIZON_HOURS_ENV: ""}) == 192
    assert horizon_slots({LEGACY_HORIZON_HOURS_ENV: "  "}) == 192
    assert (
        horizon_slots({LEGACY_HORIZON_HOURS_ENV: "", "OPTIMIZER_HORIZON_SLOTS": "96"})
        == 96
    )


def test_the_cluster_todays_value_keeps_planning_instead_of_crash_looping():
    """The exact production constellation this reversal exists for: the
    manifests set HOURS=24 and nothing else. The container must START."""
    assert horizon_slots({LEGACY_HORIZON_HOURS_ENV: "24"}) == SLOTS_24H

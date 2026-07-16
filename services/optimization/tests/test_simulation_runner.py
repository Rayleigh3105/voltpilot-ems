"""Runner tests: chaining correctness vs a sequential gold run, the
MILP >= greedy invariant, scenario (a) exactness and the result-document
shape (design report §6). Real HiGHS solves over a SHRUNK synthetic "year"
(the year grid is monkeypatched to a few days, so the whole file runs in
seconds); skipped without the solver wheel like the other solver tests."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone

import pytest

from voltpilot_forecast.weather import IrradianceSample

from voltpilot_optimization.domain import BatteryParams
from voltpilot_optimization.simulation import runner as runner_mod
from voltpilot_optimization.simulation.request import parse_request
from voltpilot_optimization.simulation.runner import (
    SimulationDeps,
    assemble_year_data,
    chunk_day_ranges,
    chunk_payloads,
    run_milp_year,
    run_simulation,
    solve_chunk,
)

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

BERLIN = runner_mod.BERLIN
SLOTS_PER_DAY = 96


def small_year_starts(days: int = 4, year: int = 2025, month: int = 1, day: int = 30):
    """A shrunk 'year': N consecutive days starting at a Berlin midnight.
    Starting Jan 30 puts a month boundary inside the range, so the runner's
    month chunking produces more than one chunk."""
    from datetime import timedelta

    start = datetime(year, month, day, tzinfo=BERLIN)
    first = start.astimezone(timezone.utc)
    return [
        first + i * timedelta(minutes=15) for i in range(days * SLOTS_PER_DAY)
    ]


def synthetic_prices(slot_starts) -> list[float]:
    """Cheap nights (20), expensive evenings (240): a clear arbitrage shape."""
    prices = []
    for s in slot_starts:
        hour = s.astimezone(BERLIN).hour
        if 0 <= hour < 6:
            prices.append(20.0)
        elif 18 <= hour < 22:
            prices.append(240.0)
        else:
            prices.append(90.0)
    return prices


def daylight_index(slot_starts):
    """Simple sunny archive: 600 W/m2 GHI from 10:00-15:59 Berlin."""
    index = {}
    for s in slot_starts:
        hour_utc = s.replace(minute=0, second=0, microsecond=0)
        local_hour = s.astimezone(BERLIN).hour
        if 10 <= local_hour < 16:
            index[hour_utc] = IrradianceSample(
                ghi_w_m2=600.0, dni_w_m2=400.0, dhi_w_m2=150.0
            )
    return index


@pytest.fixture
def small_year(monkeypatch):
    slots = small_year_starts(days=4)
    monkeypatch.setattr(runner_mod, "year_slot_starts", lambda year: slots)
    return slots


def use_year(monkeypatch, days: int):
    slots = small_year_starts(days=days)
    monkeypatch.setattr(runner_mod, "year_slot_starts", lambda year: slots)
    return slots


def make_deps(slots, max_workers: int = 1) -> SimulationDeps:
    class FakeWeather:
        def hourly_irradiance(self, latitude, longitude, year):
            return daylight_index(slots)

    return SimulationDeps(
        load_prices=lambda zone, s: synthetic_prices(s),
        load_market_values=lambda months: {},
        weather=FakeWeather(),
        max_workers=max_workers,
    )


def base_request(**tariff_overrides):
    tariff = {"tarifArt": "fest", "tarifParamCtKwh": 32.0}
    tariff.update(tariff_overrides)
    return parse_request(
        {
            "year": 2025,
            "plant": {"pvKwp": 10.0, "latitude": 52.52, "longitude": 13.41},
            "consumption": {"annualKwh": 4500},
            "tariff": tariff,
            "battery": {
                "capacityKwh": 10.0,
                "maxChargeKw": 5.0,
                "maxDischargeKw": 5.0,
            },
            "sizeSweep": [],
        }
    )


def test_month_chunking_splits_at_the_berlin_month_boundary(small_year):
    ranges = chunk_day_ranges(small_year)
    # Jan 30, Jan 31 | Feb 1, Feb 2
    assert ranges == [(0, 2), (2, 4)]


def assert_chunked_matches_gold(slots) -> None:
    """The load-bearing method fact: month chunks with warmup days reproduce
    the single sequential chain (report §1.2 measured -0.03 % on the full
    year; on this small window the tolerance is a few euro cents)."""
    request = base_request()
    deps = make_deps(slots)
    data = assemble_year_data(request, deps)

    chunked = run_milp_year(data, request.battery, False, max_workers=1)

    # Gold: ONE chunk over all days (true SoC carry, no warmup approximation).
    gold_payload = {
        **chunk_payloads(data, request.battery, False)[0],
        "chunk_index": 0,
        "day_start": 0,
        "day_end": data.days,
        "warmup_days": 0,
        "commit_days": data.days,
    }
    # Slot arrays must span the whole extended range for the gold chain.
    from voltpilot_optimization.simulation.runner import _extended, WINDOW_SLOTS
    from datetime import timedelta

    year_delta = data.slot_starts[-1] + timedelta(minutes=15) - data.slot_starts[0]
    ext_starts = data.slot_starts + [
        s + year_delta for s in data.slot_starts[:WINDOW_SLOTS]
    ]
    gold_payload.update(
        {
            "slot_starts": [s.isoformat() for s in ext_starts],
            "spot": _extended(data.spot),
            "load": _extended(data.load_kw),
            "pv": _extended(data.pv_kw),
            "imp": _extended(data.import_eur_mwh),
            "exp": _extended(data.export_eur_mwh),
        }
    )
    gold = solve_chunk(gold_payload)

    from voltpilot_optimization.simulation.runner import slot_costs_eur

    cost_chunked = sum(
        slot_costs_eur(chunked.grid_kw, data.import_eur_mwh, data.export_eur_mwh)
    )
    cost_gold = sum(
        slot_costs_eur(gold["grid_kw"], data.import_eur_mwh, data.export_eur_mwh)
    )
    assert cost_chunked == pytest.approx(cost_gold, abs=0.05)


@pytest.mark.slow
def test_chunked_run_matches_the_sequential_gold_chain(small_year):
    assert_chunked_matches_gold(small_year)


def test_chaining_smoke_three_days_match_the_gold_chain(monkeypatch):
    """CI smoke twin of the slow gold test: 3 chained days across a month
    boundary, so the warmup/commit chunking artefact protection stays guarded
    in the default (`-m 'not slow'`) selection."""
    assert_chunked_matches_gold(use_year(monkeypatch, days=3))


def test_effective_workers_bound_by_chunks_and_cpus(monkeypatch):
    from voltpilot_optimization.simulation.runner import effective_workers

    monkeypatch.setattr(runner_mod, "_available_cpus", lambda: 8)
    assert effective_workers(3, 12) == 3
    assert effective_workers(16, 2) == 2  # never more workers than chunks
    monkeypatch.setattr(runner_mod, "_available_cpus", lambda: 1)
    # A low-core container degrades to the serial path (no pool at all).
    assert effective_workers(3, 12) == 1


# Hard cap: a deadlocked pool must FAIL loudly, never wedge the CI runner
# (the pre-spawn fork pool livelocked exactly here - CI job 2587, >2.5 h).
@pytest.mark.timeout(120)
def test_parallel_chunks_equal_sequential_execution(small_year):
    request = base_request()
    deps = make_deps(small_year)
    data = assemble_year_data(request, deps)
    seq = run_milp_year(data, request.battery, False, max_workers=1)
    par = run_milp_year(data, request.battery, False, max_workers=2)
    assert par.grid_kw == pytest.approx(seq.grid_kw)
    assert par.soc_kwh == pytest.approx(seq.soc_kwh)


def test_run_simulation_result_shape_and_milp_beats_greedy(small_year):
    request = base_request()
    deps = make_deps(small_year)
    progress: list[float] = []
    result = run_simulation(request, deps, lambda p, r: progress.append(p))

    # Document shape per report §6 (German keys).
    scenarios = result["scenarios"]
    assert set(scenarios) == {"ohneSpeicher", "standardSpeicher", "voltpilot"}
    for key in ("kostenEur", "importKwh", "exportKwh", "monatlich"):
        assert key in scenarios["ohneSpeicher"]
    for key in ("wearEur", "vollzyklen", "autarkiegradPct", "abgeregeltKwh"):
        assert key in scenarios["voltpilot"]
    headline = result["headline"]
    assert set(headline) == {
        "gesamtVorteilEur",
        "gesamtVorteilNettoEur",
        "speicherVorteilEur",
        "voltpilotVorteilEur",
        "voltpilotVorteilNettoEur",
    }
    # Headline identities.
    a = scenarios["ohneSpeicher"]["kostenEur"]
    b = scenarios["standardSpeicher"]["kostenEur"]
    c = scenarios["voltpilot"]["kostenEur"]
    assert headline["speicherVorteilEur"] == pytest.approx(a - b, abs=0.02)
    assert headline["voltpilotVorteilEur"] == pytest.approx(b - c, abs=0.02)
    assert headline["gesamtVorteilEur"] == pytest.approx(a - c, abs=0.02)

    # The MILP >= greedy invariant (48h/24h chaining heals the horizon
    # artefact; residual noise is sub-euro on a full year, cents here).
    assert c <= b + 0.10

    # Example days carry the dispatch slots for the Nachvollziehbarkeit view.
    beispiel = result["beispielTage"]
    assert set(beispiel) == {"typisch", "bester"}
    slots = beispiel["bester"]["slots"]
    assert len(slots) == SLOTS_PER_DAY
    assert {"start", "preisEurMwh", "socVoltpilotKwh", "batterieStandardKw"} <= set(
        slots[0]
    )

    # Netzladen variant present (base config is EEG) with the net delta.
    variant = result["netzladenVariante"]
    assert variant is not None
    assert "zusatzVorteilNettoEur" in variant

    # Sweep contains exactly the base size (sizeSweep=[] in the request).
    assert [e["capacityKwh"] for e in result["sizeSweep"]] == [10.0]
    assert result["sizeSweep"][0]["istBasisgroesse"] is True

    # Progress is monotone and ends complete.
    assert progress == sorted(progress)
    assert progress[-1] == 1.0

    # Assumptions footer names the year and the profile honestly.
    annahmen = result["annahmen"]
    assert annahmen["preisjahr"] == "2025"
    assert annahmen["profil"] == "haushalt"
    assert "keine Zusage" in annahmen["hinweis"]

    # The whole document is JSON-serializable (the HTTP layer's contract).
    json.dumps(result)


def test_scenario_a_is_exact_arithmetic(small_year):
    request = base_request()
    deps = make_deps(small_year)
    data = assemble_year_data(request, deps)
    from voltpilot_optimization.simulation.runner import (
        scenario_a_dispatch,
        evaluate,
    )

    outcome = evaluate(data, scenario_a_dispatch(data), None)
    expected = 0.0
    for load, pv, imp, exp in zip(
        data.load_kw, data.pv_kw, data.import_eur_mwh, data.export_eur_mwh
    ):
        grid = load - pv
        expected += (
            (imp * max(grid, 0.0) - exp * max(-grid, 0.0)) * 0.25 / 1000.0
        )
    assert outcome.kosten_eur == pytest.approx(expected, abs=0.01)
    assert outcome.monatlich[0]["monat"] == "2025-01"
    assert outcome.monatlich[-1]["monat"] == "2025-02"


@pytest.mark.slow
def test_netzladen_variant_grid_charges_when_profitable(small_year):
    """With a huge night/evening spread and merchant export, the Netzladen
    variant must actually use the grid to charge (the base EEG run cannot).
    Slow: a second full run_simulation; the variant's presence + headline
    identity stay guarded in CI by the result-shape test above."""
    request = base_request(tarifArt="ohne")  # spot-settled: full spread visible
    deps = make_deps(small_year)
    result = run_simulation(request, deps)
    variant = result["netzladenVariante"]
    base = result["scenarios"]["voltpilot"]
    # The merchant battery cycles at least as much as the EEG one and the
    # variant reports its own economics.
    assert variant["vollzyklen"] >= base["vollzyklen"]
    assert variant["zusatzVorteilNettoEur"] == pytest.approx(
        base["nettoKostenEur"] - variant["nettoKostenEur"], abs=0.02
    )

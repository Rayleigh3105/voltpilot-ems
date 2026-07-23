"""The scenario runner: 3 scenarios x size sweep over the reference year.

Method (design report §1/§5, all measured):

- **(a) ohne Speicher**: arithmetic - ``grid = load - pv``, valued at the
  same asymmetric import/export prices as everything else.
- **(b) Standard-Speicher**: :mod:`voltpilot_optimization.simulation.greedy`,
  wear charged post-hoc at the same preset rate.
- **(c) VoltPilot**: the UNCHANGED production MILP
  (:func:`voltpilot_optimization.solver.optimize`), chained over the year
  with a **48-h window committing 24 h** (MANDATORY - naive 24h/24h chaining
  reproduces the horizon-end artefact, measured -148 EUR/a) and SoC carry.
  Month chunks run in parallel with 2 warmup days solved-and-discarded
  before each chunk (measured equivalence to the sequential gold run:
  -0.03 %); the January chunk starts at the SoC floor with no warmup,
  exactly like the sequential run.
- The year's final days look ahead into a CYCLIC wrap (Jan 1 follows
  Dec 31), so the last committed day plans against a real-shaped tomorrow
  instead of a horizon cliff.

Everything here is pure computation over injected data
(:class:`SimulationDeps`), so tests run fully offline.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Protocol
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from voltpilot_forecast.domain import GeoLocation, PlantSpec, SiteForecastConfig
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.weather import IrradianceSample

from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.pricing import (
    berlin_month,
    export_values,
    import_prices,
    needs_market_values,
)
from voltpilot_optimization.simulation.archive import ArchiveWeatherProvider
from voltpilot_optimization.simulation.greedy import greedy_dispatch
from voltpilot_optimization.simulation.profiles import load_series_kw
from voltpilot_optimization.simulation.request import (
    SimulationRequest,
    battery_for_size,
)
from voltpilot_optimization.simulation.data import year_slot_starts

logger = logging.getLogger("voltpilot.simulation.runner")

BERLIN = ZoneInfo("Europe/Berlin")

SLOT_HOURS = 0.25
SLOTS_PER_DAY = 96
WINDOW_SLOTS = 192  # 48-h lookahead window
WARMUP_DAYS = 2

# The simulation has no tenant; the solver requires ids, so a fixed nil UUID
# stands in (nothing is persisted or published).
NIL = UUID(int=0)


class WeatherSourceLike(Protocol):
    def hourly_irradiance(
        self, latitude: float, longitude: float, year: int
    ) -> dict[datetime, IrradianceSample]: ...


@dataclass
class SimulationDeps:
    """Injected data access so the runner stays offline-testable."""

    load_prices: Callable[[str, list[datetime]], list[float]]
    load_market_values: Callable[[list], dict]
    weather: WeatherSourceLike
    max_workers: int = 1


@dataclass
class Dispatch:
    """A full-year slot-aligned dispatch of one scenario."""

    battery_kw: list[float]
    grid_kw: list[float]
    soc_kwh: list[float]
    curtail_kw: list[float]
    wear_eur: list[float]  # per slot, as the dispatch spent it


@dataclass
class YearData:
    """Everything a scenario evaluation needs, slot-aligned over the year."""

    request: SimulationRequest
    slot_starts: list[datetime]
    spot: list[float]
    load_kw: list[float]
    pv_kw: list[float]
    import_eur_mwh: list[float]
    export_eur_mwh: list[float]
    missing_market_value_months: list[str] = field(default_factory=list)

    @property
    def days(self) -> int:
        return len(self.slot_starts) // SLOTS_PER_DAY


def assemble_year_data(request: SimulationRequest, deps: SimulationDeps) -> YearData:
    """Fetch/compute the year's inputs (prices, PV from archive weather,
    load profile, asymmetric price series)."""
    slot_starts = year_slot_starts(request.year)
    spot = deps.load_prices(request.zone, slot_starts)
    load_kw = load_series_kw(request.profile, slot_starts, request.annual_kwh)
    pv_kw = _pv_series(request, deps, slot_starts)

    market_values: dict = {}
    missing_months: list[str] = []
    if needs_market_values(request.tariff, request.netzladen_erlaubt):
        months = sorted({berlin_month(s) for s in slot_starts})
        market_values = deps.load_market_values(months)
        missing_months = [
            m.isoformat()[:7] for m in months if m not in market_values
        ]
    import_series = import_prices(request.tariff, spot)
    export_series = export_values(
        request.tariff,
        request.netzladen_erlaubt,
        spot,
        slot_starts,
        market_values,
    )
    return YearData(
        request=request,
        slot_starts=slot_starts,
        spot=spot,
        load_kw=load_kw,
        pv_kw=pv_kw,
        import_eur_mwh=import_series,
        export_eur_mwh=export_series,
        missing_market_value_months=missing_months,
    )


def _pv_series(
    request: SimulationRequest, deps: SimulationDeps, slot_starts: list[datetime]
) -> list[float]:
    if request.pv_kwp <= 0:
        return [0.0] * len(slot_starts)
    index = deps.weather.hourly_irradiance(
        request.latitude, request.longitude, request.year
    )
    forecaster = PhysicalPvForecaster(weather=ArchiveWeatherProvider(index=index))
    config = SiteForecastConfig(
        tenant_id="simulation",
        site_id="simulation",
        location=GeoLocation(request.latitude, request.longitude),
        plant=PlantSpec(
            capacity_kwp=request.pv_kwp,
            tilt_deg=request.tilt_deg,
            azimuth_deg=request.azimuth_deg,
        ),
    )
    return forecaster.power_series(config, slot_starts)


def slot_costs_eur(
    grid_kw: list[float],
    import_eur_mwh: list[float],
    export_eur_mwh: list[float],
) -> list[float]:
    """Per-slot signed cashflow (import paid, export credited; negative =
    revenue) - the same rule as OptimizationInput.cashflow_cost_eur."""
    costs = []
    for grid, imp, exp in zip(grid_kw, import_eur_mwh, export_eur_mwh):
        import_kw = max(grid, 0.0)
        export_kw = max(-grid, 0.0)
        costs.append((imp * import_kw - exp * export_kw) * SLOT_HOURS / 1000.0)
    return costs


def post_hoc_wear_eur(battery: BatteryParams, battery_kw: list[float]) -> list[float]:
    """Wear for a dispatch that did NOT price wear itself ((a)/(b)): the same
    preset rate, throughput x ct/2 per direction (report §5 fairness rule)."""
    rate = battery.wear_cost_eur_per_kwh_each_way
    return [rate * abs(b) * SLOT_HOURS for b in battery_kw]


# ---------------------------------------------------------------------------
# Scenario (c): the chained MILP year
# ---------------------------------------------------------------------------


def _extended(series: list[float]) -> list[float]:
    """Cyclic lookahead wrap: the year's first day follows its last."""
    return series + series[:WINDOW_SLOTS]


def solve_chunk(payload: dict) -> dict:
    """Solve one chunk of consecutive days (module-level: process-pool safe).

    ``payload`` carries the chunk's day range plus the slot arrays for
    [warmup_start, chunk_end + lookahead). Warmup days are solved and
    DISCARDED - they only produce a realistic SoC at the chunk start."""
    battery = BatteryParams(**payload["battery"])
    starts = [datetime.fromisoformat(s) for s in payload["slot_starts"]]
    spot = payload["spot"]
    load = payload["load"]
    pv = payload["pv"]
    imp = payload["imp"]
    exp = payload["exp"]
    netzladen = payload["netzladen"]
    warmup_days = payload["warmup_days"]
    commit_days = payload["commit_days"]

    from voltpilot_optimization.solver import optimize

    soc = battery.soc_floor_kwh(battery.soc_max_kwh)
    out_battery: list[float] = []
    out_grid: list[float] = []
    out_soc: list[float] = []
    out_curtail: list[float] = []
    out_wear: list[float] = []
    total_days = warmup_days + commit_days
    for day in range(total_days):
        i0 = day * SLOTS_PER_DAY
        window = slice(i0, i0 + WINDOW_SLOTS)
        inp = OptimizationInput(
            tenant_id=NIL,
            site_id=NIL,
            device_id=None,
            battery=battery,
            slot_starts=starts[window],
            prices_eur_mwh=spot[window],
            load_kw=load[window],
            pv_kw=pv[window],
            initial_soc_kwh=soc,
            netzladen_erlaubt=netzladen,
            import_price_eur_mwh=imp[window],
            export_value_eur_mwh=exp[window],
        )
        # explain_plan=False: the simulation discards every presentation
        # field, and the Fahrplan-Warum LP re-solve (~30 ms/solve) would add
        # real wall-clock over a 365-day chain for nothing.
        plan = optimize(inp, uuid4(), starts[i0], explain_plan=False)
        commit = plan.slots[:SLOTS_PER_DAY]
        soc = commit[-1].soc_kwh
        if day >= warmup_days:
            for s in commit:
                out_battery.append(s.battery_kw)
                out_grid.append(s.grid_kw)
                out_soc.append(s.soc_kwh)
                out_curtail.append(s.curtail_kw)
                out_wear.append(s.wear_cost_eur)
    return {
        "chunk_index": payload["chunk_index"],
        "battery_kw": out_battery,
        "grid_kw": out_grid,
        "soc_kwh": out_soc,
        "curtail_kw": out_curtail,
        "wear_eur": out_wear,
    }


def chunk_day_ranges(slot_starts: list[datetime]) -> list[tuple[int, int]]:
    """Consecutive day-index ranges [start, end) grouped by Berlin calendar
    month - the parallelization unit (12 chunks for a full year)."""
    ranges: list[tuple[int, int]] = []
    days = len(slot_starts) // SLOTS_PER_DAY
    current_month = None
    start = 0
    for day in range(days):
        month = slot_starts[day * SLOTS_PER_DAY].astimezone(BERLIN).month
        if current_month is None:
            current_month = month
        elif month != current_month:
            ranges.append((start, day))
            start = day
            current_month = month
    ranges.append((start, days))
    return ranges


def chunk_payloads(
    data: YearData,
    battery: BatteryParams,
    netzladen: bool,
    export_eur_mwh: list[float] | None = None,
) -> list[dict]:
    """Build the per-chunk solve payloads (pickle-friendly plain dicts)."""
    exp = export_eur_mwh if export_eur_mwh is not None else data.export_eur_mwh
    ext_spot = _extended(data.spot)
    ext_load = _extended(data.load_kw)
    ext_pv = _extended(data.pv_kw)
    ext_imp = _extended(data.import_eur_mwh)
    ext_exp = _extended(exp)
    year_delta = (
        data.slot_starts[-1] + timedelta(minutes=15) - data.slot_starts[0]
    )
    ext_starts = data.slot_starts + [
        s + year_delta for s in data.slot_starts[:WINDOW_SLOTS]
    ]
    battery_kwargs = {
        "capacity_kwh": battery.capacity_kwh,
        "max_charge_kw": battery.max_charge_kw,
        "max_discharge_kw": battery.max_discharge_kw,
        "roundtrip_efficiency": battery.roundtrip_efficiency,
        "soc_min_fraction": battery.soc_min_fraction,
        "soc_max_fraction": battery.soc_max_fraction,
        "wear_cost_ct_per_kwh": battery.wear_cost_ct_per_kwh,
        "backup_reserve_pct": battery.backup_reserve_pct,
    }
    payloads = []
    for chunk_index, (day_start, day_end) in enumerate(chunk_day_ranges(data.slot_starts)):
        warmup = 0 if day_start == 0 else min(WARMUP_DAYS, day_start)
        lo = (day_start - warmup) * SLOTS_PER_DAY
        hi = day_end * SLOTS_PER_DAY + WINDOW_SLOTS
        payloads.append(
            {
                "chunk_index": chunk_index,
                "day_start": day_start,
                "day_end": day_end,
                "warmup_days": warmup,
                "commit_days": day_end - day_start,
                "battery": battery_kwargs,
                "netzladen": netzladen,
                "slot_starts": [s.isoformat() for s in ext_starts[lo:hi]],
                "spot": ext_spot[lo:hi],
                "load": ext_load[lo:hi],
                "pv": ext_pv[lo:hi],
                "imp": ext_imp[lo:hi],
                "exp": ext_exp[lo:hi],
            }
        )
    return payloads


def _available_cpus() -> int:
    """CPUs this process may actually use. ``sched_getaffinity`` respects a
    container cpuset (the CI runner / prod compose case); plain ``cpu_count``
    is the portable fallback (macOS has no affinity API)."""
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 1


def effective_workers(requested: int, chunks: int) -> int:
    """Bound the solver pool: never more workers than chunks or usable CPUs.
    On a low-core container this degrades to 1 = the serial path (no pool at
    all), which is both faster there and immune to pool pathologies."""
    return max(1, min(requested, chunks, _available_cpus()))


def run_milp_year(
    data: YearData,
    battery: BatteryParams,
    netzladen: bool,
    max_workers: int = 1,
    export_eur_mwh: list[float] | None = None,
    on_chunk: Callable[[int, int, "Dispatch | None"], None] | None = None,
) -> Dispatch:
    """Scenario (c) over the whole year: chained 48h/24h chunks.

    ``on_chunk(done, total, partial)`` fires after each finished chunk;
    ``partial`` carries the year-aligned dispatch filled so far (unfinished
    chunk slots hold 0.0) so callers can publish progressive monthly rows.
    """
    payloads = chunk_payloads(data, battery, netzladen, export_eur_mwh)
    n = len(data.slot_starts)
    dispatch = Dispatch(
        battery_kw=[0.0] * n,
        grid_kw=[0.0] * n,
        soc_kwh=[0.0] * n,
        curtail_kw=[0.0] * n,
        wear_eur=[0.0] * n,
    )

    def _merge(result: dict) -> None:
        payload = payloads[result["chunk_index"]]
        base = payload["day_start"] * SLOTS_PER_DAY
        for offset in range(len(result["battery_kw"])):
            i = base + offset
            dispatch.battery_kw[i] = result["battery_kw"][offset]
            dispatch.grid_kw[i] = result["grid_kw"][offset]
            dispatch.soc_kwh[i] = result["soc_kwh"][offset]
            dispatch.curtail_kw[i] = result["curtail_kw"][offset]
            dispatch.wear_eur[i] = result["wear_eur"][offset]

    done = 0
    workers = effective_workers(max_workers, len(payloads))
    if workers <= 1:
        for payload in payloads:
            _merge(solve_chunk(payload))
            done += 1
            if on_chunk:
                on_chunk(done, len(payloads), dispatch)
    else:
        # SPAWN, never fork: by the time a year run starts, this process has
        # live threads (HiGHS/OpenMP from earlier solves, the job-store worker
        # thread). Linux's default fork start method can then deadlock the
        # child on an inherited lock - a real CI wedge (job 2587 ran >2.5 h);
        # spawned children start clean. solve_chunk + its payloads are
        # module-level/picklable, so spawn is a drop-in.
        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as pool:
            futures = [pool.submit(solve_chunk, p) for p in payloads]
            for future in as_completed(futures):
                _merge(future.result())
                done += 1
                if on_chunk:
                    on_chunk(done, len(payloads), dispatch)
    return dispatch


# ---------------------------------------------------------------------------
# Scenario evaluation + result assembly
# ---------------------------------------------------------------------------


def scenario_a_dispatch(data: YearData) -> Dispatch:
    n = len(data.slot_starts)
    return Dispatch(
        battery_kw=[0.0] * n,
        grid_kw=[l - p for l, p in zip(data.load_kw, data.pv_kw)],
        soc_kwh=[0.0] * n,
        curtail_kw=[0.0] * n,
        wear_eur=[0.0] * n,
    )


def scenario_b_dispatch(data: YearData, battery: BatteryParams) -> Dispatch:
    greedy = greedy_dispatch(battery, data.load_kw, data.pv_kw)
    return Dispatch(
        battery_kw=greedy.battery_kw,
        grid_kw=greedy.grid_kw,
        soc_kwh=greedy.soc_kwh,
        curtail_kw=[0.0] * len(greedy.battery_kw),
        wear_eur=post_hoc_wear_eur(battery, greedy.battery_kw),
    )


@dataclass
class Outcome:
    """One scenario's aggregated year economics."""

    kosten_eur: float
    wear_eur: float
    import_kwh: float
    export_kwh: float
    vollzyklen: float | None
    abgeregelt_kwh: float
    eigenverbrauchsquote_pct: float | None
    autarkiegrad_pct: float | None
    monatlich: list[dict]
    slot_costs: list[float] = field(repr=False, default_factory=list)

    @property
    def netto_eur(self) -> float:
        return self.kosten_eur + self.wear_eur


def evaluate(
    data: YearData, dispatch: Dispatch, battery: BatteryParams | None
) -> Outcome:
    costs = slot_costs_eur(dispatch.grid_kw, data.import_eur_mwh, data.export_eur_mwh)
    import_kwh = sum(max(g, 0.0) for g in dispatch.grid_kw) * SLOT_HOURS
    export_kwh = sum(max(-g, 0.0) for g in dispatch.grid_kw) * SLOT_HOURS
    discharge_kwh = sum(-b for b in dispatch.battery_kw if b < 0) * SLOT_HOURS
    curtailed_kwh = sum(dispatch.curtail_kw) * SLOT_HOURS
    pv_kwh = sum(data.pv_kw) * SLOT_HOURS
    load_kwh = sum(data.load_kw) * SLOT_HOURS
    produced_kwh = pv_kwh - curtailed_kwh
    eigenverbrauch = (
        100.0 * max(produced_kwh - export_kwh, 0.0) / produced_kwh
        if produced_kwh > 0
        else None
    )
    autarkie = (
        100.0 * max(1.0 - import_kwh / load_kwh, 0.0) if load_kwh > 0 else None
    )
    monthly: dict[str, dict] = {}
    for i, start in enumerate(data.slot_starts):
        key = start.astimezone(BERLIN).strftime("%Y-%m")
        bucket = monthly.setdefault(
            key,
            {"monat": key, "kostenEur": 0.0, "wearEur": 0.0, "importKwh": 0.0,
             "exportKwh": 0.0},
        )
        bucket["kostenEur"] += costs[i]
        bucket["wearEur"] += dispatch.wear_eur[i]
        bucket["importKwh"] += max(dispatch.grid_kw[i], 0.0) * SLOT_HOURS
        bucket["exportKwh"] += max(-dispatch.grid_kw[i], 0.0) * SLOT_HOURS
    monatlich = [
        {
            "monat": m["monat"],
            "kostenEur": round(m["kostenEur"], 2),
            "wearEur": round(m["wearEur"], 2),
            "importKwh": round(m["importKwh"], 1),
            "exportKwh": round(m["exportKwh"], 1),
        }
        for m in sorted(monthly.values(), key=lambda m: m["monat"])
    ]
    return Outcome(
        kosten_eur=round(sum(costs), 2),
        wear_eur=round(sum(dispatch.wear_eur), 2),
        import_kwh=round(import_kwh, 1),
        export_kwh=round(export_kwh, 1),
        vollzyklen=(
            round(discharge_kwh / battery.capacity_kwh, 1) if battery else None
        ),
        abgeregelt_kwh=round(curtailed_kwh, 1),
        eigenverbrauchsquote_pct=(
            round(eigenverbrauch, 1) if eigenverbrauch is not None else None
        ),
        autarkiegrad_pct=round(autarkie, 1) if autarkie is not None else None,
        monatlich=monatlich,
        slot_costs=costs,
    )


def scenario_json(outcome: Outcome, battery: bool) -> dict:
    doc = {
        "kostenEur": outcome.kosten_eur,
        "importKwh": outcome.import_kwh,
        "exportKwh": outcome.export_kwh,
        "monatlich": outcome.monatlich,
    }
    if battery:
        doc.update(
            {
                "wearEur": outcome.wear_eur,
                "nettoKostenEur": round(outcome.netto_eur, 2),
                "vollzyklen": outcome.vollzyklen,
                "eigenverbrauchsquotePct": outcome.eigenverbrauchsquote_pct,
                "autarkiegradPct": outcome.autarkiegrad_pct,
                "abgeregeltKwh": outcome.abgeregelt_kwh,
            }
        )
    return doc


def example_days(
    data: YearData, standard: Dispatch, voltpilot: Dispatch,
    costs_b: list[float], costs_c: list[float],
) -> dict:
    """The Nachvollziehbarkeit days: 'typisch' = median daily (c)-(b) cash
    advantage, 'bester' = the maximum day (both fall out of the year run)."""
    days = data.days
    daily_adv = []
    for d in range(days):
        s = slice(d * SLOTS_PER_DAY, (d + 1) * SLOTS_PER_DAY)
        daily_adv.append(sum(costs_b[s]) - sum(costs_c[s]))
    order = sorted(range(days), key=lambda d: daily_adv[d])
    typical_day = order[days // 2]
    best_day = order[-1]

    def day_json(d: int) -> dict:
        slots = []
        for i in range(d * SLOTS_PER_DAY, (d + 1) * SLOTS_PER_DAY):
            slots.append(
                {
                    "start": data.slot_starts[i].isoformat(),
                    "preisEurMwh": round(data.spot[i], 2),
                    "loadKw": round(data.load_kw[i], 3),
                    "pvKw": round(data.pv_kw[i], 3),
                    "socVoltpilotKwh": round(voltpilot.soc_kwh[i], 3),
                    "socStandardKwh": round(standard.soc_kwh[i], 3),
                    "batterieVoltpilotKw": round(voltpilot.battery_kw[i], 3),
                    "batterieStandardKw": round(standard.battery_kw[i], 3),
                }
            )
        return {
            "datum": data.slot_starts[d * SLOTS_PER_DAY]
            .astimezone(BERLIN)
            .date()
            .isoformat(),
            "vorteilEur": round(daily_adv[d], 2),
            "slots": slots,
        }

    return {"typisch": day_json(typical_day), "bester": day_json(best_day)}


def run_simulation(
    request: SimulationRequest,
    deps: SimulationDeps,
    publish: Callable[[float, dict], None] | None = None,
) -> dict:
    """The full job: assemble data, run the scenarios + sweep + Netzladen
    variant, return the result document (design report §6).

    ``publish(progress, partial_result)`` fires after every completed stage
    (and every finished month chunk of the base run) so the job store can
    expose progressive results.
    """
    publish = publish or (lambda progress, result: None)
    data = assemble_year_data(request, deps)
    base_battery = request.battery
    sweep_sizes = request.size_sweep_kwh
    netzladen_variant = not request.netzladen_erlaubt

    # Solve-count bookkeeping for the progress fraction: each size costs one
    # chunked year; the Netzladen variant one more.
    chunk_count = len(chunk_day_ranges(data.slot_starts))
    total_chunks = chunk_count * (len(sweep_sizes) + (1 if netzladen_variant else 0))
    finished_chunks = 0

    result: dict = {
        "annahmen": _annahmen(data),
        "scenarios": {},
        "headline": None,
        "sizeSweep": [],
        "netzladenVariante": None,
        "beispielTage": None,
    }

    # (a) + (b) are effectively free - published before the first solve.
    dispatch_a = scenario_a_dispatch(data)
    outcome_a = evaluate(data, dispatch_a, None)
    dispatch_b = scenario_b_dispatch(data, base_battery)
    outcome_b = evaluate(data, dispatch_b, base_battery)
    result["scenarios"]["ohneSpeicher"] = scenario_json(outcome_a, battery=False)
    result["scenarios"]["standardSpeicher"] = scenario_json(outcome_b, battery=True)
    publish(0.02, result)

    def on_chunk_progress(done_in_run: int, run_chunks: int, partial) -> None:
        nonlocal finished_chunks
        finished_chunks += 1
        publish(
            0.02 + 0.97 * (finished_chunks / max(total_chunks, 1)), result
        )

    def base_chunk(done_in_run, run_chunks, partial: Dispatch | None) -> None:
        # Progressive monthly rows for the base run: re-evaluate the partial
        # dispatch (cheap arithmetic) so the month bars fill as chunks land.
        if partial is not None:
            partial_outcome = evaluate(data, partial, base_battery)
            result["scenarios"]["voltpilot"] = scenario_json(
                partial_outcome, battery=True
            )
        on_chunk_progress(done_in_run, run_chunks, partial)

    dispatch_c = run_milp_year(
        data, base_battery, request.netzladen_erlaubt,
        max_workers=deps.max_workers, on_chunk=base_chunk,
    )
    outcome_c = evaluate(data, dispatch_c, base_battery)
    result["scenarios"]["voltpilot"] = scenario_json(outcome_c, battery=True)
    result["headline"] = _headline(outcome_a, outcome_b, outcome_c)
    result["beispielTage"] = example_days(
        data, dispatch_b, dispatch_c, outcome_b.slot_costs, outcome_c.slot_costs
    )
    publish(0.02 + 0.97 * (finished_chunks / max(total_chunks, 1)), result)

    # Größen-Sweep: greedy is free per size; the MILP year per size. The base
    # size reuses the base run.
    sweep_entries = []
    for size in sweep_sizes:
        candidate = battery_for_size(base_battery, size)
        if abs(size - base_battery.capacity_kwh) < 1e-9:
            out_b, out_c = outcome_b, outcome_c
        else:
            out_b = evaluate(
                data, scenario_b_dispatch(data, candidate), candidate
            )
            dispatch = run_milp_year(
                data, candidate, request.netzladen_erlaubt,
                max_workers=deps.max_workers, on_chunk=on_chunk_progress,
            )
            out_c = evaluate(data, dispatch, candidate)
        sweep_entries.append(
            {
                "capacityKwh": size,
                # Net of wear on both sides: the honest Kaufberatung figure.
                "gesamtVorteilEur": round(
                    outcome_a.netto_eur - out_c.netto_eur, 2
                ),
                "voltpilotVorteilEur": round(out_b.netto_eur - out_c.netto_eur, 2),
                "istBasisgroesse": abs(size - base_battery.capacity_kwh) < 1e-9,
            }
        )
        result["sizeSweep"] = sweep_entries
        publish(0.02 + 0.97 * (finished_chunks / max(total_chunks, 1)), result)

    # The Netzladen variant ("Ihr Potenzial mit Netzladen") - computed only
    # when the base configuration is EEG (netzladen off); export re-priced at
    # merchant terms (bare spot), the honest Ausschliesslichkeits-tradeoff.
    if netzladen_variant:
        exp_merchant = export_values(
            request.tariff, True, data.spot, data.slot_starts, {}
        )
        dispatch_nl = run_milp_year(
            data, base_battery, True,
            max_workers=deps.max_workers,
            export_eur_mwh=exp_merchant,
            on_chunk=on_chunk_progress,
        )
        nl_data = YearData(
            request=request,
            slot_starts=data.slot_starts,
            spot=data.spot,
            load_kw=data.load_kw,
            pv_kw=data.pv_kw,
            import_eur_mwh=data.import_eur_mwh,
            export_eur_mwh=exp_merchant,
        )
        outcome_nl = evaluate(nl_data, dispatch_nl, base_battery)
        result["netzladenVariante"] = {
            "kostenEur": outcome_nl.kosten_eur,
            "wearEur": outcome_nl.wear_eur,
            "nettoKostenEur": round(outcome_nl.netto_eur, 2),
            "vollzyklen": outcome_nl.vollzyklen,
            "abgeregeltKwh": outcome_nl.abgeregelt_kwh,
            # vs. the base VoltPilot scenario, net incl. wear: positive =
            # Netzladen would earn more, negative = it would COST (a real
            # outcome for EEG plants - the remuneration is lost, report §1.3).
            "zusatzVorteilNettoEur": round(
                outcome_c.netto_eur - outcome_nl.netto_eur, 2
            ),
        }

    publish(1.0, result)
    return result


def _headline(outcome_a: Outcome, outcome_b: Outcome, outcome_c: Outcome) -> dict:
    """Captain framing (2026-07-16): the big honest number is 'Speicher +
    VoltPilot gegenüber ohne Speicher' (a-c); the 3-way breakdown stays fully
    visible via the scenario cards."""
    return {
        "gesamtVorteilEur": round(outcome_a.kosten_eur - outcome_c.kosten_eur, 2),
        "gesamtVorteilNettoEur": round(
            outcome_a.netto_eur - outcome_c.netto_eur, 2
        ),
        "speicherVorteilEur": round(outcome_a.kosten_eur - outcome_b.kosten_eur, 2),
        "voltpilotVorteilEur": round(outcome_b.kosten_eur - outcome_c.kosten_eur, 2),
        "voltpilotVorteilNettoEur": round(
            outcome_b.netto_eur - outcome_c.netto_eur, 2
        ),
    }


def _annahmen(data: YearData) -> dict:
    doc = {
        "preisjahr": str(data.request.year),
        "zone": data.request.zone,
        "wetter": "open-meteo-archive",
        "profil": data.request.profile,
        "wearCtKwh": data.request.battery.wear_cost_ct_per_kwh,
        "hinweis": (
            f"Simulation auf Basis der echten Börsenpreise und Wetterdaten des "
            f"Jahres {data.request.year}. Typisches Lastprofil, keine Zusage "
            "künftiger Erträge."
        ),
    }
    if data.missing_market_value_months:
        doc["fehlendeMarktwertMonate"] = data.missing_market_value_months
    return doc

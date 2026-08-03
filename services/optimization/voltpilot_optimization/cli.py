"""Manual / cron / long-running entrypoint for the optimization engine.

Mirrors the sibling collectors (market-data, weather):

    python -m voltpilot_optimization plan                 # one cycle, persist+publish
    python -m voltpilot_optimization plan --no-publish    # persist only
    python -m voltpilot_optimization serve                # cycle on startup then every 15 min

The rolling cadence (default 900 s = one slot) means a fresh plan lands well
inside the edge's 20-min schedule-staleness window, and new day-ahead prices
(collector refresh) are picked up within one interval. Wiring is assembled
here (env -> dsn/repository/publisher) so the rest of the package stays
side-effect free.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
from urllib.parse import quote

from voltpilot_optimization.config import v2_plan_site_ids
from voltpilot_optimization.engine import run_cycle
from voltpilot_optimization.persistence import TimescaleScheduleRepository
from voltpilot_optimization.publisher import MqttSchedulePublisher
from voltpilot_optimization.publisher_v2 import MqttPlanV2Publisher
from voltpilot_optimization.runtime import ServeRuntime, serve_health

logger = logging.getLogger("voltpilot.optimization")


def _dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    # The optimizer reads assets/prices/forecasts across tenants and writes
    # plans, so it connects as the trusted backend role (POSTGRES_USER), not the
    # RLS-scoped app role - same as the weather collector.
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    # connect_timeout bounds the connect: without it libpq waits on the OS TCP
    # timeout, and because the cycle is strictly sequential ONE hanging connect
    # blocks every remaining site (and the shutdown handler). See
    # docs/k8s-readiness.md.
    timeout = env.get("POSTGRES_CONNECT_TIMEOUT", "10")
    return (
        f"postgresql://{user}:{password}@{host}:{port}/{db}"
        f"?connect_timeout={quote(timeout, safe='')}"
    )


def _add_common_args(sub: argparse.ArgumentParser) -> None:
    sub.add_argument(
        "--horizon-hours",
        type=float,
        default=float(os.environ.get("OPTIMIZER_HORIZON_HOURS", "24")),
        help="planning horizon in hours (default OPTIMIZER_HORIZON_HOURS, else 24)",
    )
    sub.add_argument(
        "--no-persist",
        action="store_true",
        help="do not write plans into the schedule hypertable",
    )
    sub.add_argument(
        "--no-publish",
        action="store_true",
        help="do not publish plans to the MQTT schedule topics",
    )
    sub.add_argument("--log-level", default="INFO", help="logging level (default INFO)")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-optimization")
    sub = parser.add_subparsers(dest="command", required=True)

    plan = sub.add_parser("plan", help="run one optimization cycle over all battery sites")
    _add_common_args(plan)

    serve = sub.add_parser(
        "serve", help="cycle on startup then periodically (long-running)"
    )
    _add_common_args(serve)
    serve.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.environ.get("OPTIMIZER_INTERVAL_SECONDS", "900")),
        help="seconds between cycles (default OPTIMIZER_INTERVAL_SECONDS, else 900 = one slot)",
    )
    serve.add_argument(
        "--max-cycles",
        type=int,
        default=0,
        help="stop after N cycles (0 = run forever; used by tests)",
    )
    serve.add_argument(
        "--health-port",
        type=int,
        default=int(os.environ.get("OPTIMIZER_HEALTH_PORT", "8096")),
        help="probe endpoint port, /health + /ready (default OPTIMIZER_HEALTH_PORT, "
        "else 8096; 0 disables it)",
    )

    sim = sub.add_parser(
        "simulate-serve",
        help="run the Ersparnis-Simulation HTTP service (internal, async jobs)",
    )
    sim.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SIM_PORT", "8095")),
        help="HTTP port (default SIM_PORT, else 8095)",
    )
    sim.add_argument(
        "--max-workers",
        type=int,
        default=int(os.environ.get("SIM_MAX_WORKERS", "3")),
        help="parallel solver processes per job (default SIM_MAX_WORKERS, else 3)",
    )
    sim.add_argument(
        "--max-what-if",
        type=int,
        default=int(os.environ.get("WHATIF_MAX_CONCURRENT", "2")),
        help="concurrent synchronous what-if re-optimizes (default "
        "WHATIF_MAX_CONCURRENT, else 2; excess calls get 429)",
    )
    sim.add_argument("--log-level", default="INFO", help="logging level (default INFO)")

    convert = sub.add_parser(
        "bdew-convert",
        help="convert the operator-provided official BDEW profile xlsx into "
        "the simulation's SIM_BDEW_H25_JSON file (the workbook is never "
        "bundled - see simulation/bdew_convert.py)",
    )
    convert.add_argument("xlsx", help="path to the official BDEW publication xlsx")
    convert.add_argument(
        "--profile",
        default="H25",
        choices=["H25", "G25", "L25", "P25", "S25"],
        help="profile sheet to convert (default H25)",
    )
    convert.add_argument(
        "--year",
        type=int,
        required=True,
        help="target calendar year to expand onto (the simulation's reference year)",
    )
    convert.add_argument(
        "--out",
        required=True,
        help="output JSON path ('-' = stdout); point SIM_BDEW_H25_JSON at it",
    )
    convert.add_argument("--log-level", default="INFO", help="logging level (default INFO)")
    return parser


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s %(context)s",
    )
    logging.getLogger().handlers[0].addFilter(_ContextDefault())


class _ContextDefault(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "context"):
            record.context = {}
        return True


def _run_one(args, env: dict[str, str]) -> None:
    dsn = _dsn_from_env(env)
    repository = None if args.no_persist else TimescaleScheduleRepository(dsn)
    publisher = None if args.no_publish else MqttSchedulePublisher.from_env(env)
    # v2 shadow publisher (E13a): only worth constructing when at least one
    # site is flagged via VOLTPILOT_V2_PLAN_SITES - and never for --no-publish.
    v2_publisher = None
    if not args.no_publish and v2_plan_site_ids(env):
        v2_publisher = MqttPlanV2Publisher.from_env(env)
    horizon_slots = round(args.horizon_hours * 4)
    summary = run_cycle(
        dsn,
        repository,
        publisher,
        horizon_slots=horizon_slots,
        v2_publisher=v2_publisher,
    )
    print(summary.line())


def _what_if_handler(dsn: str, max_concurrent: int):
    """The synchronous admin re-optimize route's handler (§4.3).

    Bounded on purpose: a what-if is a real MILP solve in the REQUEST thread,
    so an admin leaning on the button (or several admins at once) must never
    starve the simulation jobs sharing this container's CPU budget. Excess
    calls are refused immediately with the job store's TooBusyError, which the
    server maps to 429 - never queued behind a minutes-long year chain.
    """
    from voltpilot_optimization.inputs import gather_inputs, load_battery_sites
    from voltpilot_optimization.simulation.jobs import TooBusyError
    from voltpilot_optimization.whatif import WhatIfDeps, parse_request, run_what_if

    gate = threading.Semaphore(max(max_concurrent, 1))

    def load_site(site_id):
        sites = load_battery_sites(dsn, site_id)
        return sites[0] if sites else None

    deps = WhatIfDeps(
        load_site=load_site,
        gather=lambda site, now, slots: gather_inputs(dsn, site, now, slots),
    )

    def handle(doc: dict) -> dict:
        request = parse_request(doc)  # validate BEFORE taking a slot
        if not gate.acquire(blocking=False):
            raise TooBusyError("busy")
        try:
            return run_what_if(request, deps)
        finally:
            gate.release()

    return handle


def _simulate_serve(args, env: dict[str, str]) -> int:
    """Assemble + run the Ersparnis-Simulation service (design report §2):
    DB-backed prices/market values, keyless Open-Meteo archive weather, the
    production solver chained per chunk - behind an async job HTTP surface."""
    from voltpilot_optimization.simulation import data as sim_data
    from voltpilot_optimization.simulation.archive import ArchiveWeatherSource
    from voltpilot_optimization.simulation.jobs import JobStore
    from voltpilot_optimization.simulation.runner import (
        SimulationDeps,
        run_simulation,
    )
    from voltpilot_optimization.simulation.server import serve

    dsn = _dsn_from_env(env)
    deps = SimulationDeps(
        load_prices=lambda zone, slots: sim_data.load_year_prices(dsn, zone, slots),
        load_market_values=lambda months: sim_data.load_market_values(dsn, months),
        weather=ArchiveWeatherSource(),
        max_workers=max(args.max_workers, 1),
    )
    store = JobStore(lambda request, publish: run_simulation(request, deps, publish))
    httpd = serve(store, args.port, what_if=_what_if_handler(dsn, args.max_what_if))
    # SIGTERM handling (docs/k8s-readiness.md): a Python PID 1 without an
    # explicit handler IGNORES SIGTERM, so the container would always be
    # SIGKILLed after the full grace period. shutdown() lets serve_forever
    # return and the socket close cleanly. A RUNNING simulation job is
    # deliberately abandoned - V1 keeps its job registry in memory, so a job
    # cannot survive the restart either way and the portal simply re-submits
    # (the result cache makes the repeat instant).
    runtime = ServeRuntime("simulation")
    runtime.install_signal_handlers()
    stopper = threading.Thread(
        target=lambda: (runtime.wait_for_stop(), httpd.shutdown()),
        name="simulation-stopper",
        daemon=True,
    )
    stopper.start()
    logger.info(
        "simulate_serve.start",
        extra={"context": {"port": args.port, "max_workers": args.max_workers}},
    )
    httpd.serve_forever()
    httpd.server_close()
    logger.info("simulate_serve.stopped")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.log_level)
    env = dict(os.environ)

    if args.command == "plan":
        _run_one(args, env)
        return 0

    if args.command == "bdew-convert":
        from voltpilot_optimization.simulation.bdew_convert import (
            BdewConvertError,
            run as bdew_run,
        )

        try:
            return bdew_run(args.xlsx, args.profile, args.year, args.out)
        except (BdewConvertError, OSError) as exc:
            print(f"bdew-convert: {exc}", file=sys.stderr)
            return 2

    if args.command == "simulate-serve":
        return _simulate_serve(args, env)

    if args.command == "serve":
        # Container runtime contract (docs/k8s-readiness.md): SIGTERM-aware so
        # the process leaves the 15-min sleep at once instead of being SIGKILLed
        # after the grace period, probe endpoint for the manifests, and a short
        # exponential back-off after a failed cycle so a cold start (no
        # depends_on in Kubernetes: the DB/broker may simply not be up yet)
        # retries in seconds rather than idling a full interval.
        runtime = ServeRuntime("optimization")
        runtime.install_signal_handlers()
        serve_health(runtime, args.health_port)
        logger.info(
            "serve.start",
            extra={"context": {"interval_seconds": args.interval_seconds}},
        )
        cycle = 0
        while not runtime.stopping:
            try:
                _run_one(args, env)
                runtime.record_success()
            except Exception as exc:  # keep the loop alive across transient blips
                runtime.record_failure(exc)
                logger.warning(
                    "serve.cycle_failed", extra={"context": {"error": str(exc)}}
                )
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            if not runtime.sleep(runtime.next_delay(args.interval_seconds)):
                break
        logger.info("serve.stopped", extra={"context": {"cycles": cycle}})
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

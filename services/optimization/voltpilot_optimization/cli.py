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
import time
from urllib.parse import quote

from voltpilot_optimization.engine import run_cycle
from voltpilot_optimization.persistence import TimescaleScheduleRepository
from voltpilot_optimization.publisher import MqttSchedulePublisher

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
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


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
    horizon_slots = round(args.horizon_hours * 4)
    summary = run_cycle(dsn, repository, publisher, horizon_slots=horizon_slots)
    print(summary.line())


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.log_level)
    env = dict(os.environ)

    if args.command == "plan":
        _run_one(args, env)
        return 0

    if args.command == "serve":
        logger.info(
            "serve.start",
            extra={"context": {"interval_seconds": args.interval_seconds}},
        )
        cycle = 0
        while True:
            try:
                _run_one(args, env)
            except Exception as exc:  # keep the loop alive across transient blips
                logger.warning(
                    "serve.cycle_failed", extra={"context": {"error": str(exc)}}
                )
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            time.sleep(args.interval_seconds)

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

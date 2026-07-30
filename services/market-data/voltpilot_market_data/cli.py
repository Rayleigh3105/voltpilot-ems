"""Manual / cron / long-running entrypoint for the day-ahead price fetch.

The default source is the **keyless** energy-charts.info API (Fraunhofer ISE), so
real DE-LU day-ahead spot prices flow with no captain-provided secret. ENTSO-E
stays available (``--source entsoe``, needs ``ENTSOE_SECURITY_TOKEN``) as an
alternative / future primary. energy-charts / EPEX publish the next day's prices
around 13:00 (market time), so the intended cadence is a daily refresh shortly
after - or the ``serve`` loop, which refreshes today+tomorrow on startup and then
periodically:

    python -m voltpilot_market_data fetch                          # tomorrow (energy-charts)
    python -m voltpilot_market_data fetch --zone DE-LU --day 2026-07-02
    python -m voltpilot_market_data fetch --persist                # write to DB
    python -m voltpilot_market_data fetch --source entsoe --persist
    python -m voltpilot_market_data serve --persist                # startup + periodic refresh

Wiring is deliberately assembled here (config -> source adapter -> resilient
wrapper -> optional repository) so the rest of the package stays side-effect free.
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

from voltpilot_market_data.energy_charts import (
    EnergyChartsConfig,
    EnergyChartsDayAheadPriceSource,
)
from voltpilot_market_data.entsoe import EntsoeConfig, EntsoeDayAheadPriceSource
from voltpilot_market_data.market_value_persistence import (
    TimescaleMarketValueRepository,
)
from voltpilot_market_data.market_value_service import refresh_market_values
from voltpilot_market_data.netztransparenz import (
    NetztransparenzConfig,
    NetztransparenzMarketValueSource,
)
from voltpilot_market_data.persistence import (
    DayAheadPriceRepository,
    TimescaleDayAheadPriceRepository,
)
from voltpilot_market_data.refresh import (
    CoverageAwareScheduler,
    RefreshPolicy,
    covered_slot_count,
    day_fully_covered,
)
from voltpilot_market_data.resilience import ResilientPriceSource
from voltpilot_market_data.runtime import ServeRuntime, serve_health
from voltpilot_market_data.service import (
    FetchResult,
    backfill_range,
    delivery_day_window,
    fetch_and_store,
    next_delivery_day,
)

# Keyless default so data flows without a secret; ENTSO-E is opt-in.
DEFAULT_SOURCE = "energy-charts"


def _dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    # URL-encode credentials so passwords/users containing @ : / # etc. cannot
    # corrupt the connection URL.
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    # connect_timeout bounds the connect: without it libpq waits on the OS
    # TCP timeout, so an unreachable DB hangs the cycle (and the shutdown
    # handler) instead of failing into the retry back-off. See
    # docs/k8s-readiness.md.
    timeout = env.get("POSTGRES_CONNECT_TIMEOUT", "10")
    return (
        f"postgresql://{user}:{password}@{host}:{port}/{db}"
        f"?connect_timeout={quote(timeout, safe='')}"
    )


def _build_source(env: dict[str, str], source_name: str) -> ResilientPriceSource:
    """Assemble the requested source behind the resilience wrapper.

    ``energy-charts`` (default) is keyless; ``entsoe`` needs a security token.
    """
    if source_name == "energy-charts":
        delegate = EnergyChartsDayAheadPriceSource(EnergyChartsConfig.from_env(env))
    elif source_name == "entsoe":
        delegate = EntsoeDayAheadPriceSource(EntsoeConfig.from_env(env))
    else:
        raise SystemExit(
            f"unknown --source {source_name!r}; supported: energy-charts, entsoe"
        )
    return ResilientPriceSource(delegate=delegate)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _today_utc() -> date:
    return _now_utc().date()


def _add_common_source_args(sub: argparse.ArgumentParser) -> None:
    # The default zone/source come from the environment so the containerised job
    # picks them up without flags; explicit flags still override. Read at parse
    # time so tests/env changes apply.
    sub.add_argument(
        "--zone",
        default=os.environ.get("MARKET_DATA_ZONE", "DE-LU"),
        help="bidding zone (default from MARKET_DATA_ZONE, else DE-LU)",
    )
    sub.add_argument(
        "--source",
        default=os.environ.get("MARKET_DATA_SOURCE", DEFAULT_SOURCE),
        choices=["energy-charts", "entsoe"],
        help="price source (default from MARKET_DATA_SOURCE, else energy-charts; "
        "energy-charts is keyless, entsoe needs ENTSOE_SECURITY_TOKEN)",
    )
    sub.add_argument(
        "--persist",
        action="store_true",
        help="write the fetched series into the day_ahead_prices hypertable",
    )
    sub.add_argument(
        "--log-level", default="INFO", help="logging level (default INFO)"
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-market-data")
    sub = parser.add_subparsers(dest="command", required=True)

    fetch = sub.add_parser("fetch", help="fetch day-ahead prices for a zone (one-shot)")
    _add_common_source_args(fetch)
    fetch.add_argument(
        "--day",
        help="delivery day YYYY-MM-DD (default: next day, ~13:00 publish)",
    )

    serve = sub.add_parser(
        "serve",
        help="refresh today+tomorrow on startup then periodically (long-running)",
    )
    _add_common_source_args(serve)
    serve.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.environ.get("MARKET_DATA_REFRESH_SECONDS", "21600")),
        help="seconds between refreshes (default from MARKET_DATA_REFRESH_SECONDS, "
        "else 21600 = 6h)",
    )
    serve.add_argument(
        "--max-cycles",
        type=int,
        default=0,
        help="stop after N refresh cycles (0 = run forever; used by tests)",
    )
    serve.add_argument(
        "--health-port",
        type=int,
        default=int(os.environ.get("MARKET_DATA_HEALTH_PORT", "8094")),
        help="probe endpoint port, /health + /ready (default MARKET_DATA_HEALTH_PORT, "
        "else 8094; 0 disables it)",
    )

    backfill = sub.add_parser(
        "backfill",
        help="fetch a whole historical day range into day_ahead_prices "
        "(one-shot; the Ersparnis-Simulation's reference-year prerequisite)",
    )
    _add_common_source_args(backfill)
    backfill.add_argument(
        "--year",
        type=int,
        help="backfill one full calendar year (shorthand for --from/--to)",
    )
    backfill.add_argument(
        "--from", dest="from_day", help="first delivery day YYYY-MM-DD (inclusive)"
    )
    backfill.add_argument(
        "--to", dest="to_day", help="last delivery day YYYY-MM-DD (inclusive)"
    )

    market_values = sub.add_parser(
        "market-values",
        help="refresh the published + provisional Monatsmarktwert Solar "
        "(netztransparenz.de, keyless) - one-shot",
    )
    market_values.add_argument(
        "--persist",
        action="store_true",
        help="write into the monthly_market_value table (also enables the "
        "provisional value, which reads stored day-ahead prices)",
    )
    market_values.add_argument(
        "--log-level", default="INFO", help="logging level (default INFO)"
    )
    return parser


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s %(context)s",
    )
    # Ensure every record has a `context` field so the format string is safe.
    logging.getLogger().handlers[0].addFilter(_ContextDefault())


def _repository_for(env: dict[str, str], persist: bool) -> DayAheadPriceRepository | None:
    return TimescaleDayAheadPriceRepository(_dsn_from_env(env)) if persist else None


def _refresh_market_values_once(env: dict[str, str], persist: bool) -> str:
    """Fetch/compute the Monatsmarktwert Solar; persist when asked.

    Without ``--persist`` the published values are fetched and printed only
    (no DB -> no provisional value, which needs the stored price curve).
    """
    source = NetztransparenzMarketValueSource(NetztransparenzConfig.from_env(env))
    if not persist:
        today = _today_utc()
        published = [
            v
            for year in (today.year - 1, today.year)
            for v in source.fetch_monthly_market_values(year)
        ]
        newest = published[-1] if published else None
        return (
            "voltpilot-market-data: MW Solar "
            f"{len(published)} published months"
            + (
                f", newest {newest.month.isoformat()} = "
                f"{newest.value_ct_kwh:.3f} ct/kWh"
                if newest
                else ""
            )
        )
    dsn = _dsn_from_env(env)
    result = refresh_market_values(
        source,
        TimescaleMarketValueRepository(dsn),
        TimescaleDayAheadPriceRepository(dsn),
    )
    provisional = ", ".join(m.isoformat() for m in result.provisional_months) or "-"
    return (
        "voltpilot-market-data: MW Solar refreshed - "
        f"{result.published_rows} published rows, "
        f"{result.provisional_rows} provisional rows ({provisional})"
    )


def _describe_fetch(zone: str, day: date, result: FetchResult) -> str:
    prices = result.series.prices()
    return (
        f"voltpilot-market-data: {zone} {day.isoformat()} "
        f"{len(prices)} slots @ {result.series.resolution}, "
        f"min={min(prices):.2f} max={max(prices):.2f} EUR/MWh, "
        f"rows_written={result.rows_written}"
    )


def _fetch_one(source, zone: str, day: date, repository) -> str:
    return _describe_fetch(zone, day, fetch_and_store(source, zone, day, repository))


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.log_level)
    env = dict(os.environ)

    if args.command == "fetch":
        day = (
            date.fromisoformat(args.day)
            if args.day
            else next_delivery_day(_today_utc())
        )
        source = _build_source(env, args.source)
        repository = _repository_for(env, args.persist)
        print(_fetch_one(source, args.zone, day, repository))
        return 0

    if args.command == "backfill":
        if args.year is not None:
            first, last = date(args.year, 1, 1), date(args.year, 12, 31)
        elif args.from_day and args.to_day:
            first, last = date.fromisoformat(args.from_day), date.fromisoformat(args.to_day)
        else:
            raise SystemExit("backfill needs --year or both --from and --to")
        source = _build_source(env, args.source)
        repository = _repository_for(env, args.persist)
        results = backfill_range(source, args.zone, first, last, repository)
        points = sum(len(r.series) for r in results)
        rows = sum(r.rows_written for r in results)
        print(
            f"voltpilot-market-data: backfill {args.zone} "
            f"{first.isoformat()}..{last.isoformat()} - {len(results)} chunks, "
            f"{points} price points, rows_written={rows}"
        )
        return 0

    if args.command == "market-values":
        print(_refresh_market_values_once(env, args.persist))
        return 0

    if args.command == "serve":
        source = _build_source(env, args.source)
        repository = _repository_for(env, args.persist)
        policy = RefreshPolicy.from_env(env, baseline_seconds=args.interval_seconds)
        scheduler = CoverageAwareScheduler(policy=policy, zone=args.zone)
        # Container runtime contract (docs/k8s-readiness.md): SIGTERM-aware
        # sleep (the 6 h baseline cadence would otherwise mean every rollout
        # ends in SIGKILL after the grace period), a probe endpoint, and a
        # short exponential back-off while cycles fail - so a Kubernetes cold
        # start (no depends_on: the DB may simply not be up yet) retries in
        # seconds instead of leaving the fleet without prices for six hours.
        runtime = ServeRuntime("market-data")
        runtime.install_signal_handlers()
        serve_health(runtime, args.health_port)
        last_error: BaseException | str | None = None
        logging.getLogger("voltpilot.market_data").info(
            "serve.start",
            extra={"context": {
                "zone": args.zone,
                "source": args.source,
                "interval_seconds": args.interval_seconds,
                "fast_seconds": policy.fast_seconds,
                "publication_hour": policy.publication_hour,
            }},
        )
        cycle = 0
        while not runtime.stopping:
            today = _today_utc()
            tomorrow = today + timedelta(days=1)
            # Refresh both today (already published) and tomorrow (published
            # ~13:00) so the portal always has a full today+tomorrow curve.
            tomorrow_series = None
            fetched = 0
            for day in (today, tomorrow):
                try:
                    result = fetch_and_store(source, args.zone, day, repository)
                    print(_describe_fetch(args.zone, day, result))
                    fetched += 1
                    if day == tomorrow:
                        tomorrow_series = result.series
                except Exception as exc:  # keep the loop alive across a bad day
                    logging.getLogger("voltpilot.market_data").warning(
                        "serve.fetch_failed",
                        extra={"context": {"day": day.isoformat(), "error": str(exc)}},
                    )
                    last_error = exc
            if args.persist:
                # Monthly data, but refreshing each cycle is one cheap request
                # and keeps the CURRENT month's provisional value tracking the
                # freshly fetched prices; the official value replaces it the
                # cycle after the TSOs publish.
                try:
                    print(_refresh_market_values_once(env, True))
                except Exception as exc:  # keep the loop alive
                    logging.getLogger("voltpilot.market_data").warning(
                        "serve.market_values_failed",
                        extra={"context": {"error": str(exc)}},
                    )
            # A cycle counts as failed only when NEITHER day could be fetched
            # (upstream/DB down) - that is the cold-start case the back-off is
            # for; a single bad delivery day keeps the baseline cadence.
            if fetched:
                runtime.record_success()
            else:
                runtime.record_failure(last_error or "no day could be fetched")
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            # Coverage-aware cadence: fast-poll after the ~12:45 publication
            # threshold until tomorrow's prices land (bounded at midnight),
            # baseline otherwise. The fetched series is the coverage source -
            # the resilient wrapper serves the DB-primed last-good cache on
            # upstream failure, so a covered day stays covered.
            window_start, window_end = delivery_day_window(tomorrow)
            delay = scheduler.next_delay_seconds(
                now=_now_utc(),
                covered=day_fully_covered(tomorrow_series, window_start, window_end),
                slots=covered_slot_count(tomorrow_series, window_start, window_end),
            )
            # next_delay only shortens the wait while cycles keep failing.
            if not runtime.sleep(runtime.next_delay(delay)):
                break
        logging.getLogger("voltpilot.market_data").info(
            "serve.stopped", extra={"context": {"cycles": cycle}}
        )
        return 0

    return 2


class _ContextDefault(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "context"):
            record.context = {}
        return True


if __name__ == "__main__":
    raise SystemExit(main())

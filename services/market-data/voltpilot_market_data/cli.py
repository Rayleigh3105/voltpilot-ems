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
import time
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
from voltpilot_market_data.resilience import ResilientPriceSource
from voltpilot_market_data.service import fetch_and_store, next_delivery_day

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
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


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


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


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


def _fetch_one(source, zone: str, day: date, repository) -> str:
    result = fetch_and_store(source, zone, day, repository)
    prices = result.series.prices()
    return (
        f"voltpilot-market-data: {zone} {day.isoformat()} "
        f"{len(prices)} slots @ {result.series.resolution}, "
        f"min={min(prices):.2f} max={max(prices):.2f} EUR/MWh, "
        f"rows_written={result.rows_written}"
    )


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

    if args.command == "market-values":
        print(_refresh_market_values_once(env, args.persist))
        return 0

    if args.command == "serve":
        source = _build_source(env, args.source)
        repository = _repository_for(env, args.persist)
        logging.getLogger("voltpilot.market_data").info(
            "serve.start",
            extra={"context": {
                "zone": args.zone,
                "source": args.source,
                "interval_seconds": args.interval_seconds,
            }},
        )
        cycle = 0
        while True:
            today = _today_utc()
            # Refresh both today (already published) and tomorrow (published
            # ~13:00) so the portal always has a full today+tomorrow curve.
            for day in (today, today + timedelta(days=1)):
                try:
                    print(_fetch_one(source, args.zone, day, repository))
                except Exception as exc:  # keep the loop alive across a bad day
                    logging.getLogger("voltpilot.market_data").warning(
                        "serve.fetch_failed",
                        extra={"context": {"day": day.isoformat(), "error": str(exc)}},
                    )
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
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            time.sleep(args.interval_seconds)

    return 2


class _ContextDefault(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "context"):
            record.context = {}
        return True


if __name__ == "__main__":
    raise SystemExit(main())

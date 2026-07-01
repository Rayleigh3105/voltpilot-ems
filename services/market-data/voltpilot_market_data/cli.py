"""Manual / cron entrypoint for the day-ahead price fetch.

ENTSO-E publishes the next day's day-ahead prices around 12:45 (market time), so
the intended cadence is a daily job shortly after - e.g. cron ``0 13 * * *``
(see AGENTS.md). This module is that job's body and doubles as a manual backfill
tool:

    python -m voltpilot_market_data fetch --zone DE-LU            # tomorrow
    python -m voltpilot_market_data fetch --zone DE-LU --day 2026-07-02
    python -m voltpilot_market_data fetch --zone DE-LU --persist  # write to DB

Wiring is deliberately assembled here (config -> ENTSO-E adapter -> resilient
wrapper -> optional repository) so the rest of the package stays side-effect free.
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import date, datetime, timezone
from urllib.parse import quote

from voltpilot_market_data.entsoe import EntsoeConfig, EntsoeDayAheadPriceSource
from voltpilot_market_data.persistence import (
    DayAheadPriceRepository,
    TimescaleDayAheadPriceRepository,
)
from voltpilot_market_data.resilience import ResilientPriceSource
from voltpilot_market_data.service import fetch_and_store, next_delivery_day


def _dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    # URL-encode credentials so passwords/users containing @ : / # etc. cannot
    # corrupt the connection URL.
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _build_source(env: dict[str, str]) -> ResilientPriceSource:
    config = EntsoeConfig.from_env(env)
    entsoe = EntsoeDayAheadPriceSource(config)
    return ResilientPriceSource(delegate=entsoe)


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-market-data")
    sub = parser.add_subparsers(dest="command", required=True)

    fetch = sub.add_parser("fetch", help="fetch day-ahead prices for a zone")
    # The default zone comes from MARKET_DATA_ZONE (fallback DE-LU) so the
    # containerised cron job can pick its zone from the environment; an explicit
    # --zone still overrides it. Read at parse time so tests/env changes apply.
    default_zone = os.environ.get("MARKET_DATA_ZONE", "DE-LU")
    fetch.add_argument(
        "--zone",
        default=default_zone,
        help="bidding zone (default from MARKET_DATA_ZONE, else DE-LU)",
    )
    fetch.add_argument(
        "--day",
        help="delivery day YYYY-MM-DD (default: next day, ENTSO-E ~12:45 publish)",
    )
    fetch.add_argument(
        "--persist",
        action="store_true",
        help="write the fetched series into the day_ahead_prices hypertable",
    )
    fetch.add_argument(
        "--log-level", default="INFO", help="logging level (default INFO)"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s %(context)s",
    )
    # Ensure every record has a `context` field so the format string is safe.
    logging.getLogger().handlers[0].addFilter(_ContextDefault())

    if args.command == "fetch":
        env = dict(os.environ)
        day = (
            date.fromisoformat(args.day)
            if args.day
            else next_delivery_day(_today_utc())
        )
        source = _build_source(env)
        repository: DayAheadPriceRepository | None = (
            TimescaleDayAheadPriceRepository(_dsn_from_env(env))
            if args.persist
            else None
        )
        result = fetch_and_store(source, args.zone, day, repository)
        prices = result.series.prices()
        print(
            f"voltpilot-market-data: {args.zone} {day.isoformat()} "
            f"{len(prices)} slots @ {result.series.resolution}, "
            f"min={min(prices):.2f} max={max(prices):.2f} EUR/MWh, "
            f"rows_written={result.rows_written}"
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

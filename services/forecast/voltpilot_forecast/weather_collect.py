"""Weather-forecast collector job (keyless Open-Meteo -> weather_forecast).

Reads the sites that have coordinates from the shared TimescaleDB, fetches each
one's hourly forecast from the **keyless** Open-Meteo API, and upserts it into the
``weather_forecast`` hypertable (idempotent on ``(site_id, run_at, time)``). The
portal then surfaces it per site.

Cadences, mirroring the market-data collector:

    python -m voltpilot_forecast.weather_collect fetch            # one-shot, all sites
    python -m voltpilot_forecast.weather_collect serve            # startup + periodic

Runs as the trusted backend DB role (the compose superuser in dev), so it reads
every tenant's sites and writes rows stamped with each site's tenant_id; the
portal's RLS-scoped read then shows each tenant only its own weather.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.openmeteo import (
    OpenMeteoConfig,
    OpenMeteoWeatherSource,
)
from voltpilot_forecast.weather_repository import (
    TimescaleWeatherForecastRepository,
    WeatherForecastRepository,
)

logger = logging.getLogger("voltpilot.forecast.weather_collect")


@dataclass(frozen=True)
class SiteRow:
    tenant_id: str
    site_id: str
    location: GeoLocation


def _dsn_from_env(env: dict[str, str]) -> str:
    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    # The collector reads sites across tenants and writes weather, so it connects
    # as the trusted backend role (POSTGRES_USER), not the RLS-scoped app role.
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def load_sites_with_coordinates(dsn: str) -> list[SiteRow]:
    """Return every site that has latitude/longitude set (weather is per-location)."""
    import psycopg  # lazy: optional [db] extra

    sites: list[SiteRow] = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tenant_id, id, latitude, longitude FROM site "
                "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
            )
            for tenant_id, site_id, lat, lon in cur.fetchall():
                sites.append(
                    SiteRow(
                        tenant_id=str(tenant_id),
                        site_id=str(site_id),
                        location=GeoLocation(latitude=float(lat), longitude=float(lon)),
                    )
                )
    return sites


def collect_once(
    source: OpenMeteoWeatherSource,
    sites: list[SiteRow],
    repository: WeatherForecastRepository | None,
    run_at: datetime,
) -> int:
    """Fetch + store weather for every site; return total rows written."""
    total = 0
    for site in sites:
        try:
            forecast = source.fetch(
                site.location, site.tenant_id, site.site_id, run_at
            )
        except Exception as exc:  # one bad site must not sink the whole run
            logger.warning(
                "weather.fetch_failed",
                extra={"context": {"site_id": site.site_id, "error": str(exc)}},
            )
            continue
        written = repository.save(forecast) if repository is not None else len(forecast)
        total += written
        print(
            f"voltpilot-weather: site={site.site_id} "
            f"{len(forecast)} hourly points, rows_written={written}"
        )
    return total


def _build_source(env: dict[str, str]) -> OpenMeteoWeatherSource:
    return OpenMeteoWeatherSource(
        OpenMeteoConfig(
            base_url=env.get("OPEN_METEO_BASE_URL", OpenMeteoConfig.base_url),
            forecast_days=int(env.get("WEATHER_FORECAST_DAYS", "3")),
        )
    )


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


def _add_common_args(sub: argparse.ArgumentParser) -> None:
    sub.add_argument(
        "--persist",
        action="store_true",
        help="write forecasts into the weather_forecast hypertable",
    )
    sub.add_argument("--log-level", default="INFO", help="logging level (default INFO)")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-weather")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch", help="fetch weather for all sites once")
    _add_common_args(fetch)
    serve = sub.add_parser(
        "serve", help="fetch on startup then periodically (long-running)"
    )
    _add_common_args(serve)
    serve.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.environ.get("WEATHER_REFRESH_SECONDS", "10800")),
        help="seconds between refreshes (default WEATHER_REFRESH_SECONDS, else 10800=3h)",
    )
    serve.add_argument(
        "--max-cycles",
        type=int,
        default=0,
        help="stop after N cycles (0 = forever; used by tests)",
    )
    return parser


def _run_cycle(env: dict[str, str], source, persist: bool) -> None:
    dsn = _dsn_from_env(env)
    sites = load_sites_with_coordinates(dsn)
    if not sites:
        logger.warning("weather.no_sites", extra={"context": {}})
        return
    repository = (
        TimescaleWeatherForecastRepository(__import__("psycopg").connect(dsn))
        if persist
        else None
    )
    try:
        collect_once(source, sites, repository, _now_utc())
    finally:
        if repository is not None:
            repository._conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.log_level)
    env = dict(os.environ)
    source = _build_source(env)

    if args.command == "fetch":
        _run_cycle(env, source, args.persist)
        return 0

    if args.command == "serve":
        logger.info(
            "serve.start",
            extra={"context": {"interval_seconds": args.interval_seconds}},
        )
        cycle = 0
        while True:
            try:
                _run_cycle(env, source, args.persist)
            except Exception as exc:  # keep the loop alive across a transient DB blip
                logger.warning("serve.cycle_failed", extra={"context": {"error": str(exc)}})
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            time.sleep(args.interval_seconds)

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

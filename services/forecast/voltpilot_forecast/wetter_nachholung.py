"""Wetter-Nachholung nach "Ort berichtigen" (vp-standort-konzept §6.6, B3).

A correction moving an Anlage's point more than 2 km writes ONE outbox row into
``ort_wetter_nachholung`` (Java, ``AnlageOrtService``/``OrtWetterNachholungRepository``).
This module drains that outbox as the trusted backend role (bypasses RLS, like
every other read/write this service does on shared tenant-owned tables): for
each pending site it discards the stored weather learned at the OLD point and
fetches 28 days of history at the CURRENT point in the SAME Open-Meteo
``/v1/forecast`` call (``past_days`` - no separate archive API, see
:mod:`voltpilot_forecast.openmeteo`), then marks the row done.

Always reads the site's CURRENT coordinates at process time, never a snapshot
taken when the row was written - a second correction before this runs simply
means the first catch-up is now moot and the current point wins.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.kundenbereich import NICHT_BEENDET
from voltpilot_forecast.openmeteo import OpenMeteoConfig, OpenMeteoWeatherSource
from voltpilot_forecast.weather_repository import WeatherForecastRepository

logger = logging.getLogger("voltpilot.forecast.wetter_nachholung")

#: §6.6: 28 Tage Wetter am neuen Punkt nachholen, damit die Prognose nicht am alten lernt.
NACHHOL_TAGE = 28


@dataclass(frozen=True)
class NachholAuftrag:
    id: int
    tenant_id: str
    site_id: str
    location: GeoLocation


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def load_pending(dsn: str) -> list[NachholAuftrag]:
    """Open requests, joined to the site's CURRENT coordinates (never a snapshot)."""
    import psycopg  # lazy: optional [db] extra

    auftraege: list[NachholAuftrag] = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT n.id, n.tenant_id, n.site_id, s.latitude, s.longitude "
                "FROM ort_wetter_nachholung n "
                "JOIN site s ON s.id = n.site_id "
                "JOIN tenant t ON t.id = n.tenant_id "
                "WHERE n.erledigt_am IS NULL "
                "AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL "
                "AND " + NICHT_BEENDET
            )
            for auftrag_id, tenant_id, site_id, lat, lon in cur.fetchall():
                auftraege.append(
                    NachholAuftrag(
                        id=int(auftrag_id),
                        tenant_id=str(tenant_id),
                        site_id=str(site_id),
                        location=GeoLocation(latitude=float(lat), longitude=float(lon)),
                    )
                )
    return auftraege


def _erledigt_markieren(dsn: str, auftrag_id: int) -> None:
    import psycopg

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ort_wetter_nachholung SET erledigt_am = now() WHERE id = %s",
                (auftrag_id,),
            )
        conn.commit()


def process_auftraege(
    auftraege: list[NachholAuftrag],
    source: OpenMeteoWeatherSource,
    repository: WeatherForecastRepository,
) -> list[NachholAuftrag]:
    """The DB-agnostic core (offline-testable, like :func:`weather_collect.collect_once`):
    discard + backfill each given request; return the ones that succeeded (the
    caller marks only THOSE done). One bad site must not sink the run - a fetch
    failure is logged and its request is simply left out of the result.
    """
    erledigt: list[NachholAuftrag] = []
    for a in auftraege:
        try:
            forecast = source.fetch(a.location, a.tenant_id, a.site_id, _now_utc())
        except Exception as exc:
            logger.warning(
                "wetter_nachholung.fetch_failed",
                extra={"context": {"site_id": a.site_id, "error": str(exc)}},
            )
            continue
        repository.delete_for_site(a.site_id)
        repository.save(forecast)
        erledigt.append(a)
        print(f"voltpilot-weather: nachholung site={a.site_id} {len(forecast)} hourly points")
    return erledigt


def process_pending(
    dsn: str,
    source: OpenMeteoWeatherSource,
    repository: WeatherForecastRepository,
) -> int:
    """Drain every open request against the real database; return how many were resolved."""
    erledigt = process_auftraege(load_pending(dsn), source, repository)
    for a in erledigt:
        _erledigt_markieren(dsn, a.id)
    return len(erledigt)


def build_source(env: dict[str, str]) -> OpenMeteoWeatherSource:
    """A dedicated source: the regular collector's ``forecast_days`` would also
    re-fetch days already covered by the next regular cycle - one day plus the
    28-day catch-up is enough here."""
    return OpenMeteoWeatherSource(
        OpenMeteoConfig(
            base_url=env.get("OPEN_METEO_BASE_URL", OpenMeteoConfig.base_url),
            forecast_days=1,
            past_days=NACHHOL_TAGE,
        )
    )

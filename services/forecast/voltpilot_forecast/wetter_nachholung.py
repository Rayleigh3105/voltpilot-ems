"""Wetter-Nachholung nach "Ort berichtigen" (vp-standort-konzept §6.6, B3) und nach einem
Umzug (§7, E1 = B).

A correction or a move writes ONE outbox row into ``ort_wetter_nachholung`` (Java,
``AnlageOrtService``/``OrtWetterNachholungRepository``). This module drains that
outbox as the trusted backend role (bypasses RLS, like every other read/write
this service does on shared tenant-owned tables):

* ``ab_tag IS NULL`` ("Ort berichtigen"): discards EVERYTHING stored and fetches
  :data:`NACHHOL_TAGE` days of history at the CURRENT point in the SAME
  Open-Meteo ``/v1/forecast`` call (``past_days`` - no separate archive API,
  see :mod:`voltpilot_forecast.openmeteo`). "Adresse war falsch" may replace
  the whole learned history.
* ``ab_tag`` set (a move): the weather BEFORE that day was learned at the OLD
  point and stays correct, so it is kept - only the days from ``ab_tag``
  onward are replaced by the NEW point. Both halves are written under ONE
  fresh ``run_at`` (:meth:`WeatherForecastRepository.points_before` + a
  dynamically-sized fetch via :meth:`OpenMeteoWeatherSource.with_past_days`),
  so ``latest()`` keeps seeing one coherent run, exactly like today.

Always reads the site's CURRENT coordinates at process time, never a snapshot
taken when the row was written - a second correction before this runs simply
means the first catch-up is now moot and the current point wins.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timezone

from voltpilot_forecast.domain import GeoLocation
from voltpilot_forecast.kundenbereich import NICHT_BEENDET
from voltpilot_forecast.openmeteo import OpenMeteoConfig, OpenMeteoWeatherSource, WeatherForecast
from voltpilot_forecast.weather_repository import WeatherForecastRepository

logger = logging.getLogger("voltpilot.forecast.wetter_nachholung")

#: §6.6: 28 Tage Wetter am neuen Punkt nachholen, damit die Prognose nicht am alten lernt.
NACHHOL_TAGE = 28

#: Open-Meteo's `past_days` cap (openmeteo.py) - a move further back loses precision for
#: the days beyond this (documented, deliberate simplification, see PR body).
PAST_DAYS_MAX = 92


@dataclass(frozen=True)
class NachholAuftrag:
    id: int
    tenant_id: str
    site_id: str
    location: GeoLocation
    #: §7: gesetzt heißt Umzug - das Wetter vor diesem Tag bleibt stehen (am alten Punkt gelernt).
    ab_tag: date | None = None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def load_pending(dsn: str) -> list[NachholAuftrag]:
    """Open requests, joined to the site's CURRENT coordinates (never a snapshot)."""
    import psycopg  # lazy: optional [db] extra

    auftraege: list[NachholAuftrag] = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT n.id, n.tenant_id, n.site_id, s.latitude, s.longitude, n.ab_tag "
                "FROM ort_wetter_nachholung n "
                "JOIN site s ON s.id = n.site_id "
                "JOIN tenant t ON t.id = n.tenant_id "
                "WHERE n.erledigt_am IS NULL "
                "AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL "
                "AND " + NICHT_BEENDET
            )
            for auftrag_id, tenant_id, site_id, lat, lon, ab_tag in cur.fetchall():
                auftraege.append(
                    NachholAuftrag(
                        id=int(auftrag_id),
                        tenant_id=str(tenant_id),
                        site_id=str(site_id),
                        location=GeoLocation(latitude=float(lat), longitude=float(lon)),
                        ab_tag=ab_tag,
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


def _umzug_fetch(
    a: NachholAuftrag, source: OpenMeteoWeatherSource, repository: WeatherForecastRepository, now: datetime
) -> WeatherForecast:
    """§7: fetch only what's needed at the NEW point from ``a.ab_tag`` onward, merged with the
    EXISTING, still-correct points from before that day - under ONE fresh ``run_at``."""
    cutoff = datetime.combine(a.ab_tag, time.min, tzinfo=timezone.utc)
    past_days = min(PAST_DAYS_MAX, max(1, (now.date() - a.ab_tag).days))
    neu = source.with_past_days(past_days).fetch(a.location, a.tenant_id, a.site_id, now)
    kept = repository.points_before(a.site_id, cutoff)
    neu_ab_umzugstag = tuple(p for p in neu.points if p.timestamp >= cutoff)
    return WeatherForecast(
        tenant_id=neu.tenant_id,
        site_id=neu.site_id,
        latitude=neu.latitude,
        longitude=neu.longitude,
        run_at=neu.run_at,
        points=tuple(kept) + neu_ab_umzugstag,
        source=neu.source,
    )


def process_auftraege(
    auftraege: list[NachholAuftrag],
    source: OpenMeteoWeatherSource,
    repository: WeatherForecastRepository,
) -> list[NachholAuftrag]:
    """The DB-agnostic core (offline-testable, like :func:`weather_collect.collect_once`):
    discard + backfill each given request; return the ones that succeeded (the
    caller marks only THOSE done). One bad site must not sink the run - a fetch
    failure is logged and its request is simply left out of the result.

    A correction (``ab_tag`` unset) replaces everything, as before. A move
    (``ab_tag`` set) keeps the points before that day and only replaces from
    then on, at the new point (:func:`_umzug_fetch`) - §7, E1 = B.
    """
    now = _now_utc()
    erledigt: list[NachholAuftrag] = []
    for a in auftraege:
        try:
            forecast = (
                _umzug_fetch(a, source, repository, now)
                if a.ab_tag is not None
                else source.fetch(a.location, a.tenant_id, a.site_id, now)
            )
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

"""Anlagen-Check A1: die am Vortag erwartete Erzeugung JE EINHEIT und Tag.

Bedienkonzept vp-privatkunde-bedienkonzept §9.2 A1 (Captain BK-4 = A): die
Kachel „Solaranlage" und die Karte „Erzeugung nach Einheiten" vergleichen je
bestätigter PV-``register_einheit`` „gemessen" gegen „erwartet". Die Prognose
der Anlage ist seit S4 eine Summe über die Dachflächen aller Einheiten
(:func:`voltpilot_forecast.forecast_collect.load_pv_flaechen`) - in
``forecast`` steht nur diese Summe. Dieses Modul teilt sie nachträglich auf:

* **Bezug ist der Abend-Lauf** (17:45 ± 15 min des Vortags) eines Modells -
  derselbe Lauf, den ``forecast_rueckblick`` als „am Vortag erwartet" führt.
  Die Einheiten einer Anlage summieren sich darum je Tag genau zu dessen
  Tagessumme über alle Viertelstunden (Test ``test_einheit_erwartung``).
* **Der Anteil einer Einheit je Viertelstunde** kommt aus dem physikalischen
  Modell (:class:`~voltpilot_forecast.pv.PhysicalPvForecaster`) mit IHREN
  Flächen und dem gespeicherten Wetter des Tages (jüngster Wert je Stunde) -
  so bekommt ein Ostdach am Morgen und ein Westdach am Abend seinen Teil,
  und ein bedeckter Tag (nur diffuses Licht) gleicht die Richtungen an.
  Ohne Wetter rechnet es mit dem klaren Himmel; ohne Sonne in der
  Viertelstunde (Summe 0) nach der kWp.
* Eine Einheit ohne bestätigte Fläche zählt mit ihrer ganzen kWp nach Süden,
  30° - dieselbe Vereinfachung wie ``load_pv_flaechen``. Fehlt einer Einheit
  der Anlage die Leistung, bekommt die Anlage KEINE Zeile (die Lücken-Regel
  von ``load_pv_flaechen``: eine geratene Aufteilung wäre falscher als keine).

Geschrieben wird im selben Lauf wie ``forecast_rueckblick``
(:func:`voltpilot_forecast.rueckblick.rueckblick_day`), als vertraute
Backend-Rolle in die mandanteneigene Tabelle ``solar_erwartung_einheit``
(api-Migration ``V20261114121700``). Rückwirkend gibt es die Zahl nur, solange
``forecast`` den Abend-Lauf noch hält (30 Tage, ``rueckblick run
--days-back``).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime

from voltpilot_forecast.domain import (
    GeoLocation,
    PlantSpec,
    SiteForecastConfig,
    ensure_utc,
)
from voltpilot_forecast.kundenbereich import lebenden_bereich_sperren
from voltpilot_forecast.openmeteo import (
    OpenMeteoWeatherProvider,
    WeatherForecast,
    WeatherPoint,
)
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.weather import ClearSkyWeatherProvider

logger = logging.getLogger(__name__)

#: Ohne Koordinaten der Anlage - derselbe Ersatz wie ``forecast_collect``.
ERSATZ_ORT = GeoLocation(latitude=52.52, longitude=13.405)

SLOT_HOURS = 0.25


@dataclass(frozen=True)
class EinheitSpec:
    """Eine bestätigte PV-Einheit mit ihren Flächen (je Fläche ein PlantSpec)."""

    einheit_id: str
    leistung_kwp: float
    flaechen: tuple[PlantSpec, ...]


@dataclass(frozen=True)
class EinheitErwartung:
    """Eine Zeile von ``solar_erwartung_einheit``."""

    day: date
    tenant_id: str
    site_id: str
    einheit_id: str
    model: str
    lead_days: int
    erwartet_kwh: float
    leistung_kwp: float


# ---- reine Rechnung -------------------------------------------------------------

def anteile_je_slot(
    einheiten: list[EinheitSpec],
    leistung_je_einheit: dict[str, list[float]],
) -> list[dict[str, float]]:
    """Der Anteil jeder Einheit je Slot (Summe 1) - reine Funktion.

    ``leistung_je_einheit`` ist die physikalische Leistung je Einheit und Slot
    (gleiche Länge). Ohne Leistung im Slot (Nacht, Rand) teilt die kWp.
    """
    if not einheiten:
        return []
    n = len(next(iter(leistung_je_einheit.values()))) if leistung_je_einheit else 0
    kwp_summe = sum(e.leistung_kwp for e in einheiten)
    nach_kwp = {
        e.einheit_id: (e.leistung_kwp / kwp_summe if kwp_summe > 0 else 1.0 / len(einheiten))
        for e in einheiten
    }
    anteile: list[dict[str, float]] = []
    for i in range(n):
        werte = {e.einheit_id: max(0.0, leistung_je_einheit[e.einheit_id][i]) for e in einheiten}
        summe = sum(werte.values())
        if summe > 0.0:
            anteile.append({k: v / summe for k, v in werte.items()})
        else:
            anteile.append(dict(nach_kwp))
    return anteile


def erwartung_je_einheit(
    predicted: dict[datetime, float],
    zeiten: list[datetime],
    anteile: list[dict[str, float]],
) -> dict[str, float]:
    """kWh je Einheit über die Slots von ``zeiten`` - reine Funktion.

    ``predicted`` ist der Abend-Lauf der Anlage (kW je Viertelstunde); ein Slot
    ohne Prognosewert trägt nichts bei, negative Werte zählen als 0 (wie
    :func:`voltpilot_forecast.rueckblick.tageskwh`). Die Summe über die
    Einheiten ist genau die Tagessumme des Abend-Laufs.
    """
    summen: dict[str, float] = {}
    for ts, anteil in zip(zeiten, anteile):
        kw = predicted.get(ts)
        if kw is None:
            continue
        kwh = max(0.0, kw) * SLOT_HOURS
        for einheit_id, a in anteil.items():
            summen[einheit_id] = summen.get(einheit_id, 0.0) + kwh * a
    return {k: round(v, 4) for k, v in summen.items()}


def physikalische_leistung(
    ort: GeoLocation,
    einheiten: list[EinheitSpec],
    zeiten: list[datetime],
    wetter: list[WeatherPoint],
    site_id: str = "",
    tenant_id: str = "",
) -> dict[str, list[float]]:
    """Die physikalische Leistung (kW) jeder Einheit je Slot - mit dem Wetter
    des Tages, ohne Wetter mit dem klaren Himmel."""
    if wetter:
        provider = OpenMeteoWeatherProvider(
            WeatherForecast(
                tenant_id=tenant_id,
                site_id=site_id,
                latitude=ort.latitude,
                longitude=ort.longitude,
                run_at=zeiten[0] if zeiten else datetime.now(),
                points=tuple(wetter),
            ),
            use_true_dni=True,
        )
    else:
        provider = ClearSkyWeatherProvider()
    modell = PhysicalPvForecaster(provider)
    leistung: dict[str, list[float]] = {}
    for e in einheiten:
        config = SiteForecastConfig(
            tenant_id=tenant_id, site_id=site_id, location=ort, plants=e.flaechen
        )
        leistung[e.einheit_id] = modell.power_series(config, zeiten)
    return leistung


# ---- DB-Lesen (vertraute Backend-Rolle) -----------------------------------------

def _db_fehler(*namen: str) -> tuple[type[BaseException], ...]:
    """psycopg-Fehlerklassen nach Namen; ohne das [db]-Extra keine (die
    reinen Tests laufen ohne Treiber, ``except ()`` fängt nichts)."""
    try:
        import psycopg  # noqa: PLC0415 - optional [db] extra
    except ImportError:
        return ()
    return tuple(getattr(psycopg.errors, n) for n in namen)


def load_pv_einheiten(cur) -> dict[str, list[EinheitSpec]]:
    """``{site_id: [EinheitSpec, ...]}`` je bestätigter PV-Einheit.

    Dieselbe Abfrage und dieselbe Lücken-Regel wie
    :func:`voltpilot_forecast.forecast_collect.load_pv_flaechen`, nur je
    Einheit statt flach: fehlt EINER Einheit einer Anlage die Leistung, fällt
    die ganze Anlage heraus. Vor der S1-Migration (Tabellen fehlen) leer.
    """
    try:
        cur.execute(
            """
            SELECT re.site_id, re.id, re.leistung_kwp,
                   ef.richtung_grad, ef.neigung_grad, ef.anteil_kwp
            FROM register_einheit re
            LEFT JOIN einheit_flaeche ef ON ef.einheit_id = re.id
            WHERE re.art = 'pv' AND re.bestaetigt_am IS NOT NULL
            ORDER BY re.site_id, re.inbetriebnahme NULLS LAST, re.created_at, ef.richtung_grad
            """
        )
        rows = cur.fetchall()
    except _db_fehler("UndefinedTable", "UndefinedColumn"):
        cur.connection.rollback()
        return {}
    return einheiten_aus_zeilen(rows)


def einheiten_aus_zeilen(rows) -> dict[str, list[EinheitSpec]]:
    """Gruppiert die Zeilen von :func:`load_pv_einheiten` - reine Funktion."""
    kwp: dict[str, float] = {}
    flaechen: dict[str, list[PlantSpec]] = {}
    reihenfolge: dict[str, list[str]] = {}
    unvollstaendig: set[str] = set()
    for site_id, einheit_id, leistung_kwp, richtung, neigung, anteil in rows:
        site_id, einheit_id = str(site_id), str(einheit_id)
        if leistung_kwp is None:
            unvollstaendig.add(site_id)
            continue
        if einheit_id not in kwp:
            kwp[einheit_id] = float(leistung_kwp)
            flaechen[einheit_id] = []
            reihenfolge.setdefault(site_id, []).append(einheit_id)
        if richtung is not None and neigung is not None and anteil is not None:
            flaechen[einheit_id].append(
                PlantSpec(
                    capacity_kwp=float(anteil),
                    azimuth_deg=float(richtung),
                    tilt_deg=float(neigung),
                )
            )
    ergebnis: dict[str, list[EinheitSpec]] = {}
    for site_id, ids in reihenfolge.items():
        if site_id in unvollstaendig:
            continue
        specs = []
        for einheit_id in ids:
            eigene = tuple(flaechen[einheit_id]) or (PlantSpec(capacity_kwp=kwp[einheit_id]),)
            specs.append(EinheitSpec(einheit_id, kwp[einheit_id], eigene))
        ergebnis[site_id] = specs
    return ergebnis


def site_ort(cur, site_id: str) -> GeoLocation:
    cur.execute("SELECT latitude, longitude FROM site WHERE id = %s", (site_id,))
    row = cur.fetchone()
    if row is None or row[0] is None or row[1] is None:
        return ERSATZ_ORT
    return GeoLocation(latitude=float(row[0]), longitude=float(row[1]))


def wetter_des_tages(cur, site_id: str, start: datetime, end: datetime) -> list[WeatherPoint]:
    """Der jüngste gespeicherte Wetterwert je Stunde in ``[start, end]`` (eine
    Stunde Rand, weil ein Stundenwert die VORANGEHENDE Stunde beschreibt)."""
    from datetime import timedelta  # noqa: PLC0415

    cur.execute(
        """
        SELECT DISTINCT ON (time) time, ghi_w_m2, dni_w_m2, dhi_w_m2, dni_normal_w_m2
        FROM weather_forecast
        WHERE site_id = %s AND time >= %s AND time <= %s
        ORDER BY time, run_at DESC
        """,
        (site_id, start, end + timedelta(hours=1)),
    )
    return [
        WeatherPoint(
            timestamp=ensure_utc(ts),
            temperature_c=None,
            cloud_cover_pct=None,
            ghi_w_m2=None if g is None else float(g),
            dni_w_m2=None if dn is None else float(dn),
            dhi_w_m2=None if dh is None else float(dh),
            dni_normal_w_m2=None if dnn is None else float(dnn),
        )
        for ts, g, dn, dh, dnn in cur.fetchall()
    ]


# ---- Schreiben ------------------------------------------------------------------

class EinheitErwartungRepository(ABC):
    @abstractmethod
    def upsert(self, record: EinheitErwartung) -> None: ...


class InMemoryEinheitErwartungRepository(EinheitErwartungRepository):
    """Offline-Referenz, geschlüsselt wie der Primärschlüssel der Tabelle."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str, date, int], EinheitErwartung] = {}

    def upsert(self, record: EinheitErwartung) -> None:
        key = (record.site_id, record.einheit_id, record.model, record.day, record.lead_days)
        self.rows[key] = record


_UPSERT_SQL = """
INSERT INTO solar_erwartung_einheit (
    day, tenant_id, site_id, einheit_id, model, lead_days,
    erwartet_kwh, leistung_kwp, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (site_id, einheit_id, model, day, lead_days) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    erwartet_kwh = EXCLUDED.erwartet_kwh,
    leistung_kwp = EXCLUDED.leistung_kwp,
    computed_at = now()
"""


class TimescaleEinheitErwartungRepository(EinheitErwartungRepository):
    """psycopg-Schreiber; eine gelöschte Einheit (Fremdschlüssel) lässt nur
    ihre eigene Zeile aus, nie den Lauf der übrigen."""

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def upsert(self, record: EinheitErwartung) -> None:
        try:
            with self._conn.cursor() as cur:
                if lebenden_bereich_sperren(cur, record.tenant_id):
                    cur.execute(
                        _UPSERT_SQL,
                        (
                            record.day,
                            record.tenant_id,
                            record.site_id,
                            record.einheit_id,
                            record.model,
                            record.lead_days,
                            record.erwartet_kwh,
                            record.leistung_kwp,
                        ),
                    )
                else:
                    logger.info("einheit_erwartung.bereich_ausgelassen site=%s", record.site_id)
            self._conn.commit()
        except _db_fehler("ForeignKeyViolation", "UndefinedTable") as exc:
            self._conn.rollback()
            logger.info(
                "einheit_erwartung.ausgelassen site=%s einheit=%s: %s",
                record.site_id,
                record.einheit_id,
                exc,
            )


def zeilen_fuer_tag(
    *,
    day: date,
    tenant_id: str,
    site_id: str,
    model: str,
    lead_days: int,
    predicted: dict[datetime, float],
    zeiten: list[datetime],
    einheiten: list[EinheitSpec],
    leistung: dict[str, list[float]],
) -> list[EinheitErwartung]:
    """Die Zeilen eines Tages und Modells - reine Funktion über die schon
    gerechnete physikalische Leistung."""
    anteile = anteile_je_slot(einheiten, leistung)
    kwh = erwartung_je_einheit(predicted, zeiten, anteile)
    return [
        EinheitErwartung(
            day=day,
            tenant_id=tenant_id,
            site_id=site_id,
            einheit_id=e.einheit_id,
            model=model,
            lead_days=lead_days,
            erwartet_kwh=kwh.get(e.einheit_id, 0.0),
            leistung_kwp=e.leistung_kwp,
        )
        for e in einheiten
    ]

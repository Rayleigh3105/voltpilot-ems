"""AW>0-Zeiten der Uebertragungsnetzbetreiber (netztransparenz.de, KEYLESS).

MiSpeL MP-7. Die Festlegung MiSpeL (BNetzA, Beschluss 01.10.2026) rechnet die
Marktpraemie nur fuer Netzeinspeisung "in Zeiten mit einem anzulegenden Wert
ueber null" - Anlage 1 Abschn. 2.1.7 (S. 16-17), Formel (24) (S. 38)::

    (24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ]

und Anlage 2 Formel (P12) (S. 31) gleichlautend. Welche Viertelstunden das
sind, entscheidet nicht der Spotpreis allein, sondern die Liste der UeNB
(A1 S. 17 Fn. 8, A2 S. 15 Fn. 11): "Netztransparenz > Erneuerbare Energien und
Umlagen > EEG > Transparenzanforderungen > Marktpraemie > Negativer
Spotmarktpreis - Uebersichtstabellen".

Quelle
------
Die Seite laedt ihre Tabellen ueber ein schluesselloses CSV-Handle (geprueft
live am 02.10.2026)::

    GET /DesktopModules/LotesNetztransparenz/ErneuerbareEnergienGesetz/
        Marktpraemie/Marktwerte/CsvDownload.ashx?request=<base64(json)>
    json = {"PublicationId": {...}, "FromDate": "YYYY-MM-01T00:00:00",
            "ToDate": "<Folgemonat>-01T00:00:00"}

Je Veroeffentlichung ("Differenzierung") eine Tabelle; ``PublicationId`` ist
das, was die Seite selbst ueber ``GetPublications.ashx`` anbietet:

==================  ==========================  =================================
regel               Seite                       PublicationId
==================  ==========================  =================================
viertelstunde       "1 Viertelstunde"           Logic 0, AggregationPeriod 1
viertelstunde_2ct   "2ct Logik" (§ 51b EEG)     Logic 1, AggregationPeriod 1
stunden_N           "N Stunde(n)", N=1,2,3,4,6  Logic 0, AggregationPeriod 0,
                                                ConsecutiveCount N
==================  ==========================  =================================

Tabellenform (Fixtures ``tests/fixtures/netztransparenz_aw_*.csv``, woertlich
vom Live-Endpunkt): Semikolon-CSV, eine Zeile je Kalendertag ``TT.MM.JJJJ``,
eine Spalte je (Viertel-)Stunde in deutscher Ortszeit (``00:00 - 00:15 Uhr``
bzw. ``00 - 01 Uhr``). Zelle ``Ja`` = Verguetungsanspruch (AW > 0), ``Nein`` =
AW in dieser (Viertel-)Stunde auf null verringert. Zeitumstellung:

* Fruehjahr - die ausgefallene Stunde 02:00-03:00 hat LEERE Zellen;
* Herbst - die doppelte Stunde hat ``Ja, Nein``-Paare: erster Wert = erstes
  Auftreten (Sommerzeit), zweiter = zweites (Winterzeit).

Ein noch nicht veroeffentlichter Monat ("monatsweise rueckwirkend") liefert
einen LEEREN Koerper - das ist der Normalfall, kein Fehler.

Luecken (wie bei den Day-Ahead-Preisen): eine leere Zelle einer existierenden
Ortszeit ist KEIN "Ja" und KEIN "Nein" - sie wird ausgelassen und gezaehlt.
Unbekannt bleibt unbekannt; der Leser (api ``MispelMarktdatenRepository``)
entscheidet ueber den Rueckfall. Jede Abweichung von der Tabellenform (Kopf,
Datum ausserhalb des Monats, unbekannter Zellwert) bricht laut ab - eine
falsch gelesene Spalte ergaebe still falsche Foerderzeiten.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Mapping, Protocol
from zoneinfo import ZoneInfo

from voltpilot_market_data.http import HttpClient, RequestsHttpClient
from voltpilot_market_data.market_value import (
    MarketValueSourceError,
    MarketValueSourceUnavailable,
)

logger = logging.getLogger("voltpilot.market_data.netztransparenz_aw")

DEFAULT_BASE_URL = "https://www.netztransparenz.de"
SOURCE_TAG = "netztransparenz"
_CSV_PATH = (
    "/DesktopModules/LotesNetztransparenz/ErneuerbareEnergienGesetz/"
    "Marktpraemie/Marktwerte/CsvDownload.ashx"
)

GERMAN_TZ = ZoneInfo("Europe/Berlin")

PT15M = "PT15M"
PT60M = "PT60M"


class AwQuelleNichtErreichbar(MarketValueSourceUnavailable):
    """Transportfehler (Netz, DNS, TLS, Zeitueberschreitung): der Rest des Laufs
    wird uebersprungen, statt jede weitere Anfrage in dieselbe Wand laufen zu
    lassen - die serve-Schleife holt auch die Day-Ahead-Preise."""


@dataclass(frozen=True)
class AwRegel:
    """Eine Differenzierung der UeNB-Uebersichtstabellen."""

    key: str
    seite: str  # Bezeichnung auf netztransparenz.de, woertlich
    logic: int
    aggregation_period: int  # 1 = Viertelstunden-, 0 = Stundentabelle
    consecutive_count: int

    @property
    def aufloesung(self) -> str:
        return PT15M if self.aggregation_period == 1 else PT60M

    def publication_id(self) -> dict[str, int]:
        return {
            "Type": 0,
            "Logic": self.logic,
            "AggregationPeriod": self.aggregation_period,
            "ConsecutiveCount": self.consecutive_count,
        }


REGELN: tuple[AwRegel, ...] = (
    AwRegel("viertelstunde", "1 Viertelstunde", 0, 1, 1),
    AwRegel("viertelstunde_2ct", "2ct Logik", 1, 1, 1),
    AwRegel("stunden_1", "1 Stunde", 0, 0, 1),
    AwRegel("stunden_2", "2 Stunden", 0, 0, 2),
    AwRegel("stunden_3", "3 Stunden", 0, 0, 3),
    AwRegel("stunden_4", "4 Stunden", 0, 0, 4),
    AwRegel("stunden_6", "6 Stunden", 0, 0, 6),
)
REGEL_NACH_KEY: Mapping[str, AwRegel] = {r.key: r for r in REGELN}


@dataclass(frozen=True)
class AwZeit:
    """Eine veroeffentlichte (Viertel-)Stunde: AW > 0 ja oder nein.

    ``ts`` ist der Beginn in UTC; ``aufloesung`` die native Laenge der Zeile
    der UeNB-Tabelle (eine Stundenzeile gilt fuer ihre vier Viertelstunden).
    """

    regel: str
    ts: datetime
    aufloesung: str
    aw_groesser_null: bool
    source: str = SOURCE_TAG


@dataclass(frozen=True)
class AwMonat:
    """Ergebnis eines Monatsabrufs fuer eine Regel."""

    regel: str
    monat: date
    zeiten: tuple[AwZeit, ...]
    luecken: int  # leere Zellen an existierenden Ortszeiten

    @property
    def veroeffentlicht(self) -> bool:
        return bool(self.zeiten)

    @property
    def vollstaendig(self) -> bool:
        """Jede (Viertel-)Stunde des Monats hat einen Wert."""
        return len(self.zeiten) == intervalle_im_monat(
            self.monat, REGEL_NACH_KEY[self.regel].aufloesung
        )


def intervalle_im_monat(monat: date, aufloesung: str) -> int:
    """Zahl der (Viertel-)Stunden eines deutschen Kalendermonats.

    Ein Tag mit Zeitumstellung hat 23 bzw. 25 Stunden (92 bzw. 100
    Viertelstunden) - nie pauschal 24.
    """
    start = datetime(monat.year, monat.month, 1, tzinfo=GERMAN_TZ)
    folge = _folgemonat(monat)
    ende = datetime(folge.year, folge.month, 1, tzinfo=GERMAN_TZ)
    sekunden = (ende.astimezone(timezone.utc) - start.astimezone(timezone.utc)).total_seconds()
    return int(sekunden // (900 if aufloesung == PT15M else 3600))


def _folgemonat(monat: date) -> date:
    return date(monat.year + (monat.month == 12), monat.month % 12 + 1, 1)


_KOPF_15 = re.compile(r"^(\d\d):(\d\d) - (\d\d):(\d\d) Uhr$")
_KOPF_60 = re.compile(r"^(\d\d) - (\d\d) Uhr$")


def _erwartete_kopfzeile(aufloesung: str) -> list[str]:
    if aufloesung == PT15M:
        out = []
        for q in range(96):
            a, b = q * 15, q * 15 + 15
            out.append(f"{a // 60:02d}:{a % 60:02d} - {b // 60:02d}:{b % 60:02d} Uhr")
        return out
    return [f"{h:02d} - {h + 1:02d} Uhr" for h in range(24)]


def _zelle(text: str, wo: str) -> bool:
    if text == "Ja":
        return True
    if text == "Nein":
        return False
    raise MarketValueSourceError(f"netztransparenz AW-Tabelle: unbekannter Wert {text!r} ({wo})")


def _existiert(lokal: datetime) -> bool:
    """Eine Ortszeit existiert, wenn sie den UTC-Hin- und Rueckweg uebersteht."""
    rueck = lokal.astimezone(timezone.utc).astimezone(GERMAN_TZ)
    return rueck.replace(tzinfo=None) == lokal.replace(tzinfo=None)


def _doppelt(lokal: datetime) -> bool:
    """Die Ortszeit kommt zweimal vor (Herbst-Zeitumstellung)."""
    return lokal.replace(fold=0).utcoffset() != lokal.replace(fold=1).utcoffset()


def parse_aw_csv(body: str, regel: AwRegel, monat: date) -> AwMonat:
    """Uebersetzt eine UeNB-Uebersichtstabelle in :class:`AwZeit`-Zeilen.

    Leerer Koerper = Monat noch nicht veroeffentlicht (leeres Ergebnis).
    """
    text = body.lstrip("﻿")
    zeilen = [z for z in text.splitlines() if z.strip()]
    if not zeilen:
        return AwMonat(regel.key, monat, (), 0)

    kopf = [c.strip() for c in zeilen[0].split(";")]
    erwartet = ["Datum", *_erwartete_kopfzeile(regel.aufloesung)]
    if kopf != erwartet:
        raise MarketValueSourceError(
            f"netztransparenz AW-Tabelle ({regel.key}): unerwarteter Kopf "
            f"{kopf[:3]!r}..{kopf[-1:]!r} ({len(kopf)} Spalten, erwartet {len(erwartet)})"
        )
    schritt = timedelta(minutes=15 if regel.aufloesung == PT15M else 60)

    zeiten: list[AwZeit] = []
    luecken = 0
    gesehen: set[date] = set()
    for zeile in zeilen[1:]:
        zellen = [c.strip() for c in zeile.split(";")]
        if len(zellen) != len(kopf):
            raise MarketValueSourceError(
                f"netztransparenz AW-Tabelle ({regel.key}): Zeile mit {len(zellen)} "
                f"statt {len(kopf)} Zellen: {zeile[:40]!r}"
            )
        try:
            tag = datetime.strptime(zellen[0], "%d.%m.%Y").date()
        except ValueError as exc:
            raise MarketValueSourceError(
                f"netztransparenz AW-Tabelle ({regel.key}): Datum {zellen[0]!r}"
            ) from exc
        if (tag.year, tag.month) != (monat.year, monat.month) or tag in gesehen:
            raise MarketValueSourceError(
                f"netztransparenz AW-Tabelle ({regel.key}): Tag {tag} gehoert nicht "
                f"(einmalig) zum Monat {monat:%Y-%m}"
            )
        gesehen.add(tag)

        for i, zelle in enumerate(zellen[1:]):
            lokal = datetime.combine(tag, time()) + i * schritt
            lokal = lokal.replace(tzinfo=GERMAN_TZ)
            wo = f"{tag} {kopf[i + 1]}"
            if not _existiert(lokal):
                if zelle:
                    raise MarketValueSourceError(
                        f"netztransparenz AW-Tabelle ({regel.key}): Wert an "
                        f"ausgefallener Ortszeit {wo}"
                    )
                continue
            werte = [w.strip() for w in zelle.split(",")] if zelle else []
            if not werte:
                luecken += 1
                continue
            if _doppelt(lokal):
                if len(werte) != 2:
                    raise MarketValueSourceError(
                        f"netztransparenz AW-Tabelle ({regel.key}): doppelte Ortszeit "
                        f"{wo} braucht zwei Werte, hat {zelle!r}"
                    )
                faelle = ((lokal.replace(fold=0), werte[0]), (lokal.replace(fold=1), werte[1]))
            else:
                if len(werte) != 1:
                    raise MarketValueSourceError(
                        f"netztransparenz AW-Tabelle ({regel.key}): {wo} hat {zelle!r}"
                    )
                faelle = ((lokal, werte[0]),)
            for zeitpunkt, wert in faelle:
                zeiten.append(
                    AwZeit(
                        regel=regel.key,
                        ts=zeitpunkt.astimezone(timezone.utc),
                        aufloesung=regel.aufloesung,
                        aw_groesser_null=_zelle(wert, wo),
                    )
                )

    zeiten.sort(key=lambda z: z.ts)
    return AwMonat(regel.key, monat, tuple(zeiten), luecken)


@dataclass(frozen=True)
class NetztransparenzAwConfig:
    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "NetztransparenzAwConfig":
        env = os.environ if env is None else env
        return cls(
            base_url=env.get("NETZTRANSPARENZ_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            timeout_seconds=float(env.get("NETZTRANSPARENZ_TIMEOUT_SECONDS", "30")),
        )


def csv_request(regel: AwRegel, monat: date) -> str:
    """Der base64-Parameter, den die Seite selbst baut (Ende exklusiv)."""
    folge = _folgemonat(monat)
    anfrage = {
        "PublicationId": regel.publication_id(),
        "FromDate": f"{monat.year:04d}-{monat.month:02d}-01T00:00:00",
        "ToDate": f"{folge.year:04d}-{folge.month:02d}-01T00:00:00",
    }
    return base64.b64encode(
        json.dumps(anfrage, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")


class NetztransparenzAwSource:
    """Holt einen Monat einer Regel von netztransparenz.de."""

    def __init__(
        self,
        config: NetztransparenzAwConfig | None = None,
        http_client: HttpClient | None = None,
    ) -> None:
        self._config = config or NetztransparenzAwConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch_monat(self, regel: AwRegel, monat: date) -> AwMonat:
        url = f"{self._config.base_url.rstrip('/')}{_CSV_PATH}"
        try:
            resp = self._http.get(
                url, {"request": csv_request(regel, monat)}, self._config.timeout_seconds
            )
        except Exception as exc:  # network / DNS / TLS
            raise AwQuelleNichtErreichbar(
                f"netztransparenz AW request failed: {exc}"
            ) from exc
        if resp.status_code >= 500:
            raise MarketValueSourceUnavailable(
                f"netztransparenz AW server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise MarketValueSourceError(
                f"netztransparenz AW returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        ergebnis = parse_aw_csv(resp.text, regel, monat)
        logger.info(
            "netztransparenz_aw.fetch.ok",
            extra={"context": {
                "regel": regel.key, "monat": monat.isoformat(),
                "zeiten": len(ergebnis.zeiten), "luecken": ergebnis.luecken,
                "vollstaendig": ergebnis.vollstaendig,
            }},
        )
        return ergebnis


class AwZeitRepository(Protocol):
    def upsert_zeiten(self, zeiten: Iterable[AwZeit]) -> int:
        """Schreibt veroeffentlichte Zeilen; die neueste Veroeffentlichung gewinnt."""
        ...


class InMemoryAwZeitRepository:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, datetime], AwZeit] = {}

    def upsert_zeiten(self, zeiten: Iterable[AwZeit]) -> int:
        n = 0
        for z in zeiten:
            self.rows[(z.regel, z.ts)] = z
            n += 1
        return n


_UPSERT_SQL = """
INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null, source, fetched_at)
VALUES (%s, %s, %s, %s, %s, now())
ON CONFLICT (regel, ts)
DO UPDATE SET
    aufloesung       = EXCLUDED.aufloesung,
    aw_groesser_null = EXCLUDED.aw_groesser_null,
    source           = EXCLUDED.source,
    fetched_at       = now();
"""


class TimescaleAwZeitRepository:
    """psycopg-backed repository writing into ``eeg_aw_zeit``."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_zeiten(self, zeiten: Iterable[AwZeit]) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = [(z.regel, z.ts, z.aufloesung, z.aw_groesser_null, z.source) for z in zeiten]
        if not rows:
            return 0
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        return len(rows)


@dataclass(frozen=True)
class AwRefreshResult:
    monate: tuple[AwMonat, ...]
    rows_written: int
    fehler: tuple[str, ...]


def monate_zum_abruf(heute: date, zurueck: int = 2) -> tuple[date, ...]:
    """Der laufende Monat und die ``zurueck`` Vormonate (aelteste zuerst).

    Die UeNB veroeffentlichen "jeweils monatsweise rueckwirkend"; der laufende
    Monat ist darum meist leer, der Vormonat erscheint im Lauf des Monats, und
    der vorvorige faengt spaete Korrekturen.
    """
    m = date(heute.year, heute.month, 1)
    out = [m]
    for _ in range(zurueck):
        m = date(m.year - (m.month == 1), (m.month - 2) % 12 + 1, 1)
        out.append(m)
    return tuple(reversed(out))


def refresh_aw_zeiten(
    source: NetztransparenzAwSource,
    repository: AwZeitRepository | None,
    monate: Iterable[date],
    regeln: Iterable[AwRegel] = REGELN,
) -> AwRefreshResult:
    """Holt jede Regel fuer jeden Monat; ein Fehler einer Tabelle haelt die
    anderen nicht auf, eine unerreichbare Quelle beendet den Lauf."""
    monate = tuple(monate)
    ergebnisse: list[AwMonat] = []
    fehler: list[str] = []
    written = 0
    for regel in regeln:
        for monat in monate:
            try:
                ergebnis = source.fetch_monat(regel, monat)
            except MarketValueSourceError as exc:
                fehler.append(f"{regel.key} {monat:%Y-%m}: {exc}")
                logger.warning(
                    "netztransparenz_aw.fetch.failed",
                    extra={"context": {"regel": regel.key, "monat": monat.isoformat(),
                                       "error": str(exc)}},
                )
                if isinstance(exc, AwQuelleNichtErreichbar):
                    return AwRefreshResult(tuple(ergebnisse), written, tuple(fehler))
                continue
            ergebnisse.append(ergebnis)
            if repository is not None and ergebnis.zeiten:
                written += repository.upsert_zeiten(ergebnis.zeiten)
    return AwRefreshResult(tuple(ergebnisse), written, tuple(fehler))

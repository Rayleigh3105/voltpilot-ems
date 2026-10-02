"""Jahresmarktwert (JW) der UeNB von netztransparenz.de (KEYLESS). MiSpeL MP-7.

In der Abgrenzungs- und der Pauschaloption ist die Marktpraemie "anhand des
energietraegerspezifischen Jahresmarktwerts zu berechnen" (MiSpeL Anlage 1
S. 21 Vor. 5, Anlage 2 S. 20; Anlage 1 Nr. 2 S. 2 EEG) - Bestandsanlagen
wechseln mit der Option vom Monats- zum Jahresmarktwert.

Quelle
------
Die UeNB veroeffentlichen die Werte auf der Marktwertuebersicht unter der
Ueberschrift "Jahresmarktwerte (JW) gemäß Anlage 1 (zu § 23a) Nr. 5.3 zum EEG".
Anders als die Monatswerte (``netztransparenz.py``, JSON-Dienst) hat diese
Tabelle KEINEN Datendienst: die Seite rendert das neueste veroeffentlichte Jahr
serverseitig als Tabelle (``id=...JahresmarktwerteRadGridData_ctl00``); aeltere
Jahre gibt es nur per WebForms-Postback. Gelesen wird darum genau diese eine
Tabelle - Kopf "Alle Werte in ct/kWh" + Jahr, Zeilen "JW" + Energietraeger -
und alles andere bricht laut ab. Da der Wert einmal je Jahr erscheint und jeder
Abruf gespeichert wird, sammelt der Dienst die Jahre ueber die Zeit an.

Energietraeger (Zeilen der Tabelle, Spalte ``technology``):

=====================  ================
Zeile                  technology
=====================  ================
"JW"                   allgemein
"JW Wind an Land"      wind_an_land
"JW Wind auf See"      wind_auf_see
"JW Solar"             solar
=====================  ================

``allgemein`` ist der JW ohne Energietraeger-Zusatz (das Jahresmittel des
Spotmarktpreises; das Monats-Gegenstueck ist die Spalte "MW" neben
"Spotmarktpreis" in ``GetMarketpremiumData``).
"""

from __future__ import annotations

import html
import logging
import os
import re
from dataclasses import dataclass
from typing import Iterable, Protocol

from voltpilot_market_data.http import HttpClient, RequestsHttpClient
from voltpilot_market_data.market_value import (
    MarketValueSourceError,
    MarketValueSourceUnavailable,
)

logger = logging.getLogger("voltpilot.market_data.netztransparenz_jahresmarktwert")

DEFAULT_BASE_URL = "https://www.netztransparenz.de"
SOURCE_TAG = "netztransparenz"
PAGE_PATH = (
    "/de-de/Erneuerbare-Energien-und-Umlagen/EEG/Transparenzanforderungen/"
    "Marktpr%C3%A4mie/Marktwert%C3%BCbersicht"  # Marktprämie/Marktwertübersicht
)

TECHNOLOGIE_NACH_ZEILE = {
    "JW": "allgemein",
    "JW Wind an Land": "wind_an_land",
    "JW Wind auf See": "wind_auf_see",
    "JW Solar": "solar",
}


@dataclass(frozen=True)
class AnnualMarketValue:
    """Ein Jahresmarktwert je Energietraeger in ct/kWh (Einheit der UeNB)."""

    year: int
    technology: str
    value_ct_kwh: float
    provisional: bool = False
    source: str = SOURCE_TAG


_TABELLE = re.compile(
    r'<table[^>]*id="[^"]*JahresmarktwerteRadGridData_ctl00"[^>]*>(.*?)</table>', re.S
)
_TH = re.compile(r"<th[^>]*>(.*?)</th>", re.S)
_TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_SPAN = re.compile(r"<span[^>]*>(.*?)</span>", re.S)
_ZAHL = re.compile(r"^-?\d+(,\d+)?$")


def _text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def parse_jahresmarktwert_html(body: str) -> tuple[AnnualMarketValue, ...]:
    """Liest die serverseitig gerenderte JW-Tabelle (neuestes Jahr)."""
    treffer = _TABELLE.search(body)
    if not treffer:
        raise MarketValueSourceUnavailable(
            "netztransparenz: keine Jahresmarktwert-Tabelle auf der Seite"
        )
    tabelle = treffer.group(1)
    kopf = [_text(th) for th in _TH.findall(tabelle)]
    if len(kopf) != 2 or kopf[0] != "Alle Werte in ct/kWh" or not re.fullmatch(r"\d{4}", kopf[1]):
        raise MarketValueSourceError(f"netztransparenz JW-Tabelle: unerwarteter Kopf {kopf!r}")
    jahr = int(kopf[1])

    werte: list[AnnualMarketValue] = []
    for zeile in _TR.findall(tabelle):
        zellen = _TD.findall(zeile)
        if not zellen:
            continue  # Kopfzeile
        if len(zellen) != 2:
            raise MarketValueSourceError(f"netztransparenz JW-Zeile: {_text(zeile)!r}")
        name = " ".join(s for s in (_text(sp) for sp in _SPAN.findall(zellen[0])) if s)
        if name not in TECHNOLOGIE_NACH_ZEILE:
            raise MarketValueSourceError(f"netztransparenz JW-Zeile unbekannt: {name!r}")
        zahl = _text(zellen[1])
        if not zahl:
            continue  # noch nicht veroeffentlicht
        if not _ZAHL.match(zahl):
            raise MarketValueSourceError(f"netztransparenz JW-Wert {zahl!r} ist keine Zahl")
        werte.append(
            AnnualMarketValue(
                year=jahr,
                technology=TECHNOLOGIE_NACH_ZEILE[name],
                value_ct_kwh=float(zahl.replace(",", ".")),
            )
        )
    if not werte:
        raise MarketValueSourceUnavailable("netztransparenz JW-Tabelle ohne Werte")
    return tuple(werte)


@dataclass(frozen=True)
class NetztransparenzJahresmarktwertConfig:
    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(
        cls, env: dict[str, str] | None = None
    ) -> "NetztransparenzJahresmarktwertConfig":
        env = os.environ if env is None else env
        return cls(
            base_url=env.get("NETZTRANSPARENZ_BASE_URL", DEFAULT_BASE_URL).strip()
            or DEFAULT_BASE_URL,
            timeout_seconds=float(env.get("NETZTRANSPARENZ_TIMEOUT_SECONDS", "30")),
        )


class NetztransparenzJahresmarktwertSource:
    def __init__(
        self,
        config: NetztransparenzJahresmarktwertConfig | None = None,
        http_client: HttpClient | None = None,
    ) -> None:
        self._config = config or NetztransparenzJahresmarktwertConfig()
        self._http = http_client or RequestsHttpClient()

    def fetch_neuestes_jahr(self) -> tuple[AnnualMarketValue, ...]:
        url = f"{self._config.base_url.rstrip('/')}{PAGE_PATH}"
        try:
            resp = self._http.get(url, {}, self._config.timeout_seconds)
        except Exception as exc:  # network / DNS / TLS
            raise MarketValueSourceUnavailable(
                f"netztransparenz JW request failed: {exc}"
            ) from exc
        if resp.status_code >= 500:
            raise MarketValueSourceUnavailable(
                f"netztransparenz JW server error (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            raise MarketValueSourceError(f"netztransparenz JW returned HTTP {resp.status_code}")
        werte = parse_jahresmarktwert_html(resp.text)
        logger.info(
            "netztransparenz_jw.fetch.ok",
            extra={"context": {"jahr": werte[0].year, "werte": len(werte)}},
        )
        return werte


class AnnualMarketValueRepository(Protocol):
    def upsert_values(self, values: Iterable[AnnualMarketValue]) -> int:
        """Veroeffentlicht schlaegt vorlaeufig - wie ``monthly_market_value``."""
        ...


class InMemoryAnnualMarketValueRepository:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, int], AnnualMarketValue] = {}

    def upsert_values(self, values: Iterable[AnnualMarketValue]) -> int:
        n = 0
        for v in values:
            alt = self.rows.get((v.technology, v.year))
            if alt is not None and not alt.provisional and v.provisional:
                continue
            self.rows[(v.technology, v.year)] = v
            n += 1
        return n


_UPSERT_SQL = """
INSERT INTO annual_market_value
    (year, technology, value_ct_kwh, provisional, source, fetched_at)
VALUES (%s, %s, %s, %s, %s, now())
ON CONFLICT (technology, year)
DO UPDATE SET
    value_ct_kwh = EXCLUDED.value_ct_kwh,
    provisional  = EXCLUDED.provisional,
    source       = EXCLUDED.source,
    fetched_at   = now()
WHERE annual_market_value.provisional OR NOT EXCLUDED.provisional;
"""


class TimescaleAnnualMarketValueRepository:
    """psycopg-backed repository writing into ``annual_market_value``."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def upsert_values(self, values: Iterable[AnnualMarketValue]) -> int:
        import psycopg  # lazy: optional [db] extra

        rows = [(v.year, v.technology, v.value_ct_kwh, v.provisional, v.source) for v in values]
        if not rows:
            return 0
        with psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        return len(rows)

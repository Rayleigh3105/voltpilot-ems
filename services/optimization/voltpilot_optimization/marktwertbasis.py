"""Marktwertbasis aus dem Förderweg (MiSpeL MP-12, Entscheide W3 und W4).

Die Festlegung der BNetzA zur Marktintegration von Speichern und Ladepunkten
("MiSpeL", Beschluss 01.10.2026) gibt für die Marktprämie zwei Dinge vor, die
von der heutigen Regel (Monatsmarktwert Solar, keine Prämie bei Spot < 0)
abweichen - beide nur für Anlagen in einer MiSpeL-Option:

- **Jahresmarktwert (W3).** "Die Höhe der Marktprämie ist nach den geltenden
  speziellen Vorgaben der Anlage 1 Nr. 2 S. 2 des EEG im Fall der
  Abgrenzungsoption anhand des energieträgerspezifischen Jahresmarktwerts zu
  berechnen. Bestandsanlagen, deren Marktprämie bisher anhand von
  Monatsmarktwerten berechnet wird, wechseln mit der Inanspruchnahme der
  Abgrenzungsoption [...] zum Jahresmarktwert." (Anlage 1 S. 21, Voraussetzung
  5; gleichlautend Anlage 2 S. 20 für die Pauschaloption; Tenor S. 25-26.)
  Auch bei einer unterjährigen Änderung gilt der Jahresmarktwert, nicht der
  Monatsmarktwert (Tenor S. 57).
- **AW>0-Zeiten (W4).** Formel (24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ] (Anlage 1
  S. 38; (P12)¼ Anlage 2 S. 31): Prämie nur in Viertelstunden, in denen der
  anzulegende Wert nicht auf null verringert ist. Welche das sind,
  veröffentlichen die Übertragungsnetzbetreiber je gesetzlicher
  Differenzierung (Anlage 1 S. 17 Fn. 8) - in ``eeg_aw_zeit`` je ``regel``
  (MiSpeL MP-7). Ohne Listeneintrag gilt nur als Rückfall die vereinfachte
  Regel "AW¼ = 0 bei SP¼ < 0", und das Ergebnis ist vorläufig.

Welcher Förderweg an einem Tag gilt, steht in ``site_foerderweg`` (MP-5): die
späteste nicht aufgehobene Fassung mit ``gueltig_ab <= Tag`` (Europe/Berlin);
ohne Fassung gilt der Bestand, und der kennt keine MiSpeL-Option
(docs/contracts/v2/mispel-foerderweg.md § 2, § 5). Alle anderen Anlagen und
Tage rechnen unverändert mit dem Monatsmarktwert.

**Regel-Eingang.** Die AW-Differenzierung einer Anlage (``AW_REGELN``) ist ein
Stammdatum, das es noch nicht gibt (Folgepaket "AW-Differenzierung als
Stammdatum am Förderweg"). Bis dahin ruft jeder Leser mit ``aw_regel=None`` auf:
keine Liste, W4-Rückfall, Stand vorläufig. Für Planfenster ist die Liste ohnehin
leer - die ÜNB veröffentlichen sie monatsweise rückwirkend (MP-7) -, sie wirkt
also in Rückrechnungen über gespeicherte Monate (Simulation, MP-13).

Dieselbe Grundlage rechnen die Erlöse (``SlotEconomics.exportValueCtSql``
in services/api) - eine Preiswahrheit für Plan und Anzeige.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Mapping
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")

FOERDERWEG_ABGRENZUNG = "marktpraemie_abgrenzung"
FOERDERWEG_PAUSCHAL = "marktpraemie_pauschal"
# Die beiden MiSpeL-Optionen (§ 19 Abs. 3b, 3c EEG): Marktprämie nach dem
# Jahresmarktwert und nur in AW>0-Viertelstunden.
MISPEL_FOERDERWEGE = frozenset({FOERDERWEG_ABGRENZUNG, FOERDERWEG_PAUSCHAL})

# Die Differenzierungen der ÜNB-Übersichtstabellen (Anlage 1 S. 17 Fn. 8;
# CHECK von ``eeg_aw_zeit.regel``, MispelMarktdatenRepository.REGELN).
AW_REGELN = frozenset({
    "viertelstunde", "viertelstunde_2ct",
    "stunden_1", "stunden_2", "stunden_3", "stunden_4", "stunden_6",
})

# Energieträger des Jahresmarktwerts, wie beim Monatsmarktwert Solar.
TECHNOLOGIE_SOLAR = "solar"

_VIERTELSTUNDE = timedelta(minutes=15)


def berlin_day(at: datetime) -> date:
    """Der gesetzliche Kalendertag (Europe/Berlin) eines Zeitpunkts."""
    return at.astimezone(BERLIN).date()


def berlin_year(at: datetime) -> int:
    """Das Kalenderjahr (Europe/Berlin) - der Schlüssel des Jahresmarktwerts."""
    return at.astimezone(BERLIN).year


@dataclass(frozen=True)
class MarktwertBasis:
    """Die Marktwertbasis einer Anlage über ein Fenster.

    ``mispel_tage``: die Kalendertage (Europe/Berlin), an denen die Anlage in
    einer MiSpeL-Option ist. ``jahresmarktwert_ct``: Jahresmarktwert Solar je
    Kalenderjahr in ct/kWh (``annual_market_value``); ein fehlendes Jahr heißt
    keine Prämie, nie eine erfundene. ``aw_groesser_null``: Formel (24)¼ aus
    der ÜNB-Liste je Viertelstundenbeginn (UTC); fehlt eine Viertelstunde,
    greift der W4-Rückfall. ``aw_regel``: die Differenzierung, aus der die
    Liste stammt - ``None`` = noch kein Stammdatum.
    """

    mispel_tage: frozenset[date] = frozenset()
    jahresmarktwert_ct: Mapping[int, float] = field(default_factory=dict)
    aw_groesser_null: Mapping[datetime, bool] = field(default_factory=dict)
    aw_regel: str | None = None

    def ist_mispel(self, slot_start: datetime) -> bool:
        return berlin_day(slot_start) in self.mispel_tage

    def aw_amtlich(self, slot_start: datetime) -> bool | None:
        """Formel (24)¼ aus der ÜNB-Liste, ``None`` = kein Listeneintrag."""
        return self.aw_groesser_null.get(slot_start)


def praemien_viertelstunde(
    basis: MarktwertBasis, slot_start: datetime, spot_eur_mwh: float
) -> tuple[bool, bool]:
    """(Prämie in dieser Viertelstunde?, vorläufig?) für einen MiSpeL-Tag.

    Die Liste gewinnt - auch gegen das Vorzeichen des Spotpreises: unter einer
    Stunden-Differenzierung bleibt der anzulegende Wert in einer einzelnen
    negativen Viertelstunde über null. Ohne Listeneintrag der W4-Rückfall
    "AW¼ = 0 bei SP¼ < 0" (MispelMarktdatenRepository.RUECKFALL_SPOT).
    """
    amtlich = basis.aw_amtlich(slot_start)
    if amtlich is not None:
        return amtlich, False
    return spot_eur_mwh >= 0, True


def load_marktwertbasis(
    dsn: str,
    site_id,
    slot_starts: list[datetime],
    aw_regel: str | None = None,
) -> MarktwertBasis:
    """Die Marktwertbasis einer Anlage für die Viertelstunden eines Laufs.

    Liest den Förderweg je Tag (``site_foerderweg``, die vertrauenswürdige
    Backend-Rolle wie bei ``site_supply_price``), den Jahresmarktwert Solar der
    berührten Jahre und - nur mit ``aw_regel`` - die ÜNB-Liste. Keine
    MiSpeL-Fassung im Fenster: eine leere Basis ohne weitere Abfrage.
    """
    if not slot_starts:
        return MarktwertBasis(aw_regel=aw_regel)
    if aw_regel is not None and aw_regel not in AW_REGELN:
        raise ValueError(f"unbekannte AW-Regel: {aw_regel}")
    import psycopg  # lazy: optional [db] extra

    tage = sorted({berlin_day(s) for s in slot_starts})
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT gueltig_ab, foerderweg FROM site_foerderweg
            WHERE site_id = %s AND aufgehoben_am IS NULL AND gueltig_ab <= %s
            ORDER BY gueltig_ab
            """,
            (site_id, tage[-1]),
        )
        fassungen = cur.fetchall()
        mispel_tage = frozenset(
            tag for tag in tage if _foerderweg_am(fassungen, tag) in MISPEL_FOERDERWEGE
        )
        if not mispel_tage:
            return MarktwertBasis(aw_regel=aw_regel)
        jahre = sorted({tag.year for tag in mispel_tage})
        cur.execute(
            """
            SELECT year, value_ct_kwh FROM annual_market_value
            WHERE technology = %s AND year = ANY(%s)
            """,
            (TECHNOLOGIE_SOLAR, jahre),
        )
        jahresmarktwert = {int(j): float(v) for j, v in cur.fetchall()}
        aw: dict[datetime, bool] = {}
        if aw_regel is not None:
            von = min(slot_starts)
            bis = max(slot_starts) + _VIERTELSTUNDE
            cur.execute(
                """
                SELECT ts, aufloesung, aw_groesser_null FROM eeg_aw_zeit
                WHERE regel = %s AND ts > %s - INTERVAL '60 minutes' AND ts < %s
                """,
                (aw_regel, von, bis),
            )
            aw = _aw_je_viertelstunde(cur.fetchall())
    return MarktwertBasis(
        mispel_tage=mispel_tage,
        jahresmarktwert_ct=jahresmarktwert,
        aw_groesser_null=aw,
        aw_regel=aw_regel,
    )


def _foerderweg_am(fassungen: list[tuple[date, str]], tag: date) -> str | None:
    """Der Förderweg der spätesten Fassung mit ``gueltig_ab <= tag`` (die
    Fassungen aufsteigend nach ``gueltig_ab``); ``None`` = keine Fassung, der
    Bestand gilt - und der ist nie eine MiSpeL-Option."""
    am = None
    for gueltig_ab, foerderweg in fassungen:
        if gueltig_ab > tag:
            break
        am = foerderweg
    return am


def _aw_je_viertelstunde(rows) -> dict[datetime, bool]:
    """Die ÜNB-Liste je Viertelstunde: eine Stundenzeile gilt für ihre vier
    Viertelstunden, die feinere Auflösung gewinnt (wie
    MispelMarktdatenRepository)."""
    out: dict[datetime, bool] = {}
    fein: set[datetime] = set()
    for ts, aufloesung, wert in rows:
        beginn = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        beginn = beginn.astimezone(timezone.utc)
        if aufloesung == "PT60M":
            for q in range(4):
                t = beginn + q * _VIERTELSTUNDE
                if t not in fein:
                    out[t] = bool(wert)
        else:
            out[beginn] = bool(wert)
            fein.add(beginn)
    return out

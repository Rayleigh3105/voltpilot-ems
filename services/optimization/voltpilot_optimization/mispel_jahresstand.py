"""MiSpeL MP-26: der Jahreszustand der Pauschaloption fuer den Optimierer.

Festlegung zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az.
618-25-02, Beschluss 01.10.2026), Anlage 2; Zitierweise „A2 S. 30“ = Anlage 2,
Seite 30, „T S. 63“ = Tenor mit Begruendung, Seite 63. Bauplan
``vp-mispel-fundament`` § 8 Zeile MP-26.

Die Pauschaloption ordnet die gesamte Netzeinspeisung eines Kalenderjahres
pauschal in drei Teilmengen ein (A2 S. 9-10, Abb. 1): bis (P1) grundsaetzlich
foerderfaehig, zwischen (P1) und (P4) indifferent, ueber (P4) grundsaetzlich
saldierungsfaehig - saldiert nur in SP≥0-Zeiten und hoechstens bis zum
Jahres-Netzbezug (P10). Ein Rumpfjahr tritt an die Stelle des Kalenderjahres
(A2 S. 51-55); einen Monatsbezug gibt es nicht (T S. 63). Ein Optimierer-Lauf
sieht nur seinen Horizont; welche Teilmenge eine weitere kWh trifft, entscheidet
aber der Stand am Ende des Zeitraums. Darum bekommt jeder Lauf je Zeitraum
seines Horizonts die Grenzen und die ∑J-Summen ausserhalb des Horizonts
(:class:`~voltpilot_optimization.domain.MispelJahresstand`):

- **Grenzen** (P1)/(P1)R und (P4)/(P4)R - fuer den Zeitraum des Jahreslaufs
  aus dessen Jahreswerten, fuer jeden anderen gerechnet vom Rechenwerk MP-25
  (:func:`voltpilot_optimization.mispel_pauschal.jahr`) mit den Stammdaten des
  Jahreslaufs.
- **bisher** - (P14), (P7), (P9) aus den Jahreswerten des juengsten
  Jahreslaufs (MP-25, ``mispel_pauschal_jahr``; geladen von
  :func:`voltpilot_optimization.inputs.load_mispel_pauschal_bisher`).
- **Jahresrest** - die Zeit des Zeitraums, die weder in den bisherigen Mengen
  noch im Horizont liegt: geschaetzt mit dem bisherigen Tempo je Stunde, wie
  der Monatsrest der Abgrenzung (MP-11). Unter einem Tag gerechneter
  Viertelstunden ist das Tempo nicht bestimmt; der Rest ist dann 0.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from typing import Mapping, Sequence

from voltpilot_optimization import mispel_pauschal
from voltpilot_optimization.domain import MispelJahresstand
from voltpilot_optimization.mispel_monatsstand import MINDEST_VIERTELSTUNDEN, VIERTELSTUNDE_H
from voltpilot_optimization.mispel_pauschal import BERLIN, NULL, Rumpfjahr

#: Die ∑J-Summen, aus denen der Stand folgt (A2 S. 30-31): (P7) = ∑J (P6)¼,
#: (P9) = ∑J Z1NB¼, (P14) = ∑J (P13)¼.
SUMMEN = ("(P14)", "(P7)", "(P9)")

#: Die Formelsaetze mit EINER Foerderseite (P14)/(P15) und einem Netzbezug an
#: Z1: die Basisfaelle P1-P3 (A2 S. 25-33). P4 und P4-Variante teilen die
#: Foerderung auf zwei anzulegende Werte auf (A2 S. 36-41), P5 misst die
#: Einspeisung an ZW (A2 S. 45-46) - der Plan kennt je Anlage nur einen
#: anzulegenden Wert und den Netzanschluss: offen.
FORMELSAETZE = mispel_pauschal.BASISFAELLE


@dataclass(frozen=True)
class Bisher:
    """Der juengste Jahreslauf (MP-25) eines Kalender- oder Rumpfjahres.

    ``von``/``bis`` sind ganze Kalendertage, ``bis`` einschliesslich (A2 S.
    53, Regel ``rumpfjahre``); ``rumpfjahr`` sagt, ob der Lauf ein Rumpfjahr
    rechnet (dann traegt ``jahreswerte`` (P1)R und (P4)R). ``stammdaten``
    sind die des Laufs (Pinst, SKinst), ``viertelstunden`` die gerechneten
    (ohne Luecken)."""

    von: date
    bis: date
    rumpfjahr: bool
    formelsatz: str
    basisfall: str | None
    stammdaten: Mapping[str, Fraction]
    jahreswerte: Mapping[str, Fraction]
    viertelstunden: int


def _utc(tag: date) -> datetime:
    return datetime(tag.year, tag.month, tag.day, tzinfo=BERLIN).astimezone(timezone.utc)


def zeitraum(von: date, bis: date) -> tuple[datetime, datetime]:
    """Die ganzen Kalendertage ``von`` bis ``bis`` (einschliesslich) als
    ``[von, bis)`` in UTC, nach gesetzlicher Zeit (Regel ``zeit``)."""
    return _utc(von), _utc(bis + timedelta(days=1))


def grenzen(bisher: Bisher, von: date, bis: date) -> tuple[Fraction, Fraction]:
    """(P1)/(P4) des Zeitraums ``von``-``bis`` (Tage einschliesslich).

    Der Zeitraum des Jahreslaufs liest dessen Jahreswerte; jeder andere rechnet
    das Rechenwerk MP-25 mit den Stammdaten des Laufs - ein ganzes
    Kalenderjahr (P1)/(P4), ein Teil davon als Rumpfjahr (P1)R/(P4)R (A2 S.
    54-55: die Foerdergrenze nur ueber die Sommertage, der Indifferenzbereich
    ueber alle Tage)."""
    if (von, bis) == (bisher.von, bisher.bis):
        w = bisher.jahreswerte
        return (w["(P1)R"], w["(P4)R"]) if bisher.rumpfjahr else (w["(P1)"], w["(P4)"])
    ganz = von == date(von.year, 1, 1) and bis == date(von.year, 12, 31)
    rumpf = None if ganz else Rumpfjahr(von, bis, bisher.stammdaten)
    leer = {nr: NULL for nr in SUMMEN}
    w = mispel_pauschal.jahr(bisher.formelsatz, leer, bisher.stammdaten, rumpf,
                             basisfall=bisher.basisfall)
    return (w["(P1)"], w["(P4)"]) if rumpf is None else (w["(P1)R"], w["(P4)R"])


def _zeitraum_tage(tag: date, bisher: Bisher) -> tuple[date, date]:
    """Der Bezugszeitraum eines Tages: der des Jahreslaufs, sonst das
    Kalenderjahr - im Jahr des Laufs ohne dessen Tage (ein anderes
    Rumpfjahr)."""
    if bisher.von <= tag <= bisher.bis:
        return bisher.von, bisher.bis
    anfang, ende = date(tag.year, 1, 1), date(tag.year, 12, 31)
    if bisher.von.year == tag.year:
        if tag > bisher.bis:
            return bisher.bis + timedelta(days=1), ende
        return anfang, bisher.von - timedelta(days=1)
    return anfang, ende


def jahresstaende(
    bisher: Bisher,
    slot_starts: Sequence[datetime],
    slot_hours: float,
) -> tuple[MispelJahresstand, ...]:
    """Je Bezugszeitraum des Horizonts der Jahresstand: die Grenzen, bisher
    (nur der Zeitraum des Jahreslaufs) und der geschaetzte Jahresrest - das
    bisherige Tempo ``Summe / gerechnete Stunden`` mal die Stunden des
    Zeitraums, die weder gerechnet noch im Horizont sind. Folgejahre im
    Horizont bekommen dasselbe Tempo (der Betrieb laeuft weiter wie bisher)."""
    stunden_bisher = bisher.viertelstunden * VIERTELSTUNDE_H
    tempo = {
        nr: (float(bisher.jahreswerte[nr]) / stunden_bisher
             if bisher.viertelstunden >= MINDEST_VIERTELSTUNDEN else None)
        for nr in SUMMEN
    }
    slots_je_zeitraum: dict[tuple[date, date], int] = {}
    for s in slot_starts:
        z = _zeitraum_tage(s.astimezone(BERLIN).date(), bisher)
        slots_je_zeitraum[z] = slots_je_zeitraum.get(z, 0) + 1
    staende = []
    for (von, bis), anzahl in slots_je_zeitraum.items():
        eigener = (von, bis) == (bisher.von, bisher.bis)
        u_von, u_bis = zeitraum(von, bis)
        laenge_h = (u_bis - u_von).total_seconds() / 3600.0
        unbekannt_h = max(
            laenge_h - (stunden_bisher if eigener else 0.0) - anzahl * slot_hours, 0.0
        )
        mengen = {
            nr: (float(bisher.jahreswerte[nr]) if eigener else 0.0)
            + (tempo[nr] * unbekannt_h if tempo[nr] is not None else 0.0)
            for nr in SUMMEN
        }
        p1, p4 = grenzen(bisher, von, bis)
        staende.append(
            MispelJahresstand(
                von=u_von,
                bis=u_bis,
                p1_kwh=float(p1),
                p4_kwh=float(p4),
                p14_kwh=mengen["(P14)"],
                p7_kwh=mengen["(P7)"],
                p9_kwh=mengen["(P9)"],
            )
        )
    return tuple(staende)

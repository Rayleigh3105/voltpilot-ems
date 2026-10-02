"""MiSpeL MP-11: der Monatszustand der Abgrenzungsoption fuer den Optimierer.

Festlegung zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az.
618-25-02, Beschluss 01.10.2026), Anlage 1; Zitierweise „A1 S. 35“ = Anlage 1,
Seite 35, „T S. 38“ = Tenor mit Begruendung, Seite 38. Bauplan
``vp-mispel-fundament`` § 8 Zeile MP-11.

Die Saldierung rechnet je **Kalendermonat** (A1 S. 33-36), ein Rumpfmonat tritt
an seine Stelle (A1 S. 102). Ein Optimierer-Lauf sieht nur seinen Horizont;
ob eine weitere rote kWh noch saldiert wird, entscheidet aber (16) = MAX [ (13)
- (15) ; 0 ] am Ende der Periode. Darum bekommt jeder Lauf je Periode seines
Horizonts den Saldo ``(13) - (15)`` ausserhalb des Horizonts
(:class:`~voltpilot_optimization.domain.MispelMonatsstand`):

- **bisher** - aus den ∑M-Summen des juengsten Monatslaufs (MP-8,
  ``mispel_abgrenzung_monat``; geladen von
  :func:`voltpilot_optimization.inputs.load_mispel_bisher`), gerechnet mit
  :func:`saldo`.
- **Monatsrest** - die Zeit der Periode, die weder in den bisherigen Mengen
  noch im Horizont liegt (der Rest nach dem Horizont, Luecken und der Abstand
  zwischen Monatslauf und Lauf): geschaetzt mit dem bisherigen Tempo des
  Saldos je Stunde. Unter einem Tag gerechneter Viertelstunden ist das Tempo
  nicht bestimmt; der Rest ist dann 0 - die Periode entscheidet sich im
  Horizont.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
from typing import Mapping, Sequence

from voltpilot_optimization.domain import MispelMonatsstand
from voltpilot_optimization.mispel_abgrenzung import BERLIN

#: Die ∑M-Summen, aus denen der Saldo folgt (A1 S. 34-35): (5) = ∑M Z2V¼,
#: (6) = ∑M Z2E¼, (9) = ∑M (1)¼, (11) = ∑M (2)¼.
SUMMEN = ("(5)", "(6)", "(9)", "(11)")

#: Ab einem Tag gerechneter Viertelstunden schaetzt das bisherige Tempo den
#: Monatsrest.
MINDEST_VIERTELSTUNDEN = 96

VIERTELSTUNDE_H = 0.25


def saldo(monatswerte: Mapping[str, object], wirkungsgrad: float) -> float:
    """``(13) - (15)`` aus den ∑M-Summen einer (Teil-)Periode, in kWh, mit
    Vorzeichen (vor dem MAX von (16)).

    Woertlich nach A1 S. 34-36::

        (10) = (5) - (9)
        (12) = MAX [ (6) - (5) ; 0 ]
        (13) = MAX [ (11) - (12) ; 0 ]
        (15) = (14) * (10)

    Einzige Abweichung: (14) ist der Wirkungsgrad des Plans statt (14)A1 =
    (6) / (5) (A1 S. 35). In einem angebrochenen Monat steckt in (6) / (5)
    noch die Aenderung des Speicherinhalts; der Plan rechnet seine eigenen
    Verluste mit demselben Wirkungsgrad, und nur so bleibt „entladen und mit
    PV nachfuellen“ fuer (16) neutral (T S. 38-39). Massgeblich bleibt der
    Monatslauf (MP-8).

    Ein fehlender Wert ist kein Null: ``ValueError``.
    """
    w = {}
    for nr in SUMMEN:
        roh = monatswerte.get(nr)
        if roh is None or isinstance(roh, bool):
            raise ValueError(f"{nr}: kein Wert - unbekannt ist keine Null")
        w[nr] = Fraction(str(roh))
        if w[nr] < 0:
            raise ValueError(f"{nr} = {roh}: Mengen sind nie negativ (A1 S. 32)")
    z10 = w["(5)"] - w["(9)"]
    z12 = max(w["(6)"] - w["(5)"], Fraction(0))
    z13 = max(w["(11)"] - z12, Fraction(0))
    return float(z13) - wirkungsgrad * float(z10)


@dataclass(frozen=True)
class Bisher:
    """Die bisherigen Mengen einer Saldierungsperiode aus dem Monatslauf.

    ``von``/``bis`` ist der Zeitraum des Laufs (Kalender- oder Rumpfmonat),
    ``monatswerte`` die Monatswerte seines Nachweises (mindestens
    :data:`SUMMEN`), ``viertelstunden`` die Zahl der gerechneten
    Viertelstunden (ohne Luecken)."""

    von: datetime
    bis: datetime
    monatswerte: Mapping[str, object]
    viertelstunden: int


def _utc(at: datetime) -> datetime:
    return at.astimezone(timezone.utc)


def kalendermonat(at: datetime) -> tuple[datetime, datetime]:
    """Der Berliner Kalendermonat um ``at`` als ``[von, bis)`` in UTC
    (gesetzliche Zeit, A1 S. 33)."""
    lokal = at.astimezone(BERLIN)
    jahr, monat = (lokal.year + 1, 1) if lokal.month == 12 else (lokal.year, lokal.month + 1)
    return (
        _utc(datetime(lokal.year, lokal.month, 1, tzinfo=BERLIN)),
        _utc(datetime(jahr, monat, 1, tzinfo=BERLIN)),
    )


def _periode(at: datetime, bisher: Bisher) -> tuple[datetime, datetime]:
    """Die Saldierungsperiode eines Slots: die des Monatslaufs, sonst der
    Kalendermonat - im Monat des Laufs ohne dessen Zeitraum (ein anderer
    Rumpfmonat)."""
    von, bis = _utc(bisher.von), _utc(bisher.bis)
    if von <= at < bis:
        return von, bis
    m_von, m_bis = kalendermonat(at)
    if m_von <= von < m_bis or m_von < bis <= m_bis:
        return (bis, m_bis) if at >= bis else (m_von, von)
    return m_von, m_bis


def monatsstaende(
    bisher: Bisher,
    slot_starts: Sequence[datetime],
    slot_hours: float,
    wirkungsgrad: float,
) -> tuple[MispelMonatsstand, ...]:
    """Je Saldierungsperiode des Horizonts der Monatsstand: bisher (nur die
    Periode des Monatslaufs) und der geschaetzte Monatsrest - das bisherige
    Tempo ``saldo / gerechnete Stunden`` mal die Stunden der Periode, die
    weder gerechnet noch im Horizont sind. Folgemonate im Horizont bekommen
    dasselbe Tempo (der Betrieb laeuft weiter wie bisher)."""
    saldo_bisher = saldo(bisher.monatswerte, wirkungsgrad)
    stunden_bisher = bisher.viertelstunden * VIERTELSTUNDE_H
    tempo = (
        saldo_bisher / stunden_bisher
        if bisher.viertelstunden >= MINDEST_VIERTELSTUNDEN
        else None
    )
    eigene = (_utc(bisher.von), _utc(bisher.bis))
    slots_je_periode: dict[tuple[datetime, datetime], int] = {}
    for s in slot_starts:
        p = _periode(_utc(s), bisher)
        slots_je_periode[p] = slots_je_periode.get(p, 0) + 1
    staende = []
    for (von, bis), anzahl in slots_je_periode.items():
        ist_eigene = (von, bis) == eigene
        laenge_h = (bis - von).total_seconds() / 3600.0
        unbekannt_h = max(
            laenge_h - (stunden_bisher if ist_eigene else 0.0) - anzahl * slot_hours,
            0.0,
        )
        staende.append(
            MispelMonatsstand(
                von=von,
                bis=bis,
                bisher_kwh=saldo_bisher if ist_eigene else 0.0,
                rest_kwh=tempo * unbekannt_h if tempo is not None else 0.0,
            )
        )
    return tuple(staende)

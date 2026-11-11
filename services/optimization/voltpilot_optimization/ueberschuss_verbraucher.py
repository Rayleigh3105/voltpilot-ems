"""NS-3 B: der Speicher hat Vorrang vor dem Überschuss-Verbraucher - die
Plan-Hälfte (Captain-Entscheid 15.10.2026, Untersuchung
``vp-herzogau-nie-schlechter-k5`` Abschnitt 3, Kandidat g, Bauplan NS-P3b).

DER FALL. Herzogau (Anlage Pilsting) hat einen Großverbraucher in Stufen von
etwa 12 kW (rund 15, 25, 37 kW über einer Grundlast von 3-5 kW), der selbst
auf null Einspeisung regelt: er nimmt jeden Überschuss, den der Speicher nicht
schon hält. Plan und Box behandelten ihn als Hauslast. Der Plan rechnet im
ersten Slot mit der gemessenen Last der letzten 2 Minuten
(:func:`voltpilot_optimization.load_nowcast.ewma_residual`), trägt sie über
den Nowcast zwei Stunden weiter und plant deshalb, sobald der Verbraucher
läuft, nur noch „Sonne minus Verbraucher“ - mehr wäre Netzladen. Am 13.10.
endete der Tag so bei 12 % statt 50 %, die Nacht wurde zugekauft.

DIE REGEL. Läuft der Verbraucher JETZT (Messfenster des laufenden Slots),
rechnet der Plan im Sonnenfenster der nahen Stunden mit der Grundlast statt mit
der gemessenen Last samt Verbraucher: der gemessene Verbraucher wird aus dem
Messfenster und seinem Nachlauf im Nowcast genommen (dieselbe Abklingzeit, nie
unter die Grundlast). Außerhalb des Sonnenfensters und jenseits des Nowcasts
bleibt die Last, wie sie ist. Die Box hält die so geplante Ladung gegen den
Verbraucher (Slot-Feld ``charge_hold_base_load_kw``,
``edge-app/core/internal/guards/chargehold.go``); er bekommt, was danach übrig
bleibt.

DIE GRUNDLAST kommt aus den 15-min-Rollups der letzten :data:`TAGE` Tage
(:func:`grundlast_profil`). Kennzeichen des Verbrauchers ist, dass die Last
mindestens :data:`STUFE_KW` über der Nachtlast liegt UND die Sonne sie deckt -
er läuft auf dem Überschuss, nicht auf dem Netz. Solche Viertelstunden zählen
nicht zur Grundlast; ein Lastsprung OHNE Sonne (ein Heizstab nach Bedarf am
Morgen, eine Maschine) bleibt Grundlast, denn ihn verdrängt kein Speicher.
Die Grundlast je Tageszeit ist der Median der übrigen Viertelstunden derselben
Tageszeit (± :data:`NACHBAR_SLOTS`). Hat eine Tageszeit weniger als
:data:`MIN_TAGESZEIT_WERTE` solcher Werte - an jedem Tag der Lesung lief dort
der Verbraucher, oder es fehlen Messungen -, gibt es für sie keine Grundlast,
und die Regel bleibt dort stumm: ein Muster ist erst eines, wenn es auch die
Tage ohne es gibt.

KEINE FEHLERKENNUNG BEI NORMALER LAST. Die Regel greift nur, wenn die Anlage
das Muster in den Tagen der Lesung mindestens :data:`MIN_BELEGE` Viertelstunden
lang gezeigt hat UND die gemessene Last jetzt mindestens :data:`STUFE_KW` über
der Grundlast liegt UND die gemessene Sonne sie deckt. Eine Last, die nur
etwas höher ist als sonst, oder eine, die das Netz deckt, ändert nichts.
Irrt die Erkennung doch (eine Last, die nicht ausweicht), bleibt die Box der
Schutz: hält der Netzbezug länger als ihre Ausweichzeit an, hebt sie ihre
Grundlast um genau diesen Bezug.

SCHALTER je Anlage, Vorgabe AUS
(:func:`voltpilot_optimization.config.ueberschuss_verbraucher_enabled`). Ohne
ihn wird nichts gelesen, und der Plan ist byte-identisch zu vorher.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

from voltpilot_optimization.domain import ensure_utc
from voltpilot_optimization.load_nowcast import DEFAULT_DECAY_SLOTS
from voltpilot_optimization.night_reserve import BERLIN

#: Der Grund im Plan-Erklärtext (``slot_flags``) eines Slots, in dem der Plan
#: den gemessenen Überschuss-Verbraucher herausgerechnet hat: „Speicher vor
#: Überschuss-Verbraucher (NS-3 B): Plan rechnet mit der Grundlast“. Die
#: Grundlast selbst steht als ``load_kw`` des Slots im Plan.
SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER = "ueberschuss_verbraucher"

#: Wie weit (kW) die Last über der Nacht- bzw. Grundlast liegen muss, damit sie
#: als Verbraucher zählt: zwei Drittel einer Stufe von 12 kW. Eine kleinere
#: Abweichung ist Hauslast, die kein Speicher verdrängt.
STUFE_KW = 8.0

#: So weit (kW) darf die Last über der Sonne liegen und gilt noch als vom
#: Überschuss gedeckt (Messrauschen, ein Viertelstundenmittel über eine Wolke).
DECKUNG_TOL_KW = 1.0

#: Bis zu dieser Sonne (kW) ist eine Viertelstunde Nacht.
NACHT_PV_KW = 0.1

#: Wie viele Tage zurück die Grundlast gelesen wird.
TAGE = 7

#: Nachbarn je Seite, die zur selben Tageszeit zählen (± 15 min).
NACHBAR_SLOTS = 1

#: So viele Werte braucht die Tageszeit für einen eigenen Median.
MIN_TAGESZEIT_WERTE = 3

#: So viele Viertelstunden mit dem Verbraucher-Muster muss die Anlage in den
#: Tagen der Lesung gezeigt haben - eine Stunde. Darunter ist die Regel stumm.
MIN_BELEGE = 4

#: Über so viele Slots klingt der herausgerechnete Verbraucher ab - dieselbe
#: Zeit, über die der Nowcast die gemessene Last in die nahen Stunden trägt.
ABKLING_SLOTS = DEFAULT_DECAY_SLOTS

#: Viertelstunden je Tag (Berliner Tageszeit-Index 0..95).
_VIERTELSTUNDEN = 96


@dataclass(frozen=True)
class Viertelstunde:
    """Ein gemessenes Viertelstunden-Mittel (15-min-Rollup)."""

    start: datetime
    last_kw: float
    pv_kw: float


@dataclass(frozen=True)
class GrundlastProfil:
    """Die Grundlast ohne Überschuss-Verbraucher je Berliner Tageszeit."""

    #: 96 Werte, Index = Viertelstunde des Berliner Tages; ``None`` = für diese
    #: Tageszeit keine Grundlast (zu wenige Viertelstunden ohne Verbraucher).
    je_tageszeit: tuple[float | None, ...]
    nachtlast_kw: float
    #: Viertelstunden mit dem Verbraucher-Muster in den Tagen der Lesung.
    belege: int

    def fuer(self, start: datetime) -> float | None:
        return self.je_tageszeit[_tageszeit(start)]


@dataclass(frozen=True)
class Erkennung:
    """Der Überschuss-Verbraucher läuft im Messfenster dieses Laufs."""

    grundlast_kw: float  # Grundlast des laufenden Slots
    gemessen_kw: float  # Last im Messfenster (Mittel)
    sonne_kw: float  # Sonne im Messfenster (Mittel)
    verbraucher_kw: float  # gemessen_kw - grundlast_kw
    belege: int


def _tageszeit(start: datetime) -> int:
    b = ensure_utc(start).astimezone(BERLIN)
    return (b.hour * 60 + b.minute) // 15 % _VIERTELSTUNDEN


def _endlich(*werte: float) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in werte)


def ist_verbraucher_viertelstunde(
    last_kw: float, pv_kw: float, nachtlast_kw: float
) -> bool:
    """Das Kennzeichen: die Last liegt mindestens eine Stufe über der Nachtlast,
    und die Sonne deckt sie - der Verbraucher läuft auf dem Überschuss."""
    return last_kw >= nachtlast_kw + STUFE_KW and pv_kw >= last_kw - DECKUNG_TOL_KW


def grundlast_profil(viertelstunden: Iterable[Viertelstunde]) -> GrundlastProfil | None:
    """Die Grundlast je Tageszeit aus den gemessenen Viertelstunden der letzten
    Tage, oder ``None`` ohne eine einzige Nacht-Viertelstunde (dann gibt es
    keinen Maßstab für das Kennzeichen, und die Regel bleibt stumm).

    Nicht endliche oder negative Werte zählen nicht.
    """
    gueltig = [
        v
        for v in viertelstunden
        if _endlich(v.last_kw, v.pv_kw) and v.last_kw >= 0.0 and v.pv_kw >= 0.0
    ]
    nacht = [v.last_kw for v in gueltig if v.pv_kw <= NACHT_PV_KW]
    if not nacht:
        return None
    nachtlast = statistics.median(nacht)
    je_zeit: list[list[float]] = [[] for _ in range(_VIERTELSTUNDEN)]
    belege = 0
    for v in gueltig:
        if ist_verbraucher_viertelstunde(v.last_kw, v.pv_kw, nachtlast):
            belege += 1
            continue
        je_zeit[_tageszeit(v.start)].append(v.last_kw)
    profil: list[float | None] = []
    for k in range(_VIERTELSTUNDEN):
        werte = [
            w
            for i in range(-NACHBAR_SLOTS, NACHBAR_SLOTS + 1)
            for w in je_zeit[(k + i) % _VIERTELSTUNDEN]
        ]
        profil.append(
            statistics.median(werte) if len(werte) >= MIN_TAGESZEIT_WERTE else None
        )
    return GrundlastProfil(
        je_tageszeit=tuple(profil), nachtlast_kw=nachtlast, belege=belege
    )


def erkenne(
    profil: GrundlastProfil | None,
    start: datetime,
    gemessen_last_kw: Sequence[float],
    gemessen_pv_kw: Sequence[float],
) -> Erkennung | None:
    """Läuft der Überschuss-Verbraucher im Messfenster des laufenden Slots
    (``start``)? Beide Hälften sind die frischen Proben des Fensters, älteste
    zuerst; ohne Proben, ohne Profil oder ohne genug Belege: ``None``."""
    if profil is None or profil.belege < MIN_BELEGE:
        return None
    last = [v for v in gemessen_last_kw if _endlich(v) and v >= 0.0]
    pv = [v for v in gemessen_pv_kw if _endlich(v) and v >= 0.0]
    if not last or not pv:
        return None
    last_kw = sum(last) / len(last)
    pv_kw = sum(pv) / len(pv)
    grundlast = profil.fuer(start)
    if grundlast is None:
        return None
    if last_kw < grundlast + STUFE_KW or pv_kw < last_kw - DECKUNG_TOL_KW:
        return None
    return Erkennung(
        grundlast_kw=grundlast,
        gemessen_kw=last_kw,
        sonne_kw=pv_kw,
        verbraucher_kw=last_kw - grundlast,
        belege=profil.belege,
    )


def ohne_verbraucher(
    load_kw: Sequence[float],
    pv_kw: Sequence[float],
    slot_starts: Sequence[datetime],
    profil: GrundlastProfil,
    erkennung: Erkennung,
) -> tuple[list[float], tuple[bool, ...]]:
    """Die Lastreihe ohne den gemessenen Verbraucher, und je Slot, ob er
    herausgerechnet wurde.

    ``load_kw`` ist die Reihe NACH dem Nowcast und VOR dem Sicherheitsaufschlag
    (:func:`voltpilot_optimization.load_nowcast.apply_uncertainty_reserve` läuft
    danach auf der neuen Reihe - der Aufschlag gilt der Grundlast). Im Slot
    ``t`` wird der gemessene Verbraucher mit dem Gewicht des Nowcasts
    ``1 - t / ABKLING_SLOTS`` abgezogen, aber nie unter die Grundlast dieser
    Tageszeit (und nie über den Wert von vorher): im laufenden Slot liegt die
    Last danach auf der Grundlast, in den nahen Stunden fällt der Nachlauf des
    Messfensters weg, und eine Prognose, die den Verbraucher nicht kannte,
    bleibt, wie sie war. Nur im Sonnenfenster - wo die PV-Prognose über der
    Grundlast liegt, der Verbraucher also auf Überschuss laufen kann; danach
    bleibt die Reihe unverändert.
    """
    neu = list(load_kw)
    markiert = [False] * len(neu)
    for t in range(min(len(neu), ABKLING_SLOTS)):
        gewicht = 1.0 - t / ABKLING_SLOTS
        basis = profil.fuer(slot_starts[t])
        if basis is None or not _endlich(neu[t], pv_kw[t]) or pv_kw[t] <= basis:
            continue
        kandidat = max(neu[t] - erkennung.verbraucher_kw * gewicht, min(neu[t], basis))
        if kandidat < neu[t] - 1e-9:
            neu[t] = kandidat
            markiert[t] = True
    return neu, tuple(markiert)

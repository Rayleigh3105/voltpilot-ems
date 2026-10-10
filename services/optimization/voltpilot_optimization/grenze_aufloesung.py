"""Grenzen am Netzanschluss - der Python-Zwilling (UEMS AP-15 IP-3, Kasten W1).

Die EINE Lese-Regel: je Richtung gilt der ENGERE Wert aus Anlage und
Grenzblatt des Netzanschlusses; ohne gebundenen Netzanschluss oder ohne
gueltige Fassung der alte Wert der Anlage - dasselbe Objekt, damit eine Anlage
ohne Eintrag Byte fuer Byte bleibt.

Der Java-Zwilling ist ``services/api/.../uems/GrenzeAufloesung.java``; beide
fahren ``docs/contracts/v2/netzanschluss-grenze-vectors.json``. Wer die Regel
aendert, aendert die Vektor-Datei UND beide Zwillinge. Rein: ohne DB, ohne Uhr.
Tarif und Verguetung ziehen NICHT um (W1).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

QUELLE_ANLAGE = "anlage"
QUELLE_NETZANSCHLUSS = "netzanschluss"

FEHLER_UEBER_VEREINBART = "grenze_ueber_vereinbart"
FEHLER_UEBER_ANSCHLUSS = "grenze_ueber_anschluss"


@dataclass(frozen=True)
class Fassung:
    """Eine Fassung des Grenzblatts: gilt ab ihrem Tag bis zum Vortag der naechsten."""

    gueltig_ab: date
    einspeisegrenze_kw: float | None
    bezugsgrenze_kw: float | None
    einspeisegrenze_keine: bool = False


@dataclass(frozen=True)
class Wirksam:
    einspeisung_kw: float | None
    quelle_einspeisung: str | None
    bezug_kw: float | None
    quelle_bezug: str | None
    einspeisung_keine: bool = False


def fassung_am(fassungen, tag: date) -> Fassung | None:
    """Die Fassung mit dem spaetesten ersten Tag <= ``tag``; sonst ``None``."""
    gueltig = [f for f in (fassungen or ()) if f.gueltig_ab <= tag]
    return max(gueltig, key=lambda f: f.gueltig_ab) if gueltig else None


def engerer(anlage, netzanschluss):
    """Der engere Wert; gleich = der Wert der Anlage (dasselbe Objekt); einer fehlt = der andere."""
    if netzanschluss is None:
        return anlage
    if anlage is None:
        return netzanschluss
    return netzanschluss if netzanschluss < anlage else anlage


def _quelle(anlage, netzanschluss) -> str | None:
    wert = engerer(anlage, netzanschluss)
    if wert is None:
        return None
    return QUELLE_ANLAGE if wert is anlage else QUELLE_NETZANSCHLUSS


def aufloesen(
    einspeisung_kw, bezug_kw, gebunden: bool, fassungen, tag: date
) -> Wirksam:
    """Die wirksamen Grenzen am ``tag`` (Werte der Anlage, Bindung am Tag, Fassungen DIESES Anschlusses)."""
    f = fassung_am(fassungen, tag) if gebunden else None
    na_einspeisung = f.einspeisegrenze_kw if f is not None else None
    na_bezug = f.bezugsgrenze_kw if f is not None else None
    keine = einspeisung_kw is None and f is not None and f.einspeisegrenze_keine
    return Wirksam(
        einspeisung_kw=engerer(einspeisung_kw, na_einspeisung),
        quelle_einspeisung=QUELLE_NETZANSCHLUSS if keine else _quelle(einspeisung_kw, na_einspeisung),
        bezug_kw=engerer(bezug_kw, na_bezug),
        quelle_bezug=_quelle(bezug_kw, na_bezug),
        einspeisung_keine=keine,
    )


def plausibel(
    einspeisegrenze_kw, bezugsgrenze_kw, vereinbart_kw, anschluss_kva
) -> str | None:
    """Bezugsgrenze <= vereinbarte Leistung, jede Grenze <= Anschlussleistung; zuerst die vereinbarte."""
    if (
        bezugsgrenze_kw is not None
        and vereinbart_kw is not None
        and bezugsgrenze_kw > vereinbart_kw
    ):
        return FEHLER_UEBER_VEREINBART
    if anschluss_kva is not None and (
        (bezugsgrenze_kw is not None and bezugsgrenze_kw > anschluss_kva)
        or (einspeisegrenze_kw is not None and einspeisegrenze_kw > anschluss_kva)
    ):
        return FEHLER_UEBER_ANSCHLUSS
    return None

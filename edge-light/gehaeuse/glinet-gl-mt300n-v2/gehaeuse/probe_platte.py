"""Probe-Platte 60 x 60 x 2 mm: VoltPilot-Logo bündig in drei Farben.

Der erste Testdruck für Farben und Schwund (docs/regeln.md).

Drucklage: Sichtseite nach unten auf der Druckplatte. Die Farben liegen nur
in den ersten drei Schichten, also fallen Farbwechsel nur dort an.

Inhalt (auf die Sichtseite gesehen, von oben nach unten):
  1. Wortmarke ohne Unterzeile, 50 mm breit.
  2. Strichprobe: je sechs Stege in Schwarz und Hellblau und fünf weiße
     Spalte in Schwarz, Breiten siehe STEGE / SPALTE (links schmal).
  3. Unterzeile "ENERGY MANAGEMENT" allein auf 50 mm Breite gezogen
     (Strich rund 0,48 mm): Grenzfall, zeigt, was der Drucker noch schafft.

Nachmessen: Die Kante ist genau 60,00 mm lang; die Abweichung ist der Schwund.
"""
import numpy as np
from build123d import Align, Pos, Rectangle

from . import logo
from .ausgabe import bild, netz, schreibe_druckdateien
from .formen import rundquader
from .mehrfarb_3mf import lies_3mf
from .parameter import FARBEN, STANDARD

KANTE = 60.0
DICKE = 2.0
ECKRADIUS = 4.0
EINLAGE = 0.6         # 3 Schichten zu 0,2 mm
LOGOBREITE = 50.0
STEGE = [0.3, 0.45, 0.6, 0.8, 1.0, 1.2]     # Breiten der Farbstege
SPALTE = [0.3, 0.45, 0.6, 0.8, 1.0]         # weiße Spalte in Schwarz
STEGHOEHE = 9.0
STEG_Y = -3.5
STEG_X = {"schwarz": -25.0, "kamm": -8.5, "blau": 11.0}   # linker Rand je Gruppe
STEG_ABSTAND = 1.6


def strichprobe():
    """Stege und Spalte als Flächen; x-Lage aufsteigend von links."""
    unten = Align.MIN, Align.CENTER

    def reihe(breiten, x0):
        flaechen, x = [], x0
        for b in breiten:
            flaechen.append(Pos(x, STEG_Y) * Rectangle(b, STEGHOEHE, align=unten).face())
            x += b + STEG_ABSTAND
        return flaechen

    # Kamm: schwarze Balken von 1,5 mm, dazwischen die weißen Spalte
    kamm, x = [], STEG_X["kamm"]
    for spalt in [*SPALTE, 0]:
        kamm.append(Pos(x, STEG_Y) * Rectangle(1.5, STEGHOEHE, align=unten).face())
        x += 1.5 + spalt
    return {"schrift_schwarz": reihe(STEGE, STEG_X["schwarz"]) + kamm,
            "zeichen_hellblau": reihe(STEGE, STEG_X["blau"])}


def baue():
    """Die drei Körper mit der Sichtseite oben (z = DICKE)."""
    flaechen = logo.wortmarke(LOGOBREITE, (0.0, 15.5))
    flaechen["schrift_schwarz"] += logo.unterzeile(LOGOBREITE, (0.0, -19.0))
    for name, f in strichprobe().items():
        flaechen[name] += f
    einlagen = {name: logo.einlage(f, DICKE - EINLAGE, EINLAGE) for name, f in flaechen.items()}
    platte = rundquader(-KANTE / 2, KANTE / 2, -KANTE / 2, KANTE / 2, 0, DICKE, ECKRADIUS)
    koerper = {"gehaeuse_weiss": platte.cut(*[s for e in einlagen.values() for s in e.solids()])}
    koerper.update(einlagen)
    # Die Einlagen müssen ihre Taschen genau füllen, sonst fehlt ein Schnitt.
    voll = KANTE * KANTE * DICKE - (4 - np.pi) * ECKRADIUS ** 2 * DICKE
    summe = sum(k.volume for k in koerper.values())
    assert abs(summe - voll) < 0.01, "Einlagen und Taschen passen nicht zusammen"
    return koerper


def baue_dateien(ordner, p=STANDARD):
    netze = {name: netz(k, 0.01, 0.2) for name, k in baue().items()}
    lage = schreibe_druckdateien(ordner, "probe-platte", netze, wenden=True, schwund=p.stoff.schwund)
    szene = [(e, d, FARBEN[n]) for n, (e, d) in netze.items()]
    bild(ordner / "probe-platte-sichtseite.png", szene, azimut=-90, hoehe=90, breite=1200)
    bild(ordner / "probe-platte-schraeg.png", szene, azimut=-62, hoehe=38)
    einlagen = [(e, d, FARBEN[n]) for n, (e, d) in lage.items() if n != "gehaeuse_weiss"]
    bild(ordner / "probe-platte-drucklage-einlagen.png", einlagen, azimut=-62, hoehe=32)
    return lies_3mf(ordner / "probe-platte.3mf")

"""Das VoltPilot-Logo als Flächen für die Farbeinlagen.

Quelle ist allein ``logo/logo-vektor.svg`` (nachgezeichnet aus dem Raster-PNG,
siehe werkzeug/logo_vektor.py). Die Unterzeile "ENERGY MANAGEMENT" ist für
den Deckel nicht druckbar und entfällt dort.
"""
from pathlib import Path

from build123d import Compound, Pos, Rot, Solid, Vector, import_svg

SVG = Path(__file__).resolve().parent.parent / "logo" / "logo-vektor.svg"
# Verhältnis Höhe zu Breite der Wortmarke ohne Unterzeile
WORTMARKE_HOEHE_JE_BREITE = 8.6 / 50.0


def _gruppen():
    teile = {}
    for f in import_svg(SVG, align=None):
        teile.setdefault(f.label, []).append(f)
    return teile


def _setze(flaechen, rahmen, breite, mitte, drehung):
    s = breite / rahmen.size.X
    c = rahmen.center()
    # erst skalieren, dann schieben: scale() lässt eine Verschiebung unskaliert
    return [Pos(*mitte) * Rot(0, 0, drehung) * Pos(-c.X * s, -c.Y * s) * f.scale(s)
            for f in flaechen]


def wortmarke(breite, mitte=(0.0, 0.0), drehung=0.0):
    """Wortmarke ohne Unterzeile in der xy-Ebene, so wie man sie liest.

    Rückgabe: {"schrift_schwarz": [Flächen], "zeichen_hellblau": [Flächen]}.
    """
    t = _gruppen()
    rahmen = Compound(t["schrift"] + t["flieger"] + t["blitz"]).bounding_box()
    return {"schrift_schwarz": _setze(t["schrift"], rahmen, breite, mitte, drehung),
            "zeichen_hellblau": _setze(t["flieger"] + t["blitz"], rahmen, breite, mitte, drehung)}


def unterzeile(breite, mitte=(0.0, 0.0), drehung=0.0):
    """Die Unterzeile allein, auf ``breite`` gezogen (nur für die Probe-Platte)."""
    t = _gruppen()
    return _setze(t["unterzeile"], Compound(t["unterzeile"]).bounding_box(), breite, mitte, drehung)


def einlage(flaechen, z, tiefe):
    """Flächen der xy-Ebene als Körper von z bis z + tiefe."""
    koerper = []
    for f in flaechen:
        # Spiegeln oder Drehen kann die Flächennormale umkehren; ohne Korrektur
        # entstünde ein umgestülpter Körper, den ein Schnitt stillschweigend auslässt.
        f = f if f.normal_at().Z > 0 else -f
        koerper.append(Solid.extrude(Pos(0, 0, z) * f, Vector(0, 0, tiefe)))
    return Compound(children=koerper)

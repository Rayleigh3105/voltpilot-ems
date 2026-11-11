"""Kleine Bausteine über build123d: Körper direkt aus Koordinaten.

Alle Maße in mm, alle Körper in Platinenkoordinaten (siehe massmodell.py).
"""
from build123d import (Align, Box, Compound, Cone, Cylinder, Face, Pos, Rectangle,
                       RectangleRounded, Rot, SlotOverall, Solid, Vector, Wire, extrude)

_MITTE_UNTEN = (Align.CENTER, Align.CENTER, Align.MIN)


def quader(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * Box(x1 - x0, y1 - y0, z1 - z0, align=_MITTE_UNTEN)


def aus_huelle(q, zugabe=0.0, z_zugabe=None):
    """Quader aus einem massmodell.Quader, ringsum um ``zugabe`` vergrößert."""
    zz = zugabe if z_zugabe is None else z_zugabe
    return quader(q.x0 - zugabe, q.x1 + zugabe, q.y0 - zugabe, q.y1 + zugabe, q.z0 - zz, q.z1 + zz)


def rechteck(x0, x1, y0, y1, r=0.0):
    """Fläche in der xy-Ebene, Ecken mit Radius r."""
    f = RectangleRounded(x1 - x0, y1 - y0, r) if r > 0 else Rectangle(x1 - x0, y1 - y0)
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * f


def rundquader(x0, x1, y0, y1, z0, z1, r):
    """Quader mit gerundeten senkrechten Kanten."""
    return extrude(Pos(0, 0, z0) * rechteck(x0, x1, y0, y1, r), z1 - z0)


def zylinder(x, y, z0, z1, r):
    return Pos(x, y, z0) * Cylinder(r, z1 - z0, align=_MITTE_UNTEN)


def zylinder_x(x0, x1, y, z, r):
    """Liegender Zylinder entlang x."""
    return Pos(x0, y, z) * Rot(0, 90, 0) * Cylinder(r, x1 - x0, align=_MITTE_UNTEN)


def kegel(x, y, z0, z1, r0, r1):
    return Pos(x, y, z0) * Cone(r0, r1, z1 - z0, align=_MITTE_UNTEN)


def langloch(x, y, z0, z1, laenge, breite, entlang="y", senkung=0.0):
    """Langloch (Gesamtlänge x Breite); mit ``senkung`` als Tiefe zusätzlich
    ein 90°-Senkkegel, der sich nach oben (z1) öffnet."""
    if laenge <= breite + 1e-6:  # rundes Loch
        loch = zylinder(x, y, z0, z1, breite / 2)
        if senkung > 0:
            loch += kegel(x, y, z1 - senkung, z1 + 0.01, breite / 2, breite / 2 + senkung + 0.01)
        return loch
    profil = Rot(0, 0, 90 if entlang == "y" else 0) * SlotOverall(laenge, breite)
    loch = extrude(Pos(x, y, z0) * profil, z1 - z0)
    if senkung > 0:
        loch += extrude(Pos(x, y, z1 - senkung) * profil, senkung + 0.01, taper=-45)
    return loch


def prisma(punkte, achse, a0, a1):
    """Vieleck als Querschnitt, entlang einer Achse gezogen.

    achse "x": punkte sind (y, z); "y": (x, z); "z": (x, y).
    """
    wohin = {"x": lambda u, v: Vector(a0, u, v), "y": lambda u, v: Vector(u, a0, v),
             "z": lambda u, v: Vector(u, v, a0)}[achse]
    weg = {"x": Vector(a1 - a0, 0, 0), "y": Vector(0, a1 - a0, 0), "z": Vector(0, 0, a1 - a0)}[achse]
    k = Solid.extrude(Face(Wire.make_polygon([wohin(u, v) for u, v in punkte], close=True)), weg)
    if k.volume < 0:  # Umlaufsinn des Vielecks zeigte gegen die Zugrichtung
        k = Solid.extrude(Face(Wire.make_polygon([wohin(u, v) for u, v in reversed(punkte)],
                                                 close=True)), weg)
    return k


def verbund(teile):
    return Compound(children=list(teile))

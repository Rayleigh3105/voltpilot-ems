"""Strichschrift für die Beschriftung: Großbuchstaben und Ziffern aus Linien
fester Breite.

Eine Schrift aus dem Rechner taugt für den Druck im Kleinen nicht: Ihre
Striche sind verschieden dick, und Bambu Studio (Wände "klassisch") lässt
weg, was schmaler ist als eine Bahn, und füllt, was dazwischen liegt, mit
Resten. Hier ist jeder Buchstabe eine Folge von Mittellinien; der Strich ist
überall gleich breit (``strich``, im Deckel zwei Bahnen), die Enden sind rund.
Die Schrift ist für dieses Projekt gezeichnet, keine fremde Datei.

Maße: ``hoehe`` ist die Höhe der Großbuchstaben über alles; die Mittellinien
laufen in einem Feld der Höhe ``hoehe - strich``. Zeichen stehen in ZEICHEN
als (Breite, Linien) in Einheiten dieser Höhe.

Zwei Formen (``FORMEN``): "v03" sind die Zeichen, mit denen Deckel und
Schriftprobe v0.3 gebaut wurden; sie bleiben, wie sie sind. "offen" (seit
v0.4) zeichnet neu, was unter 4,5 mm Höhe zuläuft: A als Bogen mit
Querstrich, S, 3 und 5 mit kurzen Enden und drei Querstrichen in
gleichem Abstand, 8 aus zwei gleich hohen Ringen, W mit kurzer Mitte, N
breiter. Die kleinste Höhe ist damit drei Striche und zweimal der Abstand
(``kleinste_hoehe``).
"""
import math

from build123d import Face, Vector, Wire
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

RUND = 8   # Ecken je Viertelkreis an runden Enden


def _bogen(cx, cy, rx, ry, a0, a1, n=None):
    """Punkte auf einem Ellipsenbogen von Winkel a0 bis a1 (Grad)."""
    n = n or max(4, int(abs(a1 - a0) / 12))
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


_P = [(0, 0), (0, 1), (0.31, 1), *_bogen(0.31, 0.74, 0.27, 0.26, 90, -90), (0, 0.48)]
_O = _bogen(0.35, 0.5, 0.35, 0.5, 0, 360, 36)
_C = _bogen(0.34, 0.5, 0.34, 0.5, 55, 305)

ZEICHEN = {
    "A": (0.80, [[(0, 0), (0.40, 1), (0.80, 0)], [(0.11, 0.26), (0.69, 0.26)]]),
    "B": (0.60, [[(0, 0), (0, 1), (0.32, 1), *_bogen(0.32, 0.75, 0.25, 0.25, 90, -90), (0, 0.5)],
                 [(0, 0.5), (0.33, 0.5), *_bogen(0.33, 0.25, 0.27, 0.25, 90, -90), (0, 0)]]),
    "C": (0.62, [_C]),
    "D": (0.64, [[(0, 0), (0, 1), (0.22, 1), *_bogen(0.22, 0.5, 0.42, 0.5, 90, -90), (0, 0)]]),
    "E": (0.54, [[(0.54, 1), (0, 1), (0, 0), (0.54, 0)], [(0, 0.5), (0.44, 0.5)]]),
    "F": (0.52, [[(0.52, 1), (0, 1), (0, 0)], [(0, 0.5), (0.42, 0.5)]]),
    "G": (0.67, [[*_bogen(0.34, 0.5, 0.33, 0.5, 60, 355), (0.38, 0.46)]]),
    "H": (0.62, [[(0, 0), (0, 1)], [(0.62, 0), (0.62, 1)], [(0, 0.5), (0.62, 0.5)]]),
    "I": (0.0, [[(0, 0), (0, 1)]]),
    "J": (0.45, [[(0.45, 1), (0.45, 0.25), *_bogen(0.225, 0.25, 0.225, 0.25, 0, -180)]]),
    "K": (0.62, [[(0, 0), (0, 1)], [(0.60, 1), (0, 0.40)], [(0.22, 0.61), (0.62, 0)]]),
    "L": (0.50, [[(0, 1), (0, 0), (0.50, 0)]]),
    "M": (0.84, [[(0, 0), (0, 1), (0.42, 0.25), (0.84, 1), (0.84, 0)]]),
    "N": (0.64, [[(0, 0), (0, 1), (0.64, 0), (0.64, 1)]]),
    "O": (0.70, [_O]),
    "P": (0.58, [_P]),
    "Q": (0.70, [_O, [(0.44, 0.22), (0.72, -0.04)]]),
    "R": (0.60, [_P, [(0.30, 0.48), (0.60, 0)]]),
    "S": (0.58, [[*_bogen(0.29, 0.75, 0.29, 0.25, 30, 270), *_bogen(0.29, 0.25, 0.29, 0.25, 90, -150)[1:]]]),
    "T": (0.60, [[(0, 1), (0.60, 1)], [(0.30, 1), (0.30, 0)]]),
    "U": (0.62, [[(0, 1), (0, 0.3), *_bogen(0.31, 0.3, 0.31, 0.3, 180, 360), (0.62, 1)]]),
    "V": (0.68, [[(0, 1), (0.34, 0), (0.68, 1)]]),
    "W": (0.90, [[(0, 1), (0.225, 0), (0.45, 1), (0.675, 0), (0.90, 1)]]),
    "X": (0.64, [[(0, 0), (0.64, 1)], [(0, 1), (0.64, 0)]]),
    "Y": (0.66, [[(0, 1), (0.33, 0.48), (0.66, 1)], [(0.33, 0.48), (0.33, 0)]]),
    "Z": (0.60, [[(0, 1), (0.60, 1), (0, 0), (0.60, 0)]]),
    "0": (0.56, [_bogen(0.28, 0.5, 0.28, 0.5, 0, 360, 36)]),
    "1": (0.30, [[(0, 0.76), (0.30, 1), (0.30, 0)]]),
    "2": (0.56, [[*_bogen(0.28, 0.72, 0.28, 0.28, 165, -40), (0, 0), (0.56, 0)]]),
    "3": (0.56, [[*_bogen(0.27, 0.75, 0.27, 0.25, 150, -90), *_bogen(0.27, 0.25, 0.29, 0.25, 90, -150)[1:]]]),
    "4": (0.60, [[(0.46, 0), (0.46, 1), (0, 0.30), (0.60, 0.30)]]),
    "5": (0.56, [[(0.52, 1), (0.07, 1), (0.04, 0.52), *_bogen(0.26, 0.30, 0.30, 0.30, 135, -150)]]),
    "6": (0.56, [[*_bogen(0.30, 0.5, 0.30, 0.5, 60, 180), (0, 0.29)],
                 _bogen(0.28, 0.29, 0.28, 0.29, 0, 360, 30)]),
    "7": (0.56, [[(0, 1), (0.56, 1), (0.20, 0)]]),
    "8": (0.56, [_bogen(0.28, 0.76, 0.24, 0.24, 0, 360, 30), _bogen(0.28, 0.26, 0.28, 0.26, 0, 360, 30)]),
    "9": (0.56, [_bogen(0.28, 0.71, 0.28, 0.29, 0, 360, 30),
                 [(0.56, 0.71), *_bogen(0.26, 0.5, 0.30, 0.5, 0, -120)]]),
    "-": (0.36, [[(0, 0.5), (0.36, 0.5)]]),
    "+": (0.50, [[(0, 0.5), (0.50, 0.5)], [(0.25, 0.25), (0.25, 0.75)]]),
    "/": (0.42, [[(0, 0), (0.42, 1)]]),
    ".": (0.0, [[(0, 0)]]),
    " ": (0.30, []),
}


# Die offenen Formen (v0.4). Was hier nicht steht, ist wie in ZEICHEN.
OFFEN = {
    # ein Bogen mit Querstrich statt zweier Schrägen, die sich im Scheitel treffen: Das Feld
    # über dem Querstrich ist so weit wie das im B, und nirgends laufen zwei Striche spitz ineinander
    "A": (0.66, [[(0, 0), (0, 0.70), *_bogen(0.33, 0.70, 0.33, 0.30, 180, 0)[1:], (0.66, 0)],
                 [(0, 0.36), (0.66, 0.36)]]),
    # der obere Bauch eine Spur weiter als in v0.3: sein Innenfeld ist bei 3,8 mm das engste der vier Wörter
    "B": (0.60, [[(0, 0), (0, 1), (0.33, 1), *_bogen(0.33, 0.75, 0.25, 0.25, 90, -90), (0, 0.5)],
                 [(0, 0.5), (0.33, 0.5), *_bogen(0.33, 0.25, 0.27, 0.25, 90, -90), (0, 0)]]),
    # breiter: Die Felder neben der Schräge laufen sonst fast ganz zu
    "N": (0.70, [[(0, 0), (0, 1), (0.70, 0), (0.70, 1)]]),
    # kurze Enden: Die Öffnungen bleiben weit
    "S": (0.58, [[*_bogen(0.29, 0.75, 0.29, 0.25, 55, 270), *_bogen(0.29, 0.25, 0.29, 0.25, 90, -125)[1:]]]),
    # die Mitte reicht nicht bis oben: oben bleibt eine Öffnung statt zweier Zwickel
    "W": (1.10, [[(0, 1), (0.275, 0), (0.55, 0.66), (0.825, 0), (1.10, 1)]]),
    # drei Querstriche in gleichem Abstand
    "3": (0.56, [[*_bogen(0.27, 0.75, 0.27, 0.25, 130, -90), *_bogen(0.27, 0.25, 0.29, 0.25, 90, -130)[1:]]]),
    "5": (0.56, [[(0.52, 1), (0, 1), (0, 0.5), (0.27, 0.5), *_bogen(0.27, 0.25, 0.29, 0.25, 90, -105)[1:]]]),
    "8": (0.56, [_bogen(0.28, 0.75, 0.25, 0.25, 0, 360, 30), _bogen(0.28, 0.25, 0.28, 0.25, 0, 360, 30)]),
    # offen: Das geschlossene Dreieck der 4 läuft schon bei 4,5 mm zu
    "4": (0.50, [[(0.50, 0), (0.50, 1)], [(0, 1), (0, 0.34), (0.50, 0.34)]]),
    # nur für die Größenangabe auf der Schriftprobe; reicht unter die Grundlinie
    ",": (0.12, [[(0.12, 0.08), (0, -0.22)]]),
}
FORMEN = {"v03": ZEICHEN, "offen": {**ZEICHEN, **OFFEN}}


def kleinste_hoehe(strich, abstand):
    """Kleinste Höhe der Großbuchstaben: B, S, 3, 5 und 8 haben drei Querstriche
    übereinander und brauchen dazwischen zweimal ``abstand`` Weiß."""
    return 3 * strich + 2 * abstand


def pruefe_text(text, form="offen"):
    """Setzt Kleinbuchstaben groß und bricht bei einem Zeichen ab, das die
    Strichschrift nicht kennt."""
    text = text.upper()
    fremd = sorted({z for z in text if z not in FORMEN[form]})
    if fremd:
        raise ValueError(f"Die Beschriftung {text!r} enthält {', '.join(repr(z) for z in fremd)}: Die "
                         "Strichschrift kennt nur A bis Z, 0 bis 9, Leerzeichen und - + / . "
                         "(gehaeuse/schrift.py, ZEICHEN)")
    return text


def linien(text, hoehe, strich, luft, form="offen"):
    """Mittellinien eines Textes, linke untere Ecke der Schrift im Ursprung.

    Rückgabe: (Liste shapely-Linien und -Punkte, Breite über alles).
    """
    zeichen, breite = _gesetzt(text, hoehe, strich, luft, form)
    return [t for _, teile in zeichen for t in teile], breite


def _gesetzt(text, hoehe, strich, luft, form):
    """Setzt den Text: ([(Zeichen, Mittellinien)], Breite über alles)."""
    feld = hoehe - strich
    aus, x = [], strich / 2
    zeichen = pruefe_text(text, form)
    for i, z in enumerate(zeichen):
        breite, striche = FORMEN[form][z]
        teile = []
        for s_ in striche:
            punkte = [(x + u * feld, strich / 2 + v * feld) for u, v in s_]
            teile.append(Point(punkte[0]) if len(punkte) == 1 else LineString(punkte))
        aus.append((z, teile))
        x += breite * feld + (strich + luft if i < len(zeichen) - 1 else 0)
    return aus, x + strich / 2


def laenge(text, hoehe, strich, luft, form="offen"):
    """Länge aller Mittellinien: So lang ist eine Bahn, die den Text einmal abfährt."""
    return sum(t.length for t in linien(text, hoehe, strich, luft, form)[0])


def _flaeche(teile, strich, abstand):
    """Mittellinien -> (Fläche, Anteil, der zugelaufen ist)."""
    roh = unary_union([t.buffer(strich / 2, quad_segs=RUND) for t in teile])
    form = roh
    if abstand > 0:
        form = roh.buffer(abstand / 2, quad_segs=RUND).buffer(-abstand / 2, quad_segs=RUND)
        form = form.union(roh)
    form = form.simplify(0.004)
    return form, (form.area - roh.area) / roh.area


def flaeche(text, hoehe, strich, luft, abstand=0.0, form="offen"):
    """Der Text als Fläche (shapely), linke untere Ecke im Ursprung.

    ``abstand``: Lücken zwischen Strichen, die schmaler sind, laufen zu (die
    Fläche wird dort geschlossen). So endet ein Zwickel zwischen zwei Strichen
    nicht in einer weißen Spitze, die schmaler ist als eine Bahn.

    Rückgabe: (Fläche, Breite, Anteil der Fläche, der zugelaufen ist).
    """
    teile, breite = linien(text, hoehe, strich, luft, form)
    if not teile:
        return Polygon(), 0.0, 0.0
    flaeche_, zugelaufen = _flaeche(teile, strich, abstand)
    return flaeche_, breite, zugelaufen


def zeichenweise(text, hoehe, strich, luft, abstand=0.0, form="offen"):
    """Jedes Zeichen des Textes für sich, an seinem Platz im Wort: Liste dict
    mit ``zeichen``, ``form`` (Fläche), ``linien`` (Mittellinien als eine
    Geometrie), ``laenge`` (ihrer Länge), ``zugelaufen`` (Anteil) und
    ``geschlossen`` (eine Öffnung des Zeichens ist verschwunden oder eine neue
    entstanden). Leerzeichen entfallen."""
    aus = []
    for z, teile in _gesetzt(text, hoehe, strich, luft, form)[0]:
        if not teile:
            continue
        roh = _flaeche(teile, strich, 0.0)[0]
        f, zu = _flaeche(teile, strich, abstand)
        aus.append({"zeichen": z, "form": f, "linien": unary_union(teile), "laenge": sum(t.length for t in teile),
                    "zugelaufen": zu, "geschlossen": _loecher(roh) != _loecher(f)})
    return aus


def _loecher(form):
    return sum(len(v.interiors) for v in vielecke(form))


def gesetzt(form, breite, hoehe, mitte, drehung=0.0):
    """Schiebt eine Textfläche mit ihrer Mitte nach ``mitte`` und dreht sie dort."""
    form = affinity.translate(form, mitte[0] - breite / 2, mitte[1] - hoehe / 2)
    return affinity.rotate(form, drehung, origin=mitte) if drehung else form


def vielecke(form):
    return [g for g in getattr(form, "geoms", [form]) if isinstance(g, Polygon) and not g.is_empty]


def flaechen(form):
    """shapely-Fläche -> Liste build123d-Flächen in der xy-Ebene."""
    def draht(ring):
        return Wire.make_polygon([Vector(x, y, 0) for x, y in ring.coords[:-1]], close=True)

    return [Face(draht(v.exterior), [draht(r) for r in v.interiors]) for v in vielecke(form)]

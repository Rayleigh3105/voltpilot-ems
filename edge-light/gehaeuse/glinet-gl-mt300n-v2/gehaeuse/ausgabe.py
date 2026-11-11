"""Vom Körper zur Datei: Dreiecksnetz, Drucklage, STL, 3MF, Vorschaubild."""
import struct
from pathlib import Path

import numpy as np

from .mehrfarb_3mf import Teil, schreibe_3mf
from .parameter import FARBEN
from .vorschau import zeichne

AUS = Path(__file__).resolve().parent.parent / "aus"
FILAMENT = {name: platz for platz, name in enumerate(FARBEN, start=1)}


def netz(koerper, toleranz=0.02, winkel=0.25):
    """Dreiecksnetz mit zusammengelegten Ecken (dicht, für 3MF, STL und Bild)."""
    ecken, dreiecke = koerper.tessellate(toleranz, winkel)
    e = np.array([(v.X, v.Y, v.Z) for v in ecken])
    einzeln, index = np.unique(np.round(e, 5), axis=0, return_inverse=True)
    d = index.reshape(-1)[np.array(dreiecke)]
    d = d[(d[:, 0] != d[:, 1]) & (d[:, 1] != d[:, 2]) & (d[:, 0] != d[:, 2])]
    return einzeln, d


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gewendet(ecken):
    """Halbe Drehung um die x-Achse: Was oben war, liegt unten."""
    return ecken * [1.0, -1.0, -1.0]


def drucklage(netze, wenden=False, schwund=0.0):
    """Legt zusammengehörige Netze gemeinsam auf die Druckplatte: Unterseite
    auf z = 0, Mitte im Ursprung, um den Schwund vergrößert.

    netze: {name: (ecken, dreiecke)}; alle Teile behalten ihre Lage zueinander.
    """
    gedreht = {n: (gewendet(e) if wenden else e, d) for n, (e, d) in netze.items()}
    alle = np.vstack([e for e, _ in gedreht.values()])
    versatz = np.array([(alle[:, 0].min() + alle[:, 0].max()) / 2,
                        (alle[:, 1].min() + alle[:, 1].max()) / 2, alle[:, 2].min()])
    faktor = 1.0 / (1.0 - schwund)
    return {n: ((e - versatz) * faktor, d) for n, (e, d) in gedreht.items()}


def in_drucklage(netze, wenden=False, schwund=0.0):
    """Die Abbildung von ``drucklage`` für Flächen der xy-Ebene (shapely):
    Funktion Fläche in Bauteilkoordinaten -> Fläche auf dem Druckbett."""
    from shapely import affinity
    alle = np.vstack([e for e, _ in netze.values()])
    spiegel = -1.0 if wenden else 1.0
    y = alle[:, 1] * spiegel
    cx, cy = (alle[:, 0].min() + alle[:, 0].max()) / 2, (y.min() + y.max()) / 2
    f = 1.0 / (1.0 - schwund)
    # x' = f (x - cx), y' = f (spiegel y - cy)
    return lambda g: affinity.affine_transform(g, [f, 0, 0, f * spiegel, -f * cx, -f * cy])


def schreibe_stl(pfad, ecken, dreiecke):
    """Binäres STL."""
    p = ecken[dreiecke].astype(np.float32)
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-20
    satz = np.zeros(len(p), dtype=[("n", "<f4", 3), ("p", "<f4", (3, 3)), ("a", "<u2")])
    satz["n"], satz["p"] = n, p
    with open(pfad, "wb") as f:
        f.write(b"Edge-Light-Gehaeuse".ljust(80, b" "))
        f.write(struct.pack("<I", len(p)))
        f.write(satz.tobytes())


def teile_fuer_3mf(netze, farben=None):
    """{name: (ecken, dreiecke)} -> Liste Teil; Farbe und Filamentplatz nach Namen."""
    farben = farben or FARBEN
    return [Teil(n, e, d, farben.get(n, "#FFFFFF"), FILAMENT.get(n, 1)) for n, (e, d) in netze.items()]


def schreibe_druckdateien(ordner, name, netze, wenden=False, schwund=0.0, einstellungen=None):
    """Schreibt <name>.3mf (ein Objekt, je Farbe ein Teil) und je Teil ein STL.
    ``einstellungen``: Einstellungen von Bambu Studio für dieses Objekt.

    Rückgabe: die Netze in Drucklage.
    """
    ordner.mkdir(parents=True, exist_ok=True)
    lage = drucklage(netze, wenden, schwund)
    schreibe_3mf(ordner / f"{name}.3mf", {name: teile_fuer_3mf(lage)}, {name: einstellungen or {}})
    for teil, (e, d) in lage.items():
        zusatz = "" if len(lage) == 1 else f"-{teil}"
        schreibe_stl(ordner / f"{name}{zusatz}.stl", e, d)
    return lage


def nebeneinander(lagen, abstand=8.0, achse=0):
    """Mehrere Objekte in Drucklage in einer Reihe entlang x (``achse`` 1:
    hintereinander entlang y, das erste hinten); Reihe mittig im Ursprung.

    lagen: {objektname: {teilname: (ecken, dreiecke)}}
    """
    breiten = {o: np.ptp(np.vstack([e for e, _ in t.values()])[:, achse]) for o, t in lagen.items()}
    richtung = 1.0 if achse == 0 else -1.0
    x = -richtung * (sum(breiten.values()) + abstand * (len(lagen) - 1)) / 2
    aus = {}
    for o, t in lagen.items():
        v = np.zeros(3)
        v[achse] = x + richtung * breiten[o] / 2
        aus[o] = {n: (e + v, d) for n, (e, d) in t.items()}
        x += richtung * (breiten[o] + abstand)
    return aus


def bild(pfad, szene, azimut=-60, hoehe=30, breite=1400):
    """szene: Liste (ecken, dreiecke, '#RRGGBB')."""
    zeichne([(e, d, rgb(f)) for e, d, f in szene], azimut=azimut, hoehe=hoehe,
            breite=breite).save(pfad)


def schnittbild(pfad, szene, achse, wert, massstab=22, rand=3.0):
    """Schnitt durch die Szene in der Ebene achse = wert als Bild.

    szene: Liste (ecken, dreiecke, '#RRGGBB'); achse "x" zeigt die yz-Ebene,
    "y" die xz-Ebene. Spätere Teile der Liste liegen über früheren.
    """
    from PIL import Image, ImageDraw

    from .pruefung import scheibe
    tausch = {"x": [1, 2, 0], "y": [0, 2, 1]}[achse]
    formen = [(scheibe(e[:, tausch], d, wert), farbe) for e, d, farbe in szene]
    formen = [(f, farbe) for f, farbe in formen if not f.is_empty]
    u0, v0, u1, v1 = (fn(b[i] for b in (f.bounds for f, _ in formen)) for fn, i in
                      ((min, 0), (min, 1), (max, 2), (max, 3)))
    breite, hoehe = int((u1 - u0 + 2 * rand) * massstab), int((v1 - v0 + 2 * rand) * massstab)

    def px(ring):
        return [((u - u0 + rand) * massstab, hoehe - (v - v0 + rand) * massstab) for u, v in ring.coords]

    bild_ = Image.new("RGB", (breite, hoehe), (238, 240, 243))
    for form, farbe in formen:
        maske = Image.new("L", (breite, hoehe), 0)
        stift = ImageDraw.Draw(maske)
        for teil in getattr(form, "geoms", [form]):
            stift.polygon(px(teil.exterior), fill=255)
            for loch in teil.interiors:
                stift.polygon(px(loch), fill=0)
        bild_.paste(Image.new("RGB", (breite, hoehe), rgb(farbe)), (0, 0), maske)
        kante = ImageDraw.Draw(bild_)
        for teil in getattr(form, "geoms", [form]):
            for ring in (teil.exterior, *teil.interiors):
                kante.line(px(ring), fill=(70, 72, 78), width=2)
    bild_.save(pfad)

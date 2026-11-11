"""Zeichnet das VoltPilot-Logo aus dem Raster-PNG als Vektor nach.

Das Logo liegt nur als PNG vor (2040 x 816 px, in Canva erzeugt). Dieses
Skript legt Konturen subpixelgenau auf die Deckkraft (Marching Squares bei
50 %), trennt Schwarz und Hellblau und schreibt eine SVG mit benannten
Gruppen. Die SVG ist danach die einzige Quelle für CAD; liefert VoltPilot
später ein Original-SVG, ersetzt es diese Datei.

Aufruf:  python logo_vektor.py <voltpilot-logo.png> <logo-vektor.svg>
"""
import sys

import numpy as np
from PIL import Image
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union
from skimage import measure

SCHWARZ, BLAU = "#000000", "#95B9FF"
TOLERANZ_PX = 0.35  # Vereinfachung; bei 50 mm Logobreite rund 0,009 mm


def masken(png):
    """Deckkraft je Farbe als Feld 0..1 (Schwarz, Blau)."""
    a = np.asarray(Image.open(png).convert("RGBA")).astype(float)
    alpha = a[..., 3] / 255.0
    ist_blau = (a[..., 2] - a[..., 0]) > 60
    return alpha * ~ist_blau, alpha * ist_blau


def flaechen(feld):
    """Konturen bei 50 % Deckkraft -> Liste von Polygonen mit Löchern (px)."""
    feld = np.pad(feld, 1)
    ringe = []
    for c in measure.find_contours(feld, 0.5):
        if len(c) < 4:
            continue
        p = Polygon([(x - 1, y - 1) for y, x in c]).buffer(0)
        if p.area > 4:
            ringe.append(p)
    ringe.sort(key=lambda p: -p.area)
    form = Polygon()
    for r in ringe:  # gerade/ungerade: Ring in einem Ring ist ein Loch
        form = form.symmetric_difference(r)
    form = form.simplify(TOLERANZ_PX, preserve_topology=True)
    teile = list(form.geoms) if isinstance(form, MultiPolygon) else [form]
    return [t for t in teile if t.area > 4]


def gruppen(png):
    """Teilt das Logo in seine vier Bestandteile.

    schrift     Wortmarke "Volt Pilot" samt i-Punkt (schwarz)
    unterzeile  "ENERGY MANAGEMENT" (schwarz)
    flieger     Papierflieger zwischen den Wörtern (hellblau)
    blitz       Blitz als Stamm des i (hellblau)
    """
    schwarz, blau = masken(png)
    s, b = flaechen(schwarz), flaechen(blau)
    # Die Unterzeile ist das untere, klar abgesetzte Band schwarzer Teile.
    oben = sorted(s, key=lambda p: p.bounds[1])
    grenze = _luecke([p.bounds[1] for p in oben], [p.bounds[3] for p in oben])
    b.sort(key=lambda p: p.bounds[0])
    return {
        "schrift": [p for p in s if p.bounds[1] < grenze],
        "unterzeile": [p for p in s if p.bounds[1] >= grenze],
        "flieger": b[:1],
        "blitz": b[1:],
    }


def _luecke(oben, unten):
    """y-Wert der größten senkrechten Lücke zwischen den Teilen."""
    kanten = sorted(zip(oben, unten))
    reichweite, beste, wo = kanten[0][1], 0, kanten[-1][0] + 1
    for o, u in kanten[1:]:
        if o - reichweite > beste:
            beste, wo = o - reichweite, (o + reichweite) / 2
        reichweite = max(reichweite, u)
    return wo


def pfad(polygone):
    d = []
    for p in polygone:
        for ring in [p.exterior, *p.interiors]:
            pts = list(ring.coords)[:-1]
            d.append("M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z")
    return " ".join(d)


def schreibe_svg(g, groesse, ziel):
    b, h = groesse
    farbe = {"schrift": SCHWARZ, "unterzeile": SCHWARZ, "flieger": BLAU, "blitz": BLAU}
    zeilen = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {b} {h}" '
        f'width="{b}" height="{h}">',
        "<!-- Nachgezeichnet aus voltpilot-logo.png mit logo_vektor.py; "
        "Einheit = Pixel der Vorlage -->",
    ]
    for name, polygone in g.items():
        zeilen.append(
            f'<path id="{name}" fill="{farbe[name]}" fill-rule="evenodd" '
            f'd="{pfad(polygone)}"/>'
        )
    zeilen.append("</svg>")
    with open(ziel, "w") as f:
        f.write("\n".join(zeilen) + "\n")


if __name__ == "__main__":
    quelle, ziel = sys.argv[1], sys.argv[2]
    g = gruppen(quelle)
    schreibe_svg(g, Image.open(quelle).size, ziel)
    for name, polygone in g.items():
        box = unary_union(polygone).bounds
        punkte = sum(len(p.exterior.coords) + sum(len(i.coords) for i in p.interiors)
                     for p in polygone)
        print(f"{name:11s} {len(polygone):2d} Teile, {punkte:5d} Punkte, "
              f"Rahmen x {box[0]:.0f}..{box[2]:.0f}  y {box[1]:.0f}..{box[3]:.0f} px")

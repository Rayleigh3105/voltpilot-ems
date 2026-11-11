"""Vorschaubilder ohne Grafikkarte: ein kleiner Tiefenpuffer-Zeichner in numpy.

Zeichnet Dreiecksnetze in Parallelprojektion mit einfacher Beleuchtung.
Kein OpenGL, kein Bildschirm, kein Browser nötig; das Ergebnis ist ein PNG.
"""
import numpy as np
from PIL import Image


def drehung(azimut, hoehe):
    """Blickrichtung: Azimut um z, dann Höhe über der xy-Ebene (Grad).

    Höhe > 0 schaut von oben, < 0 von unten (auf die Unterseite z = 0).
    """
    a, h = np.radians(azimut), np.radians(hoehe)
    blick = -np.array([np.cos(h) * np.cos(a), np.cos(h) * np.sin(a), np.sin(h)])
    rechts = np.cross(blick, [0, 0, 1.0])
    if np.linalg.norm(rechts) < 1e-9:  # senkrechter Blick
        # Von oben liegt +x rechts, von unten -x: so steht +y stets oben.
        rechts = np.array([1.0 if h > 0 else -1.0, 0, 0])
    rechts /= np.linalg.norm(rechts)
    oben = np.cross(rechts, blick)
    return np.array([rechts, oben, -blick])


def zeichne(netze, azimut=-60, hoehe=30, breite=1400, rand=0.06,
            hintergrund=(238, 240, 243), glaetten=2):
    """netze: Liste (Ecken[n,3], Dreiecke[m,3], (r, g, b))."""
    R = drehung(azimut, hoehe)
    alle = np.vstack([e @ R.T for e, _, _ in netze])
    lo, hi = alle[:, :2].min(0), alle[:, :2].max(0)
    B = breite * glaetten
    massstab = B * (1 - 2 * rand) / (hi - lo).max()
    H = int((hi - lo)[1] * massstab + 2 * rand * B)
    versatz = np.array([(B - (hi - lo)[0] * massstab) / 2, (H - (hi - lo)[1] * massstab) / 2])
    bild = np.empty((H, B, 3), np.float32)
    bild[:] = hintergrund
    tiefe = np.full((H, B), -np.inf, np.float32)
    licht = np.array([0.30, 0.42, 0.86])  # im Blickraum: Licht kommt von der Kamera
    licht /= np.linalg.norm(licht)
    for ecken, dreiecke, farbe in netze:
        p = ecken @ R.T
        xy = (p[:, :2] - lo) * massstab + versatz
        xy[:, 1] = H - xy[:, 1]
        for i0, i1, i2 in dreiecke:
            a, b, c = xy[i0], xy[i1], xy[i2]
            flaeche = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(flaeche) < 1e-9:
                continue
            n = np.cross(p[i1] - p[i0], p[i2] - p[i0])
            n /= np.linalg.norm(n) + 1e-12
            if n[2] <= 0:  # Rückseite
                continue
            x0, x1 = max(int(min(a[0], b[0], c[0])), 0), min(int(max(a[0], b[0], c[0])) + 1, B - 1)
            y0, y1 = max(int(min(a[1], b[1], c[1])), 0), min(int(max(a[1], b[1], c[1])) + 1, H - 1)
            if x1 < x0 or y1 < y0:
                continue
            X, Y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((b[0] - X) * (c[1] - Y) - (b[1] - Y) * (c[0] - X)) / flaeche
            w1 = ((c[0] - X) * (a[1] - Y) - (c[1] - Y) * (a[0] - X)) / flaeche
            w2 = 1 - w0 - w1
            z = w0 * p[i0, 2] + w1 * p[i1, 2] + w2 * p[i2, 2]
            ausschnitt = tiefe[y0:y1 + 1, x0:x1 + 1]
            innen = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6) & (z > ausschnitt + 1e-4)
            if not innen.any():
                continue
            hell = 0.42 + 0.58 * max(float(n @ licht), 0.0)
            ton = np.array(farbe, np.float32) * hell + 14 * (1 - hell)
            ausschnitt[innen] = z[innen]
            bild[y0:y1 + 1, x0:x1 + 1][innen] = ton
    fertig = Image.fromarray(np.clip(bild, 0, 255).astype(np.uint8))
    return fertig.resize((breite, H // glaetten), Image.LANCZOS)

"""Liest aus dem G-Code, welche Stege der Probe-Platte der Slicer wirklich druckt.

Für jede Schicht der Farbeinlage und jeden Steg: Länge der Extrusionsbahnen
des richtigen Filaments, deren Mittellinie im Steg liegt. 0 mm heißt: Der
Slicer hat den Steg weggelassen. Daraus stammen die Grenzen für das Logo
(Strich mindestens 0,45 mm, Abstand mindestens 0,6 mm).

Die Lage der Platte auf dem Druckbett wird aus den Bahnen der oberen,
einfarbigen Schichten bestimmt (dort gibt es keinen Spülturm mehr).

Aufruf:  .venv/bin/python werkzeug/gcode_strichprobe.py <probe-platte-geslict.3mf>
"""
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gehaeuse.probe_platte import (SPALTE, STEG_ABSTAND, STEG_X, STEG_Y, STEGE,  # noqa: E402
                                   STEGHOEHE)

gcode = zipfile.ZipFile(sys.argv[1]).read("Metadata/plate_1.gcode").decode().splitlines()


def bahnen(zeilen):
    """Liefert (Schicht, Filament, x0, y0, x1, y1) je Extrusionsbahn."""
    filament, schicht, pos = None, 0, [0.0, 0.0]
    for z in zeilen:
        if z.startswith("; layer num/total_layer_count:"):
            schicht = int(z.split(":")[1].split("/")[0])
        m = re.match(r"T(\d+)$", z.strip())
        if m and int(m.group(1)) < 16:
            filament = int(m.group(1))
        if z.startswith(("G1 ", "G0 ")):
            w = dict((t[0], float(t[1:])) for t in z.split(";")[0].split()[1:] if t[0] in "XYE")
            neu = [w.get("X", pos[0]), w.get("Y", pos[1])]
            if w.get("E", 0) > 0 and schicht > 0 and ("X" in w or "Y" in w):
                yield schicht, filament, pos[0], pos[1], neu[0], neu[1]
            pos = neu


alle = list(bahnen(gcode))
oben = [b for b in alle if b[0] >= 6]
mx = (min(min(b[2], b[4]) for b in oben) + max(max(b[2], b[4]) for b in oben)) / 2
my = (min(min(b[3], b[5]) for b in oben) + max(max(b[3], b[5]) for b in oben)) / 2
print(f"Plattenmitte auf dem Bett: {mx:.2f} / {my:.2f}")


def stege(x0, breiten):
    aus, x = [], x0
    for b in breiten:
        aus.append((b, x, x + b))
        x += b + STEG_ABSTAND
    return aus


ziele = {"schwarz (Filament 2)": (1, stege(STEG_X["schwarz"], STEGE)),
         "hellblau (Filament 3)": (2, stege(STEG_X["blau"], STEGE))}
# weiße Spalte im schwarzen Kamm: Filament 1 zwischen den Balken
spalte, x = [], STEG_X["kamm"]
for s in SPALTE:
    x += 1.5
    spalte.append((s, x, x + s))
    x += s
ziele["weißer Spalt in Schwarz (Filament 1)"] = (0, spalte)

laenge = {}
for schicht, filament, x0, y0, x1, y1 in alle:
    if schicht > 3 or filament is None:
        continue
    # Die Platte liegt gewendet auf dem Bett: halbe Drehung um x, also y gespiegelt.
    xm, ym = (x0 + x1) / 2 - mx, (y0 + y1) / 2 - my
    if abs(ym + STEG_Y) > STEGHOEHE / 2:
        continue
    weg = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    for name, (f, liste) in ziele.items():
        if f == filament:
            for b, xa, xb in liste:
                if xa - 0.05 <= xm <= xb + 0.05:
                    laenge[(name, b, schicht)] = laenge.get((name, b, schicht), 0) + weg
for name, (f, liste) in ziele.items():
    print(name)
    for b, _, _ in liste:
        print(f"  {b:4.2f} mm: " + "  ".join(
            f"Schicht {s}: {laenge.get((name, b, s), 0):5.1f} mm" for s in (1, 2, 3)))

"""HARNESS · Bewegung P1: misst die EHRLICHKEIT des Chart-Einstiegs.

Aufruf:  python3 analyze-frames.py '<verzeichnis>/<name>-t*.png'

Fuer jeden angehaltenen Frame:
  aufgedeckt%  wie weit die Maske von links gelaufen ist (rechteste bemalte Spalte)
  voll%        Anteil der AUFGEDECKTEN Spalten, deren oberster Daten-Pixel
               GENAU dort sitzt wie im Endbild (Toleranz 2 px)
  zu_niedrig   Spalten, die NIEDRIGER bemalt sind als im Endbild — jede einzelne
               waere ein Balken, der aus der Null waechst, also ein lesbarer
               Falschwert. Diese Zahl muss 0 sein.

Gemessen wird nur GESAETTIGTE Tinte (Daten), nicht Achsen/Text/Raster.
"""
import sys, glob, os
from PIL import Image

DATEN = 60  # Saettigung ab der ein Pixel als Daten-Tinte gilt


def spaltenhoehen(pfad):
    im = Image.open(pfad).convert('RGB')
    w, h = im.size
    px = im.load()
    oben = [None] * w          # oberster Daten-Pixel je Spalte
    for x in range(w):
        for y in range(h):
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) > DATEN and not (r > 235 and g > 235 and b > 235):
                oben[x] = y
                break
    return w, h, oben


dateien = sorted(glob.glob(sys.argv[1]))
endbild = [f for f in dateien if f.endswith('tFINAL.png')]
if not endbild:
    sys.exit('kein Endbild (…-tFINAL.png) gefunden')
w, h, ziel = spaltenhoehen(endbild[0])
zweites = [f for f in dateien if f.endswith('zFINAL2.png')]
frames = [f for f in dateien if not f.endswith('tFINAL.png') and not f.endswith('zFINAL2.png')]

# ⚠ Hat sich das Bild WAEHREND des Laufs geaendert (Nachladen, neuer Live-Punkt),
# misst der Vergleich diese Aenderung und nicht den Einstieg. Dann ist der Lauf
# kein Messwert - lieber laut abbrechen als eine erfundene Zahl berichten.
if zweites:
    _, _, spaeter = spaltenhoehen(zweites[0])
    drift = sum(1 for x in range(w)
                if ziel[x] is not None and spaeter[x] is not None and abs(ziel[x] - spaeter[x]) > 2)
    if drift:
        sys.exit(f'UNGUELTIG: die Flaeche hat sich waehrend des Laufs geaendert '
                 f'({drift} Spalten zwischen den zwei Endbildern) - Lauf wiederholen')

print(f"{'frame':<26}{'aufgedeckt':>12}{'voll':>8}{'zu_niedrig':>12}{'Spalten':>9}")
schlecht = 0
for f in frames:
    _, _, ist = spaltenhoehen(f)
    rechts = max([x for x in range(w) if ist[x] is not None], default=-1)
    gepruef = passt = tief = 0
    for x in range(rechts + 1):
        if ziel[x] is None or ist[x] is None:
            continue
        gepruef += 1
        if abs(ist[x] - ziel[x]) <= 2:
            passt += 1
        elif ist[x] > ziel[x]:   # weiter unten = niedrigerer Balken
            tief += 1
    schlecht += tief
    p = f"{100 * passt / gepruef:.0f}%" if gepruef else "-"
    print(f"{os.path.basename(f):<26}{100*(rechts+1)/w:>11.0f}%{p:>8}{tief:>12}{gepruef:>9}")
print(f"\nzu niedrig ueber alle Frames: {schlecht}  ->  {'EHRLICH' if schlecht == 0 else 'FEHLER'}")

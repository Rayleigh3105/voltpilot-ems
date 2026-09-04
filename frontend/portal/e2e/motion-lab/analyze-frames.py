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

⚠ DIE FADE WIRD HERAUSGERECHNET, UND DAS IST KEINE NACHSICHT — es ist die
Kalibrierung des Massstabs. Der Einstieg blendet zusaetzlich zur Maske die
Deckkraft 0→1 auf; ein angehaltener Frame liegt also als `α · Farbe +
(1-α) · Weiss` vor. Ein blasser, kantengeglaetteter Balken-Deckel faellt damit
knapp unter die Saettigungsschwelle und der Detektor findet den naechsten
Pixel DARUNTER — gemessen: (192,210,250) statt (184,205,249) bei α = 0,90,
Saettigung 58 gegen die Schwelle 60, und der Balken erschien 4 px zu kurz,
obwohl seine Tinte exakt an derselben Stelle sass. Die Frage dieses Wächters
ist die GEOMETRIE („steht der Balken schon auf seinem wahren Wert?"), nicht
die Staerke der Tinte. `α` wird je Frame als EIN Skalar kleinstquadratisch aus
der Tinte selbst geschaetzt und herausdividiert: ein globaler Faktor kann
keine Spalte verschieben und einen kurzen Balken nie lang machen.
"""
import sys, glob, os
from PIL import Image

DATEN = 60      # Saettigung ab der ein Pixel als Daten-Tinte gilt
SICHTBAR = 8    # Abweichung von Weiss, ab der eine Spalte als AUFGEDECKT gilt
                # (fade-unempfindlich: dunkle Tinte bleibt das bis α ~ 0,08)
ALPHA_MIN = 0.05  # darunter ist die Rekonstruktion Rauschen — dann lieber schweigen


def _laden(pfad):
    im = Image.open(pfad).convert('RGB')
    w, h = im.size
    return w, h, im.load()


def _alpha(px, ziel_px, w, h, bis_x):
    """α aus der Tinte selbst: (255 - Frame) = α · (255 - Endbild).

    Nur ueber den AUFGEDECKTEN Bereich — die noch verdeckten Spalten sind reines
    Weiss und wuerden α nach unten ziehen. Ein Skalar je Frame, kleinstquadratisch.
    """
    num = den = 0.0
    for x in range(0, bis_x + 1, 3):
        for y in range(0, h, 3):
            dz = 255 - min(ziel_px[x, y])
            if dz >= 40:
                num += (255 - min(px[x, y])) * dz
                den += dz * dz
    return num / den if den else 1.0


def spaltenhoehen(pfad, ziel_px=None):
    """Oberster Daten-Pixel je Spalte, plus die rechteste aufgedeckte Spalte."""
    w, h, px = _laden(pfad)
    # 1. Wie weit ist die Maske gelaufen? (niedrige Schwelle, fade-unempfindlich)
    rechts = -1
    for x in range(w):
        for y in range(h):
            if 255 - min(px[x, y]) >= SICHTBAR:
                rechts = x
                break
    # 2. Die Fade herausrechnen, damit die Schwelle GEOMETRIE misst.
    a = 1.0
    if ziel_px is not None and rechts >= 0:
        a = max(_alpha(px, ziel_px, w, h, rechts), ALPHA_MIN)
    oben = [None] * w
    for x in range(w):
        for y in range(h):
            r, g, b = px[x, y]
            if a < 0.999:   # un-blenden: c = 255 - (255 - c_gemessen) / α
                r = 255 - (255 - r) / a
                g = 255 - (255 - g) / a
                b = 255 - (255 - b) / a
            if max(r, g, b) - min(r, g, b) > DATEN and not (r > 235 and g > 235 and b > 235):
                oben[x] = y
                break
    return w, h, oben, rechts, a


dateien = sorted(glob.glob(sys.argv[1]))
endbild = [f for f in dateien if f.endswith('tFINAL.png')]
if not endbild:
    sys.exit('kein Endbild (…-tFINAL.png) gefunden')
_, _, ziel_px = _laden(endbild[0])
w, h, ziel, _, _ = spaltenhoehen(endbild[0])
zweites = [f for f in dateien if f.endswith('zFINAL2.png')]
frames = [f for f in dateien if not f.endswith('tFINAL.png') and not f.endswith('zFINAL2.png')]

# ⚠ Hat sich das Bild WAEHREND des Laufs geaendert (Nachladen, neuer Live-Punkt),
# misst der Vergleich diese Aenderung und nicht den Einstieg. Dann ist der Lauf
# kein Messwert - lieber laut abbrechen als eine erfundene Zahl berichten.
if zweites:
    _, _, spaeter, _, _ = spaltenhoehen(zweites[0])
    drift = sum(1 for x in range(w)
                if ziel[x] is not None and spaeter[x] is not None and abs(ziel[x] - spaeter[x]) > 2)
    if drift:
        sys.exit(f'UNGUELTIG: die Flaeche hat sich waehrend des Laufs geaendert '
                 f'({drift} Spalten zwischen den zwei Endbildern) - Lauf wiederholen')

print(f"{'frame':<26}{'aufgedeckt':>12}{'voll':>8}{'zu_niedrig':>12}{'Spalten':>9}{'fade':>7}")
schlecht = 0
for f in frames:
    _, _, ist, rechts, a = spaltenhoehen(f, ziel_px)
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
    print(f"{os.path.basename(f):<26}{100*(rechts+1)/w:>11.0f}%{p:>8}{tief:>12}{gepruef:>9}{a:>7.2f}")
print(f"\nzu niedrig ueber alle Frames: {schlecht}  ->  {'EHRLICH' if schlecht == 0 else 'FEHLER'}")

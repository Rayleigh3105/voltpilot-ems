"""Zeichnet den Lichtschacht im Schnitt, vorher (v0.1) und nachher (v0.2).

Die Flächen sind Schnitte durch dieselben Körper, aus denen die Druckdateien
entstehen (Unterteil, Deckel, Platine aus dem Maßmodell); nur Maßzahlen,
Nummern und die Pfeile für das Licht sind dazugezeichnet. Die Nummern erklärt
der Begleittext: So bleibt die Schrift auch klein dargestellt lesbar.

  schnitt-*       längs durch eine LED (Ebene x = fest): Wand der LED-Seite
                  mit Lüftungsschlitz, Vorderwand des Schachts, LED,
                  Stiftleiste
  quer-*          quer durch alle drei LEDs (Ebene y = LED-Mitte)
  fuss-grundriss  wo der Schacht auf der Platine steht, von oben
"""
import cairosvg
from shapely.geometry import box

from . import entwurf, massmodell as m, platine
from .ausgabe import netz
from .massmodell import zahl
from .parameter import BAHN, SCHACHT_V01
from .pruefung import scheibe

SCHRIFT = 'font-family="DejaVu Sans, Arial, sans-serif"'
UNTERTEIL, DECKEL, RAND = "#dedbd1", "#fbfaf6", "#3c3e44"
LICHT, MASS, MARKE = "#e8890c", "#1f5fbf", "#b4231f"
PROBE, FOTO = "#1f5fbf", "#e8890c"


class Blatt:
    """Zeichenfläche in Bildpunkten über einem Fenster in Millimetern (u nach
    rechts, v nach oben)."""

    def __init__(self, u0, v0, u1, v1, massstab, kopf=0, schrift=1.0):
        """``schrift``: Faktor für Maßzahlen und Nummern; breite Blätter werden am
        Handy stark verkleinert und brauchen größere Schrift."""
        self.u0, self.v1, self.s, self.kopf, self.f = u0, v1, massstab, kopf, schrift
        self.b, self.h = (u1 - u0) * massstab, (v1 - v0) * massstab + kopf
        self.fenster = box(u0, v0, u1, v1)
        self.t = []

    def p(self, u, v):
        return (u - self.u0) * self.s, self.kopf + (self.v1 - v) * self.s

    def _pfad(self, ring):
        return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in (self.p(u, v) for u, v in ring.coords)) + " Z"

    def form(self, geom, fuell, rand=RAND, dicke=1.4):
        geom = geom.intersection(self.fenster)
        for teil in getattr(geom, "geoms", [geom]):
            if teil.is_empty or not hasattr(teil, "exterior"):
                continue
            d = self._pfad(teil.exterior) + "".join(self._pfad(r) for r in teil.interiors)
            self.t.append(f'<path d="{d}" fill="{fuell}" fill-rule="evenodd" stroke="{rand}" '
                          f'stroke-width="{dicke}" stroke-linejoin="round"/>')

    def rechteck(self, u0, v0, u1, v1, fuell="none", rand=RAND, dicke=1.4, strich=None, deck=1.0):
        a, b, c, d = self.fenster.bounds   # nicht über das Fenster hinaus (dort steht der Titel)
        (x0, y1), (x1, y0) = self.p(max(u0, a), max(v0, b)), self.p(min(u1, c), min(v1, d))
        s = f' stroke-dasharray="{strich}"' if strich else ""
        self.t.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1 - x0:.1f}" height="{y1 - y0:.1f}" '
                      f'fill="{fuell}" fill-opacity="{deck}" stroke="{rand}" stroke-width="{dicke}"{s}/>')

    def linie(self, punkte, farbe=RAND, dicke=1.4, strich=None, pfeil=False):
        s = f' stroke-dasharray="{strich}"' if strich else ""
        e = ' marker-end="url(#spitze)"' if pfeil else ""
        d = " ".join(f"{x:.1f},{y:.1f}" for x, y in (self.p(u, v) for u, v in punkte))
        self.t.append(f'<polyline points="{d}" fill="none" stroke="{farbe}" stroke-width="{dicke}"{s}{e}/>')

    def text(self, u, v, s, groesse=15, farbe="#1c1d1f", anker="start", fett=False, dx=0, dy=0,
             hof="#ffffff"):
        x, y = self.p(u, v)
        groesse = round(groesse * self.f, 1)
        self._passt(x + dx, s, groesse, anker)
        g = ' font-weight="bold"' if fett else ""
        kopf = (f'<text x="{x + dx:.1f}" y="{y + dy:.1f}" font-size="{groesse}" text-anchor="{anker}"{g} '
                f'{SCHRIFT}')
        if hof:   # heller Hof hinter der Schrift, als eigene Zeile darunter
            self.t.append(f'{kopf} fill="{hof}" stroke="{hof}" stroke-width="4" '
                          f'stroke-linejoin="round">{s}</text>')
        self.t.append(f'{kopf} fill="{farbe}">{s}</text>')

    def _passt(self, x, s, groesse, anker="start"):
        """Bricht ab, wenn Schrift über den Blattrand liefe (Breite geschätzt):
        Abgeschnittener Text in einem Bild fällt sonst erst dem Leser auf."""
        breite = 0.68 * groesse * len(s)
        links = x - {"start": 0, "middle": breite / 2, "end": breite}[anker]
        assert links >= 0 and links + breite <= self.b, f"Schrift läuft aus dem Blatt: {s!r}"

    def titel(self, s):
        self._passt(10, s, round(17 * min(self.f, 1.3)))
        self.t.append(f'<text x="10" y="{self.kopf - 12}" font-size="{round(17 * min(self.f, 1.3))}" font-weight="bold" '
                      f'fill="#1c1d1f" {SCHRIFT}>{s}</text>')

    def mass(self, u0, v0, u1, v1, s, seite=1, ab=0.0, hoch=0.0):
        """Maßlinie zwischen zwei Punkten mit Endstrichen; die Zahl steht daneben
        (seite: +1 rechts oder oben, -1 links oder unten)."""
        self.linie([(u0, v0), (u1, v1)], farbe=MASS, dicke=1.6)
        senkrecht = abs(u1 - u0) < abs(v1 - v0)
        q = 5.0 * self.f / self.s
        for u, v in ((u0, v0), (u1, v1)):
            self.linie([(u - q, v), (u + q, v)] if senkrecht else [(u, v - q), (u, v + q)],
                       farbe=MASS, dicke=1.6)
        um, vm = (u0 + u1) / 2, (v0 + v1) / 2
        if senkrecht:
            self.text(um, vm, s, farbe=MASS, fett=True, anker="start" if seite > 0 else "end",
                      dx=seite * (9 * self.f + ab), dy=5 * self.f - hoch)
        else:
            self.text(um, vm, s, farbe=MASS, fett=True, anker="middle",
                      dy=-9 * self.f - ab if seite > 0 else 20 * self.f + ab)

    def nummer(self, u, v, nr, farbe=MARKE):
        x, y = self.p(u, v)
        f = self.f
        self.t.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{11.5 * f:.1f}" fill="#ffffff" stroke="{farbe}" '
                      f'stroke-width="2"/><text x="{x:.1f}" y="{y + 5.5 * f:.1f}" font-size="{15.5 * f:.1f}" '
                      f'font-weight="bold" fill="{farbe}" text-anchor="middle" {SCHRIFT}>{nr}</text>')

    def licht(self, punkte, strich=None):
        self.linie(punkte, farbe=LICHT, dicke=2.6, strich=strich, pfeil=True)

    def svg(self):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.b:.0f} {self.h:.0f}" '
                f'width="{self.b:.0f}" height="{self.h:.0f}">'
                f'<defs><marker id="spitze" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" '
                f'markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" '
                f'fill="{LICHT}"/></marker></defs>'
                f'<rect width="{self.b:.0f}" height="{self.h:.0f}" fill="#eef0f3"/>' + "".join(self.t)
                + "</svg>")

    def schreibe(self, ordner, name):
        svg = self.svg()
        (ordner / f"{name}.svg").write_text(svg, encoding="utf-8")
        cairosvg.svg2png(bytestring=svg.encode(), write_to=str(ordner / f"{name}.png"), scale=2)


def _szene(p):
    """Netze für die Schnitte: Unterteil, Deckel und die Bauteile der Platine."""
    return {"unterteil": netz(entwurf.unterteil(p)),
            "deckel": netz(entwurf.deckel(p)["gehaeuse_weiss"], 0.01, 0.2),
            "platine": [(netz(k, 0.05, 0.4), farbe) for _, k, farbe in platine.bauteile()]}


def _schnitt(bl, szene, achse, wert):
    tausch = {"x": [1, 2, 0], "y": [0, 2, 1]}[achse]
    for (e, d), farbe in [(szene["unterteil"], UNTERTEIL), *szene["platine"], (szene["deckel"], DECKEL)]:
        bl.form(scheibe(e[:, tausch], d, wert), farbe)


def laengs(ordner, name, szene, p, led, titel, lang):
    """Längsschnitt durch die LED Nummer ``led``; links die Wand der LED-Seite."""
    x = float(m.LED_X[led])
    bl = Blatt(-3.1, -2.1, 9.6, 10.9, 46, kopf=46, schrift=1.25)
    # Der Schnitt läuft durch einen Lüftungsschlitz: Die Wand der LED-Seite ist
    # dort offen und nur als Umriss angedeutet.
    bl.rechteck(p.ya0, -3.0, p.yi0, p.z_wand - p.falz_tiefe - 1.5, fuell=UNTERTEIL, rand="#8b8d94",
                dicke=1.2, strich="5 4", deck=0.45)
    _schnitt(bl, szene, "x", x)
    bl.titel(titel)
    bl.text((p.ya0 + p.yi0) / 2, 6.0, "Schlitz", groesse=13, anker="middle", farbe="#5d6068", hof=None)
    bl.text(7.6, -0.72, "Platine", groesse=13, anker="middle", farbe="#ffffff", hof=None)
    q = m.leds()[led]
    _, _, ya, yb, w = entwurf.schacht_aussen(p)
    sockel = m.uart_sockel()
    am_sockel = sockel.x0 < x < sockel.x1
    oben = (q.y0 + q.y1) / 2, q.z1
    if not lang:
        spalt = m.LED_HOEHE + 0.4
        bl.mass(ya + w / 2, 0, ya + w / 2, spalt, zahl(spalt), seite=-1, hoch=17)
        bl.licht([(oben[0] - 0.3, oben[1] - 0.2), (p.yi0 - 0.3, 0.42), (-2.95, 0.28)])
        bl.licht([(oben[0] + 0.25, oben[1]), (4.6, 4.9), (8.2, 7.2)])
        bl.licht([(oben[0] + 0.3, oben[1] - 0.2), (8.4, 2.9 if am_sockel else 1.1)], strich="7 5")
        bl.nummer(ya + w / 2 + 0.05, spalt + 1.5, 1)
        bl.nummer(-1.6, 1.9, 2)
        bl.nummer(6.6, 7.4, 3)
        bl.mass(8.9, 0, 8.9, m.UART_HOEHE + p.led_schacht_ueber_stiften,
                zahl(m.UART_HOEHE + p.led_schacht_ueber_stiften), seite=-1)
    else:
        ry0, ry1, z_klein, z_sockel, _, _ = entwurf.schacht_rueckwand(p)
        ab = z_sockel if am_sockel else z_klein
        bl.nummer(ya + w / 2, -1.1, 1)
        bl.linie([(ya + w / 2, -0.75), (ya + w / 2, -0.08)], farbe=MARKE, dicke=1.6)
        bl.mass(6.4, 0, 6.4, ab, zahl(ab), seite=1)
        bl.linie([(ry1, ab), (6.9, ab)], farbe=MASS, dicke=1.0, strich="4 4")
        bl.nummer((ry0 + ry1) / 2, 6.2, 2)
        if am_sockel:
            bl.licht([(oben[0] + 0.3, oben[1] - 0.1), (sockel.y0 - 0.06, 1.75)])
            bl.licht([(oben[0] + 0.25, oben[1]), ((ry0 + sockel.y0) / 2 + 0.12, 2.72), (4.75, 2.82)],
                     strich="7 5")
            bl.nummer(7.9, 3.1, 3)
        else:
            bl.licht([(oben[0] + 0.3, oben[1] - 0.2), (5.6, 0.82)], strich="7 5")
            bl.nummer(5.9, 2.2, 3)
    bl.schreibe(ordner, name)


def quer(ordner, name, szene, p, titel, lang):
    """Querschnitt durch die Mitte aller drei LEDs, Blick von der LED-Seite."""
    x0, x1, _, _, w = entwurf.schacht_aussen(p)
    bl = Blatt(x0 - 3.8, -1.5, x1 + 2.0, 4.9, 30, kopf=48, schrift=1.6)
    _schnitt(bl, szene, "y", float(m.LED_Y))
    bl.titel(titel)
    bx = p.led_oeffnung[0]
    mitte = (m.LED_X[0] + m.LED_X[1]) / 2
    if not lang:
        spalt = m.LED_HOEHE + 0.4
        bl.linie([(x0 - 1.2, spalt), (x0, spalt)], farbe=MASS, dicke=1.0, strich="4 4")
        bl.mass(x0 - 0.9, 0, x0 - 0.9, spalt, zahl(spalt), seite=-1, hoch=-8)
        for q in m.leds():
            for r in (-1, 1):
                bl.licht([((q.x0 + q.x1) / 2 + r * 0.7, q.z1 - 0.1), ((q.x0 + q.x1) / 2 + r * 2.3, 0.5)])
    else:
        for a, _, b, _ in m.led_loetflaechen():   # Lötflächen, im Schnitt nur ein Strich
            bl.rechteck(a, 0.0, b, 0.12, fuell="#d9dde2", dicke=0.8)
        rand = m.led_loetflaechen()[1][2]
        innen = float(m.LED_X[1]) + bx / 2 + BAHN
        bl.mass(rand, 0.36, innen, 0.36, zahl(round(innen - rand, 1)), seite=1, ab=34)
        bl.linie([(x0 - 1.2, p.led_schacht_fuss), (x0 + BAHN, p.led_schacht_fuss)], farbe=MASS, dicke=1.0,
                 strich="4 4")
        bl.mass(x0 - 0.9, 0, x0 - 0.9, p.led_schacht_fuss, zahl(p.led_schacht_fuss), seite=-1)
    bl.schreibe(ordner, name)


def grundriss(ordner, name, p):
    """Der Fuß des Schachts auf der Platine, von oben: blau, wo schon die Füße
    der Schachtprobe standen, orange, wo nur das Herstellerfoto freie Platine zeigt."""
    x0, x1, ya, yb, w = entwurf.schacht_aussen(p)
    bl = Blatt(x0 - 3.8, -1.0, x1 + 2.4, 7.4, 30, kopf=48, schrift=1.6)
    bl.titel("Von oben: wo der Schacht steht")
    bl.rechteck(x0 - 3, p.yi0 - 3, x1 + 3, p.yi0, fuell=UNTERTEIL)
    bl.rechteck(x0 - 3, 0, x1 + 3, 9, fuell=platine.PLATINENGRUEN, rand="#1f5a37")
    for q in (m.uart_sockel(), *m.kleinteile()):
        bl.rechteck(q.x0, q.y0, q.x1, q.y1, fuell=q.farbe)
    for x in m.UART_X:
        bl.rechteck(x - 0.32, m.UART_Y - 0.32, x + 0.32, m.UART_Y + 0.32, fuell="#c9a227", dicke=0.8)
    for (a, b, c, d), q in zip(m.led_loetflaechen(), m.leds()):
        bl.rechteck(a, b, c, d, fuell="#d9dde2", dicke=0.8)
        bl.rechteck(q.x0, q.y0, q.x1, q.y1, fuell=q.farbe, dicke=0.8)
    from shapely.ops import unary_union
    fuss = unary_union([box(*r) for r in entwurf.schacht_fuss(p)])
    probe = unary_union([box(*r) for r in m.schachtprobe_fuesse()])
    bl.form(fuss.difference(probe), FOTO, rand="#8a4d00", dicke=1.2)
    bl.form(fuss.intersection(probe), PROBE, rand="#143f80", dicke=1.2)
    ry0, ry1, _, _, sx0, sx1 = entwurf.schacht_rueckwand(p)
    bl.rechteck(x0, ry0, x1, ry1, rand="#ffffff", dicke=2.0, strich="6 4")
    bl.nummer(x0 - 1.2, (ya + w + ry0) / 2, 1, farbe=PROBE)
    bl.nummer((m.LED_X[0] + m.LED_X[1]) / 2, -0.4, 2, farbe="#8a4d00")
    bl.linie([((m.LED_X[0] + m.LED_X[1]) / 2, -0.1), ((m.LED_X[0] + m.LED_X[1]) / 2, 1.5)],
             farbe="#8a4d00", dicke=1.6)
    bl.nummer(x1 + 1.2, (ry0 + ry1) / 2, 3, farbe="#1c1d1f")
    bl.nummer(float(m.UART_X[1]), 6.4, 4, farbe="#1c1d1f")
    bl.schreibe(ordner, name)


def baue(ordner, p):
    """Schreibt alle Zeichnungen nach ``ordner``."""
    alt = p.mit(**SCHACHT_V01)
    neu, vorher = _szene(p), None
    vorher = {**neu, "deckel": netz(entwurf.deckel(alt)["gehaeuse_weiss"], 0.01, 0.2)}
    laengs(ordner, "schnitt-vorher", vorher, alt, 1, "v0.1: Schnitt durch die WAN-LED", False)
    laengs(ordner, "schnitt-nachher", neu, p, 1, "v0.2: Schnitt durch die WAN-LED", True)
    laengs(ordner, "schnitt-nachher-power", neu, p, 0, "v0.2: Schnitt durch die Power-LED", True)
    quer(ordner, "quer-vorher", vorher, alt, "v0.1: quer durch die drei LEDs", False)
    quer(ordner, "quer-nachher", neu, p, "v0.2: quer durch die drei LEDs", True)
    grundriss(ordner, "fuss-grundriss", p)

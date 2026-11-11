"""Zeichnet das Maßmodell der Mango-Platine und das Messblatt.

Die Zahlen kommen aus ``massmodell.py``. Gemessene Werte (Betreiber,
09.10.2026) stehen blau, Schätzungen aus Fotos orange. Das Messblatt zeigt
die eingetragenen Messwerte und hebt hervor, was noch fehlt oder mehrdeutig ist.

Bezug: Blick auf die Bestückungsseite, Netzwerkbuchsen oben. Ursprung ist die
linke untere Platinenecke, x nach rechts, y nach oben.
"""
import cairosvg

from . import massmodell as m
from .massmodell import zahl

B, H = float(m.PLATINE_X), float(m.PLATINE_Y)
GEMESSEN, GESCHAETZT = "#1d4ed8", "#c2410c"


def _rechteck(q, titel=""):
    return (q.x0, q.y0, q.x1, q.y1, q.farbe, titel)


MODELL = {
    "rj45": _rechteck(m.rj45(), "2 × RJ45"),
    "microusb": _rechteck(m.microusb(), "Micro-USB"),
    "usba": _rechteck(m.usba(), "USB-A"),
    "reset": _rechteck(m.reset()),
    "schalter": _rechteck(m.schalter()),
    "soc": _rechteck(m.flachteile()[0], "Prozessor"),
    "ram": _rechteck(m.flachteile()[1], "RAM"),
}
ANTENNEN = m.antennen()
LEDS = [(float(x), float(m.LED_Y), x.notiz.split(",")[0]) for x in m.LED_X]
UART = [(float(x), float(m.UART_Y)) for x in m.UART_X]
LOCH = (float(m.LOCH_X), float(m.LOCH_Y), float(m.LOCH_D))
UFL = [(float(x), float(y)) for x, y in m.UFL]
_s, _k = m.reset_stoessel(), m.schalter_knopf()
STOESSEL = (_s.x0, _s.y0, _s.x1, _s.y1)
KNOPF = (_k.x0, m.SCHALTER_Y - m.SCHALTER_KNOPF_BREITE / 2, _k.x1,
         m.SCHALTER_Y + m.SCHALTER_KNOPF_BREITE / 2)   # gemessene Stellung

SCHRIFT = 'font-family="DejaVu Sans, Arial, sans-serif"'


class Blatt:
    def __init__(self, breite, hoehe):
        self.b, self.h, self.t = breite, hoehe, []

    def roh(self, s):
        self.t.append(s)

    def text(self, x, y, s, groesse=3.2, farbe="#1a1a1a", anker="start", fett=False, drehen=None):
        dreh = f' transform="rotate({drehen} {x} {y})"' if drehen else ""
        gewicht = ' font-weight="bold"' if fett else ""
        self.roh(f'<text x="{x:.2f}" y="{y:.2f}" font-size="{groesse}" fill="{farbe}" '
                 f'text-anchor="{anker}"{gewicht}{dreh} {SCHRIFT}>{s}</text>')

    def linie(self, x0, y0, x1, y1, farbe="#1a1a1a", dicke=0.25, strich=None):
        s = f' stroke-dasharray="{strich}"' if strich else ""
        self.roh(f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
                 f'stroke="{farbe}" stroke-width="{dicke}"{s}/>')

    def rechteck(self, x, y, b, h, fuell="none", rand="#1a1a1a", dicke=0.25, r=0, strich=None):
        s = f' stroke-dasharray="{strich}"' if strich else ""
        self.roh(f'<rect x="{x:.2f}" y="{y:.2f}" width="{b:.2f}" height="{h:.2f}" rx="{r}" '
                 f'fill="{fuell}" stroke="{rand}" stroke-width="{dicke}"{s}/>')

    def kreis(self, x, y, r, fuell="none", rand="#1a1a1a", dicke=0.25):
        self.roh(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="{fuell}" '
                 f'stroke="{rand}" stroke-width="{dicke}"/>')

    def marke(self, x, y, nr, farbe="#c2410c"):
        """Nummer im Kreis: Verweis auf eine Zeile der Messliste."""
        self.kreis(x, y, 2.6, fuell="#ffffff", rand=farbe, dicke=0.45)
        self.text(x, y + 1.15, str(nr), groesse=3.1, farbe=farbe, anker="middle", fett=True)

    def mass(self, x0, y0, x1, y1, nr, versatz=(0, 0), farbe="#c2410c"):
        """Maßlinie mit Endstrichen und Nummer."""
        self.linie(x0, y0, x1, y1, farbe=farbe, dicke=0.35)
        dx, dy = x1 - x0, y1 - y0
        n = (dx * dx + dy * dy) ** 0.5 or 1
        qx, qy = -dy / n * 1.3, dx / n * 1.3
        for x, y in ((x0, y0), (x1, y1)):
            self.linie(x - qx, y - qy, x + qx, y + qy, farbe=farbe, dicke=0.35)
        self.marke((x0 + x1) / 2 + versatz[0], (y0 + y1) / 2 + versatz[1], nr, farbe)

    def svg(self):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.b} {self.h}" '
                f'width="{self.b}mm" height="{self.h}mm">'
                f'<rect width="{self.b}" height="{self.h}" fill="#ffffff"/>' + "".join(self.t) + "</svg>")

    def schreibe(self, ordner, name, dpi=150):
        svg = self.svg()
        (ordner / f"{name}.svg").write_text(svg, encoding="utf-8")
        cairosvg.svg2png(bytestring=svg.encode(), write_to=str(ordner / f"{name}.png"), dpi=dpi)
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=str(ordner / f"{name}.pdf"))


def draufsicht(bl, ox, oy, s, beschriften=True):
    """Platine maßstäblich; (ox, oy) = linke obere Ecke der Platine auf dem Blatt."""
    X = lambda x: ox + s * x
    Y = lambda y: oy + s * (H - y)
    for x0, y0, x1, y1 in ANTENNEN:
        bl.rechteck(X(x0), Y(y1), s * (x1 - x0), s * (y1 - y0), fuell="#fde9a8", rand="#b88a00",
                    dicke=0.2, strich="1.2 0.8")
    bl.rechteck(X(0), Y(H), s * B, s * H, fuell="none", rand="#1f6f3a", dicke=0.6,
                r=m.PLATINE_ECKRADIUS * s)
    for name, (x0, y0, x1, y1, farbe, titel) in MODELL.items():
        bl.rechteck(X(x0), Y(y1), s * (x1 - x0), s * (y1 - y0), fuell=farbe, rand="#1a1a1a", dicke=0.25)
        if s < 2.5 and name == "microusb":
            titel = ""
        if beschriften and titel:
            hell = farbe == "#3a3f47"
            bl.text(X((x0 + x1) / 2), Y((y0 + y1) / 2) + 1.1, titel, groesse=3.0, anker="middle",
                    farbe="#ffffff" if hell else "#1a1a1a")
    r = m.rj45()
    bl.linie(X((r.x0 + r.x1) / 2), Y(r.y1), X((r.x0 + r.x1) / 2), Y(r.y0), dicke=0.2, strich="0.8 0.8")
    for x0, y0, x1, y1 in (STOESSEL, KNOPF):
        bl.rechteck(X(x0), Y(y1), s * (x1 - x0), s * (y1 - y0), fuell="#1a1a1a", dicke=0.1)
    for x, y, name in LEDS:
        bl.rechteck(X(x) - s, Y(y) - 0.45 * s, 2 * s, 0.9 * s, fuell="#22a34a", dicke=0.15)
    for x, y in UART:
        bl.rechteck(X(x) - 0.6 * s, Y(y) - 0.6 * s, 1.2 * s, 1.2 * s, fuell="#1a1a1a", dicke=0.1)
    for x, y in UFL:
        bl.kreis(X(x), Y(y), 1.3 * s, fuell="#e7c873", dicke=0.2)
    bl.kreis(X(LOCH[0]), Y(LOCH[1]), LOCH[2] / 2 * s, fuell="#ffffff", dicke=0.4)
    if beschriften:
        a0, a1 = ANTENNEN
        bl.text(X(a0[2] / 2), Y(a0[3] / 2) + 1.0, "Antenne", groesse=2.8, anker="middle", farbe="#7a5c00")
        bl.text(X((a1[0] + a1[2]) / 2), Y(a1[3] / 2), "Antenne", groesse=2.8, anker="middle",
                farbe="#7a5c00")
    return X, Y


def massmodell(ordner):
    s = 2.6
    bl = Blatt(300, 224)
    bl.text(12, 12, "GL-MT300N-V2 „Mango“ – Platine, Bestückungsseite, maßstäblich", groesse=4.4, fett=True)
    bl.text(12, 18, "blau: gemessen oder am Probedruck bestätigt, Betreiber 09.10.2026", groesse=3.2,
            farbe=GEMESSEN)
    bl.text(126, 18, "orange: aus Fotos geschätzt (±0,4 mm, hohe Teile ±1 mm)", groesse=3.2,
            farbe=GESCHAETZT)
    ox, oy = 92, 56
    X, Y = draufsicht(bl, ox, oy, s)
    bl.linie(X(0), Y(0), X(0) + 14, Y(0), farbe="#1d4ed8", dicke=0.5)
    bl.linie(X(0), Y(0), X(0), Y(0) - 14, farbe="#1d4ed8", dicke=0.5)
    bl.text(X(0) + 15, Y(0) + 1, "x", groesse=3.4, farbe="#1d4ed8", fett=True)
    bl.text(X(0) - 1, Y(0) - 15.5, "y", groesse=3.4, farbe="#1d4ed8", fett=True, anker="middle")
    bl.text(X(0) - 2, Y(0) + 5.5, "Ursprung (0 | 0)", groesse=3.0, farbe="#1d4ed8", anker="end")
    bl.text(X(B / 2), Y(H) - 12, f"Netzwerk-Kante (y = {zahl(H)})", groesse=3.4, anker="middle", fett=True)
    bl.text(X(B / 2), Y(0) + 11, "LED-Kante (y = 0)", groesse=3.4, anker="middle", fett=True)
    bl.text(X(0) + 16, Y(0) + 17.5, "↑ USB-Kante (x = 0)", groesse=3.4, fett=True, anker="middle")
    bl.text(X(B) - 16, Y(0) + 17.5, f"freie Kante (x = {zahl(B)}) ↑", groesse=3.4, fett=True, anker="middle")

    def hinweis(x, y, tx, ty, zeilen, anker="start"):
        """zeilen: Liste (Text, gemessen?)."""
        bl.linie(X(x), Y(y), tx, ty - 1, farbe="#555", dicke=0.2)
        for i, (z, gem) in enumerate(zeilen):
            farbe = "#1a1a1a" if gem is None else (GEMESSEN if gem else GESCHAETZT)
            bl.text(tx + (1 if anker == "start" else -1), ty + i * 4.0, z, groesse=2.9, anker=anker,
                    farbe=farbe)

    r, mu, u = m.rj45(), m.microusb(), m.usba()
    hinweis(r.x1, 43.0, X(B) + 12, Y(43) - 22, [
        ("Netzwerkblock", None),
        (f"Breite {zahl(m.RJ45_BREITE)}, ragt {zahl(m.RJ45_UEBERSTAND)} über", True),
        (f"Höhe {zahl(m.RJ45_HOEHE)}", True),
        (f"liegt bei x {zahl(r.x0)} … {zahl(r.x1)}", False)])
    hinweis(m.MICROUSB_MITTE_X, mu.y1, X(0) - 6, Y(H) - 16, [
        ("Micro-USB (Strom)", None), (f"Mitte x = {zahl(m.MICROUSB_MITTE_X)}", True),
        (f"ragt {zahl(m.MICROUSB_UEBERSTAND)} über, {zahl(m.MICROUSB_HOEHE)} hoch", False)], anker="end")
    hinweis(0.0, (u.y0 + u.y1) / 2, X(0) - 6, Y(u.y1) + 1, [
        ("USB-A, hochkant", None),
        (f"Höhe {zahl(m.USBA_HOEHE)}, {zahl(m.USBA_ABSTAND_NETZKANTE)} zur Netzwerk-Kante", True),
        (f"Breite {zahl(m.USBA_BREITE)}, Mündung bündig ±1", False)], anker="end")
    hinweis(STOESSEL[0], m.RESET_Y, X(0) - 6, Y(m.RESET_Y) + 9, [
        (f"Reset-Taster, Mitte y = {zahl(m.RESET_Y)}, {zahl(m.RESET_Z)} hoch", True),
        ("Stößel zeigt nach links", None)], anker="end")
    hinweis(KNOPF[0], m.SCHALTER_Y, X(0) - 6, Y(m.SCHALTER_Y) + 7, [
        (f"Schiebeschalter, Knopf bei y = {zahl(m.SCHALTER_Y)}", True),
        (f"zweite Stellung bei {zahl(m.SCHALTER_Y - m.SCHALTER_HUB)} (am Probedruck)", True)], anker="end")
    hinweis(LOCH[0], LOCH[1], X(0) - 6, Y(LOCH[1]) + 8, [
        (f"Loch Ø {zahl(m.LOCH_D)} für Haltestift", True),
        (f"Mitte ({zahl(m.LOCH_X)} | {zahl(m.LOCH_Y)})", True)], anker="end")
    hinweis(LEDS[-1][0], LEDS[-1][1], X(B) + 12, Y(2.1) + 1, [
        (f"3 LEDs bei y = {zahl(m.LED_Y)}", True),
        ("x = " + " / ".join(zahl(x) for x in m.LED_X), True), ("(Power, WAN, WLAN)", None)])
    hinweis(UART[-1][0], UART[-1][1], X(B) + 12, Y(4.6) - 13, [
        ("UART, 3 Stifte, Raster 2,54", None),
        (f"x {zahl(m.UART_X[0])} … {zahl(m.UART_X[-1])}, y = {zahl(m.UART_Y)}", False),
        (f"Stifte ≈ {zahl(m.UART_HOEHE)} hoch", False)])
    a0, a1 = ANTENNEN
    hinweis((a1[0] + a1[2]) / 2, 15.0, X(B) + 12, Y(15) - 20, [
        ("Antennenflächen (gelb):", None), ("kein Metall in der Nähe", None),
        (f"x 0 … {zahl(a0[2])} | y 0 … {zahl(a0[3])}", False),
        (f"x {zahl(a1[0])} … {zahl(a1[2])} | y 0 … {zahl(a1[3])}", False)])
    bl.text(12, 212, f"Platine {zahl(B)} × {zahl(H)} × {zahl(m.PLATINE_DICKE)} mm; tiefster Punkt der "
            f"Unterseite {zahl(m.UNTERSEITE_TIEFE)} mm unter der Platine (wo, ist nicht gemessen).",
            groesse=3.0, farbe=GEMESSEN)
    bl.text(12, 218, "Bezug wie FCC-Innenfoto. Das Herstellerbild „PINOUT“ zeigt die Platine um 180° gedreht.",
            groesse=3.0, farbe="#555")
    bl.schreibe(ordner, "massmodell")


def _eintrag(*masse):
    return " / ".join(zahl(x) for x in masse)


MESSEN = [  # Nr, Text, erwartet, gemessen
    (1, "Platine, Breite entlang der LED-Kante", "50,4", _eintrag(m.PLATINE_X)),
    (2, "Platine, Länge entlang der USB-Kante", "50,4", _eintrag(m.PLATINE_Y)),
    (3, "Platinendicke (ohne Bauteile)", "1,0 – 1,6", _eintrag(m.PLATINE_DICKE)),
    (4, "USB-A: Oberkante über Platinen-Oberseite", "13,5 – 14,5", _eintrag(m.USBA_HOEHE)),
    (5, "Netzwerkblock: Oberkante über Platinen-Oberseite", "≈ 13,5", _eintrag(m.RJ45_HOEHE)),
    (6, "Tiefster Punkt unter der Platine (Lötspitzen, Spulen)", "2 – 2,5", _eintrag(m.UNTERSEITE_TIEFE)),
    (7, "Loch für den Haltestift: Durchmesser", "≈ 2,2", _eintrag(m.LOCH_D)),
    (8, "Loch: Mitte bis USB-Kante", "15,6", _eintrag(m.LOCH_X)),
    (9, "Loch: Mitte bis LED-Kante", "9,1", _eintrag(m.LOCH_Y)),
]
OFFEN = "#c2410c"
PROBE = [  # Nr, Text, erwartet, gemessen, was noch offen ist
    (10, "Netzwerkblock: Überstand über die Platinenkante", "2,8 (2,2 – 3,3)",
     _eintrag(m.RJ45_UEBERSTAND), ""),
    (11, "Netzwerkblock: Breite / Abstand zur freien Kante", "30,7 / 2,1",
     _eintrag(m.RJ45_BREITE) + " / –", "Abstand fehlt"),
    (12, "Micro-USB: Mitte bis USB-Kante / Überstand", "7,1 / 1,4",
     _eintrag(m.MICROUSB_MITTE_X) + " / –", "Überstand fehlt"),
    (13, "USB-A: Abstand zur Netzwerk-Kante / Breite", "8,4 / 5,5",
     _eintrag(m.USBA_ABSTAND_NETZKANTE) + " / –", "Breite fehlt"),
    (14, "USB-A: Mündung zur Platinenkante (+ ragt über)", "0 ± 1", "–", "nicht gemessen"),
    (15, "Reset: Stößelmitte bis LED-Kante / Höhe über Platine", "31,5 / ?",
     _eintrag(m.RESET_Y) + " / " + m.RESET_Z.alt, f"Probedruck: Höhe {zahl(m.RESET_Z)}"),
    (16, "Schalter: Knopfmitte bis LED-Kante / Hub / Höhe", "20,6 / ? / ?",
     _eintrag(m.SCHALTER_Y) + " / 0,5 / 2,5", f"Probedruck: Hub {zahl(m.SCHALTER_HUB)}"),
    (17, "LEDs: Abstand zur LED-Kante / zur USB-Kante", "2,1 / 19,6 · 25,6 · 31,7",
     _eintrag(m.LED_Y) + " / " + " · ".join(zahl(x) for x in m.LED_X), ""),
]


def messblatt(ordner):
    bl = Blatt(210, 297)
    bl.text(12, 13, "Messblatt Mango-Platine (GL-MT300N-V2)", groesse=5.2, fett=True)
    bl.text(12, 19.5, "Blick auf die Bestückungsseite, Netzwerkbuchsen oben. Zeichnung maßstäblich nach "
            "den Messwerten.", groesse=3.1)
    bl.text(12, 24.5, "Eingetragen: Messung des Betreibers vom 09.10.2026, alle Werte in mm. "
            "Orange: fehlt noch oder ist mehrdeutig.", groesse=3.1)
    s = 1.8
    ox, oy = 32, 42
    X, Y = draufsicht(bl, ox, oy, s)
    rot = "#c2410c"
    r, mu, u = m.rj45(), m.microusb(), m.usba()
    bl.text(X(B / 2), Y(H) - 9.5, "Netzwerk-Kante", groesse=3.0, anker="middle", farbe="#555")
    bl.text(X(B) - 1.5, Y(27), "freie Kante", groesse=2.8, farbe="#555", anker="end")
    # 1 Breite, 2 Länge
    bl.mass(X(0), Y(0) + 11, X(B), Y(0) + 11, 1)
    bl.linie(X(0), Y(0), X(0), Y(0) + 12.5, farbe=rot, dicke=0.15); bl.linie(X(B), Y(0), X(B), Y(0) + 12.5, farbe=rot, dicke=0.15)
    bl.text(X(B / 2), Y(0) + 18.5, "LED-Kante", groesse=3.0, anker="middle", farbe="#555")
    bl.mass(X(0) - 17, Y(0), X(0) - 17, Y(H), 2)
    bl.linie(X(0), Y(0), X(0) - 18.5, Y(0), farbe=rot, dicke=0.15); bl.linie(X(0), Y(H), X(0) - 18.5, Y(H), farbe=rot, dicke=0.15)
    bl.text(X(0) - 23.5, Y(H / 2), "USB-Kante", groesse=3.0, anker="middle", farbe="#555", drehen=-90)
    # Loch 7, 8, 9
    bl.marke(X(LOCH[0]) + 5.2, Y(LOCH[1]) - 4.6, 7)
    bl.mass(X(0), Y(LOCH[1]), X(LOCH[0]), Y(LOCH[1]), 8, versatz=(-4, -5.0))
    bl.mass(X(LOCH[0]), Y(0), X(LOCH[0]), Y(LOCH[1]), 9, versatz=(4.8, -1.6))
    # Stecker 10-17
    bl.mass(X(B) + 7, Y(H), X(B) + 7, Y(r.y1), 10, versatz=(5, 0))
    bl.linie(X(r.x1), Y(r.y1), X(B) + 8.5, Y(r.y1), farbe=rot, dicke=0.15); bl.linie(X(B), Y(H), X(B) + 8.5, Y(H), farbe=rot, dicke=0.15)
    bl.mass(X(r.x0), Y(r.y0 - 2.8), X(r.x1), Y(r.y0 - 2.8), 11)
    bl.linie(X(r.x0), Y(r.y0), X(r.x0), Y(r.y0 - 3.8), farbe=rot, dicke=0.15); bl.linie(X(r.x1), Y(r.y0), X(r.x1), Y(r.y0 - 3.8), farbe=rot, dicke=0.15)
    xm = float(m.MICROUSB_MITTE_X)
    bl.mass(X(0), Y(H + 5.2), X(xm), Y(H + 5.2), 12, versatz=(0, -4.2))
    bl.linie(X(xm), Y(mu.y1), X(xm), Y(H + 6.0), farbe=rot, dicke=0.15); bl.linie(X(0), Y(H), X(0), Y(H + 6.0), farbe=rot, dicke=0.15)
    bl.mass(X(u.x1 + 1.6), Y(u.y1), X(u.x1 + 1.6), Y(H), 13, versatz=(4.4, 0))
    bl.linie(X(u.x1), Y(u.y1), X(u.x1 + 2.4), Y(u.y1), farbe=rot, dicke=0.15)
    bl.marke(X(0) - 6.5, Y((u.y0 + u.y1) / 2), 14)
    bl.marke(X(0) - 6.5, Y(m.RESET_Y), 15)
    bl.marke(X(0) - 6.5, Y(m.SCHALTER_Y), 16)
    bl.marke(X(LEDS[1][0]), Y(0) + 4.6, 17)
    # Seitenansicht für die Höhen
    sx, sy = 150, 76
    bl.text(sx - 6, sy - 26, "Seitenansicht (schematisch)", groesse=3.3, fett=True)
    bl.rechteck(sx, sy, 46, 2.4, fuell="#bfe3c8", rand="#1f6f3a", dicke=0.4)
    bl.rechteck(sx + 3, sy - 21, 8, 21, fuell="#c9ced6")
    bl.text(sx + 7, sy - 22.5, "USB-A", groesse=2.6, anker="middle")
    bl.rechteck(sx + 20, sy - 20, 24, 20, fuell="#d9dde2")
    bl.text(sx + 32, sy - 21.5, "RJ45", groesse=2.6, anker="middle")
    bl.rechteck(sx + 14, sy + 2.4, 5, 3.4, fuell="#8a8f98")
    for i in range(4):
        bl.linie(sx + 24 + i * 4, sy + 2.4, sx + 24 + i * 4, sy + 5.0, dicke=0.5)
    bl.mass(sx - 5, sy, sx - 5, sy + 2.4, 3, versatz=(-5, 0))
    bl.mass(sx + 13.5, sy - 21, sx + 13.5, sy, 4, versatz=(0, 0))
    bl.linie(sx + 11, sy - 21, sx + 14.5, sy - 21, farbe=rot, dicke=0.15)
    bl.mass(sx + 49, sy - 20, sx + 49, sy, 5, versatz=(4.5, 0))
    bl.linie(sx + 44, sy - 20, sx + 50, sy - 20, farbe=rot, dicke=0.15)
    bl.mass(sx + 8, sy + 2.4, sx + 8, sy + 5.8, 6, versatz=(-5, 2.0))
    bl.linie(sx + 7, sy + 5.8, sx + 19, sy + 5.8, farbe=rot, dicke=0.15)
    bl.text(sx - 6, sy + 16, "3 = Dicke   4, 5 = Höhe über der", groesse=2.8, farbe="#555")
    bl.text(sx - 6, sy + 20, "Oberseite   6 = Tiefe unter der", groesse=2.8, farbe="#555")
    bl.text(sx - 6, sy + 24, "Unterseite, am tiefsten Punkt", groesse=2.8, farbe="#555")

    def tabelle(y, titel, zeilen, hinweis):
        bl.text(12, y, titel, groesse=3.8, fett=True)
        bl.text(12, y + 4.8, hinweis, groesse=2.9, farbe="#555")
        y += 9
        bl.text(112, y, "erwartet", groesse=2.8, farbe="#555")
        bl.text(150, y, "gemessen", groesse=2.8, farbe="#555")
        y += 2
        for nr, text, erw, gem, *offen in zeilen:
            y += 5.9
            bl.marke(15, y - 1.2, nr)
            bl.text(21, y, text, groesse=3.0)
            bl.text(112, y, erw, groesse=3.0, farbe="#555")
            bl.text(150, y, gem, groesse=3.2, farbe=GEMESSEN, fett=True)
            if offen and offen[0]:
                bl.text(198, y, offen[0], groesse=2.8, farbe=OFFEN, anker="end")
        return y + 8

    y = tabelle(158, "A  Mit dem Messschieber", MESSEN,
                "Alle neun Pflichtwerte liegen vor.")
    tabelle(y, "B  Lagen der Stecker, Taster und LEDs", PROBE,
            "Was hier noch fehlt, klären Schablone und Steckerwand: Platine einlegen, Abweichungen notieren.")
    bl.schreibe(ordner, "messblatt")

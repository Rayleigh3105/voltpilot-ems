"""Zeichnet die Beschriftung des Deckels: wo welches Wort steht und wie groß
die Schrift in jeder Größe ist, die zur Wahl steht.

Alle Zeichnungen zeigen den Deckel von vorn, Netzwerk-Seite unten (so hängt er
an der Wand, so steht das Logo). Schrift, Logo, Fenster und Schrauben sind die
Flächen des Entwurfs.

  beschriftung-plan    der ganze Deckel, außen an den Kanten die Anschlüsse
                       angedeutet. Die Nummern erklärt der Begleittext.
  groesse-<k>          der Deckel in der Schriftgröße <k> ohne jede Zutat: Die
                       Breite in Millimetern steht in der Rückgabe (echte Größe).
  ausschnitt-<k>       der Streifen an der Netzwerk-Seite mit allen Wörtern,
                       vergrößert
"""
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

from . import entwurf, massmodell as m
from .ausgabe import netz
from .parameter import FARBEN, SCHRIFTGROESSEN
from .pruefung import scheibe
from .schachtbild import Blatt

DECKEL, WAND, BUCHSE = "#fbfaf6", "#dedbd1", "#c9ced6"
SCHWARZ, FENSTER, KOPF = "#101010", "#bfe6c6", "#b9bfc8"
MARKE, BLAU = "#b4231f", "#1f5fbf"


def _gelesen(geom):
    """Platinenkoordinaten -> so, wie man den Deckel liest: halbe Drehung um z."""
    return affinity.scale(geom, -1, -1, origin=(0, 0))


def nummern(p):
    """Was die Zeichnung nummeriert: Liste (Nummer, Name, Text auf dem Deckel).
    Die Reihenfolge ist die der Legende im Begleittext. Reset-Loch, Schalter und
    LEDs sind gezeichnet, aber ohne Nummer: Sie tragen kein Wort."""
    return [(i + 1, s_.name, s_.text) for i, s_ in enumerate(entwurf.beschriftung(p))]


def _deckel(bl, p, kanten=1.8):
    """Zeichnet den Deckel auf das Blatt: Umriss, Schraubenköpfe, Fenster, Logo, Schrift."""
    umriss = unary_union([box(p.xa0 + p.eckradius, p.ya0 + p.eckradius, p.xa1 - p.eckradius,
                              p.ya1 - p.eckradius).buffer(p.eckradius),
                          *[Point(x, y).buffer(p.dom_radius) for x, y in p.dome]])
    bl.form(_gelesen(umriss), DECKEL, dicke=kanten)
    for x, y in p.dome:
        bl.form(_gelesen(Point(x, y).buffer(p.schraube_kopf_d / 2)), KOPF, dicke=1.0)
    bx, by = p.led_oeffnung
    if p.led_anzeige != "keine":
        for x in m.LED_X:
            bl.form(_gelesen(box(x - bx / 2, m.LED_Y - by / 2, x + bx / 2, m.LED_Y + by / 2)), FENSTER,
                    dicke=1.0)
    # Logo: Schnitt durch die Einlagen ohne Beschriftung
    for teil, flaeche in _logo(p).items():
        bl.form(_gelesen(flaeche), FARBEN[teil], rand=FARBEN[teil], dicke=0.4)
    for s in entwurf.beschriftung(p):
        bl.form(_gelesen(s.form), SCHWARZ if p.beschriftung == "eingelegt" else "#cfcbc0", rand=SCHWARZ,
                dicke=0.3)


_LOGO = {}


def _logo(p):
    """Die Flächen des Logos in der Sichtfläche, je Teil; das Logo ist in allen Schriftgrößen dasselbe."""
    kennung = (p.logo_breite, p.logo_drehung, p.logo_mitte_y, p.mitte)
    if kennung not in _LOGO:
        koerper = entwurf.deckel(p.mit(beschriftung="keine"))
        _LOGO[kennung] = {teil: scheibe(*netz(koerper[teil], 0.01, 0.2), p.z_deckel - p.einlage / 2)
                          for teil in ("schrift_schwarz", "zeichen_hellblau")}
    return _LOGO[kennung]


def plan(ordner, name, p, titel):
    """Der Deckel von vorn mit allen Wörtern und den Anschlüssen an den Kanten."""
    rand = 9.0
    # große Nummern: Am Handy ist die Zeichnung nur ein Viertel so breit
    bl = Blatt(-p.xa1 - rand, -p.ya1 - rand, -p.xa0 + rand, -p.ya0 + 2.0, 13, kopf=46, schrift=2.4)
    bl.titel(titel)
    r, mu, u = m.rj45(), m.microusb(), m.usba()
    # Anschlüsse: stehen in der Zeichnung über die Kante hinaus, damit man sie sieht
    aussen = 4.5
    halb = (r.x1 - r.x0) / 2
    teile = [box(r.x0, p.ya1 - 1.0, r.x0 + halb - 0.4, p.ya1 + aussen),
             box(r.x0 + halb + 0.4, p.ya1 - 1.0, r.x1, p.ya1 + aussen),
             box(mu.x0, p.ya1 - 1.0, mu.x1, p.ya1 + aussen - 1.5),
             box(p.xa0 - aussen, u.y0, p.xa0 + 1.0, u.y1)]
    for t in teile:
        bl.form(_gelesen(t), BUCHSE, dicke=1.2)
    bl.form(_gelesen(Point(p.xa0 - 1.6, float(m.RESET_Y)).buffer(1.0)), "#ffffff", dicke=1.2)
    _deckel(bl, p)
    # Der Schalter liegt hinter der Wand: nur gestrichelt
    k = m.schalter_knopf()
    g = _gelesen(box(p.xa0, k.y0, p.xa0 + 2.4, k.y1))
    bl.rechteck(*g.bounds, rand="#5d6068", dicke=1.2, strich="4 3")
    # Nummern außen an den Anschlüssen
    nb = m.netzwerkbuchsen()
    orte = {"wan": (-nb["WAN"], -p.ya1 - 6.4), "lan": (-nb["LAN"], -p.ya1 - 6.4),
            "strom": (-float(m.MICROUSB_MITTE_X), -p.ya1 - 6.4),
            "usb": (-p.xa0 + 6.6, -(u.y0 + u.y1) / 2)}
    for nr, name_, _ in nummern(p):
        bl.nummer(*orte[name_], nr, farbe=MARKE)
    bl.schreibe(ordner, name)


def _rahmen_deckel(p, rand):
    """Fenster um den ganzen Deckel samt Schraubsäulen, wie man ihn liest: (u0, v0, u1, v1)."""
    r = p.dom_radius
    return (-p.xa1 - r - rand, -p.ya1 - rand, -p.xa0 + r + rand, -p.ya0 + rand)


def groesse(ordner, name, p, massstab=12):
    """Der Deckel ohne Zutat, für die Ansicht in echter Größe. Rückgabe:
    (Breite, Höhe) der Zeichnung in Millimetern."""
    u0, v0, u1, v1 = _rahmen_deckel(p, 0.6)
    bl = Blatt(u0, v0, u1, v1, massstab)
    _deckel(bl, p, kanten=1.2)
    bl.schreibe(ordner, name)
    return round(u1 - u0, 2), round(v1 - v0, 2)


def ausschnitt(ordner, name, p, massstab=30):
    """Der Streifen an der Netzwerk-Seite mit allen vier Wörtern, vergrößert.
    Rückgabe: Breite des Streifens in Millimetern."""
    u0, _, u1, _ = _rahmen_deckel(p, 0.6)
    oben = min(s.form.bounds[1] for s in entwurf.beschriftung(p)) - 2.0     # Kante über dem höchsten Wort (USB)
    bl = Blatt(u0, -p.ya1 - 0.6, u1, -oben, massstab)
    _deckel(bl, p, kanten=1.6)
    bl.schreibe(ordner, name)
    return round(u1 - u0, 2)


def baue(ordner, p):
    """Schreibt die Zeichnungen. Rückgabe: {Kennung der Schriftgröße: dict mit
    den Maßen der Zeichnungen in Millimetern}."""
    plan(ordner, "beschriftung-plan", p, "Deckel von vorn: die Anschlüsse")
    aus = {}
    for kennung, aenderung in SCHRIFTGROESSEN.items():
        q = p.mit(**aenderung)
        breite, hoehe = groesse(ordner, f"groesse-{kennung}", q)
        aus[kennung] = {"breite": breite, "hoehe": hoehe, "streifen_breite": ausschnitt(ordner, f"ausschnitt-{kennung}", q)}
    return aus

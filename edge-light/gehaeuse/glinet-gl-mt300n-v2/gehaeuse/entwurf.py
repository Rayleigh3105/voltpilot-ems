"""Gehäuse für die nackte Mango-Platine: Unterteil, Deckel, Zubehör.

Stand v0.4: liegend oder an der Wand, ohne abstehende Halterung. Gegenüber
v0.1, das der Betreiber am 10.10.2026 gedruckt hat, ist nur der Deckel geändert:
Sein Lichtschacht steht auf der Platine (v0.2, gedruckt und bestätigt am
11.10.2026), und die Anschlüsse sind auf der Sichtfläche beschriftet (v0.3),
seit v0.4 in kleinerer Schrift. Das Unterteil ist unverändert. Alle Maße kommen
aus ``massmodell.py`` (Platine) und ``parameter.py`` (Stellgrößen); hier steht
nur, wie daraus Körper werden.

Aufbau
  Unterteil  Wanne mit vier Wänden. Die Platine wird von oben eingelegt und
             liegt auf Auflagen in den Ecken (unter den Antennenflächen, wo
             keine Bauteile sitzen) und auf einer Säule mit Stift im Loch.
             Alle Stecker-Öffnungen sind nach oben offene Schlitze: keine
             Brücken, kein Verkanten beim Einlegen.
  Deckel     Platte mit Falz. Zungen schließen die Schlitze von oben,
             Niederhalter drücken auf Netzwerkblock, USB-A und die beiden
             Antennenecken. Der Lichtschacht über den drei LEDs steht auf
             der Platine. Logo und Beschriftung der Anschlüsse liegen bündig
             in der Sichtfläche; der Deckel wird mit der Sichtfläche auf der
             Druckplatte gedruckt.
  Verschluss vier Senkkopfschrauben von der Sichtseite in Säulen außen an
             der Wand (Metall bleibt bei y > 25, weg von den Antennen), dazu
             der Falz und ein Rastwulst an der LED-Seite.
  Sockel     unter dem Boden der Wanne: zwei Schlüssellöcher für die Wand
             (die Schraubenköpfe sitzen in geschlossenen Taschen, getrennt
             vom Raum der Platine), vier Mulden für Klebefüße, Etikettfeld.
  Zubehör    Clip für die Hutschiene, von hinten in die beiden mittleren
             Säulen geschraubt; Bohrlehre für die beiden Wandschrauben.

Die Passproben sind das Unterteil ohne Anbauten (``anbauten=False``): Wanne,
Aufnahme und Öffnungen entstehen dort mit denselben Aufrufen wie hier.
"""
import math
from dataclasses import dataclass

from build123d import Axis, Circle, Compound, Pos, chamfer, extrude
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from . import massmodell as m, schrift
from .formen import (aus_huelle, kegel, langloch, prisma, quader, rechteck, rundquader, zylinder,
                     zylinder_x)
from .logo import WORTMARKE_HOEHE_JE_BREITE, einlage, wortmarke
from .parameter import BAHN, STANDARD

UEBER = 0.1   # Überlappung, damit Schnitte und Vereinigungen nie auf einer Fläche enden
KEHLE = 1.5   # Fußradius zwischen Lasche und Wand (docs/regeln.md)


# ---- Bausteine, die auch die Passproben verwenden -------------------------

def schale(p, z0, z1):
    """Außenkörper von z0 bis z1 mit Fase an der Unterkante (liegt auf der Druckplatte)."""
    k = rundquader(p.xa0, p.xa1, p.ya0, p.ya1, z0, z1, p.eckradius)
    return chamfer(k.edges().group_by(Axis.Z)[0], p.fase)


def hohlraum(p, z1):
    return rundquader(p.xi0, p.xi1, p.yi0, p.yi1, p.z_boden_innen, z1 + UEBER,
                      p.eckradius - p.wand)


def auflagen(p):
    """Flächen (x0, x1, y0, y1), auf denen die Platine von unten aufliegt.

    Die Ecken an der LED-Kante liegen unter den Antennenflächen; dort ist die
    Platine frei von Bauteilen. Die übrigen Stellen sind Annahmen und der
    wichtigste Prüfpunkt der Schablone.
    """
    a, t = p.auflage_ecke, p.auflage_leiste
    bx, by = m.PLATINE_X, m.PLATINE_Y
    return {
        "ecke_led_usb": (p.xi0 - UEBER, a, p.yi0 - UEBER, a),
        "ecke_led_frei": (bx - a, p.xi1 + UEBER, p.yi0 - UEBER, a),
        "ecke_netz_usb": (p.xi0 - UEBER, a, by - a, p.yi1 + UEBER),
        "leiste_frei_mitte": (bx - t, p.xi1 + UEBER, 24.0, 30.0),
        "leiste_frei_netz": (bx - t, p.xi1 + UEBER, 40.0, 46.0),
    }


def anschlagrippen(p):
    """Rippen an der Innenwand der Netzwerk-Seite (x0, x1, z1): Die Platine
    liegt hier an, Schwund und Toleranz sammeln sich an der LED-Kante."""
    r, mu = m.rj45(), m.microusb()
    zwischen = (mu.x1 + p.oeffnung_luft + r.x0 - p.oeffnung_luft) / 2
    return [(1.6, 3.0, 0.5), (zwischen - 1.0, zwischen + 1.0, 0.5),
            (r.x1 - 5.0, r.x1 - 3.0, -0.3)]   # die dritte steht unter dem Netzwerkblock


def aufnahme(p):
    """Alles, was die Platine trägt und führt (wird zum Unterteil addiert)."""
    zb, za = p.z_boden_innen - UEBER, p.z_auflage
    plus = [quader(x0, x1, y0, y1, zb, za) for x0, x1, y0, y1 in auflagen(p).values()]
    plus.append(zylinder(m.LOCH_X, m.LOCH_Y, zb, za, p.nabe_d / 2))
    stift = zylinder(m.LOCH_X, m.LOCH_Y, za - UEBER, p.stift_ueber, p.stift_d / 2)
    plus.append(chamfer(stift.edges().group_by(Axis.Z)[-1], 0.3))
    for x0, x1, z1 in anschlagrippen(p):
        plus.append(quader(x0, x1, m.PLATINE_Y + p.anschlag_luft, p.yi1 + UEBER, zb, z1))
    return plus


def schlitz_rj45(p):
    r, l = m.rj45(), p.oeffnung_luft
    return (r.x0 - l, r.x1 + l)


def schlitz_microusb(p):
    mu, l = m.microusb(), p.oeffnung_luft
    return (mu.x0 - l, mu.x1 + l)


def schlitz_usba(p):
    u, l = m.usba(), p.oeffnung_luft
    return (u.y0 - l, u.y1 + l)


def kanal_schalter(p):
    k = m.schalter_knopf()
    return (k.y0 - p.schalter_luft_led, k.y1 + p.schalter_luft_netz)


def schalter_tasche(p):
    """Tiefe des Kanals in der Innenwand für den Schalterknopf."""
    return m.SCHALTER_UEBERSTAND - p.luft_usb + 0.4


def reset_tasche(p):
    """Tiefe des Kanals in der Innenwand für den Stößel des Tasters."""
    return max(m.RESET_UEBERSTAND - p.luft_usb, 0.0) + p.reset_luft


def senkungen(p):
    """Griffsenkungen von außen: Platz für die Umspritzung der Stecker, damit
    Micro-USB und USB-A trotz der Wand davor ganz einrasten."""
    tief = p.wand - p.senkung_rest
    mu, u = m.microusb(), m.usba()
    b, h = p.microusb_griff
    zm = (mu.z0 + mu.z1) / 2
    xm = (mu.x0 + mu.x1) / 2
    micro = quader(xm - b / 2, xm + b / 2, p.ya1 - tief, p.ya1 + UEBER, zm - h / 2, zm + h / 2)
    # Decke der Senkung unter 45°, damit sie ohne Stütze druckt
    oben = zm + h / 2
    micro += prisma([(p.ya1 - tief, oben - UEBER), (p.ya1 + UEBER, oben - UEBER),
                     (p.ya1 + UEBER, oben + tief + UEBER), (p.ya1 - tief, oben)],
                    "x", xm - b / 2, xm + b / 2)
    b, h = p.usba_griff
    ym, zm = (u.y0 + u.y1) / 2, (u.z0 + u.z1) / 2
    usb = quader(p.xa0 - UEBER, p.xa0 + tief, ym - b / 2, ym + b / 2, zm - h / 2,
                 min(zm + h / 2, p.z_wand))
    return [micro, usb]


def wandoeffnungen(p, z1):
    """Schnittkörper für alles, was durch die Wand muss oder in ihr Platz braucht."""
    unten = -0.3    # knapp unter der Platinenoberseite: die Buchsen sitzen auf der Platine
    oben = z1 + UEBER
    schnitte = []
    x0, x1 = schlitz_rj45(p)
    schnitte.append(quader(x0, x1, p.yi1 - UEBER, p.ya1 + UEBER, unten, oben))
    x0, x1 = schlitz_microusb(p)
    schnitte.append(quader(x0, x1, p.yi1 - UEBER, p.ya1 + UEBER, unten, oben))
    y0, y1 = schlitz_usba(p)
    schnitte.append(quader(p.xa0 - UEBER, p.xi0 + UEBER, y0, y1, unten, oben))
    schnitte += senkungen(p)
    # Reset: Loch für die Büroklammer in der Achse des Stößels
    schnitte.append(zylinder_x(p.xa0 - UEBER, p.xi0 + UEBER, m.RESET_Y, m.RESET_Z, p.reset_loch / 2))
    # Der Stößel ragt über die Platinenkante. Ein Kanal in der Innenwand hält
    # ihn beim Einlegen frei; sonst könnte die Wand den Taster gedrückt halten.
    h = m.RESET_STOESSEL_BREITE / 2 + p.reset_luft
    schnitte.append(quader(p.xi0 - reset_tasche(p), p.xi0 + UEBER, m.RESET_Y - h, m.RESET_Y + h,
                           unten, oben))
    # Schalter: bleibt verdeckt; innen ein Kanal, in dem der Knopf Platz hat und
    # durch den er beim Einlegen der Platine nach unten gleitet
    y0, y1 = kanal_schalter(p)
    schnitte.append(quader(p.xi0 - schalter_tasche(p), p.xi0 + UEBER, y0, y1, unten, oben))
    return schnitte


def lueftungsschlitze(p):
    """Senkrechte Schlitze an LED- und Netzwerk-Seite: im Einbau oben und unten."""
    teilung = p.schlitz + p.schlitz_steg

    def reihe(x0, x1):
        n = int((x1 - x0 + p.schlitz_steg) / teilung)
        start = (x0 + x1) / 2 - (n * teilung - p.schlitz_steg) / 2
        return [start + i * teilung for i in range(n)]

    schnitte = []
    unten = p.z_boden + p.schlitz_ab_boden
    # Mit Laschen in der Bodenebene (Form v0) schneiden die Schlitze auch durch
    # die Kehle am Laschenfuß; sonst bliebe dort ein hauchdünner Rest.
    mit_kehle = p.laschen and p.z_rueck + p.lasche_dicke + KEHLE > unten
    kehle = KEHLE + UEBER if mit_kehle else UEBER
    lx0, lx1 = p.mitte[0] - p.lasche_breite / 2, p.mitte[0] + p.lasche_breite / 2

    def kehlenreste(xs, y0, y1):
        """Schmale Reste der Kehle zwischen ihrem Ende und dem nächsten Schlitz."""
        for x in xs if mit_kehle else ():
            if 0 < x - lx0 < 1.5:
                yield quader(lx0 - UEBER, x + UEBER, y0, y1, unten, unten + kehle)
            if 0 < lx1 - (x + p.schlitz) < 1.5:
                yield quader(x + p.schlitz - UEBER, lx1 + UEBER, y0, y1, unten, unten + kehle)

    # LED-Seite: mittig (hängend ist das die Oberseite), bis unter den Falz.
    # Mit Laschen wie in v0 zwischen den Eck-Auflagen.
    oben = p.z_wand - p.falz_tiefe - 1.5
    if p.laschen:
        xs = reihe(p.auflage_ecke + 12.0, m.PLATINE_X - p.auflage_ecke - 6.0)
    else:
        xs = reihe(p.xa0 + p.schlitz_rand, p.xa1 - p.schlitz_rand)
    schnitte += [quader(x, x + p.schlitz, p.ya0 - kehle, p.yi0 + UEBER, unten, oben) for x in xs]
    schnitte += kehlenreste(xs, p.ya0 - kehle, p.ya0)
    # Netzwerk-Seite: unter dem Netzwerkblock
    x0, x1 = schlitz_rj45(p)
    xs = reihe(x0 + 1.5, anschlagrippen(p)[-1][0] - 1.5)
    schnitte += [quader(x, x + p.schlitz, p.yi1 - UEBER, p.ya1 + kehle, unten, -1.3) for x in xs]
    schnitte += kehlenreste(xs, p.ya1, p.ya1 + kehle)
    return schnitte


# ---- Unterteil ------------------------------------------------------------

def rumpf(p, z1):
    """Außenkörper der Grundform von der Standfläche bis z1: Wanne samt Sockel
    und den Schraubsäulen, mit Fase um die Standfläche."""
    z0 = p.z_rueck
    k = rundquader(p.xa0, p.xa1, p.ya0, p.ya1, z0, z1, p.eckradius)
    k = chamfer(k.edges().group_by(Axis.Z)[0], p.fase_unten)
    for x, y in p.dome:
        saeule = zylinder(x, y, z0, z1, p.dom_radius)
        k += chamfer(saeule.edges().group_by(Axis.Z)[0], p.fase_unten)
    return k


def schluesselloecher(p):
    """Schnittkörper der beiden Schlüssellöcher in der Standfläche.

    Der Schraubenkopf geht durch die runde Öffnung, der Schaft läuft im
    Schlitz in Richtung LED-Seite bis in die Rast. Hängend zeigt die
    Netzwerk-Seite nach unten: Das Gerät wird aufgesetzt und nach unten
    geschoben. Die Tasche für den Kopf endet unter dem Boden der Wanne.
    """
    z0, zl = p.z_rueck, p.z_rueck + p.wand_lippe
    zt = zl + p.wand_tasche
    schnitte = []
    for x, y in p.wandschrauben:
        ye, ym = y + p.wand_hub, y + p.wand_hub / 2
        schnitte.append(zylinder(x, ye, z0 - UEBER, zt, p.wand_einstieg_d / 2))
        schnitte.append(langloch(x, ym, z0 - UEBER, zl + UEBER, p.wand_hub + p.wand_schlitz,
                                 p.wand_schlitz, "y"))
        schnitte.append(langloch(x, ym, zl, zt, p.wand_hub + p.wand_tasche_breite,
                                 p.wand_tasche_breite, "y"))
    return schnitte


def fussmulden(p):
    """Flache Mulden in der Standfläche für Klebefüße (Schnittkörper)."""
    return [zylinder(x, y, p.z_rueck - UEBER, p.z_rueck + p.fuss_tiefe, p.fuss_d / 2)
            for x, y in p.fussmulden]


def clipbohrungen(p):
    """Kernlöcher von unten in den mittleren Säulen für die Schrauben des Clips."""
    return [zylinder(x, y, p.z_rueck - UEBER, p.z_rueck + p.clip_loch_tiefe, 0.42 * p.schraube_d)
            for x, y in p.clip_schrauben]


def etikett_unten(p):
    """Rahmen des Etikettfelds auf der Standfläche (x0, x1, y0, y1): mittig
    zwischen den Mulden an der LED-Seite und den Schlitzen der Schlüssellöcher."""
    b, h = p.etikett_groesse
    rand = p.fase_unten + p.fuss_rand
    unten = p.fussmulden[0][1] + p.fuss_d / 2 if p.fuesse else p.ya0 + rand
    if p.wandmontage:
        oben = p.wand_y - p.wand_schlitz / 2
    else:
        oben = p.fussmulden[-1][1] - p.fuss_d / 2 if p.fuesse else p.ya1 - rand
    cx, cy = p.mitte[0], (unten + oben) / 2
    return (cx - b / 2, cx + b / 2, cy - h / 2, cy + h / 2)


def _lasche(p, seite):
    """Schraublasche in der Ebene der Standfläche (Form v0); seite -1 = LED-Seite,
    +1 = Netzwerk-Seite."""
    cx = p.mitte[0]
    b, lang, r = p.lasche_breite / 2, p.lasche_laenge, 4.0
    wand = p.ya0 if seite < 0 else p.ya1
    spitze = wand + seite * lang
    z0, z1 = p.z_rueck, p.z_rueck + p.lasche_dicke
    ya, yb = sorted((spitze, spitze - seite * (2 * r + 1)))
    grund = rechteck(cx - b, cx + b, ya, yb, r)                       # gerundete Spitze
    ya, yb = sorted((spitze - seite * r, wand - seite * 1.0))
    grund += rechteck(cx - b, cx + b, ya, yb)                          # bis in die Wand
    rf = 2.0                                                           # Fußradius im Grundriss
    for kante in (-1, 1):
        x = cx + kante * b
        xa, xb = sorted((x, x + kante * rf))
        ya, yb = sorted((wand - seite * 1.0, wand + seite * rf))
        grund += rechteck(xa, xb, ya, yb)
        grund -= Pos(x + kante * rf, wand + seite * rf) * Circle(rf)
    k = extrude(Pos(0, 0, z0) * grund, z1 - z0)
    k = chamfer(k.edges().group_by(Axis.Z)[0], p.fase)
    # Kehle zwischen Laschenoberseite und Wand
    rk = KEHLE
    yc, zc = wand + seite * rk, z1 + rk
    bogen = [(yc - seite * rk * math.cos(math.radians(w)), zc - rk * math.sin(math.radians(w)))
             for w in range(0, 91, 10)]
    kehle = prisma([(wand - seite * 0.05, z1 - 0.05), (wand - seite * 0.05, zc), *bogen,
                    (yc, z1 - 0.05)], "x", cx - b, cx + b)
    return k + kehle


def _laschenloch(p, x, y):
    tief = (p.lasche_senkung_d - p.lasche_loch) / 2
    return langloch(x, y, p.z_rueck - UEBER, p.z_rueck + p.lasche_dicke,
                    p.lasche_loch + p.lasche_langloch, p.lasche_loch, "y", senkung=tief)


def rastnut(p):
    """Nut an der Innenwand der LED-Seite für den Wulst am Falz des Deckels."""
    zc, t = p.z_wand - 2.0, p.rastwulst + 0.1
    return prisma([(p.yi0 + 0.01, zc - 0.6), (p.yi0 - t, zc), (p.yi0 + 0.01, zc + 0.6)],
                  "x", 8.0, m.PLATINE_X - 8.0)


def etikettfeld(p):
    """Vertieftes Feld für das Etikett (Schnittkörper) oder None."""
    b, h = p.etikett_groesse
    if p.etikett == "deckel":
        cx = p.mitte[0]
        logo_oben = _logo_mitte(p)[1] + p.logo_breite * WORTMARKE_HOEHE_JE_BREITE / 2
        cy = (logo_oben + p.ya1 - 3.0) / 2
        return quader(cx - b / 2, cx + b / 2, cy - h / 2, cy + h / 2,
                      p.z_deckel - p.etikett_tiefe, p.z_deckel + UEBER)
    if p.etikett == "seite":
        # freie Seite, zwischen LED-Kante und der ersten Schraubsäule
        y1 = min(p.schrauben_y) - p.dom_radius - 1.0
        y0 = max(y1 - b, p.ya0 + p.eckradius)
        zc = (p.z_boden + p.z_wand) / 2
        return quader(p.xa1 - 0.3, p.xa1 + UEBER, y0, y1, zc - h / 2, zc + h / 2)
    if p.etikett == "unterseite":
        x0, x1, y0, y1 = etikett_unten(p)
        return quader(x0, x1, y0, y1, p.z_rueck - UEBER, p.z_rueck + p.etikett_tiefe)
    return None


def unterteil(p=STANDARD, anbauten=True, z_oben=None, boden=None):
    """Unterteil. Mit ``anbauten=False`` entsteht nur die Wanne mit Aufnahme
    und Öffnungen, ohne Sockel und Säulen: Das sind die Passproben; ``z_oben``
    und ``boden`` kürzen sie für die Schablone."""
    z1 = p.z_wand if z_oben is None else z_oben
    z0 = p.z_boden if boden is None else p.z_boden_innen - boden
    plus, minus = [], [hohlraum(p, z1)]
    if anbauten:
        k = rumpf(p, z1)
        minus += [zylinder(x, y, z1 - p.schraube_tiefe, z1 + UEBER, 0.42 * p.schraube_d)
                  for x, y in p.dome]
        if p.laschen:
            plus += [_lasche(p, -1), _lasche(p, +1)]
            minus += [_laschenloch(p, x, y) for x, y in p.laschenloecher]
        if p.wandmontage:
            minus += schluesselloecher(p)
        if p.fuesse:
            minus += fussmulden(p)
        if p.clip_bohrungen:
            minus += clipbohrungen(p)
        if p.etikett == "unterseite":
            minus.append(etikettfeld(p))
    else:
        k = schale(p, z0, z1)
    if plus:
        k += plus
    k = k - minus + aufnahme(p) - wandoeffnungen(p, z1)
    if z_oben is None:
        if p.lueftung:
            k -= lueftungsschlitze(p)
        if p.rastwulst > 0:
            k -= rastnut(p)
        if p.etikett == "seite":
            k -= etikettfeld(p)
    return k


# ---- Deckel ---------------------------------------------------------------

def _logo_mitte(p):
    return (p.mitte[0], p.logo_mitte_y)


def falz(p):
    """Umlaufender Falz, der den Deckel im Unterteil ausrichtet; ausgespart,
    wo Netzwerkblock und USB-A bis unter den Deckel reichen."""
    s, z0, z1 = p.spiel, p.z_wand - p.falz_tiefe, p.z_wand + UEBER
    ring = rundquader(p.xi0 + s, p.xi1 - s, p.yi0 + s, p.yi1 - s, z0, z1, p.eckradius - p.wand - s)
    d = s + p.falz
    ring -= quader(p.xi0 + d, p.xi1 - d, p.yi0 + d, p.yi1 - d, z0 - UEBER, z1 + UEBER)
    return ring - [aus_huelle(q, p.oeffnung_luft) for q in (m.rj45(), m.usba())]


def zungen(p):
    """Schließen die nach oben offenen Schlitze von Netzwerkblock und Micro-USB."""
    s = p.spiel
    innen = p.yi1 - s - 0.05     # bis an den Falz: Zunge und Falz verschmelzen
    x0, x1 = schlitz_rj45(p)
    teile = [quader(x0 + s, x1 - s, innen, p.ya1, m.RJ45_HOEHE + p.oeffnung_luft,
                    p.z_wand + UEBER)]
    x0, x1 = schlitz_microusb(p)
    zunge = quader(x0 + s, x1 - s, p.yi1, p.ya1, m.MICROUSB_HOEHE + p.oeffnung_luft + 0.1,
                   p.z_wand + UEBER)
    zunge += quader(x0 + s, x1 - s, innen, p.yi1 + UEBER, p.z_wand - p.falz_tiefe,
                    p.z_wand + UEBER)
    teile.append(zunge - senkungen(p)[0])
    return teile


def niederhalter(p):
    """Flächen, mit denen der Deckel die Platine niederhält: Klötze auf
    Netzwerkblock und USB-A, Kreuzstifte auf den beiden Antennenecken."""
    luft, oben = p.niederhalter_luft, p.z_wand + UEBER
    r, u = m.rj45(), m.usba()
    ym = r.y0 + 6.0
    teile = [quader(r.x0 + 4.0, r.x0 + 10.0, ym, ym + 3.0, r.z1 + luft, oben),
             quader(r.x1 - 10.0, r.x1 - 4.0, ym, ym + 3.0, r.z1 + luft, oben),
             quader(u.x0 + 4.0, u.x0 + 10.0, u.y0 + 1.0, u.y1 - 1.0, u.z1 + luft, oben)]
    for x, y in ((10.5, 4.0), (m.PLATINE_X - 3.5, 10.0)):
        teile.append(quader(x - 3.0, x + 3.0, y - 0.7, y + 0.7, luft, oben))
        teile.append(quader(x - 0.7, x + 0.7, y - 3.0, y + 3.0, luft, oben))
    return teile


def schacht_hinten(p):
    """y, bis zu dem die Schachtwände unterhalb der Stiftspitzen reichen: knapp
    hinter die Hinterkante der LEDs, davor bleibt die Stiftleiste frei."""
    return max(q.y1 for q in m.leds()) + p.led_schacht_hinter_led


def schacht_aussen(p):
    """Außenkanten des Schachtblocks (x0, x1, y0, y1) und die Stärke von Vorder-
    und Rückwand. Die Seitenwände des langen Schachts sind eine Bahn dicker:
    Am Fuß bleibt von ihnen die äußere Hälfte stehen, siehe ``schacht_fuss``."""
    bx, by = p.led_oeffnung
    w = 2 * BAHN
    seite = w + BAHN if p.led_schacht_bis_platine else w
    return (m.LED_X[0] - bx / 2 - seite, m.LED_X[-1] + bx / 2 + seite, m.LED_Y - by / 2 - w,
            m.LED_Y + by / 2 + w, w)


def schacht_rueckwand(p):
    """Rückwand des Schachts unterhalb der Stiftspitzen: (y0, y1, z über den
    kleinen Bauteilen, z über dem Sockel, x0 und x1 der Aussparung um den Sockel).

    Sie steht zwischen der Hinterkante der LEDs und den Stiften, über dem
    Sockel der Stiftleiste und über den kleinen Bauteilen hinter den LEDs. Bis
    auf die Platine reicht sie nirgends: Dafür ist zwischen LED und Sockel
    kein Platz.
    """
    y0 = schacht_hinten(p)
    s = m.uart_sockel()
    neben = p.led_schacht_luft_neben_sockel
    return (y0, y0 + p.led_schacht_rueckwand, m.KLEINTEILE_HOEHE + p.led_schacht_luft_kleinteile,
            s.z1 + p.led_schacht_luft_sockel, s.x0 - neben, s.x1 + neben)


def schacht_fuss(p):
    """Wo der Schacht auf der Platine steht: Rechtecke (x0, y0, x1, y1).

    Die Vorderwand in voller Stärke, dahinter die Seitenwände und die Wände
    zwischen den LEDs, je Seite eine Bahn schmaler als darüber: So bleibt Luft
    zu den Lötflächen der LEDs. Nichts davon ist schmaler als zwei Bahnen.
    """
    if not (p.led_schacht and p.led_schacht_bis_platine and p.led_anzeige != "keine"):
        return []
    bx, _ = p.led_oeffnung
    x0, x1, y0, _, w = schacht_aussen(p)
    kanten = [x0, *(x + v for x in m.LED_X for v in (-bx / 2 - BAHN, bx / 2 + BAHN)), x1]
    waende = [(kanten[i], y0 + w, kanten[i + 1], schacht_hinten(p)) for i in range(0, len(kanten), 2)]
    return [(x0, y0, x1, y0 + w), *waende]


def led_anzeige(p):
    """(plus, minus) für die Anzeige der drei LEDs im Deckel.

    Der Schacht ist ein Block über alle drei LEDs mit je einer Öffnung. Seit
    v0.2 reicht er bis auf die Platine (``led_schacht_bis_platine``); am Fuß
    sind die Öffnungen je Seite eine Bahn weiter, siehe ``schacht_fuss``. Hinter den LEDs steht die Stiftleiste; dort schließt
    eine Rückwand, so weit Sockel, Stifte und die kleinen Bauteile es
    zulassen, siehe ``schacht_rueckwand``. Erst über den Stiftspitzen ist der
    Schacht ein voller Block mit der ganzen Öffnung.

    Der Schacht von v0.1 endete 0,4 mm über den LEDs und war hinten bis über
    die Stiftspitzen offen.
    """
    if p.led_anzeige == "keine":
        return [], []
    bx, by = p.led_oeffnung
    x0, x1, ya, yb, w = schacht_aussen(p)
    y0, y1 = ya + w, yb - w
    oben = p.z_deckel + UEBER if p.led_anzeige == "offen" else p.z_deckel - p.led_fenster
    lang = p.led_schacht and p.led_schacht_bis_platine
    unten = p.led_schacht_luft if lang else m.LED_HOEHE + 0.4
    block_ab = m.UART_HOEHE + p.led_schacht_ueber_stiften     # darüber: voller Block
    hinten = schacht_hinten(p)
    plus, minus = [], []
    if p.led_schacht:
        plus.append(quader(x0, x1, ya, yb, unten, p.z_wand + UEBER))
    if p.led_schacht and not lang:
        minus.append(quader(x0 - UEBER, x1 + UEBER, hinten, yb + UEBER, unten - UEBER, block_ab))
    z0 = unten - UEBER if p.led_schacht else p.z_wand - UEBER
    if not lang:
        minus += [quader(x - bx / 2, x + bx / 2, y0, y1, z0, oben) for x in m.LED_X]
        return plus, minus
    ry0, ry1, z_klein, z_sockel, sx0, sx1 = schacht_rueckwand(p)
    # hinter der Rückwand: Platz für die Stifte, über die ganze Reihe
    minus.append(quader(x0 - UEBER, x1 + UEBER, ry1, yb + UEBER, unten - UEBER, block_ab))
    # unter der Rückwand: der Sockel der Stiftleiste und die kleinen Bauteile
    minus.append(quader(sx0, sx1, hinten, yb + UEBER, unten - UEBER, z_sockel))
    minus.append(quader(x0 - UEBER, x1 + UEBER, hinten, yb + UEBER, unten - UEBER, z_klein))
    for x in m.LED_X:
        # Öffnung: über den Stiftspitzen ganz, darunter bis an die Rückwand
        minus.append(quader(x - bx / 2, x + bx / 2, y0, y1, block_ab, oben))
        minus.append(quader(x - bx / 2, x + bx / 2, y0, hinten, z0, block_ab + UEBER))
        # Fuß: Die Öffnung ist unten je Seite eine Bahn weiter
        minus.append(quader(x - bx / 2 - BAHN, x + bx / 2 + BAHN, y0, hinten + UEBER, z0,
                            unten + p.led_schacht_fuss))
    return plus, minus


# ---- Beschriftung der Anschlüsse ------------------------------------------

@dataclass(frozen=True)
class Schild:
    """Ein Wort auf dem Deckel und das Dreieck, das auf sein Teil zeigt."""
    name: str          # "wan", "lan", "strom", "usb", "reset", "led0" bis "led2"
    text: str
    teil: str          # was es beschriftet
    kante: str         # wo das Teil sitzt: "netzwerk", "usb" oder "led"
    ziel: tuple        # Mitte des Teils (x, y): an der Außenkante oder im LED-Fenster
    wort: object       # Fläche der Schrift (shapely), Platinenkoordinaten
    zeiger: object     # Fläche des Dreiecks oder None
    laenge: float      # Länge aller Mittellinien der Schrift
    zugelaufen: float  # Anteil der Schriftfläche, der aus zugelaufenen Lücken stammt
    zeichen: tuple = ()   # jedes Zeichen für sich, an seinem Platz: schrift.zeichenweise

    @property
    def form(self):
        return self.wort if self.zeiger is None else self.wort.union(self.zeiger)


def _dreieck(spitze, richtung, p):
    """Dreieck mit der Spitze in ``spitze``, die in ``richtung`` (dx, dy) zeigt.
    Die Spitze ist gerundet: Schmaler als eine Bahn druckt nichts."""
    breite, lang = p.zeiger
    (x, y), (dx, dy) = spitze, richtung
    fuss = (x - dx * lang, y - dy * lang)
    ecken = [spitze, (fuss[0] - dy * breite / 2, fuss[1] + dx * breite / 2),
             (fuss[0] + dy * breite / 2, fuss[1] - dx * breite / 2)]
    return Polygon(ecken).buffer(-BAHN / 2).buffer(BAHN / 2, quad_segs=schrift.RUND)


def beschriftung(p):
    """Die Wörter auf der Sichtfläche des Deckels: Liste ``Schild``.

    Jedes Wort steht an der Kante, an der sein Anschluss sitzt, mittig vor
    ihm, und ein Dreieck zeigt von dort zur Kante. Die Schrift steht wie das
    Logo (``logo_drehung``): aufrecht, wenn die Netzwerk-Seite unten ist. So
    liest man sie hängend, und liegend von der Seite der Netzwerkbuchsen.
    Die Texte kommen aus ``parameter.py``; ein leerer Text entfällt.
    """
    if p.beschriftung == "keine":
        return []
    assert p.logo_drehung in (0.0, 180.0), "Die Beschriftung steht wie das Logo: 0 oder 180 Grad"
    hoehe, lang = p.schrift_hoehe, p.zeiger[1]
    buchsen, u = m.netzwerkbuchsen(), m.usba()
    y_spitze = p.ya1 - p.fase - p.zeiger_rand       # Netzwerk-Seite: Dreieck zeigt nach +y
    x_spitze = p.xa0 + p.fase + p.zeiger_rand       # USB-Seite: Dreieck zeigt nach -x
    plan = [("wan", p.text_wan, "Netzwerkbuchse WAN", "netzwerk", (buchsen["WAN"], p.ya1)),
            ("lan", p.text_lan, "Netzwerkbuchse LAN", "netzwerk", (buchsen["LAN"], p.ya1)),
            ("strom", p.text_strom, "Micro-USB (Strom)", "netzwerk", (float(m.MICROUSB_MITTE_X), p.ya1)),
            ("usb", p.text_usb, "USB-A", "usb", (p.xa0, (u.y0 + u.y1) / 2)),
            ("reset", p.text_reset, "Reset-Loch", "usb", (p.xa0, float(m.RESET_Y)))]
    if p.led_anzeige != "keine":
        plan += [(f"led{i}", text, f"LED-Fenster über der LED bei x = {m.zahl(x)}", "led",
                  (float(x), float(m.LED_Y))) for i, (x, text) in enumerate(zip(m.LED_X, p.text_leds))]
    schilder = []
    for name, text, teil, kante, (x, y) in plan:
        if not text.strip():
            continue
        satz = (text.strip(), hoehe, p.schrift_strich, p.schrift_luft)
        wort, breite, zu = schrift.flaeche(*satz, p.schrift_abstand, p.schrift_form)
        zeiger = None
        if kante == "netzwerk":
            zeiger = _dreieck((x, y_spitze), (0, 1), p)
            mitte = (x, y_spitze - lang - p.zeiger_luft - hoehe / 2)
        elif kante == "usb":
            zeiger = _dreieck((x_spitze, y), (-1, 0), p)
            mitte = (x_spitze + lang + p.zeiger_luft + breite / 2, y)
        else:
            mitte = (x, y + p.led_oeffnung[1] / 2 + p.led_text_luft + hoehe / 2)
        setze = lambda g: schrift.gesetzt(g, breite, hoehe, mitte, p.logo_drehung)
        zeichen = tuple({**z, "form": setze(z["form"]), "linien": setze(z["linien"])}
                        for z in schrift.zeichenweise(*satz, p.schrift_abstand, p.schrift_form))
        schilder.append(Schild(name, schrift.pruefe_text(text.strip(), p.schrift_form), teil, kante, (x, y),
                               setze(wort), zeiger, schrift.laenge(*satz, p.schrift_form), zu, zeichen))
    return schilder


def rastwulst(p):
    zc, yf = p.z_wand - 2.0, p.yi0 + p.spiel
    return prisma([(yf + 0.05, zc - 0.5), (p.yi0 - p.rastwulst, zc), (yf + 0.05, zc + 0.5)],
                  "x", 8.5, m.PLATINE_X - 8.5)


def deckel(p=STANDARD):
    """Deckel als drei Körper: {"gehaeuse_weiss", "schrift_schwarz", "zeichen_hellblau"}.
    Die eingelegte Beschriftung der Anschlüsse gehört zum Körper ihrer Farbe."""
    umriss = rechteck(p.xa0, p.xa1, p.ya0, p.ya1, p.eckradius)
    for x, y in p.dome:
        umriss += Pos(x, y) * Circle(p.dom_radius)
    platte = extrude(Pos(0, 0, p.z_wand) * umriss, p.deckel)
    # Die Sichtfläche liegt beim Druck auf der Platte: Fase statt Rundung.
    platte = chamfer(platte.edges().group_by(Axis.Z)[-1], p.fase)
    plus = [falz(p), *zungen(p), *niederhalter(p)]
    minus = []
    led_plus, led_minus = led_anzeige(p)
    if p.rastwulst > 0:
        plus.append(rastwulst(p))
    kopf = (p.schraube_kopf_d - p.schraube_d - 0.4) / 2
    for x, y in p.dome:
        minus.append(zylinder(x, y, p.z_wand - UEBER, p.z_deckel + UEBER, p.schraube_d / 2 + 0.2))
        minus.append(kegel(x, y, p.z_deckel - kopf, p.z_deckel + 0.01, p.schraube_d / 2 + 0.2,
                           p.schraube_kopf_d / 2 + 0.01))
    if p.etikett == "deckel":
        minus.append(etikettfeld(p))
    weiss = platte + (plus + led_plus) - (minus + led_minus)

    logo = wortmarke(p.logo_breite, _logo_mitte(p), p.logo_drehung)
    einlagen = {name: einlage(flaechen, p.z_deckel - p.einlage, p.einlage)
                for name, flaechen in logo.items()}
    worte = [f for s in beschriftung(p) for f in schrift.flaechen(s.form)]
    if worte and p.beschriftung == "eingelegt":
        # dieselbe Farbe, dieselben drei Schichten wie die Schrift des Logos:
        # kein zusätzlicher Farbwechsel
        farbe = p.beschriftung_farbe
        einlagen[farbe] = Compound(children=[
            *einlagen[farbe].solids(), *einlage(worte, p.z_deckel - p.einlage, p.einlage).solids()])
    elif worte and p.beschriftung == "vertieft":
        weiss = weiss.cut(*einlage(worte, p.z_deckel - p.beschriftung_tiefe,
                                   p.beschriftung_tiefe + UEBER).solids())
    elif worte and p.beschriftung == "erhaben":
        weiss = weiss + list(einlage(worte, p.z_deckel - UEBER, p.beschriftung_tiefe + UEBER).solids())
    weiss = weiss.cut(*[s for e in einlagen.values() for s in e.solids()])
    return {"gehaeuse_weiss": weiss, **einlagen}


# ---- Kennung auf der Unterseite (Entscheid 8 vom 26.10.2026) --------------
#
# Referenz und QR-Code werden mit dem Unterteil gedruckt: eine schwarze Einlage in den
# ersten drei Schichten, wie Logo und Schrift des Deckels. Die Standfläche liegt beim
# Druck auf der Platte; sie ist die Sichtseite. Man liest sie von unten, mit der
# Netzwerk-Seite unten wie den Deckel und wie an der Wand: Dort zeigt nach rechts +x
# und nach oben -y. Deshalb steht beides in Platinenkoordinaten gespiegelt (y = -oben).

# Kleine Zugabe je Modul: Module, die sich nur an einer Ecke berühren, gäben Flächen
# mit Berührpunkten, die der Geometriekern nicht annimmt; so wird daraus eine Brücke
# weit unter jeder Druckauflösung.
QR_ZUGABE = 0.002


@dataclass(frozen=True)
class Kennung:
    """Was auf der Standfläche einer Box liegt (Platinenkoordinaten, von unten gelesen)."""
    inhalt: dict       # kennung.inhalt(ref): referenz, klartext, link, fassung, maske, module
    qr: object         # Fläche der dunklen Module (shapely)
    qr_rahmen: tuple   # (x0, y0, x1, y1) des Codes ohne Ruhezone
    zeilen: tuple      # je Zeile dict(text, form, zeichen, laenge)

    @property
    def form(self):
        return unary_union([self.qr, *(z["form"] for z in self.zeilen)])


def standflaeche(p):
    """Die Standfläche ohne Fase und was auf ihr liegt: (ebene Fläche, Umriss des Teils,
    {Name: Fläche}) als shapely-Flächen, aus den Stellgrößen. Die Prüfung misst dasselbe
    noch einmal am Netz (pruefung.pruefe_kennung)."""
    r = p.eckradius
    umriss = box(p.xa0 + r, p.ya0 + r, p.xa1 - r, p.ya1 - r).buffer(r)
    belegt = {"Mulde für einen Fuß": unary_union([Point(x, y).buffer(p.fuss_d / 2) for x, y in p.fussmulden])}
    if p.wandmontage:
        belegt["Schlüsselloch"] = unary_union(
            [Point(x, y + p.wand_hub).buffer(p.wand_einstieg_d / 2) for x, y in p.wandschrauben]
            + [LineString([(x, y), (x, y + p.wand_hub)]).buffer(p.wand_schlitz / 2) for x, y in p.wandschrauben])
    return umriss.buffer(-p.fase_unten), umriss, belegt


def _dunkel_abstand(p, form):
    """Abstand einer Fläche der Standfläche zum nächsten Dunklen: Loch, Mulde, Rand des Teils."""
    _, umriss, belegt = standflaeche(p)
    return min([umriss.exterior.distance(form), *(g.distance(form) for g in belegt.values())])


def _qr_form(module, x0, y0, modul):
    """Die dunklen Module als Fläche, Zeile 0 bei y0 (oben, von unten gelesen), Spalte 0 bei x0."""
    teile = []
    for zeile, reihe in enumerate(module):
        x = 0
        while x < len(reihe):
            if reihe[x] != "1":
                x += 1
                continue
            a = x
            while x < len(reihe) and reihe[x] == "1":
                x += 1
            y = y0 + zeile * modul
            teile.append(box(x0 + a * modul - QR_ZUGABE, y - QR_ZUGABE, x0 + x * modul + QR_ZUGABE,
                             y + modul + QR_ZUGABE))
    return unary_union(teile)


def _von_unten(form, breite, mitte_x, grundlinie):
    """Setzt eine Textfläche (Schriftkoordinaten: x nach rechts, y nach oben, ab 0) so auf die
    Standfläche, dass man sie von unten liest: mittig über ``mitte_x``, Grundlinie bei y =
    ``grundlinie``, nach oben ist -y."""
    from shapely import affinity
    return affinity.affine_transform(form, [1, 0, 0, -1, mitte_x - breite / 2, grundlinie])


def kennung_unten(p, inhalt):
    """Lage von QR-Code und Klarschrift auf der Standfläche: ``Kennung``.

    Der Code steht mittig zwischen den Mulden der LED-Seite, in y dort, wo sein Abstand zum
    Rand des Teils und zu den Schlüssellöchern am größten ist. Die Klarschrift steht in zwei
    Zeilen an der Netzwerk-Seite: "EDGE-" zwischen den Schlüssellöchern, darunter der Rest,
    mit ``beschriftung_frei`` Abstand zur Fase."""
    assert p.wandmontage and p.fuesse, "Die Kennung ist für die Unterseite mit Schlüssellöchern und Mulden gelegt"
    n = len(inhalt["module"])
    seite = n * p.qr_modul
    cx = p.mitte[0]
    y_unten = p.ya0 + seite / 2
    y_oben = p.wand_y
    schritte = round((y_oben - y_unten) / 0.01)
    cy = max((y_unten + i * (y_oben - y_unten) / schritte for i in range(schritte + 1)),
             key=lambda y: round(_dunkel_abstand(p, box(cx - seite / 2, y - seite / 2,
                                                        cx + seite / 2, y + seite / 2)), 3))
    x0, y0 = cx - seite / 2, cy - seite / 2
    qr = _qr_form(inhalt["module"], x0, y0, p.qr_modul)

    text = inhalt["klartext"]
    teile = [text[:len("EDGE-")], text[len("EDGE-"):]]
    satz = lambda t: (t, p.schrift_hoehe, p.schrift_strich, p.schrift_luft)
    grundlinie = None
    zeilen = []
    for t in reversed(teile):   # von der Netzwerk-Seite her
        wort, breite, _ = schrift.flaeche(*satz(t), p.schrift_abstand, p.schrift_form)
        if grundlinie is None:   # der Schwanz des Q reicht unter die Grundlinie
            grundlinie = p.ya1 - p.fase_unten - p.beschriftung_frei + min(0.0, wort.bounds[1])
        setze = lambda g, b=breite, gl=grundlinie: _von_unten(g, b, cx, gl)
        zeichen = tuple({**z, "form": setze(z["form"]), "linien": setze(z["linien"])}
                        for z in schrift.zeichenweise(*satz(t), p.schrift_abstand, p.schrift_form))
        zeilen.insert(0, {"text": schrift.pruefe_text(t, p.schrift_form), "form": setze(wort), "zeichen": zeichen,
                          "laenge": schrift.laenge(*satz(t), p.schrift_form)})
        grundlinie -= p.schrift_hoehe + p.kennung_zeilenabstand
    return Kennung(inhalt, qr, (x0, y0, x0 + seite, y0 + seite), tuple(zeilen))


def unterteil_mit_kennung(p, inhalt):
    """Das Unterteil einer Box mit ihrer Kennung: {"gehaeuse_weiss", "schrift_schwarz"}.

    Gegenüber dem gedruckten Unterteil ändert sich nur die Standfläche: Das Etikettfeld
    (0,2 mm tief) entfällt, und QR-Code und Klarschrift liegen als schwarze Einlage in den
    ersten drei Schichten. Alles darüber ist dasselbe Teil."""
    k = kennung_unten(p, inhalt)
    weiss = unterteil(p.mit(etikett="keins"))
    schwarz = einlage(schrift.flaechen(k.form), p.z_rueck, p.einlage)
    weiss = weiss.cut(*schwarz.solids())
    return {"gehaeuse_weiss": weiss, p.beschriftung_farbe: schwarz}


# ---- Wandmontage: Schrauben und Bohrlehre ---------------------------------

def wandschrauben(p=STANDARD, laenge=14.0):
    """Die beiden Wandschrauben in der Rast, nur zum Prüfen und für die Bilder:
    Kopf in der Tasche, Schaft durch die Lippe in die Wand."""
    zl = p.z_rueck + p.wand_lippe
    teile = []
    for x, y in p.wandschrauben:
        kopf = zylinder(x, y, zl, zl + p.wand_kopf_hoehe, p.wand_kopf_d / 2)
        teile.append(kopf + zylinder(x, y, p.z_rueck - laenge, zl + UEBER, p.wand_schaft / 2))
    return teile


def wandlehre(p=STANDARD):
    """Bohrlehre für die beiden Wandschrauben, in Drucklage (z = 0 unten).

    Ein Streifen mit zwei nach unten offenen Schlitzen im Schraubenabstand:
    an die Wand halten, anzeichnen, die Schrauben bis auf den Streifen
    eindrehen, Streifen nach oben abziehen. Er ist so dick wie die Lippe der
    Schlüssellöcher plus Spiel; damit stehen die Köpfe richtig vor der Wand.
    """
    dicke = p.wand_lippe + p.wand_lehre_luft
    halb, hoch = p.wand_abstand / 2 + 2 * p.wand_kopf_d, 2 * p.wand_kopf_d
    k = rundquader(-halb, halb, 0, hoch, 0, dicke, 2.0)
    k = chamfer(k.edges().group_by(Axis.Z)[0], 0.3)
    mitte = hoch / 2
    schlitze = [langloch(x, mitte / 2, -UEBER, dicke + UEBER, mitte + p.wand_schlitz + 2 * UEBER,
                         p.wand_schlitz, "y") + quader(x - p.wand_schlitz / 2, x + p.wand_schlitz / 2,
                                                       -UEBER, mitte / 2, -UEBER, dicke + UEBER)
                for x in (-p.wand_abstand / 2, p.wand_abstand / 2)]
    # Kerbe in der Mitte der Oberkante: zum Ausrichten an einem Strich
    kerbe = prisma([(-1.0, hoch + UEBER), (0.0, hoch - 1.5), (1.0, hoch + UEBER)], "z",
                   -UEBER, dicke + UEBER)
    return k - schlitze - kerbe


# ---- Hutschienen-Clip (Zubehör) -------------------------------------------

def _schiene_y(p):
    """y der beiden Schienenkanten: der feste Haken sitzt an der LED-Seite."""
    yc = p.mitte[1]
    return yc - p.schiene_breite / 2, yc + p.schiene_breite / 2


def clip(p=STANDARD):
    """Abnehmbarer Clip für die Hutschiene TH 35, ein Teil, flach gedruckt.

    Oben (LED-Seite) ein fester Haken über die ganze Breite, unten ein Riegel
    an einem Federarm, der in der Druckebene liegt. Ein Schraubendreher in der
    Öse zieht den Riegel nach unten. Ein Quersteg reicht zu den beiden
    mittleren Schraubsäulen; dort wird der Clip von hinten mit zwei
    Gehäuseschrauben angeschraubt. Die Schraubenköpfe liegen in der Rinne der
    Schiene.
    """
    cx = p.mitte[0]
    zf, zr = p.z_rueck, p.z_rueck - p.clip_platte
    hb = p.clip_breite / 2
    yt, yb = _schiene_y(p)
    fd, tiefe = p.feder_dicke, p.feder_tiefe
    arm_y0 = yb + 0.2                     # der Arm selbst hält Abstand zur Schiene
    arm_y1 = arm_y0 + fd
    tip_x0, tip_x1 = cx - p.feder_laenge / 2, cx - p.feder_laenge / 2 + 10.0
    wurzel_x = cx + p.feder_laenge / 2
    y0 = yt - 6.0                         # über dem festen Haken
    y1 = arm_y1 + p.feder_weg + 5.0       # unter der Wurzel des Federarms

    def gefast(k):                        # die Vorderseite liegt auf der Druckplatte
        return chamfer(k.edges().group_by(Axis.Z)[-1], 0.4)

    platte = gefast(rundquader(cx - hb, cx + hb, y0, y1, zr, zf, 3.0))
    (xs0, ys), (xs1, _) = p.clip_schrauben
    platte += gefast(rundquader(xs0 - p.dom_radius, xs1 + p.dom_radius, ys - p.clip_steg / 2,
                                ys + p.clip_steg / 2, zr, zf, 3.0))
    fenster = quader(cx - hb + 3.0, wurzel_x, yb - 2.1, arm_y1 + p.feder_weg, zr - UEBER, zf + UEBER)
    schlitz = quader(tip_x0 - 0.6, tip_x0 + 3.6, arm_y1 + p.feder_weg - UEBER, y1 + UEBER,
                     zr - UEBER, zf + UEBER)
    k = platte - [fenster, schlitz]

    plus, minus = [], []
    # Schrauben in die Säulen: Durchgang und Senkung für den Kopf auf der Rückseite
    kopf = (p.schraube_kopf_d - p.schraube_d - 0.4) / 2
    for x, y in p.clip_schrauben:
        minus.append(zylinder(x, y, zr - UEBER, zf + UEBER, p.schraube_d / 2 + 0.2))
        minus.append(kegel(x, y, zr - 0.01, zr + kopf, p.schraube_kopf_d / 2 + 0.01,
                           p.schraube_d / 2 + 0.2))
    # Fester Haken: Block über der Schienenkante, Nase mit 45°-Keil dahinter
    hz = zr - 5.0
    plus.append(quader(cx - 15.0, cx + 15.0, yt - 4.0, yt, hz, zr + UEBER))
    h = p.haken_hinterschnitt
    plus.append(prisma([(yt - 0.05, zr - p.schiene_kante), (yt + h, zr - p.schiene_kante - h),
                        (yt + h, hz), (yt - 0.05, hz)], "x", cx - 15.0, cx + 15.0))
    # Federarm mit Wurzel; die Wurzel bleibt neben der Schiene
    zt = zf - tiefe
    plus.append(quader(tip_x0, wurzel_x + UEBER, arm_y0, arm_y1, zt, zf))
    plus.append(quader(wurzel_x, cx + hb, arm_y0, arm_y1 + p.feder_weg + 3.0, zt, zf))
    rf = 1.0   # Fußradius an der Wurzel
    zwickel = quader(wurzel_x - rf, wurzel_x + UEBER, arm_y1 - UEBER, arm_y1 + rf, zt, zf)
    plus.append(zwickel - zylinder(wurzel_x - rf, arm_y1 + rf, zt - UEBER, zf + UEBER, rf))
    # Riegel an der Armspitze: Sitz an der Schienenkante (mit Vorspannung) und
    # Nase hinter der Kante; die Auflaufschräge liegt beim Druck oben
    yr = yb - p.riegel_vorspannung
    plus.append(quader(tip_x0, tip_x1, yr, arm_y0 + UEBER, zt, zf))
    spalt = p.schiene_kante_max + 0.3
    e = p.riegel_eingriff
    plus.append(prisma([(yr + 0.05, zr - spalt), (yr - e, zr - spalt - e * math.tan(math.radians(20))),
                        (yr - e, zt + 1.5), (yr + 0.05, zt)], "x", tip_x0, tip_x1))
    # Zuglasche mit Öse für den Schraubendreher: ragt unter der Netzwerk-Seite hervor
    plus.append(quader(tip_x0, tip_x0 + 3.0, arm_y1 - UEBER, y1 + 4.0, zr, zf))
    plus.append(rundquader(tip_x0 - 1.0, tip_x0 + 5.0, y1 + 1.5, y1 + 7.5, zr, zf, 1.5))
    minus.append(zylinder(tip_x0 + 2.0, y1 + 4.5, zr - UEBER, zf + UEBER, 1.6))
    return k + plus - minus


def schiene(p=STANDARD, laenge=90.0):
    """Hutschiene TH 35-7,5 hinter dem Clip, nur zum Prüfen und für die Bilder."""
    cx, yc = p.mitte
    zr = p.z_rueck - p.clip_platte
    t, tief, hb = p.schiene_kante, p.schiene_tiefe, p.schiene_breite / 2
    profil = [(-hb, 0), (-12.5, 0), (-12.5, -(tief - t)), (12.5, -(tief - t)), (12.5, 0), (hb, 0),
              (hb, -t), (12.5 + t, -t), (12.5 + t, -tief), (-12.5 - t, -tief), (-12.5 - t, -t),
              (-hb, -t)]
    return prisma([(yc + y, zr + z) for y, z in profil], "x", cx - laenge / 2, cx + laenge / 2)

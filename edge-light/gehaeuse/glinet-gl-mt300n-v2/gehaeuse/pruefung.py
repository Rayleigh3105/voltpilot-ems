"""Prüft den Entwurf, soweit es ohne Drucker geht.

1. Durchdringung: Die Platine liegt als Körper im Gehäuse; kein Bauteil darf
   Unterteil oder Deckel schneiden, die Teile dürfen einander nicht schneiden.
2. Abstände: kleinster Abstand jedes Bauteils zu Unterteil und Deckel.
3. Regeln: Wandstärken, Spiel, Schrauben, Wandmontage, Clip gegen die Zahlen
   aus docs/regeln.md.
4. Stege: Jede Druckschicht jedes Teils wird geschnitten; gemeldet wird, wo
   Material schmaler ist als eine oder zwei Bahnen.
5. Logo: kleinster Strich und kleinster Abstand der Einlagen.
6. Gedrucktes: Sind die Passproben, das Unterteil und der Deckel v0.2 noch
   die Körper des festgehaltenen Stands, und durchdringt die Platine keine
   Passprobe?
7. Lichtschacht: Wo steht er auf der Platine, ist sie dort frei, was bleibt
   offen, und was geschieht, wenn er um die Toleranz zu lang oder zu kurz ist?
8. Beschriftung: Steht jedes Wort vor seinem Anschluss, frei von Logo,
   Fenstern, Schraubenköpfen und Nachbarwort, und hält die Schrift die Regeln
   für Strich, Abstand und Inseln? Geprüft für jede Schriftgröße, die zur
   Wahl steht (parameter.SCHRIFTGROESSEN).

Aufruf über ``python -m gehaeuse pruefung``; schreibt aus/pruefung/pruefbericht.md
und gibt bei einem harten Fehler einen Rückgabewert ungleich 0.
"""
import json
import math

import numpy as np
import shapely
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

from . import entwurf, massmodell as m, passproben, platine, schrift, schriftprobe
from .ausgabe import AUS, netz
from .formen import verbund
from .logo import wortmarke
from .massmodell import zahl
from .parameter import (BAHN, DECKEL_V02, ETIKETT_DECKEL, FARBEN, FORM_V0, MIT_RESET_UND_LEDS, SCHACHT_V01,
                        SCHICHT, SCHRIFT_FEIN, SCHRIFT_V03, SCHRIFTGROESSEN, STANDARD)

# Für den Überschlag, was ein zu langer Schacht bewirkt (Biegemodul in N/mm²)
ZUGELAUFEN = 0.10     # so viel der Fläche eines Buchstabens darf aus zugelaufenen Lücken stammen
E_ASA = 1900.0        # Bambu ASA, Datenblatt: 1920 liegend, 1770 stehend gedruckt
E_PLATINE = 22000.0   # FR4, üblicher Wert
PLATINE_STREIFEN = 10.0   # Breite des Randstreifens der Platine, der sich mitbiegt (Annahme)
TOLERANZ_Z = 0.2      # Wandoberkante bis Platinenoberseite gegen die Länge des Schachts (Annahme)


# ---- 1 und 2: Durchdringung und Abstände ----------------------------------

def _schnitt(a, b):
    s = a & b
    return float(s.volume) if s else 0.0


def durchdringung(p, teile):
    """teile: {"unterteil", "deckel", "clip"} als Körper. Liefert (Zeilen, Paare, Fehler)."""
    unterteil, deckel = teile["unterteil"], teile["deckel"]
    zeilen, fehler = [], []
    for name, koerper, _ in platine.bauteile():
        zeile = {"bauteil": name}
        for gegen, k in (("unterteil", unterteil), ("deckel", deckel)):
            zeile[f"schnitt_{gegen}"] = round(_schnitt(koerper, k), 4)
            zeile[f"abstand_{gegen}"] = round(float(koerper.distance_to(k)), 3)
            if zeile[f"schnitt_{gegen}"] > 1e-3:
                fehler.append(f"{name} durchdringt {gegen}: {zeile[f'schnitt_{gegen}']} mm³")
        zeilen.append(zeile)
    paare = {
        "Deckel in Unterteil": _schnitt(deckel, unterteil),
        "Clip in Unterteil": _schnitt(teile["clip"], unterteil),
    }
    if p.wandmontage:
        schrauben = verbund(entwurf.wandschrauben(p))
        paare["Wandschrauben (in der Rast) in Unterteil"] = _schnitt(schrauben, unterteil)
        paare["Wandschrauben in Platine und Bauteilen"] = _schnitt(
            schrauben, verbund([k for _, k, _ in platine.bauteile()]))
    for name, v in paare.items():
        if v > 1e-3:
            fehler.append(f"{name}: {v:.4f} mm³")
    paare["Clip in Hutschiene (gewollt: Vorspannung des Riegels)"] = _schnitt(
        teile["clip"], entwurf.schiene(p))
    return zeilen, {k: round(v, 4) for k, v in paare.items()}, fehler


def wandmontage(p):
    """Abstände der Wandschrauben in der Rast: bis zum Innenraum, bis zur Platine."""
    if not p.wandmontage:
        return None
    schrauben = verbund(entwurf.wandschrauben(p))
    innen = entwurf.hohlraum(p, p.z_wand)
    brett = verbund([k for _, k, _ in platine.bauteile()] + [platine.unterseite_huelle()])
    return {"abstand_innenraum": round(float(schrauben.distance_to(innen)), 2),
            "abstand_platine": round(float(schrauben.distance_to(brett)), 2)}


def unterseite(p, unterteil):
    """Auflagen stehen im Raum unter der Platine, dessen Bestückung unbekannt ist."""
    raum = platine.unterseite_huelle()
    flaeche = sum((x1 - max(x0, 0.0)) * (min(y1, m.PLATINE_Y) - max(y0, 0.0))
                  for x0, x1, y0, y1 in ((a[0], min(a[1], m.PLATINE_X), a[2], a[3])
                                         for a in entwurf.auflagen(p).values()))
    flaeche += np.pi * (p.nabe_d / 2) ** 2
    return {"volumen_im_raum": round(_schnitt(raum, unterteil), 1),
            "auflageflaeche": round(float(flaeche), 1),
            "anteil": round(float(flaeche) / (m.PLATINE_X * m.PLATINE_Y) * 100, 1)}


# ---- 7: Lichtschacht ------------------------------------------------------

def _ganze_schichten(wert):
    return abs(wert / SCHICHT - round(wert / SCHICHT)) < 1e-6


def versatz(p):
    """Um so viel können Deckel und Platine seitlich gegeneinander verschoben
    sein: Spiel des Falzes plus Luft des Haltestifts im Loch."""
    return p.spiel + (m.LOCH_D - p.stift_d) / 2


def schlitze_vor_leds(p):
    """Lüftungsschlitze der LED-Seite, die vor einer LED liegen: (x0, x1, LED-Nummer)."""
    if not p.lueftung or p.laschen:
        return []
    teilung = p.schlitz + p.schlitz_steg
    x0, x1 = p.xa0 + p.schlitz_rand, p.xa1 - p.schlitz_rand
    n = int((x1 - x0 + p.schlitz_steg) / teilung)
    start = (x0 + x1) / 2 - (n * teilung - p.schlitz_steg) / 2
    aus = []
    for i in range(n):
        a = start + i * teilung
        for nr, q in enumerate(m.leds()):
            if a < q.x1 and a + p.schlitz > q.x0:
                aus.append((round(a, 2), round(a + p.schlitz, 2), nr))
    return aus


def schacht(p):
    """Zahlen zum Lichtschacht: Spalt von v0.1, Aufstandsfläche, was offen
    bleibt, und der Überschlag zur Toleranz. None ohne langen Schacht."""
    fuss = entwurf.schacht_fuss(p)
    if not fuss:
        return None
    flaeche = unary_union([box(*r) for r in fuss])
    probe = unary_union([box(*r) for r in m.schachtprobe_fuesse()])
    loet = unary_union([box(*r) for r in m.led_loetflaechen()])
    frei = box(*(float(v) for v in m.FREI_NACH_FOTO)).difference(loet)
    ry0, ry1, z_klein, z_sockel, sx0, sx1 = entwurf.schacht_rueckwand(p)
    x0, x1, ya, yb, w = entwurf.schacht_aussen(p)
    sockel, stifte = m.uart_sockel(), m.uart()
    block_ab = m.UART_HOEHE + p.led_schacht_ueber_stiften
    # Überschlag: Deckelrand als Kragarm ab den vorderen Schrauben, Platinenrand
    # als Balken zwischen den beiden Eck-Auflagen der LED-Kante
    arm = min(p.schrauben_y) - m.LED_Y
    k_deckel = 3 * E_ASA * ((p.xa1 - p.xa0) * p.deckel ** 3 / 12) / arm ** 3
    spanne = m.PLATINE_X - 2 * p.auflage_ecke
    k_platine = 48 * E_PLATINE * (PLATINE_STREIFEN * m.PLATINE_DICKE ** 3 / 12) / spanne ** 3
    k = 1 / (1 / k_deckel + 1 / k_platine)
    kraft = k * TOLERANZ_Z
    # Unter einem Restspalt s kommt nur Licht durch, das tiefer als h startet:
    # Strahl vom LED-Körper unter der Vorderwand (Abstand d, Stärke w) hindurch.
    d_vorn = m.leds()[0].y0 - (ya + w)
    start = TOLERANZ_Z * (d_vorn + w) / w
    schmal = min(min(c - a, d - b) for a, b, c, d in fuss)
    return {
        "spalt_v01": round(m.LED_HOEHE + 0.4, 2),
        "v01_ueber_led": 0.4,
        "v01_offen_bis": round(block_ab, 2),
        "schlitze_vor_leds": schlitze_vor_leds(p),
        "wand_bis_led_vorn": round(m.leds()[0].y0 - p.yi0, 2),
        "fuss": [[round(v, 3) for v in r] for r in fuss],
        "fuss_flaeche": round(flaeche.area, 2),
        "fuss_frei_nach_foto": bool(frei.buffer(1e-6).contains(flaeche)),
        "anteil_probe": round(100 * flaeche.intersection(probe).area / flaeche.area, 0),
        "abstand_loetflaechen": round(flaeche.distance(loet), 3),
        "abstand_led_vorn": round(d_vorn, 3),
        "versatz": round(versatz(p), 2),
        "luft": p.led_schacht_luft,
        "fuss_hoch": p.led_schacht_fuss,
        "fuss_schmal": round(schmal, 3),
        "rueckwand": [round(ry0, 3), round(ry1, 3)],
        "rueckwand_ab_klein": round(z_klein, 2),
        "rueckwand_ab_sockel": round(z_sockel, 2),
        "rueckwand_bis_stifte": round(stifte.y0 - ry1, 3),
        "luft_ueber_sockel": round(z_sockel - sockel.z1, 2),
        "luft_ueber_klein": round(z_klein - max(m.KLEINTEILE_HOEHE, m.LED_HOEHE), 2),
        "kanal_vor_sockel": round(m.UART_SOCKEL_VORN - ry0, 3),
        "sockel_x": [round(sx0, 2), round(sx1, 2)],
        "schacht_x": [round(x0, 2), round(x1, 2)],
        "toleranz_z": TOLERANZ_Z,
        "k_deckel": round(k_deckel, 1), "k_platine": round(k_platine, 1), "k": round(k, 1),
        "kraft": round(kraft, 1),
        "deckel_hebt": round(kraft / k_deckel, 2), "platine_biegt": round(kraft / k_platine, 2),
        "pressung": round(kraft / flaeche.area, 2),
        "restspalt_start": round(start, 2),
    }


# ---- 8: Beschriftung ------------------------------------------------------

def sichtflaeche(p):
    """Die ebene Sichtfläche des Deckels innerhalb der Fase und was auf ihr
    schon liegt: (Fläche, {Name: Fläche})."""
    r = p.eckradius
    flach = box(p.xa0 + r, p.ya0 + r, p.xa1 - r, p.ya1 - r).buffer(r).buffer(-p.fase)
    belegt = {"Schraubenkopf": unary_union([Point(x, y).buffer(p.schraube_kopf_d / 2) for x, y in p.dome])}
    if p.led_anzeige != "keine":
        bx, by = p.led_oeffnung
        belegt["LED-Fenster"] = unary_union([box(x - bx / 2, m.LED_Y - by / 2, x + bx / 2, m.LED_Y + by / 2)
                                             for x in m.LED_X])
    rahmen = [f.bounding_box() for teil in wortmarke(p.logo_breite, entwurf._logo_mitte(p),
                                                      p.logo_drehung).values() for f in teil]
    belegt["Logo"] = unary_union([box(b.min.X, b.min.Y, b.max.X, b.max.Y) for b in rahmen])
    if p.etikett == "deckel":
        b = entwurf.etikettfeld(p).bounding_box()
        belegt["Etikettfeld"] = box(b.min.X, b.min.Y, b.max.X, b.max.Y)
    return flach, belegt


def beschriftung(p):
    """Zahlen zur Beschriftung des Deckels; None, wenn er keine trägt."""
    schilder = entwurf.beschriftung(p)
    if not schilder:
        return None
    flach, belegt = sichtflaeche(p)
    zeilen = []
    for s in schilder:
        was, abstand = min(((n, g.distance(s.form)) for n, g in belegt.items()), key=lambda e: e[1])
        andere = [(o.form.distance(s.form), o.text) for o in schilder if o is not s]
        nachbar = min(andere) if andere else (float("inf"), "")
        zu = [z["zeichen"] for z in s.zeichen if z["geschlossen"] or z["zugelaufen"] > ZUGELAUFEN]
        mitte = s.wort.centroid if s.zeiger is None else box(*s.wort.bounds).centroid
        versatz = abs(mitte.y - s.ziel[1]) if s.kante == "usb" else abs(mitte.x - s.ziel[0])
        zeilen.append({
            "name": s.name, "text": s.text, "teil": s.teil, "kante": s.kante,
            "rahmen": [round(v, 2) for v in s.form.bounds],
            "rand": round(flach.exterior.distance(s.form), 2) if flach.contains(s.form) else -1.0,
            "belegt_was": was, "belegt": round(abstand, 2),
            "nachbar": nachbar[1], "nachbar_abstand": round(min(nachbar[0], 99.0), 2),
            "versatz": round(versatz, 3), "zugelaufen": round(100 * s.zugelaufen, 1),
            "zugelaufen_zeichen": round(100 * max(z["zugelaufen"] for z in s.zeichen), 1),
            "geschlossen": zu,
            "insel": round(min(g.area for g in schrift.vielecke(s.form)), 2),
            "laenge": round(s.laenge, 1), "flaeche": round(s.form.area, 1)})
    tiefe = p.einlage if p.beschriftung == "eingelegt" else p.beschriftung_tiefe
    return {"art": p.beschriftung, "hoehe": p.schrift_hoehe, "strich": p.schrift_strich,
            "form": p.schrift_form, "wandgenerator": p.wandgenerator,
            "luft": p.schrift_luft, "tiefe": tiefe, "farbe": p.beschriftung_farbe,
            "querstriche": round((p.schrift_hoehe - 3 * p.schrift_strich) / 2, 3),
            "kleinste_hoehe": round(schrift.kleinste_hoehe(p.schrift_strich, p.schrift_abstand), 2),
            "insel": min(z["insel"] for z in zeilen),
            "breite": {z["name"]: round(z["rahmen"][2] - z["rahmen"][0], 2) for z in zeilen},
            "frei": min(min(z["belegt"], z["nachbar_abstand"]) for z in zeilen),
            "rand": min(z["rand"] for z in zeilen),
            "versatz": max(z["versatz"] for z in zeilen),
            "geschlossen": [f"{c} in {z['text']}" for z in zeilen for c in z["geschlossen"]],
            "flaeche": round(sum(z["flaeche"] for z in zeilen), 1),
            "zeilen": zeilen}


def _beschriftung_regeln(p):
    b = beschriftung(p)
    if not b:
        return []
    e = 1e-9
    # Mit den Wänden "klassisch" fährt der Slicer um jeden Strich eine Schleife: Der Strich
    # braucht zwei Bahnen. Eine einzelne Bahn (docs/regeln.md: Strich mindestens 0,45 mm) fährt
    # nur Arachne, und dort am saubersten, wenn sie nicht breiter ist als die Bahn der
    # ersten Schicht.
    if p.wandgenerator == "arachne":
        strich = ("Beschriftung: Strich der Schrift (Wandgenerator Arachne)",
                  "eine Bahn: 0,45 bis 0,5 mm, oder mindestens 2 Bahnen (0,84)", b["strich"],
                  0.45 - e <= b["strich"] <= 0.5 + e or b["strich"] >= 2 * BAHN - e)
    else:
        strich = ("Beschriftung: Strich der Schrift (Wände \"klassisch\")", "mindestens 2 Bahnen (0,84)",
                  b["strich"], b["strich"] >= 2 * BAHN - e)
    return [
        strich,
        ("Beschriftung: Weiß zwischen zwei Buchstaben", "mindestens 0,6 mm (docs/regeln.md)", b["luft"],
         b["luft"] >= 0.6 - e),
        ("Beschriftung: Weiß zwischen drei Querstrichen (B, S, 5)", "mindestens 0,6 mm (docs/regeln.md)",
         b["querstriche"], b["querstriche"] >= 0.6 - e),
        ("Beschriftung: kein Buchstabe läuft zu",
         f"jede Öffnung bleibt, je Buchstabe höchstens {zahl(100 * ZUGELAUFEN)} % der Fläche gefüllt",
         f"ja (höchstens {zahl(max(z['zugelaufen_zeichen'] for z in b['zeilen']))} %)" if not b["geschlossen"]
         else "nein: " + ", ".join(b["geschlossen"]), not b["geschlossen"]),
        ("Beschriftung: kleinste schwarze Insel (Buchstabe oder Dreieck)",
         f"mindestens {zahl(p.insel_min)} mm² (das Dreieck von v0.3)", b["insel"], b["insel"] >= p.insel_min - e),
        ("Beschriftung: Tiefe in ganzen Schichten", "Vielfaches von 0,2 mm", b["tiefe"],
         b["tiefe"] > 0 and _ganze_schichten(b["tiefe"])),
        ("Beschriftung: Farbe ist ein Farbplatz des Logos", "schrift_schwarz oder zeichen_hellblau",
         b["farbe"], b["farbe"] in FARBEN and b["farbe"] != "gehaeuse_weiss"),
        ("Beschriftung: jedes Wort mittig vor seinem Anschluss", "Versatz 0", b["versatz"],
         b["versatz"] < 0.01),
        ("Beschriftung: frei von Logo, Fenstern, Schraubenköpfen, Etikettfeld und Nachbarwort",
         f"mindestens {zahl(p.beschriftung_frei)} mm", b["frei"], b["frei"] >= p.beschriftung_frei - e),
        ("Beschriftung: auf der ebenen Sichtfläche, Abstand zur Fase der Kante",
         "mindestens 2 Bahnen (0,84)", b["rand"], b["rand"] >= 2 * BAHN - e),
    ]


# ---- 3: Regeln ------------------------------------------------------------

def regeln(p):
    """Liste (Regel, Soll, Ist, erfüllt)."""
    tasche = entwurf.schalter_tasche(p)
    knopf = m.schalter_knopf()
    kanal = entwurf.kanal_schalter(p)
    dome_y = min(y for _, y in p.dome)
    ant = m.antennen()
    lasche_x = p.laschenloecher[0][0]
    haken_tiefe = 5.0
    # Säulen an der USB-Seite neben den Öffnungen dieser Wand
    u = m.usba()
    senkung = ((u.y0 + u.y1) / 2 - p.usba_griff[0] / 2, (u.y0 + u.y1) / 2 + p.usba_griff[0] / 2)
    saeulen = sorted(set(p.schrauben_y))
    saeule_usba = min(max(senkung[0] - (y + p.dom_radius), (y - p.dom_radius) - senkung[1])
                      for y in saeulen)
    saeule_reset = min(abs(y - m.RESET_Y) - p.dom_radius - p.reset_loch / 2 for y in saeulen)
    wand, unten, laschen = [], [], []
    if p.wandmontage:
        kopf_y = p.wand_y - p.wand_kopf_d / 2
        auflage = (p.wand_kopf_d - p.wand_schlitz) / 2
        xk = [x for x, _ in p.wandschrauben]
        rand = min(xk) - p.wand_einstieg_d / 2 - (p.xa0 + p.fase_unten)
        wand = [
            ("Wandschrauben weg von den Antennen", "Kopf ganz bei y über 25", kopf_y, kopf_y > 25.0),
            ("Wandschraube: Auflage des Kopfes auf der Lippe", "mindestens 1,5 mm je Seite", auflage,
             auflage >= 1.5),
            ("Lippe zwischen Schraubenkopf und Wand", "mindestens 1,6 mm (8 Schichten)", p.wand_lippe,
             p.wand_lippe >= 1.6),
            ("Boden zwischen Schraubentasche und Innenraum", "geschlossen, mindestens 1,0 mm",
             p.wand_decke, 1.0 <= p.wand_decke <= p.boden),
            ("Luft über dem Schraubenkopf in der Tasche", "mindestens 0,3 mm", p.wand_kopf_luft,
             p.wand_kopf_luft >= 0.3),
            ("Einsetzöffnung bis zur Fase der Standfläche", "mindestens 2 mm", round(rand, 2),
             rand >= 2.0),
        ]
        if p.fuesse:
            steg = min(math.hypot(xf - x, yf - (y + p.wand_hub)) - p.fuss_d / 2 - p.wand_einstieg_d / 2
                       for xf, yf in p.fussmulden for x, y in p.wandschrauben)
            wand.append(("Steg zwischen Einsetzöffnung und Fußmulde", "mindestens 2 Bahnen (0,84)",
                         round(steg, 2), steg >= 2 * BAHN))
    if p.fuesse:
        unten.append(("Fußmulde in ganzen Schichten", "Vielfaches von 0,2 mm", p.fuss_tiefe,
                      abs(p.fuss_tiefe / SCHICHT - round(p.fuss_tiefe / SCHICHT)) < 1e-6))
        unten.append(("Boden unter der Fußmulde", "mindestens 1,0 mm",
                      round(p.boden + p.sockel - p.fuss_tiefe, 2), p.boden + p.sockel - p.fuss_tiefe >= 1.0))
    if p.etikett == "unterseite":
        x0, x1, y0, y1 = entwurf.etikett_unten(p)
        frei = [x0 - (p.xa0 + p.fase_unten), (p.xa1 - p.fase_unten) - x1]
        if p.fuesse:
            frei += [y0 - (p.fussmulden[0][1] + p.fuss_d / 2)]
        if p.wandmontage:
            frei += [p.wand_y - p.wand_schlitz / 2 - y1]
        unten.append(("Etikettfeld frei von Fase, Mulden und Schlüssellöchern", "mindestens 1,0 mm",
                      round(min(frei), 2), min(frei) >= 1.0))
    if p.laschen:
        laschen = [
            ("Laschenschraube zwischen den Antennenflächen",
             f"x zwischen {zahl(ant[0][2])} und {zahl(ant[1][0])}", round(lasche_x, 2),
             ant[0][2] < lasche_x < ant[1][0]),
            ("Lasche: Breite", "mindestens 5 mm", p.lasche_breite, p.lasche_breite >= 5.0),
            ("Lasche: Dicke", "3 mm", p.lasche_dicke, p.lasche_dicke >= 3.0),
            ("Lasche: Loch für 4-mm-Schraube", "4,3 bis 4,5 mm, Langloch", p.lasche_loch,
             4.3 <= p.lasche_loch <= 4.5 and p.lasche_langloch > 0),
        ]
    lang, sch = [], schacht(p)
    if sch:
        lang = [
            ("Lichtschacht: Fuß über der Platinenoberseite", "0 (liegt auf) oder ganze Schichten",
             p.led_schacht_luft, p.led_schacht_luft >= 0 and _ganze_schichten(p.led_schacht_luft)),
            ("Lichtschacht: schmalste Wand am Fuß", "mindestens 2 Bahnen (0,84)", sch["fuss_schmal"],
             sch["fuss_schmal"] >= 2 * BAHN - 1e-9),
            ("Lichtschacht: weitere Öffnung am Fuß", "ganze Schichten hoch", p.led_schacht_fuss,
             p.led_schacht_fuss > 0 and _ganze_schichten(p.led_schacht_fuss)),
            ("Lichtschacht: Fuß steht nur, wo die Platine nach dem Herstellerfoto frei ist", "ja",
             "ja" if sch["fuss_frei_nach_foto"] else "nein", sch["fuss_frei_nach_foto"]),
            ("Lichtschacht: Fuß bis zu den Lötflächen der LEDs",
             f"mindestens {zahl(sch['versatz'])} mm (so weit können Deckel und Platine versetzt sein)",
             min(sch["abstand_loetflaechen"], sch["abstand_led_vorn"]),
             min(sch["abstand_loetflaechen"], sch["abstand_led_vorn"]) >= sch["versatz"]),
            ("Lichtschacht: Rückwand vor den Stiften", f"mindestens {zahl(sch['versatz'])} mm",
             sch["rueckwand_bis_stifte"], sch["rueckwand_bis_stifte"] >= sch["versatz"]),
            ("Lichtschacht: Rückwand über dem Sockel der Stiftleiste (Höhe ungeprüft)",
             "mindestens 0,4 mm", sch["luft_ueber_sockel"], sch["luft_ueber_sockel"] >= 0.4),
            ("Lichtschacht: Rückwand über LEDs und kleinen Bauteilen (Höhen ungeprüft)",
             "mindestens 0,2 mm", sch["luft_ueber_klein"], sch["luft_ueber_klein"] >= 0.2),
            ("Lichtschacht: Rückwand", "mindestens 2 Bahnen (0,84)", p.led_schacht_rueckwand,
             p.led_schacht_rueckwand >= 2 * BAHN - 1e-9),
        ]
    r = [
        ("Gehäusewand", "2,0 mm", p.wand, p.wand >= 2.0),
        ("Boden", "2,0 mm", p.boden, p.boden >= 2.0),
        ("Deckel", "2,0 mm, davon 0,6 mm Einlage", p.deckel, p.deckel >= 2.0 and p.einlage == 0.6),
        ("Weiß hinter der Einlage", "mindestens 1,0 mm", p.deckel - p.einlage,
         p.deckel - p.einlage >= 1.0),
        ("Einlage in ganzen Schichten", "3 x 0,2 mm", p.einlage, abs(p.einlage / SCHICHT - 3) < 1e-6),
        ("Wand in der Griffsenkung", "mindestens 2 Bahnen (0,84)", p.senkung_rest,
         p.senkung_rest >= 2 * BAHN - 1e-9),
        ("Wand am Schalterkanal", "mindestens 2 Bahnen (0,84)", p.wand - tasche,
         p.wand - tasche >= 2 * BAHN - 1e-9),
        ("Wand am Kanal des Reset-Stößels", "mindestens 2 Bahnen (0,84)",
         p.wand - entwurf.reset_tasche(p), p.wand - entwurf.reset_tasche(p) >= 2 * BAHN - 1e-9),
        ("Luft Platine–Wand, LED-Kante", "0,5 mm", p.luft_led, p.luft_led >= 0.5),
        ("Luft Platine–Wand, freie Kante", "0,5 mm", p.luft_frei, p.luft_frei >= 0.5),
        ("Luft Platine–Wand, USB-Kante (Bezugsseite)", "0,2 bis 0,5 mm", p.luft_usb,
         0.2 <= p.luft_usb <= 0.5),
        ("Luft Platine–Anschlagrippen, Netzwerk-Kante", "0,2 bis 0,5 mm", p.anschlag_luft,
         0.2 <= p.anschlag_luft <= 0.5),
        ("Luft unter dem tiefsten Punkt der Unterseite", "mindestens 0,5 mm", p.luft_unten,
         p.luft_unten >= 0.5),
        ("Luft über dem höchsten Bauteil (USB-A)", "mindestens 0,5 mm", p.luft_oben,
         p.luft_oben >= 0.5),
        ("Luft um den Körper der Buchsen", "0,5 mm; für den Stecker die Griffsenkung",
         p.oeffnung_luft, p.oeffnung_luft >= 0.5),
        ("Schalterknopf: Raum für beide Stellungen, auch wenn die zweite bei 19,5 läge",
         f"y {zahl(knopf.y0)} bis {zahl(knopf.y1)}, Höhe bis {zahl(knopf.z1)}",
         f"Kanal y {zahl(kanal[0])} bis {zahl(kanal[1])}, über die ganze Wandhöhe",
         kanal[0] < min(knopf.y0, 19.5 - m.SCHALTER_KNOPF_BREITE / 2) and kanal[1] > knopf.y1),
        ("Spiel gedruckt in gedruckt (Falz, Zungen)", "0,2 bis 0,3 mm", p.spiel,
         0.2 <= p.spiel <= 0.3),
        ("Falz", "1,5 mm", p.falz, p.falz >= 1.5),
        ("Haltestift im Loch", f"Loch {zahl(m.LOCH_D)} mm, je Seite 0,15 bis 0,3 Luft", p.stift_d,
         0.15 <= (m.LOCH_D - p.stift_d) / 2 <= 0.3),
        ("Kernloch der Schraube", "0,84 x Durchmesser", round(0.84 * p.schraube_d, 2), True),
        ("Dom außen", "2 x Schraubendurchmesser", 2 * p.dom_radius,
         2 * p.dom_radius >= 2 * p.schraube_d),
        ("Einschraubtiefe", "mindestens 2 x Durchmesser", p.schraube_tiefe,
         p.schraube_tiefe >= 2 * p.schraube_d),
        ("Rand um die Kopfsenkung im Deckel", "mindestens 1,0 mm",
         p.dom_radius - p.schraube_kopf_d / 2, p.dom_radius - p.schraube_kopf_d / 2 >= 1.0 - 1e-9),
        ("Deckel unter dem Schraubenkopf", "mindestens 1,0 mm",
         round(p.deckel - (p.schraube_kopf_d - p.schraube_d - 0.4) / 2, 2),
         p.deckel - (p.schraube_kopf_d - p.schraube_d - 0.4) / 2 >= 1.0 - 1e-9),
        ("Schrauben weg von den Antennen", "y über 25", dome_y, dome_y > 25.0),
        ("Säule frei von der Griffsenkung des USB-A", "mindestens 0,5 mm daneben",
         round(saeule_usba, 2), saeule_usba >= 0.5),
        ("Säule frei vom Loch für den Reset", "mindestens 0,3 mm daneben",
         round(saeule_reset, 2), saeule_reset >= 0.3),
        *wand, *unten, *laschen,
        ("Lüftungsschlitz", "unter 2,5 mm", p.schlitz, p.schlitz < 2.5),
        ("Steg zwischen Schlitzen", "mindestens 0,84 mm", p.schlitz_steg, p.schlitz_steg >= 0.84),
        ("LED-Fenster in ganzen Schichten", "Vielfaches von 0,2 mm", p.led_fenster,
         abs(p.led_fenster / SCHICHT - round(p.led_fenster / SCHICHT)) < 1e-6),
        ("Lichtschacht vor der Stiftleiste (Sockel bei rund 3,2, nicht gemessen)", "mindestens 0,3 mm",
         round(m.UART_SOCKEL_VORN - entwurf.schacht_hinten(p), 3),
         m.UART_SOCKEL_VORN - entwurf.schacht_hinten(p) >= 0.3),
        ("Lichtschacht, wenn der Sockel bei 2,9 beginnt (Platine ganz an der LED-Wand)", "frei",
         round(2.9 - entwurf.schacht_hinten(p), 3), 2.9 - entwurf.schacht_hinten(p) > 0.1),
        ("Schachtwand reicht hinter die LED", "mindestens bis zu ihrer Hinterkante",
         p.led_schacht_hinter_led, p.led_schacht_hinter_led >= 0),
        *lang,
        *_beschriftung_regeln(p),
        ("Clip: Dicke hinter der Schienenkante", "höchstens 7 mm", haken_tiefe, haken_tiefe <= 7.0),
        ("Clip: Haken greift Kanten von 1,0 und 1,5 mm", "Spalt mindestens 1,5 mm",
         p.schiene_kante + p.haken_hinterschnitt, p.schiene_kante + p.haken_hinterschnitt >= 1.5),
        ("Clip: Einschraubtiefe in der Säule", "mindestens 2 x Durchmesser",
         p.schraube_laenge - p.clip_platte, p.schraube_laenge - p.clip_platte >= 2 * p.schraube_d),
        ("Clip: Kernloch tiefer als die Schraube", "mindestens 0,5 mm",
         p.clip_loch_tiefe - (p.schraube_laenge - p.clip_platte),
         p.clip_loch_tiefe - (p.schraube_laenge - p.clip_platte) >= 0.5),
        ("Säule: Kunststoff zwischen den Kernlöchern von oben und von unten", "mindestens 2 mm",
         round(p.z_wand - p.schraube_tiefe - (p.z_rueck + p.clip_loch_tiefe), 2),
         p.z_wand - p.schraube_tiefe - (p.z_rueck + p.clip_loch_tiefe) >= 2.0),
        ("Gesamttiefe auf der Schiene", "höchstens 40 mm",
         round(p.z_deckel - p.z_rueck + p.clip_platte + p.schiene_tiefe, 1),
         p.z_deckel - p.z_rueck + p.clip_platte + p.schiene_tiefe <= 40.0),
        ("Breite entlang der Schiene", "höchstens 3,5 TE (63 mm)",
         round(p.xa1 - p.xa0 + 2 * (p.dom_radius + p.dom_versatz), 2),
         p.xa1 - p.xa0 + 2 * (p.dom_radius + p.dom_versatz) <= 63.0),
        ("Federarm: Randdehnung bei vollem Hub", "unter 1,5 %",
         zahl(150 * p.feder_dicke * p.feder_weg / p.feder_laenge ** 2) + " %",
         1.5 * p.feder_dicke * p.feder_weg / p.feder_laenge ** 2 < 0.015),
    ]
    return [(a, b, zahl(c) if isinstance(c, (int, float)) else c, bool(d)) for a, b, c, d in r]


# ---- 4: Stege je Druckschicht ---------------------------------------------

def scheibe(ecken, dreiecke, z):
    """Schnitt des Netzes mit der Ebene z als shapely-Fläche (gerade/ungerade)."""
    s = ecken[:, 2] - z
    oben = (s > 0)[dreiecke]
    quer = (oben.sum(1) % 3) != 0
    d, o = dreiecke[quer], oben[quer]
    punkte = np.full((len(d), 3, 2), np.nan)
    for k, (i, j) in enumerate(((0, 1), (1, 2), (2, 0))):
        kreuzt = o[:, i] != o[:, j]
        a, b = np.minimum(d[:, i], d[:, j]), np.maximum(d[:, i], d[:, j])   # je Kante gleiche Rechnung
        a, b = a[kreuzt], b[kreuzt]
        w = (s[a] / (s[a] - s[b]))[:, None]
        punkte[kreuzt, k] = ecken[a, :2] + w * (ecken[b, :2] - ecken[a, :2])
    strecken = punkte[~np.isnan(punkte[:, :, 0])].reshape(-1, 2, 2)
    if not len(strecken):
        return Polygon()
    linien = shapely.line_merge(shapely.multilinestrings([shapely.linestrings(strecken)]))[0]
    ringe = [Polygon(g.coords) for g in shapely.get_parts(linien) if g.is_ring]
    form = Polygon()
    for ring in sorted(ringe, key=lambda r: -r.area):   # Ring im Ring ist ein Loch
        form = form.symmetric_difference(ring.buffer(0))
    return form


def duenne_stellen(form, breite):
    """Teile der Fläche, die schmaler sind als ``breite`` (eine Scheibe dieses
    Durchmessers passt nicht hinein). Stege, die genau ``breite`` messen,
    zählen nicht; kleine Zwickel an Ecken werden übergangen."""
    r = (breite - 0.02) / 2
    kern = form.buffer(-r, join_style="mitre")
    rest = form.difference(kern.buffer(r + 1e-3, join_style="mitre"))
    teile = list(rest.geoms) if hasattr(rest, "geoms") else [rest]
    return [t for t in teile if t.area > 0.3 * breite ** 2 and _staerke(t) > 0.1]


def _staerke(t):
    """Schmale Seite eines Rechtecks gleicher Fläche und gleichen Umfangs."""
    u, a = t.length, t.area
    return (u / 2 - max(u * u / 4 - 4 * a, 0.0) ** 0.5) / 2


def stege(ecken, dreiecke, breiten=(BAHN, 2 * BAHN)):
    """Sucht über alle Druckschichten Stellen, die schmaler sind als ``breiten``.

    Rückgabe: {breite: [Stelle]} mit Stelle = dict(z0, z1, x, y, laenge, staerke).
    Stellen, die schon bei der kleineren Breite gemeldet sind, fehlen bei der größeren.
    """
    z0, z1 = ecken[:, 2].min(), ecken[:, 2].max()
    hoehen = np.arange(z0 + SCHICHT / 2, z1, SCHICHT) + 1e-4
    funde = {b: [] for b in breiten}
    for z in hoehen:
        form = scheibe(ecken, dreiecke, z)
        schon = []
        for b in sorted(breiten):
            for t in duenne_stellen(form, b):
                if any(t.intersection(s).area > 0.5 * t.area for s in schon):
                    continue
                c = t.representative_point()
                funde[b].append({"z": float(z), "x": c.x, "y": c.y, "flaeche": t.area,
                                 "staerke": _staerke(t),
                                 "laenge": max(t.bounds[2] - t.bounds[0], t.bounds[3] - t.bounds[1])})
                schon.append(t)
    return {b: _buendeln(f) for b, f in funde.items()}


def _buendeln(funde, naehe=1.5):
    """Fasst Funde zusammen, die in aufeinanderfolgenden Schichten übereinander liegen."""
    gruppen = []
    for f in funde:
        for g in gruppen:
            if (abs(g["x"] - f["x"]) < naehe and abs(g["y"] - f["y"]) < naehe
                    and f["z"] - g["z1"] < 1.5 * SCHICHT + 1e-6):
                g["z1"] = f["z"]
                g["staerke"] = min(g["staerke"], f["staerke"])
                g["laenge"] = max(g["laenge"], f["laenge"])
                break
        else:
            gruppen.append({"x": f["x"], "y": f["y"], "z0": f["z"], "z1": f["z"],
                            "staerke": f["staerke"], "laenge": f["laenge"]})
    return gruppen


# ---- 5: Logo --------------------------------------------------------------

def logo_grenzen(p):
    """Kleinster Abstand zwischen den Einlagen und Flächenanteil, den eine Bahn
    von 0,42 mm nicht füllt (docs/regeln.md: Strich mindestens 0,45, Abstand 0,6)."""
    aus = {}
    koerper = entwurf.deckel(p.mit(beschriftung="keine"))   # nur das Logo; die Beschriftung: Abschnitt 8
    z = p.z_deckel - p.einlage / 2
    formen = {}
    for name in ("schrift_schwarz", "zeichen_hellblau"):
        e, d = netz(koerper[name], 0.01, 0.2)
        form = scheibe(e, d, z)
        formen[name] = form
        kern = form.buffer(-BAHN / 2).buffer(BAHN / 2)
        aus[name] = {"flaeche": round(form.area, 1),
                     "verlust_prozent": round(100 * (1 - kern.area / form.area), 1)}
    teile = [t for f in formen.values() for t in (f.geoms if hasattr(f, "geoms") else [f])]
    aus["kleinster_abstand"] = round(min(a.distance(b) for i, a in enumerate(teile)
                                         for b in teile[i + 1:]), 2)
    rand = unary_union(teile).bounds
    aus["rand_zum_deckel"] = round(min(rand[0] - p.xa0, p.xa1 - rand[2]), 2)
    return aus


# ---- 6: Stellgrößen -------------------------------------------------------

VARIANTEN = {
    "geschlossen, ohne LED-Anzeige": {"lueftung": False, "led_anzeige": "keine"},
    "LEDs als offene Löcher": {"led_anzeige": "offen"},
    "LED-Fenster ohne Schacht": {"led_schacht": False},
    "Etikett auf dem Deckel (dann ohne Beschriftung an der USB-Seite)": ETIKETT_DECKEL,
    "Etikett an der freien Seite": {"etikett": "seite"},
    "nur liegend: ohne Sockel und Schlüssellöcher": {"wandmontage": False},
    "Form v0: Schraublaschen, kein Sockel": FORM_V0,
    "Lichtschacht wie v0.1: endet über den LEDs": SCHACHT_V01,
    "Lichtschacht eine Schicht kürzer": {"led_schacht_luft": 0.2},
    "alles in PETG": {"material": "petg"},
    "Schrift wie v0.3: 4,5 mm hoch, Zeichen von damals": SCHRIFT_V03,
    "Schrift fein: 3,0 mm hoch, Strich eine Bahn, Wandgenerator Arachne": SCHRIFT_FEIN,
    "abgewählter Vorschlag von v0.3: dazu Reset und LEDs": MIT_RESET_UND_LEDS,
    "Beschriftung vertieft statt eingelegt": {"beschriftung": "vertieft"},
    "Beschriftung erhaben (in dieser Drucklage nicht druckbar)": {"beschriftung": "erhaben"},
    "Deckel v0.2: ohne Beschriftung": DECKEL_V02,
}


def stellgroessen(p):
    """Baut den Entwurf mit anderen Stellgrößen und prüft, dass er heil bleibt."""
    brett = verbund([k for _, k, _ in platine.bauteile()])
    zeilen = []
    for name, aenderung in VARIANTEN.items():
        q = p.mit(**aenderung)
        unten, oben = entwurf.unterteil(q), entwurf.deckel(q)["gehaeuse_weiss"]
        ok = (len(unten.solids()) == 1 and len(oben.solids()) == 1 and unten.is_valid
              and oben.is_valid)
        schnitt = _schnitt(brett, unten) + _schnitt(brett, oben) + _schnitt(oben, unten)
        b = beschriftung(q)
        frei = b is None or (b["frei"] >= q.beschriftung_frei - 1e-9 and b["rand"] >= 2 * BAHN - 1e-9
                             and not b["geschlossen"])
        zeilen.append({"variante": name, "aenderung": aenderung, "ein_koerper": bool(ok),
                       "beschriftung_frei": bool(frei),
                       "schnitt": round(schnitt, 4), "volumen_unterteil": round(unten.volume, 0),
                       "volumen_deckel": round(oben.volume, 0)})
    return zeilen


# ---- Bericht --------------------------------------------------------------

def _stege_md(name, funde):
    zeilen = []
    for breite, stellen in sorted(funde.items()):
        if not stellen:
            zeilen.append(f"- **{name}**, schmaler als {zahl(breite)} mm: keine Stelle")
            continue
        zeilen.append(f"- **{name}**, schmaler als {zahl(breite)} mm: {len(stellen)} Stelle(n)")
        for s in sorted(stellen, key=lambda s: s["staerke"])[:12]:
            zeilen.append(f"  - bei x {zahl(s['x'])}, y {zahl(s['y'])}, z {zahl(s['z0'])} bis "
                          f"{zahl(s['z1'])}: rund {zahl(s['staerke'])} mm stark, "
                          f"{zahl(s['laenge'])} mm lang")
    return zeilen


def _schacht_md(sch):
    if not sch:
        return ["Der Schacht reicht in diesem Stand nicht bis auf die Platine.", ""]
    return [
        f"- **Fuß:** Der Schacht steht mit {zahl(sch['fuss_flaeche'])} mm² auf der Platine, im Nennmaß "
        f"{zahl(sch['luft'])} mm darüber; die schmalste Wand ist dort {zahl(sch['fuss_schmal'])} mm. Auf den "
        f"untersten {zahl(sch['fuss_hoch'])} mm sind die Öffnungen je Seite {zahl(BAHN)} mm weiter. "
        f"Nach dem Herstellerfoto ist die Platine dort überall frei; {zahl(sch['anteil_probe'])} % der "
        "Fläche liegen dort, wo schon die Füße der Schachtprobe standen (\"stehen auf freier Platine\").",
        f"- **Abstand zu den LEDs:** {zahl(sch['abstand_loetflaechen'])} mm bis zu den Lötflächen, "
        f"{zahl(sch['abstand_led_vorn'])} mm vor den LEDs; Deckel und Platine können um "
        f"{zahl(sch['versatz'])} mm gegeneinander versetzt sein.",
        f"- **Rückwand:** y {zahl(sch['rueckwand'][0])} bis {zahl(sch['rueckwand'][1])}, "
        f"{zahl(sch['rueckwand_bis_stifte'])} mm vor den Stiften. Sie beginnt {zahl(sch['rueckwand_ab_sockel'])} mm "
        f"über der Platine, wo der Sockel steht (x {zahl(sch['sockel_x'][0])} bis {zahl(sch['sockel_x'][1])}), "
        f"sonst {zahl(sch['rueckwand_ab_klein'])} mm.",
        f"- **Offen bleibt:** vor dem Sockel ein Kanal von {zahl(sch['kanal_vor_sockel'])} mm (Lage des "
        f"Sockels abgeleitet) bis {zahl(sch['rueckwand_ab_sockel'])} mm Höhe, davon "
        f"{zahl(sch['luft_ueber_sockel'])} mm über dem Sockel; hinter der Power-LED und am äußeren "
        f"Rand der WLAN-LED ein Schlitz von {zahl(sch['rueckwand_ab_klein'])} mm Höhe.",
        f"- **Zu lang um {zahl(sch['toleranz_z'])} mm (Überschlag):** Deckelrand "
        f"{zahl(sch['k_deckel'])} N/mm, Platinenrand {zahl(sch['k_platine'])} N/mm, zusammen "
        f"{zahl(sch['k'])} N/mm: rund {zahl(sch['kraft'])} N. Der Deckelrand hebt sich um "
        f"{zahl(sch['deckel_hebt'])} mm, die Platine biegt sich um {zahl(sch['platine_biegt'])} mm. "
        f"Der Fuß trägt dabei {zahl(sch['pressung'])} N/mm² und gibt selbst nicht nach.",
        f"- **Zu kurz um {zahl(sch['toleranz_z'])} mm:** Unter dem Restspalt kommt nur Licht durch, das "
        f"tiefer als {zahl(sch['restspalt_start'])} mm über der Platine startet.",
        f"- **Vorher (v0.1):** Der Schacht endete {zahl(sch['spalt_v01'])} mm über der Platine, "
        f"{zahl(sch['v01_ueber_led'])} mm über den LEDs, und war hinten bis {zahl(sch['v01_offen_bis'])} mm "
        f"offen. Vor jeder LED liegt ein Lüftungsschlitz der LED-Seite "
        f"({', '.join(f'x {zahl(a)} bis {zahl(b)}' for a, b, _ in sch['schlitze_vor_leds'])}), "
        f"{zahl(sch['wand_bis_led_vorn'])} mm vor ihrer Vorderkante.", ""]


def _beschriftung_md(b, p):
    if not b:
        return ["Der Deckel trägt in diesem Stand keine Beschriftung.", ""]
    art = {"eingelegt": f"eingelegt in `{b['farbe']}`, {zahl(b['tiefe'])} mm tief (dieselben Schichten wie das Logo)",
           "vertieft": f"vertieft, {zahl(b['tiefe'])} mm tief, in der Gehäusefarbe",
           "erhaben": f"erhaben, {zahl(b['tiefe'])} mm hoch"}[b["art"]]
    kante = {"netzwerk": "Netzwerk-Seite", "usb": "USB-Seite", "led": "unter dem LED-Fenster"}
    bahnen = "zwei Bahnen" if b["strich"] >= 2 * BAHN - 1e-9 else "eine Bahn"
    md = [f"Schrift {zahl(b['hoehe'])} mm hoch (kleinste Höhe bei diesem Strich: {zahl(b['kleinste_hoehe'])} mm), "
          f"Strich {zahl(b['strich'])} mm ({bahnen}), Zeichenformen „{b['form']}“, Wandgenerator "
          f"„{b['wandgenerator']}“, {zahl(b['luft'])} mm zwischen den Buchstaben; {art}. Lücken unter "
          f"{zahl(p.schrift_abstand)} mm zwischen Strichen sind gefüllt. Kleinste schwarze Insel: "
          f"{zahl(b['insel'])} mm². Die Wörter stehen wie das Logo (Netzwerk-Seite unten). "
          "Koordinaten wie im Maßmodell.", "",
          "| Wort | beschriftet | Kante | Rahmen x | Rahmen y | bis zur Fase der Kante | nächste Fläche "
          "| nächstes Wort | Versatz zum Anschluss | zugelaufen |", "|---|---|---|---|---|---|---|---|---|---|"]
    for z in b["zeilen"]:
        x0, y0, x1, y1 = z["rahmen"]
        md.append(f"| {z['text']} | {z['teil']} | {kante[z['kante']]} | {zahl(x0)} bis {zahl(x1)} | "
                  f"{zahl(y0)} bis {zahl(y1)} | {zahl(z['rand'])} | {z['belegt_was']}: {zahl(z['belegt'])} | "
                  f"{z['nachbar']}: {zahl(z['nachbar_abstand'])} | {zahl(z['versatz'])} | "
                  f"{zahl(z['zugelaufen'])} % |")
    md.append("")
    return md


def pruefe(p=STANDARD, name=None):
    from .bau import NAME
    name = name or NAME
    ordner = AUS / "pruefung"
    ordner.mkdir(parents=True, exist_ok=True)
    deckel = entwurf.deckel(p)
    teile = {"unterteil": entwurf.unterteil(p), "deckel": deckel["gehaeuse_weiss"],
             "clip": entwurf.clip(p)}
    zeilen, paare, fehler = durchdringung(p, teile)
    unten = unterseite(p, teile["unterteil"])
    wand = wandmontage(p)
    brett = verbund([k for _, k, _ in platine.bauteile()])
    for probe, bau in passproben.PASSPROBEN.items():
        v = _schnitt(brett, bau(p))
        paare[f"Platine in Passprobe {probe}"] = round(v, 4)
        if v > 1e-3:
            fehler.append(f"Platine durchdringt die Passprobe {probe}: {v:.4f} mm³")
    v = _schnitt(passproben.schachtprobe(p), teile["unterteil"])
    paare["Schachtprobe in Unterteil"] = round(v, 4)
    if v > 1e-3:
        fehler.append(f"Die Schachtprobe durchdringt das Unterteil: {v:.4f} mm³")
    proben = passproben.vergleich_mit_gedruckt(p, {"passproben": AUS / "passproben", "gehaeuse": AUS / name})
    for probe in proben:
        if not probe["gleich"]:
            was = "Passprobe" if probe["abschnitt"] == "passproben" else "Gedrucktes Teil"
            fehler.append(f"{was} {probe['name']} weicht vom festgehaltenen Stand ab: Die "
                          "Rückmeldung des Betreibers passt nicht mehr zu den Maßen")
    regel = regeln(p)
    fehler += [f"Regel verletzt: {a} (Soll {b}, Ist {c})" for a, b, c, ok in regel if not ok]
    # jede Schriftgröße, die zur Wahl steht, gegen die Regeln der Beschriftung
    groessen = {}
    for kennung, aenderung in SCHRIFTGROESSEN.items():
        q = p.mit(**aenderung)
        groessen[kennung] = {"zahlen": beschriftung(q),
                             "regeln": [(a, b, zahl(c) if isinstance(c, (int, float)) else c, bool(ok))
                                        for a, b, c, ok in _beschriftung_regeln(q)]}
        if aenderung:
            fehler += [f"Schrift {kennung}: Regel verletzt: {a} (Soll {b}, Ist {c})"
                       for a, b, c, ok in groessen[kennung]["regeln"] if not ok]
    logo = logo_grenzen(p)
    if logo["kleinster_abstand"] < 0.6:
        fehler.append(f"Logo: kleinster Abstand {logo['kleinster_abstand']} mm unter 0,6 mm")
    steg = {n: stege(*netz(k, *((0.01, 0.2) if n == "deckel" else ()))) for n, k in teile.items()}
    steg["bohrlehre"] = stege(*netz(entwurf.wandlehre(p)))
    steg["schablone"] = stege(*netz(passproben.schablone(p)))
    steg["steckerwand"] = stege(*netz(passproben.steckerwand(p)))
    steg["schachtprobe"] = stege(*netz(passproben.schachtprobe(p)))
    for objekt, koerper in schriftprobe.baue(p).items():
        steg[objekt] = stege(*netz(koerper["gehaeuse_weiss"], 0.01, 0.2))
    for kennung, aenderung in SCHRIFTGROESSEN.items():
        if aenderung:
            steg[f"deckel, Schrift {kennung}"] = stege(*netz(entwurf.deckel(p.mit(**aenderung))["gehaeuse_weiss"],
                                                             0.01, 0.2))
    for n, funde in steg.items():
        if funde[BAHN]:
            fehler.append(f"{n}: {len(funde[BAHN])} Stelle(n) schmaler als eine Bahn (0,42 mm)")

    stell = stellgroessen(p)
    for v in stell:
        if not v["ein_koerper"] or v["schnitt"] > 1e-3 or not v["beschriftung_frei"]:
            fehler.append(f"Variante „{v['variante']}“ baut nicht sauber")

    md = [f"# Prüfbericht {name}", "",
          f"Material: {p.stoff.name}, Schwundausgleich {zahl(p.stoff.schwund * 100)} %. "
          "Dieser Bericht ist gerechnet. Was gedruckt und bestätigt ist, steht in `druck/README.md`.", "",
          "## Ergebnis", ""]
    md += [f"- **Fehler:** {f}" for f in fehler] or ["- Keine Durchdringung, keine verletzte Regel, "
                                                    "kein Steg unter einer Bahnbreite."]
    md += ["", "## 1. Platine im Gehäuse", "",
           "Die Platine liegt als Körper aus dem Maßmodell im Entwurf. Schnitt in mm³, "
           "kleinster Abstand in mm (0 = berührt, etwa die Leiterplatte auf den Auflagen).", "",
           "| Bauteil | Schnitt mit Unterteil | Abstand zum Unterteil | Schnitt mit Deckel "
           "| Abstand zum Deckel |", "|---|---|---|---|---|"]
    for z_ in zeilen:
        md.append(f"| {z_['bauteil']} | {zahl(z_['schnitt_unterteil'])} | "
                  f"{zahl(z_['abstand_unterteil'])} | {zahl(z_['schnitt_deckel'])} | "
                  f"{zahl(z_['abstand_deckel'])} |")
    md += ["", "| Teile gegeneinander | Schnitt in mm³ |", "|---|---|"]
    md += [f"| {k} | {zahl(v)} |" for k, v in paare.items()]
    if wand:
        md += ["",
               f"**Wandschrauben:** Köpfe bis {zahl(p.wand_kopf_d)} × {zahl(p.wand_kopf_hoehe)} mm sitzen in "
               f"der Rast {zahl(wand['abstand_innenraum'])} mm unter dem Innenraum und "
               f"{zahl(wand['abstand_platine'])} mm unter dem tiefsten Punkt, den die Unterseite der "
               f"Platine haben kann; dazwischen liegt ein geschlossener Boden von {zahl(p.wand_decke)} mm."]
    md += ["",
           f"**Unterseite:** Auflagen und Säule stehen mit {zahl(unten['volumen_im_raum'])} mm³ in dem "
           f"Raum unter der Platine, der bis {zahl(m.UNTERSEITE_TIEFE)} mm bestückt sein kann. Sie "
           f"berühren {zahl(unten['auflageflaeche'])} mm² der Unterseite ({zahl(unten['anteil'])} % "
           "der Fläche). An der gedruckten Schablone stößt keine Auflage an ein Bauteil (Betreiber, "
           "09.10.2026); wo die Bauteile der Unterseite sitzen, ist weiter nicht vermessen.",
           "", "## 2. Konstruktionsregeln (docs/regeln.md)", "",
           "| Regel | Soll | Ist | erfüllt |", "|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {'ja' if ok else '**nein**'} |" for a, b, c, ok in regel]
    md += ["", "## 3. Kleinste Stege je Druckschicht", "",
           "Jede Schicht (0,2 mm) jedes Teils geschnitten; gemeldet ist Material, das schmaler "
           "ist als eine Bahn (0,42 mm: wird nicht gedruckt) oder als zwei Bahnen (0,84 mm: "
           "einzelne Bahn, schwach). Koordinaten wie im Maßmodell.", ""]
    for n, funde in steg.items():
        md += _stege_md(n, funde)
    md += ["", "## 4. Logo", "",
           f"- Breite {zahl(p.logo_breite)} mm, Rand zum Deckel {zahl(logo['rand_zum_deckel'])} mm",
           f"- kleinster Abstand zwischen Einlagen: {zahl(logo['kleinster_abstand'])} mm "
           "(Grenze 0,6 mm)",
           f"- Schrift: {zahl(logo['schrift_schwarz']['verlust_prozent'])} % der Fläche schmaler als "
           "eine Bahn; Zeichen: "
           f"{zahl(logo['zeichen_hellblau']['verlust_prozent'])} % (Spitzen runden ab)", ""]
    md += ["## 5. Stellgrößen", "",
           "Der Entwurf mit geänderten Stellgrößen gebaut: je ein Körper für Unterteil und "
           "Deckel, keine Durchdringung mit der Platine oder untereinander.", "",
           "| Variante | geänderte Stellgrößen | baut als ein Körper | Beschriftung frei "
           "| Durchdringung in mm³ | Unterteil mm³ | Deckel mm³ |", "|---|---|---|---|---|---|---|"]
    md += [f"| {v['variante']} | {', '.join(f'{k} = {w}' for k, w in v['aenderung'].items())} | "
           f"{'ja' if v['ein_koerper'] else '**nein**'} | {'ja' if v['beschriftung_frei'] else '**nein**'} | "
           f"{zahl(v['schnitt'])} | "
           f"{zahl(v['volumen_unterteil'])} | {zahl(v['volumen_deckel'])} |" for v in stell]
    md += ["", "## 6. Passproben, Unterteil und Deckel v0.2 gegen den festgehaltenen Stand", ""]
    stand = passproben.gedruckter_stand()
    if stand:
        md += [f"Stand vom {stand['stand']}: {stand['anlass']}", "",
               "| Teil | Körper gleich (Volumen, Oberfläche, Hülle, Schwerpunkt) | größte Abweichung "
               "| STL Byte für Byte gleich |", "|---|---|---|---|"]
        wort = {True: "ja", False: "**nein**", None: "nicht gebaut"}
        md += [f"| {q['name']} | {wort[q['gleich']]} | "
               f"{zahl(q['abweichung']) if q['abweichung'] < 1e9 else 'gibt es nicht mehr'} | "
               f"{wort[q['stl_gleich']]} |" for q in proben]
        md += ["", "Nach einer gewollten Änderung der Maße den Stand neu festhalten: "
               "`.venv/bin/python -m gehaeuse.passproben \"Anlass\"`."]
    else:
        md.append("Kein Stand festgehalten.")
    sch = schacht(p)
    md += ["", "## 7. Lichtschacht", ""] + _schacht_md(sch)
    schild = beschriftung(p)
    md += ["## 8. Beschriftung der Anschlüsse", "",
           "Die Texte stehen in `gehaeuse/parameter.py` (`text_wan`, `text_lan`, `text_strom`, `text_usb`); "
           "`text_reset` und `text_leds` sind leer (Betreiber, 11.10.2026). Geprüft ist jede Schriftgröße, die "
           "zur Wahl steht, von der bisherigen zur kleinsten.", ""]
    for kennung, g in groessen.items():
        q = p.mit(**SCHRIFTGROESSEN[kennung])
        md += [f"### Schrift {schriftprobe.angabe(q.schrift_hoehe)} mm"
               + ("" if SCHRIFTGROESSEN[kennung] else " (Vorgabe)"), ""]
        md += _beschriftung_md(g["zahlen"], q)
        md += ["| Regel | Soll | Ist | erfüllt |", "|---|---|---|---|"]
        md += [f"| {a} | {b} | {c} | {'ja' if ok else '**nein**'} |" for a, b, c, ok in g["regeln"]] + [""]
    (ordner / "pruefbericht.md").write_text("\n".join(md), encoding="utf-8")
    daten = {"fehler": fehler, "platine": zeilen, "paare": paare, "unterseite": unten, "schacht": sch,
             "beschriftung": schild, "beschriftung_groessen": groessen,
             "wandmontage": wand, "passproben": proben, "stellgroessen": stell,
             "regeln": regel, "stege": {n: {str(b): s for b, s in f.items()} for n, f in steg.items()},
             "logo": logo}
    (ordner / "pruefung.json").write_text(json.dumps(daten, indent=1, ensure_ascii=False),
                                          encoding="utf-8")
    return daten

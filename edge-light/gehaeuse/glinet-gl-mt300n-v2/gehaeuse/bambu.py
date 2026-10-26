"""Prüft die Druckdateien gegen Bambu Studio (Kommandozeile) und slict sie zur Probe.

Braucht das entpackte Bambu Studio unter .werkzeug/bambu (siehe
werkzeug/bambu_einrichten.sh). Fehlt es, wird der Schritt übersprungen.
Je Datei: Kommen Objekte, Teilnamen und Filamentplätze an? Druckzeit,
Filamentwechsel, Material im Teil und Abfall laut Slicer. Für Deckel und
Schachtprobe zusätzlich aus dem G-Code: Druckt der Slicer den Fuß des
Lichtschachts (die obersten Schichten) ganz, und fährt er keine Bahn doppelt?
Für jede Datei mit eingelegter Beschriftung (daneben liegt <name>-schrift.json
aus dem Bau): Fährt der Slicer in jeder Schicht der Einlage jedes Zeichen mit
der Farbe der Schrift ab, als geschlossene Bahn und ohne zu viel Kunststoff?
Dazu das Bild der ersten Schicht (<name>-bahnen.png): Sie ist die Sichtfläche.
Für jede Datei mit Kennung auf der Unterseite (daneben liegt <name>-kennung.json):
Liest zxing-cpp den QR-Code aus den gezeichneten Schichten der Einlage, auch wie
eine Kamera ihn sieht, und liefert er genau den Link (``qr_im_gcode``)?
"""
import json
import math
import os
import re
import subprocess
import zipfile

import numpy as np
import shapely
from shapely import affinity, wkt

from . import entwurf
from .ausgabe import AUS
from .bau import DECKEL_DATEIEN, NAME, kennung_ordner
from .massmodell import zahl
from .parameter import BAHN, SCHICHT, STANDARD

WURZEL = AUS.parent
SKRIPT = WURZEL / "werkzeug" / "bambu_pruefung.sh"
PROGRAMM = WURZEL / ".werkzeug" / "bambu" / "squashfs-root" / "bin" / "bambu-studio"
ASA = "asa;asa;abs"            # weiß und schwarz in ASA, das Zeichen in ABS Azure
PETG = "petg-hf;petg-hf;petg-hf"

LAEUFE = [  # (Name des Laufs, Datei unter aus/, Filamente, erwartete Teile je Objekt)
    ("schablone", "passproben/schablone.3mf", ASA, {"schablone": 1}),
    ("steckerwand", "passproben/steckerwand.3mf", ASA, {"steckerwand": 1}),
    ("schachtprobe", "passproben/schachtprobe.3mf", ASA, {"schachtprobe": 1}),
    ("probe-platte", "probe-platte/probe-platte.3mf", ASA, {"probe-platte": 3}),
    ("schriftprobe", "schriftprobe/schriftprobe.3mf", ASA, {"schriftprobe": 2, "schriftprobe-fein": 2}),
    # dieselbe Probe ohne die Einstellung des Wandgenerators: Was wird dann aus der feinen Zeile?
    ("schriftprobe-gegenprobe", "schriftprobe/schriftprobe-gegenprobe.3mf", ASA,
     {"schriftprobe": 2, "schriftprobe-fein": 2}),
    ("unterteil", f"{NAME}/unterteil.3mf", ASA, {"unterteil": 1}),
    ("deckel", f"{NAME}/deckel.3mf", ASA, {"deckel": 3}),
    ("deckel-petg", f"{NAME}/deckel.3mf", PETG, {"deckel": 3}),
    # der Deckel in den anderen Schriftgrößen
    *((d, f"{NAME}/{d}.3mf", ASA, {d: 3}) for d, (_, unter) in DECKEL_DATEIEN.items() if not unter),
    (NAME, f"{NAME}/{NAME}.3mf", ASA, {"unterteil": 1, "deckel": 3}),
    ("hutschienen-clip", f"{NAME}/hutschienen-clip.3mf", ASA, {"hutschienen-clip": 1}),
    ("bohrlehre", f"{NAME}/bohrlehre.3mf", ASA, {"bohrlehre": 1}),
]


def kennung_laeufe(ref):
    """Die Läufe für das Unterteil einer Box mit Kennung (bau.bau_kennung): allein und mit dem Deckel."""
    o, ordner = f"unterteil-{ref}", kennung_ordner(ref).relative_to(AUS)
    return [(o, f"{ordner}/{o}.3mf", ASA, {o: 2}),
            (f"gehaeuse-{ref}", f"{ordner}/gehaeuse-{ref}.3mf", ASA, {o: 2, "deckel": 3})]


# Läufe, deren oberste Schichten der Fuß des Lichtschachts sind
SCHACHTFUSS = ("schachtprobe", "deckel", *(d for d, (_, unter) in DECKEL_DATEIEN.items() if not unter))
SOLL_PLATZ = {"gehaeuse_weiss": 1, "schrift_schwarz": 2, "zeichen_hellblau": 3}


ERSTE_BAHN = 0.5   # Bahnbreite der ersten Schicht im Profil "0.20mm Standard" (initial_layer_line_width)
FILAMENT_QUERSCHNITT = math.pi * (1.75 / 2) ** 2
# Grenzen für die Beschriftung im G-Code (schrift_im_gcode)
NAH = 0.15     # so nah an der Mittellinie muss der Rand einer schwarzen Bahn liegen
DICHT = 0.95   # Anteil der Mittellinien eines Zeichens, an dem eine Bahn liegen muss (die Enden
               # eines Strichs fährt der Slicer bis zu einer halben Bahn kürzer)
QUILLT = 1.3   # Füllung, über der deutlich mehr Kunststoff liegt, als in das Zeichen passt: Sauber gefahrene
               # Zeichen liegen bei höchstens 1,25 (das N mit einer Bahn je Strich: Arachne legt in seine
               # spitzen Winkel zwei Bahnen), doppelt gefahrene Striche der Gegenprobe ab 1,34
DUENN = 0.75   # Füllung, unter der das Dreieck (es hat keine Mittellinie) nicht ganz gedruckt ist


def vorhanden():
    return PROGRAMM.exists()


def bahnen_mit_breite(geslict):
    """Extrusionsbahnen je Schicht aus dem G-Code einer geslicten 3MF, in der
    Reihenfolge des Drucks: {Schicht: [(x0, y0, x1, y1, Filamentplatz, Breite, Objekt)]}.
    Filamentplatz ab 1. Die Breite der Bahn folgt aus der geförderten Menge
    (E je Millimeter Weg, Flussfaktor des Filaments, Schichthöhe): Arachne und
    die Lückenfüllung fahren Bahnen wechselnder Breite. Objekt ist die Kennung,
    unter der der Slicer das Objekt führt (``objekte_auf_dem_bett``), 0 für
    Spülturm und alles andere."""
    gcode = zipfile.ZipFile(geslict).read("Metadata/plate_1.gcode").decode()
    fluss = re.search(r"^; filament_flow_ratio = (.*)$", gcode, flags=re.M)
    fluss = [float(v) for v in fluss.group(1).split(",")] if fluss else []
    bahnen, schicht, pos, filament, hoehe, objekt = {}, 0, [0.0, 0.0], 0, SCHICHT, 0
    for z in gcode.splitlines():
        z = z.strip()   # der erste Wechsel steht eingerückt im Start-G-Code
        if z.startswith("; layer num/total_layer_count:"):
            schicht = int(z.split(":")[1].split("/")[0])
        elif z.startswith("; LAYER_HEIGHT:"):
            hoehe = float(z.split(":")[1])
        elif z.startswith("; start printing object, unique label id:"):
            objekt = int(z.split(":")[1])
        elif z.startswith("; stop printing object"):
            objekt = 0
        elif z.startswith("T") and z[1:].isdigit() and int(z[1:]) < 16:
            filament = int(z[1:]) + 1
        elif z.startswith(("G1 ", "G0 ", "G2 ", "G3 ")):
            w = {t[0]: float(t[1:]) for t in z.split(";")[0].split()[1:]
                 if t[0] in "XYEIJ" and re.fullmatch(r"-?[\d.]+", t[1:])}
            neu = [w.get("X", pos[0]), w.get("Y", pos[1])]
            if w.get("E", 0) > 0 and schicht > 0 and ("X" in w or "Y" in w):
                weg = _bogen(pos, neu, w, z[1] == "2") if z[1] in "23" else [pos, neu]
                lang = sum(math.hypot(e[0] - a[0], e[1] - a[1]) for a, e in zip(weg, weg[1:]))
                if lang > 1e-6:
                    f = fluss[filament - 1] if 0 < filament <= len(fluss) else 1.0
                    quer = w["E"] * FILAMENT_QUERSCHNITT / f / lang
                    # Querschnitt einer Bahn: Rechteck mit halbrunden Seiten
                    breite = (quer - math.pi * hoehe ** 2 / 4) / hoehe + hoehe
                    bahnen.setdefault(schicht, []).extend((*a, *e, filament, breite, objekt)
                                                          for a, e in zip(weg, weg[1:]))
            pos = neu
    return bahnen


def bahnen_mit_filament(geslict):
    """Wie ``bahnen_mit_breite``, ohne die Breite: {Schicht: [(x0, y0, x1, y1, Filamentplatz)]}."""
    return {s_: [b[:5] for b in liste] for s_, liste in bahnen_mit_breite(geslict).items()}


def _bogen(von, bis, w, im_uhrzeigersinn, schritt=0.15):
    """Ein Kreisbogen des G-Codes (G2/G3 mit Mittelpunkt I, J) als Folge kurzer Strecken."""
    cx, cy = von[0] + w.get("I", 0.0), von[1] + w.get("J", 0.0)
    r = math.hypot(von[0] - cx, von[1] - cy)
    a0, a1 = math.atan2(von[1] - cy, von[0] - cx), math.atan2(bis[1] - cy, bis[0] - cx)
    if im_uhrzeigersinn and a1 >= a0:
        a1 -= 2 * math.pi
    if not im_uhrzeigersinn and a1 <= a0:
        a1 += 2 * math.pi
    n = max(2, math.ceil(abs(a1 - a0) * r / schritt))
    return [von, *([cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)]
                   for i in range(1, n)), bis]


def bahnen_je_schicht(geslict):
    """Wie ``bahnen_mit_filament``, ohne den Filamentplatz: {Schicht: [(x0, y0, x1, y1)]}."""
    return {s_: [b[:4] for b in liste] for s_, liste in bahnen_mit_breite(geslict).items()}


def _stuecke(bahnen, schritt=0.1):
    """Zerlegt Bahnen in kurze Stücke: (x, y, Länge, Filamentplatz, Breite) je Stück als Felder."""
    if not bahnen:
        return np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0, int), np.zeros(0)
    b = np.array(bahnen, dtype=float)
    lang = np.hypot(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1])
    n = np.maximum(1, np.ceil(lang / schritt)).astype(int)
    welche = np.repeat(np.arange(len(b)), n)
    anteil = (np.concatenate([np.arange(k) for k in n]) + 0.5) / n[welche]
    x = b[welche, 0] + anteil * (b[welche, 2] - b[welche, 0])
    y = b[welche, 1] + anteil * (b[welche, 3] - b[welche, 1])
    return x, y, lang[welche] / n[welche], b[welche, 4].astype(int), b[welche, 5]


def objekte_auf_dem_bett(geslict, bahnen, n_ein=3):
    """Wo der Slicer die Objekte der Datei hingelegt hat: {Objektname: (x0, y0,
    x1, y1)}, der Rahmen der Bahnen jedes Objekts in den einfarbigen Schichten
    über der Einlage. Der Slicer rückt mehrere Objekte einer Datei zurecht;
    der G-Code nennt dann zu jeder Bahn ihr Objekt, Metadata/slice_info.config
    dessen Namen."""
    import xml.etree.ElementTree as ET
    namen = {int(o.get("identify_id")): o.get("name")
             for o in ET.fromstring(zipfile.ZipFile(geslict).read("Metadata/slice_info.config")).iter("object")}
    b = np.array([q for s_ in sorted(bahnen) if n_ein + 2 <= s_ <= 10 for q in bahnen[s_]])
    aus = {}
    for kennung, name in namen.items():
        q = b[b[:, 6] == kennung]
        if not len(q) and len(namen) == 1:
            q = b   # ein einzelnes Objekt trägt im G-Code keine Marke; dort gehört jede Bahn zu ihm
        aus[name] = (min(q[:, 0].min(), q[:, 2].min()), min(q[:, 1].min(), q[:, 3].min()),
                     max(q[:, 0].max(), q[:, 2].max()), max(q[:, 1].max(), q[:, 3].max()))
    return aus


def _mitte(rahmen):
    return (rahmen[0] + rahmen[2]) / 2, (rahmen[1] + rahmen[3]) / 2


def schrift_im_gcode(geslict, plan):
    """Was der Slicer aus der eingelegten Beschriftung macht.

    ``plan``: Inhalt von <name>-schrift.json (bau._schrift_json). Für jedes
    Zeichen jedes Wortes und jede Schicht der Einlage:

      abdeckung  Anteil seiner Mittellinien, an dem eine Bahn der Schriftfarbe
                 liegt (ihr Rand höchstens ``NAH`` daneben). 1 heißt: Die
                 schwarze Bahn ist geschlossen, kein Stück des Zeichens fehlt.
      bahnen     Länge der Bahnen in der Fläche des Zeichens, geteilt durch die
                 Länge der Mittellinien: rund 2 bei einer Schleife um den
                 Strich (Wände "klassisch"), rund 1 bei einer einzelnen Bahn
                 (Arachne).
      fuellung   abgelegte Fläche (Länge mal Breite jeder Bahn) durch die
                 Fläche des Zeichens. Über ``QUILLT`` legt der Slicer deutlich
                 mehr Kunststoff ab, als in den Strich passt.

    Ein Zeichen gilt als gedruckt, wenn in jeder Schicht die Abdeckung
    mindestens ``DICHT`` und die Füllung höchstens ``QUILLT`` ist. Das Dreieck
    hat keine Mittellinie; für es zählt die Füllung (mindestens ``DUENN``).
    """
    bahnen = bahnen_mit_breite(geslict)
    n_ein, platz = plan["einlage_schichten"], plan["filament"]
    bett = objekte_auf_dem_bett(geslict, bahnen, n_ein)
    stuecke = {s_: _stuecke(bahnen.get(s_, [])) for s_ in range(1, n_ein + 1)}
    aus = []
    for wort in plan["worte"]:
        zeichen = []
        mx, my = _mitte(bett[wort["objekt"]])
        for z in wort["zeichen"]:
            form = affinity.translate(wkt.loads(z["wkt"]), mx, my)
            linien = affinity.translate(wkt.loads(z["linien"]), mx, my) if z["linien"] else None
            punkte = (np.array([linien.interpolate(d).coords[0] for d in np.arange(0.0, linien.length, 0.05)])
                      if linien is not None and linien.length > 0 else None)
            je = []
            for s_ in range(1, n_ein + 1):
                x, y, lang, fil, breite = stuecke[s_]
                schwarz = (fil == platz) & shapely.contains_xy(form.buffer(0.3), x, y)
                drin = schwarz & shapely.contains_xy(form.buffer(0.05), x, y)
                eintrag = {"fuellung": round(float((lang[drin] * breite[drin]).sum()) / form.area, 2)}
                if punkte is not None:
                    if schwarz.any():
                        d = np.hypot(punkte[:, None, 0] - x[schwarz][None, :], punkte[:, None, 1] - y[schwarz][None, :])
                        d -= breite[schwarz][None, :] / 2     # Abstand zum Rand der Bahn
                        eintrag["abdeckung"] = round(float((d.min(axis=1) <= NAH).mean()), 3)
                    else:
                        eintrag["abdeckung"] = 0.0
                    eintrag["bahnen"] = round(float(lang[drin].sum()) / z["laenge"], 2)
                je.append(eintrag)
            gut = all(e["abdeckung"] >= DICHT if "abdeckung" in e else e["fuellung"] >= DUENN for e in je)
            gut = gut and all(e["fuellung"] <= QUILLT for e in je)
            zeichen.append({"zeichen": z["zeichen"], "schichten": je, "gedruckt": gut})
        aus.append({"name": wort["name"], "text": wort["text"], "wandgenerator": wort["wandgenerator"],
                    "zeichen": zeichen, "gedruckt": all(z["gedruckt"] for z in zeichen),
                    "abdeckung": min((e["abdeckung"] for z in zeichen for e in z["schichten"] if "abdeckung" in e),
                                     default=1.0),
                    "fuellung": [min(e["fuellung"] for z in zeichen for e in z["schichten"]),
                                 max(e["fuellung"] for z in zeichen for e in z["schichten"])],
                    "bahnen": [round(float(np.median([z["schichten"][i]["bahnen"] for z in zeichen
                                                      if "bahnen" in z["schichten"][i]])), 2) for i in range(n_ein)]})
    erste = {str(s_): round(sum(float(np.hypot(q[2] - q[0], q[3] - q[1])) for q in bahnen.get(s_, [])) / 1000, 2)
             for s_ in range(1, 5)}
    return {"worte": aus, "bahn_je_schicht_m": erste}


def laengste_gerade(bahnen):
    """Längste Strecke, die in einer Schicht auf einer Geraden entlang x gedruckt
    wird (mm): Bahnen gleicher Höhe y zusammengezählt."""
    je_y = {}
    for x0, y0, x1, y1 in bahnen:
        if abs(y1 - y0) < 0.05:
            je_y[round((y0 + y1) / 2, 1)] = je_y.get(round((y0 + y1) / 2, 1), 0.0) + abs(x1 - x0)
    return max(je_y.values(), default=0.0)


def schachtfuss(geslict, p=STANDARD):
    """Was der Slicer aus dem Fuß des Schachts macht. Die Vorderwand ist das
    einzige lange, gerade Stück der obersten Schichten: Ihre Bahn muss da sein,
    und sie darf nicht zweimal auf derselben Linie liegen. So druckt Bambu
    Studio (Wände "klassisch") eine Wand, die genau eine Bahn breit ist: Sie
    bekäme die doppelte Menge oder fiele ganz weg.
    """
    fuss = entwurf.schacht_fuss(p)
    if not fuss:
        return None
    soll = fuss[0][2] - fuss[0][0] - BAHN
    bahnen = bahnen_je_schicht(geslict)
    oben = sorted(bahnen)[-max(1, round(p.led_schacht_fuss / SCHICHT)):]
    gerade = {str(s_): round(laengste_gerade(bahnen[s_]), 1) for s_ in oben}
    return {"soll_mm": round(soll, 1), "schichten": gerade,
            "gedruckt": all(v >= 0.9 * soll for v in gerade.values()),
            "doppelt": any(v > 1.5 * soll for v in gerade.values())}


def bahnbild(geslict, plan, pfad, schicht=1, massstab=40, rahmen=None, halb_gedreht=False, objekt=None):
    """Zeichnet eine Schicht aus dem G-Code, wie man sie auf der Sichtseite
    sieht: jede Bahn in der Breite, die der Slicer fördert, die Schriftfarbe
    schwarz, alles andere hell; grau bleibt, wo der Slicer nichts ablegt. Wo
    sich zwei Bahnen überdecken, liegt oben, was zuerst gedruckt wird: Das
    liegt auf der Platte. ``objekt``: nur dieses Objekt, sonst alle Objekte
    der Datei; ``rahmen``: Ausschnitt (x0, y0, x1, y1) um die Mitte des Objekts. ``halb_gedreht``: Das Bild steht, wie man
    den Deckel liest (Netzwerk-Seite unten)."""
    from PIL import Image, ImageDraw
    bahnen = bahnen_mit_breite(geslict)
    bett = objekte_auf_dem_bett(geslict, bahnen, plan["einlage_schichten"])
    gezeigt = [bett[objekt]] if objekt else list(bett.values())
    x0, y0, x1, y1 = (fn(r[i] for r in gezeigt) for fn, i in ((min, 0), (min, 1), (max, 2), (max, 3)))
    rand = BAHN
    if rahmen:
        mx, my = _mitte(gezeigt[0])
        x0, y0, x1, y1 = rahmen[0] + mx, rahmen[1] + my, rahmen[2] + mx, rahmen[3] + my
        rand = 0.0
    b = np.array(bahnen[schicht])
    # alles, was den Ausschnitt berührt; nur der Spülturm und andere Objekte bleiben draußen
    im_teil = ((np.maximum(b[:, 0], b[:, 2]) > x0 - 1) & (np.minimum(b[:, 0], b[:, 2]) < x1 + 1)
               & (np.maximum(b[:, 1], b[:, 3]) > y0 - 1) & (np.minimum(b[:, 1], b[:, 3]) < y1 + 1))
    bild = Image.new("RGB", (round((x1 - x0 + 2 * rand) * massstab), round((y1 - y0 + 2 * rand) * massstab)),
                     (139, 141, 148))
    stift = ImageDraw.Draw(bild)
    # auf die Sichtseite gesehen ist die Schicht gegenüber dem Druckbett in y gespiegelt
    px = lambda x, y: ((x - x0 + rand) * massstab, (y - y0 + rand) * massstab)
    for xa, ya, xb, yb, fil, breite, _ in b[im_teil][::-1]:
        farbe = (16, 16, 16) if fil == plan["filament"] else (243, 243, 239)
        a, e, w = px(xa, ya), px(xb, yb), max(breite, 0.05) * massstab
        stift.line([a, e], fill=farbe, width=max(1, round(w)))
        for c in (a, e):
            stift.ellipse([c[0] - w / 2, c[1] - w / 2, c[0] + w / 2, c[1] + w / 2], fill=farbe)
    (bild.rotate(180) if halb_gedreht else bild).save(pfad)


GRAU = (139, 141, 148)   # kein Kunststoff in den gezeichneten Schichten: Loch, Mulde, neben dem Teil
QR_RAND = 6              # so viele Module Umgebung zeigt das Bild um den Code: Ruhezone und was dahinter liegt
QR_KAMERA = (8, 5, 3)    # Bildpunkte je Modul, wie eine Telefonkamera den Code aus der Nähe bis von weiter weg sieht


def sichtbild(geslict, plan, schichten, massstab=40):
    """Die Standfläche um den QR-Code, wie man sie von unten sieht, aus dem G-Code gezeichnet: jede Bahn
    der Schichten ``schichten`` bis 1 in ihrer geförderten Breite, die Einlage schwarz, Weiß weiß, grau, wo
    nichts liegt. Die erste Schicht liegt oben; durch ihre Lücken sieht man auf die zweite und dritte.
    Netzwerk-Seite unten, wie die Unterseite gelesen wird. ``plan``: <name>-kennung.json."""
    from PIL import Image, ImageDraw
    bahnen = bahnen_mit_breite(geslict)
    bett = objekte_auf_dem_bett(geslict, bahnen, plan["einlage_schichten"])
    mx, my = _mitte(bett[plan["objekt"]])
    rand = QR_RAND * plan["modul"]
    r = plan["rahmen"]
    x0, y0, x1, y1 = r[0] + mx - rand, r[1] + my - rand, r[2] + mx + rand, r[3] + my + rand
    bild = Image.new("RGB", (round((x1 - x0) * massstab), round((y1 - y0) * massstab)), GRAU)
    stift = ImageDraw.Draw(bild)
    px = lambda x, y: ((x - x0) * massstab, (y - y0) * massstab)   # von unten gesehen: y wie auf dem Bett, nach unten
    for s_ in range(schichten, 0, -1):
        b = np.array(bahnen.get(s_, []))
        if not len(b):
            continue
        b = b[(np.maximum(b[:, 0], b[:, 2]) > x0 - 1) & (np.minimum(b[:, 0], b[:, 2]) < x1 + 1)
              & (np.maximum(b[:, 1], b[:, 3]) > y0 - 1) & (np.minimum(b[:, 1], b[:, 3]) < y1 + 1)]
        for xa, ya, xb, yb, fil, breite, _ in b[::-1]:
            farbe = (16, 16, 16) if int(fil) == plan["filament"] else (243, 243, 239)
            a, e, w = px(xa, ya), px(xb, yb), max(breite, 0.05) * massstab
            stift.line([a, e], fill=farbe, width=max(1, round(w)))
            for c in (a, e):
                stift.ellipse([c[0] - w / 2, c[1] - w / 2, c[0] + w / 2, c[1] + w / 2], fill=farbe)
    return bild


def lies_qr(bild):
    """Was zxing-cpp im Bild findet: Liste (Text, gespiegelt)."""
    import zxingcpp
    return [(t.text, bool(getattr(t, "is_mirrored", False))) for t in zxingcpp.read_barcodes(bild)
            if "QR" in str(t.format)]


def kamera(bild, px_je_modul, modul, massstab=40, seed=7):
    """Das Bild, wie eine Kamera es aufnimmt: verkleinert auf ``px_je_modul`` Bildpunkte je Modul,
    unscharf, mit Rauschen ±25 (fest gesät: gleiches Bild, gleiches Ergebnis)."""
    import random
    from PIL import Image, ImageFilter
    grau = bild.convert("L")
    f = px_je_modul / (modul * massstab)
    klein = grau.resize((max(1, round(grau.width * f)), max(1, round(grau.height * f))), Image.BILINEAR)
    klein = klein.filter(ImageFilter.GaussianBlur(radius=0.6))
    zufall = random.Random(seed)
    werte = [max(0, min(255, v + zufall.randint(-25, 25))) for v in klein.getdata()]
    klein.putdata(werte)
    return klein


def qr_im_gcode(geslict, plan, ordner, name):
    """Liest den QR-Code aus dem G-Code, so wie er gedruckt wird.

    Gezeichnet wird die Sichtfläche aus den drei Schichten der Einlage (``sichtbild``); gelesen mit
    zxing-cpp in voller Auflösung (das Grau, wo nichts liegt, einmal hell und einmal dunkel: Wie eine
    Lücke wirkt, hängt am Licht) und wie eine Kamera mit 8, 5 und 3 Bildpunkten je Modul, unscharf und
    verrauscht. Bestanden ist sie, wenn jeder Fall genau den Link liefert, nicht gespiegelt. Die erste
    Schicht allein wird zum Vergleich auch gelesen; sie entscheidet nicht."""
    soll, modul = plan["link"], plan["modul"]
    sicht = sichtbild(geslict, plan, plan["einlage_schichten"])
    sicht.save(ordner / f"{name}-qr-sicht.png")
    erste = sichtbild(geslict, plan, 1)
    erste.save(ordner / f"{name}-qr-schicht1.png")

    def faelle(bild):
        grau = bild.convert("L")
        aus = {"voll, Lücken hell": grau.point(lambda v: 255 if v > 100 else 0),
               "voll, Lücken dunkel": grau.point(lambda v: 255 if v > 200 else 0)}
        for n in QR_KAMERA:
            aus[f"{n} Bildpunkte je Modul, unscharf, Rauschen"] = kamera(bild, n, modul)
        return aus

    def lies(bilder):
        e = {}
        for fall, b in bilder.items():
            gelesen = lies_qr(b)
            e[fall] = {"gelesen": [t for t, _ in gelesen], "gespiegelt": any(s for _, s in gelesen),
                       "richtig": [t for t, _ in gelesen] == [soll] and not any(s for _, s in gelesen)}
        return e

    sichtfaelle = faelle(sicht)
    kamera(sicht, QR_KAMERA[-1], modul).save(ordner / f"{name}-qr-kamera-{QR_KAMERA[-1]}px.png")
    ergebnis = {"link": soll, "modul": modul, "bild": f"{name}-qr-sicht.png",
                "drei_schichten": lies(sichtfaelle), "erste_schicht": lies(faelle(erste))}
    ergebnis["lesbar"] = all(f["richtig"] for f in ergebnis["drei_schichten"].values())
    return ergebnis


def _zuordnung_stimmt(ergebnis, erwartet):
    objekte = {name: teile for name, teile in ergebnis.get("objekte", [])}
    if set(objekte) != set(erwartet):
        return False
    return all(len(objekte[o]) == n and all(SOLL_PLATZ.get(t) == platz for t, platz in objekte[o])
               for o, n in erwartet.items())


def pruefe(laeufe=None, ziel=None):
    """Alle Läufe (Vorgabe: ``LAEUFE`` und die Unterseite mit der Kennung der Probe-Referenz) durch Bambu
    Studio; Bericht nach <ziel>/bambu.md (Vorgabe aus/pruefung)."""
    from . import kennung
    if laeufe is None:
        laeufe = [*LAEUFE, *kennung_laeufe(kennung.probe_referenz())]
    ziel = ziel or AUS / "pruefung"
    ordner = ziel / "bambu"
    ordner.mkdir(parents=True, exist_ok=True)
    if not vorhanden():
        print("Bambu Studio fehlt (werkzeug/bambu_einrichten.sh): Schritt übersprungen.")
        return None
    aus, fehler = {}, []
    for name, datei, filamente, erwartet in laeufe:
        pfad = AUS / datei
        if not pfad.exists():
            continue
        # einzeln und mit niedriger Priorität: Die Maschine wird geteilt
        lauf = subprocess.run([str(SKRIPT), str(pfad), str(ordner), filamente],
                              env={**os.environ, "NAME": name}, capture_output=True, text=True)
        print(lauf.stdout.strip() or lauf.stderr.strip())
        e = json.loads((ordner / f"{name}-bambu.json").read_text(encoding="utf-8"))
        e["datei"] = datei
        e["zuordnung_stimmt"] = bool(e.get("erfolg")) and _zuordnung_stimmt(e, erwartet)
        if not e.get("erfolg"):
            fehler.append(f"{name}: {e.get('meldung')}")
        elif not e["zuordnung_stimmt"]:
            fehler.append(f"{name}: Objekte oder Filamentplätze kommen nicht wie geschrieben an")
        geslict = ordner / f"{name}-geslict.3mf"
        if e.get("erfolg") and name in SCHACHTFUSS and geslict.exists():
            e["schachtfuss"] = f = schachtfuss(geslict)
            if f and not f["gedruckt"]:
                fehler.append(f"{name}: Der Slicer druckt den Fuß des Lichtschachts nicht ganz (Soll "
                              f"{f['soll_mm']} mm gerade Bahn je Schicht, Ist {f['schichten']})")
            if f and f["doppelt"]:
                fehler.append(f"{name}: Der Slicer fährt am Fuß des Lichtschachts eine Bahn doppelt "
                              f"(Wand zu schmal; {f['schichten']} mm auf einer Linie, Wand {f['soll_mm']} mm)")
        plan = pfad.with_name(pfad.stem + "-schrift.json")
        if e.get("erfolg") and plan.exists() and geslict.exists():
            plan_ = json.loads(plan.read_text(encoding="utf-8"))
            e["schrift"] = s_ = schrift_im_gcode(geslict, plan_)
            e["gegenprobe"] = bool(plan_.get("gegenprobe"))
            if name != "deckel-petg":   # dieselbe Datei wie "deckel": ein Bild genügt
                for b in plan_["bilder"]:
                    bahnbild(geslict, plan_, pfad.with_name(b["datei"]), rahmen=b["rahmen"],
                             halb_gedreht=b["halb_gedreht"], objekt=b["objekt"])
            for w in s_["worte"]:
                for z in w["zeichen"]:
                    # Gegenprobe: Dass die feine Schrift ohne ihre Einstellung nicht sauber fährt, soll sie zeigen.
                    if not z["gedruckt"] and not (e["gegenprobe"] and w["wandgenerator"] != "klassisch"):
                        fehler.append(f"{name}: Der Slicer druckt das Zeichen {z['zeichen']!r} von "
                                      f"{w['name']!r} nicht sauber ({z['schichten']})")
        plan = pfad.with_name(pfad.stem + "-kennung.json")
        if e.get("erfolg") and plan.exists() and geslict.exists():
            e["qr"] = q = qr_im_gcode(geslict, json.loads(plan.read_text(encoding="utf-8")), pfad.parent, name)
            if not q["lesbar"]:
                schlecht = [f for f, r in q["drei_schichten"].items() if not r["richtig"]]
                fehler.append(f"{name}: Der QR-Code ist aus dem G-Code nicht sicher lesbar ({', '.join(schlecht)})")
        aus[name] = e
        # Das geslicte 3MF ist groß und nur für die Auswertung da.
        geslict.unlink(missing_ok=True)
    daten = {"laeufe": aus, "fehler": fehler}
    (ziel / "bambu.json").write_text(json.dumps(daten, indent=1, ensure_ascii=False), encoding="utf-8")
    (ziel / "bambu.md").write_text(bericht_md(daten), encoding="utf-8")
    return daten


def bericht_md(daten):
    md = ["## 10. Bambu Studio 02.08.02.61, Kommandozeile", "",
          "P1S mit 0,4-mm-Düse, Profil „0.20mm Standard“, strukturierte PEI-Platte, Spülturm an. "
          "Zeiten, Wechsel und Mengen sind Schätzungen des Slicers.", "",
          "| Lauf | Datei | Filamente | geladen und geslict | Teile und Filamentplätze | Druckzeit "
          "| Filamentwechsel | im Teil | Abfall (Spülen, Turm) |",
          "|---|---|---|---|---|---|---|---|---|"]
    for name, e in daten["laeufe"].items():
        if not e.get("erfolg"):
            md.append(f"| {name} | `{e['datei']}` | {e.get('filamente', '')} | **nein**: "
                      f"{e.get('meldung')} | | | | | |")
            continue
        teile = "; ".join(f"{o}: " + ", ".join(f"{t} → {p}" for t, p in ts) for o, ts in e["objekte"])
        md.append(f"| {name} | `{e['datei']}` | {e['filamente']} | ja | "
                  f"{teile}{'' if e['zuordnung_stimmt'] else ' **(weicht ab)**'} | "
                  f"{zahl(e['druckzeit_min'])} min | {e['filamentwechsel']} | {zahl(e['im_teil_g'])} g "
                  f"| {zahl(e['abfall_g'])} g |")
    for name, e in daten["laeufe"].items():
        f = e.get("schachtfuss")
        if f:
            urteil = ("**Der Slicer lässt einen Teil aus.**" if not f["gedruckt"]
                      else "**Eine Bahn liegt doppelt auf derselben Linie.**" if f["doppelt"]
                      else "Der Slicer druckt ihn, keine Bahn doppelt.")
            md += ["", f"**Fuß des Lichtschachts, {name}:** In den obersten {len(f['schichten'])} Schichten "
                   "ist die längste gerade Bahn im G-Code "
                   + ", ".join(f"{zahl(v)} mm" for v in f["schichten"].values())
                   + f" lang (Vorderwand am Fuß: {zahl(f['soll_mm'])} mm). {urteil}"]
    for name, e in daten["laeufe"].items():
        s_ = e.get("schrift")
        if not s_ or not s_["worte"]:
            continue
        if e.get("gegenprobe"):
            md += ["", f"**Gegenprobe {name}:** dieselbe Datei wie die Schriftprobe, ohne die Einstellung des "
                   "Wandgenerators. So slict Bambu Studio die feine Zeile, wenn die Einstellung aus der 3MF nicht "
                   "ankommt; dass sie hier nicht sauber fährt, ist das erwartete Ergebnis und kein Fehler."]
        md += ["", f"**Beschriftung im G-Code, {name}:** je Wort über alle Zeichen und die drei Schichten der "
               f"Einlage. Abdeckung: kleinster Anteil der Mittellinien eines Zeichens, an dem eine schwarze Bahn "
               f"liegt (Soll mindestens {zahl(100 * DICHT)} %). Bahnen je Strich: rund 2 bei einer Schleife um den "
               f"Strich, rund 1 bei einer einzelnen Bahn. Füllung: abgelegte Fläche durch Fläche des Zeichens "
               f"(Soll höchstens {zahl(100 * QUILLT)} %; kurze Striche liegen darunter, weil die Bahn vor dem "
               "runden Ende aufhört).", "",
               "| Wort | Wandgenerator | Abdeckung | Bahnen je Strich, Schicht 1 / 2 / 3 | Füllung von … bis | Urteil |",
               "|---|---|---|---|---|---|"]
        for w in s_["worte"]:
            schlecht = [z["zeichen"] for z in w["zeichen"] if not z["gedruckt"]]
            md.append(f"| {w['text']} ({w['name']}) | {w['wandgenerator']} | {zahl(100 * w['abdeckung'])} % | "
                      + " / ".join(zahl(v) for v in w["bahnen"])
                      + f" | {zahl(100 * w['fuellung'][0])} bis {zahl(100 * w['fuellung'][1])} % | "
                      + ("geschlossen gefahren" if w["gedruckt"] else "**nicht sauber: " + ", ".join(schlecht) + "**")
                      + " |")
        md.append("")
        md.append("Bahn in den ersten vier Schichten: "
                  + ", ".join(f"{zahl(v)} m" for v in s_["bahn_je_schicht_m"].values()) + ".")
    for name, e in daten["laeufe"].items():
        q = e.get("qr")
        if not q:
            continue
        md += ["", f"**QR-Code im G-Code, {name}:** `{q['link']}`, Modul {zahl(q['modul'])} mm. Gezeichnet aus den "
               "Bahnen der drei Schichten der Einlage, von unten gesehen (Bild "
               f"`{q['bild']}`), gelesen mit zxing-cpp. Voll: das Bild in 40 Bildpunkten je mm, das Grau ohne "
               "Kunststoff (Loch, Mulde, neben dem Teil) einmal hell, einmal dunkel. Kamera: verkleinert, unscharf, "
               "Rauschen ±25. Zum Vergleich die erste Schicht allein.", "",
               "| Fall | drei Schichten | erste Schicht allein |", "|---|---|---|"]
        for fall, r in q["drei_schichten"].items():
            s1 = q["erste_schicht"][fall]
            md.append(f"| {fall} | {'richtig gelesen' if r['richtig'] else '**nicht gelesen**: ' + str(r['gelesen'])} "
                      f"| {'richtig gelesen' if s1['richtig'] else 'nicht gelesen: ' + str(s1['gelesen'])} |")
        md.append("")
        md.append("Urteil: " + ("**lesbar** in allen Fällen." if q["lesbar"] else "**nicht sicher lesbar.**"))
    md += ["", "Die Oberfläche von Bambu Studio ist damit nicht geprüft: Beim Öffnen einer fremden "
           "3MF kann sie fragen, ob nur die Geometrie geladen werden soll, und die Filamentplätze "
           "zurücksetzen. Das zeigt erst das Öffnen in der Oberfläche.", ""]
    return "\n".join(md)

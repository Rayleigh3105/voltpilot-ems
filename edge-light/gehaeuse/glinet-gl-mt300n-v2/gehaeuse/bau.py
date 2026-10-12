"""Baut die Druckdateien und Vorschaubilder nach ``aus/``.

Jeder Schritt schreibt in einen eigenen Unterordner und gibt eine kurze
Zusammenfassung zurück; sie liegt als JSON neben den Dateien.
"""
import json
import time

import numpy as np

from . import entwurf, massmodell as m, passproben, platine, schachtbild, schrift, schriftbild
from .ausgabe import (AUS, bild, drucklage, gewendet, in_drucklage, nebeneinander, netz, schnittbild,
                      schreibe_druckdateien, schreibe_stl, teile_fuer_3mf)
from .mehrfarb_3mf import lies_3mf, schreibe_3mf
from .formen import prisma, quader, zylinder
from .parameter import (DECKEL_V02, ETIKETT_DECKEL, FARBEN, SCHACHT_V01, SCHICHT, SCHRIFTGROESSEN,
                        STANDARD)

NAME = "gehaeuse-v04"   # Ordner unter aus/ und Name der Druckdatei
# Slicer-Einstellung von Bambu Studio je Wandgenerator; "klassisch" ist dort die Voreinstellung.
WANDGENERATOR = {"klassisch": {}, "arachne": {"wall_generator": "arachne"}}


def deckel_datei(kennung):
    """Dateiname (ohne Endung) des Deckels in einer Schriftgröße aus
    ``parameter.SCHRIFTGROESSEN``; die Vorgabe heißt schlicht "deckel"."""
    return f"deckel-schrift-{kennung}" if SCHRIFTGROESSEN[kennung] else "deckel"


# Der Deckel in den anderen Ausführungen: Dateiname -> (geänderte Stellgrößen, Unterordner).
# Die anderen Schriftgrößen liegen bei den Druckdateien; der Deckel v0.2, den
# der Betreiber gedruckt hat, liegt zum Vergleich mit dem festgehaltenen Stand in "vergleich".
DECKEL_DATEIEN = {
    **{deckel_datei(k): (a, "") for k, a in SCHRIFTGROESSEN.items() if a},
    "deckel-ohne-beschriftung": (DECKEL_V02, "vergleich"),
}
WEISS = "#f3f3ef"       # Anzeigefarbe des weißen Gehäuses im Bild (reines Weiß frisst die Kanten)
CLIPGRAU = "#dcdcd8"
STAHL = "#9aa3ad"
ETIKETT = "#cfccc0"
WAND = "#d8d2c4"
GUMMI = "#3b3d42"
KABEL = "#8f96a0"
# Für die Bilder an der Wand: Rückseite an die Wand, Netzwerk-Seite nach unten,
# Blick von vorn (x' = -x, y' = -z in die Wand, z' = -y nach oben).
AN_DIE_WAND = np.array([[-1.0, 0, 0], [0, 0, -1.0], [0, -1.0, 0]])


def _platine_szene(versatz=(0.0, 0.0, 0.0)):
    return [(e + versatz, d, farbe) for (e, d), farbe in
            ((netz(k, 0.05, 0.4), f) for _, k, f in platine.bauteile())]


def _feld(x0, x1, y0, y1, z, farbe):
    """Flaches Rechteck als Bildmarke (zwei Dreiecke)."""
    return (np.array([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]]),
            np.array([[0, 1, 2], [0, 2, 3]]), farbe)


def _marken(p):
    """Für die Draufsicht: wo die LEDs durchscheinen und wo das Etikett sitzt.
    Beides ist im Bild sonst nicht zu sehen (Fenster von innen, Feld 0,2 mm tief)."""
    marken = []
    if p.led_anzeige != "keine":
        bx, by = p.led_oeffnung
        marken += [_feld(x - bx / 2, x + bx / 2, m.LED_Y - by / 2, m.LED_Y + by / 2,
                         p.z_deckel + 0.02, "#bfe6c6") for x in m.LED_X]
    if p.etikett == "deckel":
        ecken = entwurf.etikettfeld(p).bounding_box()
        marken.append(_feld(ecken.min.X, ecken.max.X, ecken.min.Y, ecken.max.Y,
                            p.z_deckel - p.etikett_tiefe + 0.02, ETIKETT))
    return marken


def _marken_unten(p):
    """Für die Ansicht der Standfläche: das Etikettfeld (0,2 mm tief) und der
    Grund der Schlüssellöcher; beides ist im Bild sonst nicht zu sehen."""
    def feld(x0, x1, y0, y1, z, farbe):   # Reihenfolge der Ecken: Die Fläche zeigt nach unten
        return (np.array([[x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z]]),
                np.array([[0, 1, 2], [0, 2, 3]]), farbe)

    marken = []
    if p.etikett == "unterseite":
        marken.append(feld(*entwurf.etikett_unten(p), p.z_rueck + p.etikett_tiefe - 0.02, ETIKETT))
    if p.wandmontage:   # Grund der Taschen dunkel: Von unten gesehen heben sich die Öffnungen sonst nicht ab
        h, z = p.wand_einstieg_d / 2, p.z_rueck + p.wand_lippe + p.wand_tasche - 0.02
        marken += [feld(x - h, x + h, y - h, y + p.wand_hub + h, z, "#7d8088") for x, y in p.wandschrauben]
    return marken


def _fuesse(p, hoehe=2.0):
    """Klebefüße in den Mulden, nur für die Bilder."""
    if not p.fuesse:
        return []
    z = p.z_rueck + p.fuss_tiefe
    return [(*netz(zylinder(x, y, z - hoehe, z, p.fuss_d / 2 - 0.25)), GUMMI) for x, y in p.fussmulden]


def _kabel(p, laenge=38.0):
    """Zwei Netzwerkkabel und das Stromkabel, grob angedeutet, nur für die Bilder."""
    r, mu = m.rj45(), m.microusb()
    teile = []

    def strang(x, z, radius, y0):
        kreis = [(x + radius * np.cos(w), z + radius * np.sin(w))
                 for w in np.linspace(0, 2 * np.pi, 12, endpoint=False)]
        return prisma(kreis, "y", y0, y0 + laenge)

    for x in (r.x0 + (r.x1 - r.x0) * 0.25, r.x0 + (r.x1 - r.x0) * 0.75):
        teile.append((quader(x - 5.8, x + 5.8, p.ya1 - 6.0, p.ya1 + 12.0, 2.0, 10.0), "#c9ced6"))
        teile.append((strang(x, 6.0, 2.8, p.ya1 + 12.0), KABEL))
    xm, zm = (mu.x0 + mu.x1) / 2, (mu.z0 + mu.z1) / 2
    teile.append((quader(xm - 5.3, xm + 5.3, p.ya1 - 1.0, p.ya1 + 17.0, zm - 3.4, zm + 3.4), "#2b2c30"))
    teile.append((strang(xm, zm, 1.8, p.ya1 + 17.0), "#2b2c30"))
    return [(*netz(k, 0.05, 0.4), farbe) for k, farbe in teile]


def _masse(lage):
    alle = np.vstack([e for e, _ in lage.values()])
    return [round(float(v), 2) for v in np.ptp(alle, axis=0)]


def _volumen(ecken, dreiecke):
    p = ecken[dreiecke]
    return float(abs(np.einsum("ij,ij->i", p[:, 0], np.cross(p[:, 1], p[:, 2])).sum()) / 6)


def _merke(ordner, name, daten):
    (ordner / f"{name}.json").write_text(json.dumps(daten, indent=1, ensure_ascii=False), encoding="utf-8")
    return daten


def _schrift_json(pfad, worte, bilder, p, gegenprobe=False):
    """Hält für die Kontrolle des G-Codes fest, wo in der Druckdatei eingelegte
    Schrift liegt. Alle Flächen stehen in Druckkoordinaten um die Mitte ihres
    Objekts (gewendet: y gespiegelt); wo das Objekt auf dem Bett liegt, sagt
    der Slicer (er rückt mehrere Objekte einer Datei zurecht).

    worte: Liste dict(name, text, objekt, wandgenerator, zeichen); jedes
    Zeichen ist dict(zeichen, form, linien, laenge) mit Fläche und
    Mittellinien (bambu.py prüft je Zeichen, ob eine schwarze Bahn seine
    Mittellinien abfährt).
    bilder: die Bilder der ersten Schicht, die bambu.py aus dem G-Code
    zeichnet: Liste dict(datei, objekt, rahmen, halb_gedreht). ``objekt``: nur
    dieses Objekt; ``rahmen``: Ausschnitt (x0, y0, x1, y1) um seine Mitte.
    gegenprobe: Die Datei ist absichtlich ohne die Einstellung geschrieben,
    die sie braucht; was der Slicer dann nicht sauber fährt, ist kein Fehler.
    """
    daten = {"einlage_schichten": round(p.einlage / SCHICHT),
             "filament": list(FARBEN).index(p.beschriftung_farbe) + 1,
             "bilder": bilder, "gegenprobe": gegenprobe,
             "worte": [{"name": w["name"], "text": w["text"], "objekt": w["objekt"],
                        "wandgenerator": w["wandgenerator"],
                        "zeichen": [{"zeichen": z["zeichen"], "laenge": round(z["laenge"], 3),
                                     "wkt": z["form"].wkt, "linien": z["linien"].wkt if z["laenge"] else ""}
                                    for z in w["zeichen"]]} for w in worte]}
    pfad.write_text(json.dumps(daten, ensure_ascii=False), encoding="utf-8")


def _worte_in_drucklage(worte, lege, faktor, objekt, wandgenerator):
    """Wörter (dict mit ``name``, ``text``, ``zeichen``) mit ihren Flächen auf das Druckbett gelegt."""
    return [{"name": w["name"], "text": w["text"], "objekt": objekt, "wandgenerator": wandgenerator,
             "zeichen": [{"zeichen": z["zeichen"], "form": lege(z["form"]), "linien": lege(z["linien"]),
                          "laenge": z["laenge"] * faktor} for z in w["zeichen"]]} for w in worte]


def _schilder(p, netze, objekt="deckel"):
    """Die eingelegten Wörter des Deckels für ``_schrift_json`` und das Bild
    der ersten Schicht um sie (Datei <objekt>-bahnen.png), alles auf dem
    Druckbett. Das Dreieck zählt als eigenes Zeichen ohne Mittellinie.
    Vertieft oder erhaben: keine Einlage, nichts zu prüfen."""
    if p.beschriftung != "eingelegt":
        return [], []
    lege, f = in_drucklage(netze, wenden=True, schwund=p.stoff.schwund), 1.0 / (1.0 - p.stoff.schwund)
    worte = []
    for s in entwurf.beschriftung(p):
        zeichen = list(s.zeichen)
        if s.zeiger is not None:
            zeichen.append({"zeichen": "Dreieck", "form": s.zeiger, "linien": s.zeiger.centroid, "laenge": 0.0})
        worte.append({"name": s.name, "text": s.text, "zeichen": zeichen})
    worte = _worte_in_drucklage(worte, lege, f, objekt, p.wandgenerator)
    alle = [z["form"].bounds for w in worte for z in w["zeichen"]]
    if not alle:
        return [], []
    rahmen = [round(fn(b[i] for b in alle) + d, 2)
              for fn, i, d in ((min, 0, -1.5), (min, 1, -1.5), (max, 2, 1.5), (max, 3, 1.5))]
    return worte, [{"datei": f"{objekt}-bahnen.png", "objekt": objekt, "rahmen": rahmen,
                    "halb_gedreht": p.logo_drehung == 180.0}]


def bau_schriftprobe(p=STANDARD):
    """Die Schriftprobe: die Wörter des Deckels in den Größen, die zur Wahl
    stehen. Eine Druckdatei mit einem Plättchen je Wandgenerator."""
    from . import schriftprobe
    ordner = AUS / "schriftprobe"
    ordner.mkdir(parents=True, exist_ok=True)
    schwund = p.stoff.schwund
    plan = schriftprobe.plan(p)
    netze = {o: {n: netz(k, 0.01, 0.2) for n, k in teile.items()} for o, teile in schriftprobe.baue(p).items()}
    lagen = {o: drucklage(t, wenden=True, schwund=schwund) for o, t in netze.items()}
    # auf dem Bett liegt die Sichtseite unten: Das Plättchen mit der größten Schrift liegt vorn
    platte = nebeneinander(dict(reversed(lagen.items())), schriftprobe.OBJEKTLUFT, achse=1)
    generator = {o: reihen[0]["q"].wandgenerator for o, (_, _, reihen) in plan.items()}
    schreibe_3mf(ordner / "schriftprobe.3mf", {o: teile_fuer_3mf(t) for o, t in platte.items()},
                 {o: WANDGENERATOR[g] for o, g in generator.items()})
    worte = []
    for o, (_, _, reihen) in plan.items():
        for teil, (e, d) in platte[o].items():
            schreibe_stl(ordner / f"{o}-{teil}.stl", e, d)
        lege = in_drucklage(netze[o], wenden=True, schwund=schwund)
        worte += _worte_in_drucklage([w for z in reihen for w in z["worte"]], lege, 1.0 / (1.0 - schwund), o,
                                     generator[o])
    # je Plättchen ein Bild der ersten Schicht: Der Slicer legt sie auf dem Bett selbst zurecht
    bilder = [{"datei": f"{o}-bahnen.png", "objekt": o, "rahmen": None, "halb_gedreht": False} for o in plan]
    _schrift_json(ordner / "schriftprobe-schrift.json", worte, bilder, p)
    # Gegenprobe: dieselbe Datei ohne die Einstellung des Wandgenerators. So slict Bambu Studio
    # die feine Zeile, wenn die Einstellung aus der 3MF nicht ankommt. Kein Bild: Zwei Bahnen, die
    # übereinander liegen, sehen gezeichnet aus wie eine; den Unterschied zeigen die Zahlen.
    schreibe_3mf(ordner / "schriftprobe-gegenprobe.3mf", {o: teile_fuer_3mf(t) for o, t in platte.items()})
    _schrift_json(ordner / "schriftprobe-gegenprobe-schrift.json", worte, [], p, gegenprobe=True)
    # Bilder: beide Plättchen, wie man sie von der Sichtseite sieht, das größere oben
    sicht = nebeneinander({o: drucklage(t) for o, t in netze.items()}, schriftprobe.OBJEKTLUFT, achse=1)
    szene = [(e, d, FARBEN[n] if n != "gehaeuse_weiss" else WEISS) for t in sicht.values() for n, (e, d) in t.items()]
    bild(ordner / "schriftprobe-sichtseite.png", szene, azimut=-90, hoehe=90, breite=1400)
    bild(ordner / "schriftprobe-schraeg.png", szene, azimut=-78, hoehe=38, breite=1400)
    daten = {"objekte": {o: {"masse": _masse(platte[o]), "breite": round(b, 2), "hoehe": round(h, 2),
                             "wandgenerator": generator[o],
                             "volumen": {n: round(_volumen(*x), 1) for n, x in netze[o].items()}}
                         for o, (b, h, _) in plan.items()},
             "text": " ".join(w["text"] for w in next(iter(plan.values()))[2][0]["worte"] if not w["angabe"]),
             "zeilen": [{"name": z["name"], "objekt": o, "hoehe": z["hoehe"], "strich": z["q"].schrift_strich,
                         "form": z["q"].schrift_form, "wandgenerator": z["q"].wandgenerator,
                         "breite": round(z["breite"], 2),
                         "inseln": [round(g.area, 2) for w in z["worte"] for g in schrift.vielecke(w["form"])],
                         "kleinste_insel": round(min(g.area for w in z["worte"] if not w["angabe"]
                                                     for g in schrift.vielecke(w["form"])), 2),
                         "komma": round(min(g.area for w in z["worte"] if w["angabe"]
                                            for g in schrift.vielecke(w["form"])), 2)}
                        for o, (_, _, reihen) in plan.items() for z in reihen],
             "kontrolle": lies_3mf(ordner / "schriftprobe.3mf")}
    return _merke(ordner, "schriftprobe", daten)


def bau_passproben(p=STANDARD):
    ordner = AUS / "passproben"
    ordner.mkdir(parents=True, exist_ok=True)
    schwund = p.stoff.schwund
    aus = {}
    brett = _platine_szene()

    k = k_schablone = netz(passproben.schablone(p))
    lage = schreibe_druckdateien(ordner, "schablone", {"gehaeuse_weiss": k}, schwund=schwund)
    bild(ordner / "schablone.png", [(*k, WEISS)], azimut=115, hoehe=42)
    bild(ordner / "schablone-mit-platine.png", [(*k, WEISS)] + brett, azimut=115, hoehe=42)
    aus["schablone"] = {"masse": _masse(lage), "volumen": _volumen(*k)}

    k = netz(passproben.steckerwand(p))
    lage = schreibe_druckdateien(ordner, "steckerwand", {"gehaeuse_weiss": k}, schwund=schwund)
    bild(ordner / "steckerwand.png", [(*k, WEISS)], azimut=125, hoehe=28)
    bild(ordner / "steckerwand-mit-platine.png", [(*k, WEISS)] + brett, azimut=125, hoehe=28)
    aus["steckerwand"] = {"masse": _masse(lage), "volumen": _volumen(*k)}

    k = netz(passproben.schachtprobe(p))
    lage = schreibe_druckdateien(ordner, "schachtprobe", {"gehaeuse_weiss": k}, wenden=True,
                                 schwund=schwund)
    bild(ordner / "schachtprobe.png", [(*lage["gehaeuse_weiss"], WEISS)], azimut=-62, hoehe=32, breite=1200)
    # so wird sie benutzt: auf dem gedruckten Unterteil, über der LED-Reihe der Platine
    unten = [(*netz(entwurf.unterteil(p)), WEISS)]
    gebrauch = unten + brett + [(*k, "#e9d9a8")]
    bild(ordner / "schachtprobe-gebrauch.png", gebrauch, azimut=-52, hoehe=34)
    # von schräg hinten oben: Dort bleibt das Unterteil offen, der Fuß des Schachts ist zu sehen
    bild(ordner / "schachtprobe-von-hinten.png", gebrauch, azimut=62, hoehe=52)
    bild(ordner / "schachtprobe-fuss.png", brett + [(*k, "#e9d9a8")], azimut=68, hoehe=24)
    aus["schachtprobe"] = {"masse": _masse(lage), "volumen": _volumen(*k)}

    for name in aus:
        aus[name]["kontrolle"] = lies_3mf(ordner / f"{name}.3mf")
    return _merke(ordner, "passproben", aus)


def _teile(p):
    """Körper und Netze von Unterteil und Deckel für einen Satz Stellgrößen."""
    deckel = entwurf.deckel(p)
    return {"unterteil": netz(entwurf.unterteil(p)),
            "deckel": {n: netz(k, 0.01, 0.2) for n, k in deckel.items()},
            "deckel_koerper": deckel}


def _szenen(teile):
    unten = [(*teile["unterteil"], WEISS)]
    oben = [(e, d, FARBEN[n] if n != "gehaeuse_weiss" else WEISS) for n, (e, d) in teile["deckel"].items()]
    return unten, oben


def _hoch(szene, dz):
    return [(e + [0, 0, dz], d, f) for e, d, f in szene]


def _halb_gedreht(szene):   # halbe Drehung um z: Blick von der Netzwerk-Seite, Logo lesbar
    return [(e * [-1, -1, 1], d, f) for e, d, f in szene]


def _umgedreht(szene):      # Standfläche nach oben
    return [(gewendet(e), d, f) for e, d, f in szene]


def _an_der_wand(szene, p, rand=28.0):
    """Dreht die Szene an die Wand und stellt ein Stück Wand dahinter."""
    wand = netz(quader(p.xa0 - rand, p.xa1 + rand, p.ya0 - rand, p.ya1 + rand + 30.0,
                       p.z_rueck - 1.5, p.z_rueck - 0.02))
    return [(e @ AN_DIE_WAND.T, d, f) for e, d, f in [(*wand, WAND)] + szene]


def bau_entwurf(p=STANDARD, name=NAME):
    ordner = AUS / name
    ordner.mkdir(parents=True, exist_ok=True)
    schwund = p.stoff.schwund
    t = time.time()
    neu = _teile(p)
    unterteil, deckel, deckel_koerper = neu["unterteil"], neu["deckel"], neu["deckel_koerper"]
    clip = netz(entwurf.clip(p))
    lehre = netz(entwurf.wandlehre(p))
    schiene = netz(entwurf.schiene(p))
    schrauben = [(*netz(k), STAHL) for k in entwurf.wandschrauben(p)]

    # Die Einlagen müssen ihre Taschen genau füllen, sonst fehlt ein Schnitt.
    einlagen = sum(k.volume for n, k in deckel_koerper.items() if n != "gehaeuse_weiss")
    soll = sum(_volumen(*deckel[n]) for n in deckel if n != "gehaeuse_weiss")
    assert abs(einlagen - soll) < 0.5, "Netz und Körper der Einlagen weichen ab"

    # ---- Druckdateien ------------------------------------------------------
    lagen = {
        "unterteil": schreibe_druckdateien(ordner, "unterteil", {"gehaeuse_weiss": unterteil},
                                           schwund=schwund),
        "deckel": schreibe_druckdateien(ordner, "deckel", deckel, wenden=True, schwund=schwund,
                                        einstellungen=WANDGENERATOR[p.wandgenerator]),
    }
    platte = nebeneinander(lagen)
    schreibe_3mf(ordner / f"{name}.3mf", {o: teile_fuer_3mf(t_) for o, t_ in platte.items()},
                 {"deckel": WANDGENERATOR[p.wandgenerator]})
    _schrift_json(ordner / "deckel-schrift.json", *_schilder(p, deckel), p)
    # Der Deckel in den anderen Schriftgrößen und ohne Beschriftung (v0.2)
    andere = {}
    for datei, (aenderung, unter) in DECKEL_DATEIEN.items():
        q = p.mit(**aenderung)
        netze_q = {n: netz(k, 0.01, 0.2) for n, k in entwurf.deckel(q).items()}
        schreibe_druckdateien(ordner / unter, datei, netze_q, wenden=True, schwund=schwund,
                              einstellungen=WANDGENERATOR[q.wandgenerator])
        worte, bilder = _schilder(q, netze_q, datei)
        if worte:
            _schrift_json(ordner / unter / f"{datei}-schrift.json", worte, bilder, q)
        andere[datei] = (q, [(e, d, FARBEN[n] if n != "gehaeuse_weiss" else WEISS)
                             for n, (e, d) in netze_q.items()])
    # Zubehör: eigene Dateien, nicht Teil der Grundform
    zubehoer = {
        "hutschienen-clip": schreibe_druckdateien(ordner, "hutschienen-clip", {"gehaeuse_weiss": clip},
                                                  wenden=True, schwund=schwund),
        "bohrlehre": schreibe_druckdateien(ordner, "bohrlehre", {"gehaeuse_weiss": lehre},
                                           schwund=schwund),
    }

    # ---- Bilder: liegend ---------------------------------------------------
    b = ordner
    s_unten, s_deckel = _szenen(neu)
    s_clip = [(*clip, CLIPGRAU)]
    s_schiene = [(*schiene, STAHL)]
    brett = _platine_szene()
    fuesse = _fuesse(p)
    zu = s_unten + s_deckel
    liegend = zu + brett + fuesse
    bild(b / "liegend-stecker.png", liegend, azimut=118, hoehe=30)
    bild(b / "liegend-led-seite.png", liegend, azimut=-62, hoehe=30)
    bild(b / "liegend-usb-seite.png", liegend, azimut=172, hoehe=16)
    bild(b / "liegend-flach.png", liegend, azimut=-105, hoehe=8)
    bild(b / "draufsicht.png", _halb_gedreht(zu + _marken(p)), azimut=-90, hoehe=90, breite=1200)
    bild(b / "draufsicht-ohne-beschriftung.png",
         _halb_gedreht(s_unten + andere["deckel-ohne-beschriftung"][1] + _marken(p)), azimut=-90, hoehe=90,
         breite=1200)
    # liegend, von der Seite der Netzwerkbuchsen: Dort steht die Schrift aufrecht
    bild(b / "liegend-beschriftet.png", liegend, azimut=118, hoehe=46)
    zeichnungen = schriftbild.baue(b, p)
    bild(b / "unterseite.png", _umgedreht(s_unten + _marken_unten(p) + fuesse), azimut=-90, hoehe=90,
         breite=1200)
    bild(b / "unterseite-schraeg.png", _umgedreht(zu + _marken_unten(p) + fuesse[:2]), azimut=-125,
         hoehe=38)
    bild(b / "ansicht-offen.png", s_unten + brett, azimut=118, hoehe=42)
    bild(b / "ansicht-deckel-innen.png", _umgedreht(s_deckel), azimut=-118, hoehe=40)
    # Der Lichtschacht vorher und nachher: Streifen des Deckels, Fuß nach oben
    alt = p.mit(**SCHACHT_V01)
    streifen = lambda q: [(*netz(passproben.schachtprobe(q)), WEISS)]
    bild(b / "schacht-vorher.png", _umgedreht(streifen(alt)), azimut=-112, hoehe=30, breite=1200)
    bild(b / "schacht-nachher.png", _umgedreht(streifen(p)), azimut=-112, hoehe=30, breite=1200)
    schachtbild.baue(b, p)
    explosion = _hoch(s_deckel, 30) + _hoch(brett, 14) + s_unten + _hoch(fuesse, -12)
    bild(b / "explosion.png", explosion, azimut=118, hoehe=20, breite=1200)

    # ---- Bilder: an der Wand -----------------------------------------------
    kabel = _kabel(p)
    bild(b / "wand-vorn.png", _an_der_wand(zu + _marken(p) + kabel, p), azimut=-90, hoehe=0, breite=1200)
    bild(b / "wand-schraeg.png", _an_der_wand(zu + kabel, p), azimut=-128, hoehe=14)
    bild(b / "wand-von-unten.png", _an_der_wand(zu + brett + kabel, p), azimut=-60, hoehe=-28)
    # Schnitt durch eine Wandschraube, hängend: rechts die Wand, unten die Netzwerk-Seite
    mauer = netz(quader(p.xa0 - 2, p.xa1 + 2, p.ya0 - 6, p.ya1 + 6, p.z_rueck - 12.0, p.z_rueck))
    haengend = [(e @ AN_DIE_WAND.T, d, f)
                for e, d, f in [(*mauer, WAND)] + s_unten + s_deckel + brett + schrauben]
    schnittbild(b / "schnitt-wand.png", haengend, "x", -p.wandschrauben[0][0])

    # ---- Schnitte, Varianten, Zubehör, Drucklage ---------------------------
    # längs durch die mittlere LED und einen Stift der Stiftleiste, quer durch den Haltestift
    alles = s_unten + s_deckel + brett
    schnittbild(b / "schnitt-laengs.png", alles, "x", float(m.UART_X[0]) + 0.2)
    schnittbild(b / "schnitt-quer.png", alles, "y", float(m.LOCH_Y))
    # Etikett auf dem Deckel statt auf der Unterseite
    q = _teile(p.mit(**ETIKETT_DECKEL))
    bild(b / "etikett-deckel.png", _halb_gedreht(sum(_szenen(q), []) + _marken(p.mit(**ETIKETT_DECKEL))),
         azimut=-90, hoehe=90, breite=1200)
    # ohne Lüftung und ohne LED-Anzeige
    q = p.mit(lueftung=False, led_anzeige="keine")
    bild(b / "variante-geschlossen.png", [(*netz(entwurf.unterteil(q)), WEISS)] + s_deckel + brett + fuesse,
         azimut=-62, hoehe=30)
    # nur liegend: ohne Sockel und Schlüssellöcher
    q = p.mit(wandmontage=False)
    flach = [(*netz(entwurf.unterteil(q)), WEISS)] + s_deckel + brett + _fuesse(q)
    bild(b / "variante-flach.png", flach, azimut=-105, hoehe=8)
    bild(b / "zubehoer-clip.png", _umgedreht(zu + s_clip), azimut=-60, hoehe=35)
    bild(b / "zubehoer-hutschiene.png", _umgedreht(zu + s_clip + s_schiene), azimut=-25, hoehe=20)
    bild(b / "zubehoer-bohrlehre.png", [(*lehre, CLIPGRAU)], azimut=-70, hoehe=40, breite=900)
    drucken = [(e, d, FARBEN[n] if n != "gehaeuse_weiss" else WEISS)
               for teile in platte.values() for n, (e, d) in teile.items()]
    bild(b / "drucklage.png", drucken, azimut=-70, hoehe=38)
    bild(b / "drucklage-farben.png", [s for s in drucken if s[2] != WEISS] or drucken,
         azimut=-90, hoehe=90, breite=1000)

    daten = {
        "name": name,
        "material": p.stoff.name,
        "schwund": schwund,
        "aussen": [round(float(v), 2) for v in p.aussen],
        "masse_mit_saeulen": _masse({"u": unterteil, **deckel}),
        "deckel_v01_volumen": round(float(entwurf.deckel(alt)["gehaeuse_weiss"].volume), 1),
        "beschriftung": [{"name": s.name, "text": s.text, "teil": s.teil, "kante": s.kante,
                          "rahmen": [round(v, 2) for v in s.form.bounds]} for s in entwurf.beschriftung(p)],
        "zeichnungen": zeichnungen,
        "deckel_dateien": {k: deckel_datei(k) for k in SCHRIFTGROESSEN},
        "hoehe_ohne_wandmontage": round(float(p.mit(wandmontage=False).aussen[2]), 2),
        "tiefe_mit_clip_und_schiene": round(float(p.z_deckel - p.z_rueck + p.clip_platte
                                                  + p.schiene_tiefe), 2),
        "teile": {o: {"masse": _masse(l), "volumen": {n: round(_volumen(*x), 1) for n, x in l.items()}}
                  for o, l in {**lagen, **zubehoer}.items()},
        "kontrolle": lies_3mf(ordner / f"{name}.3mf"),
        "sekunden": round(time.time() - t, 1),
    }
    return _merke(ordner, "entwurf", daten)


def bau_massbild():
    from . import massbild
    ordner = AUS / "massmodell"
    ordner.mkdir(parents=True, exist_ok=True)
    massbild.massmodell(ordner)
    massbild.messblatt(ordner)
    (ordner / "massmodell.md").write_text(m.tabelle_md() + "\n", encoding="utf-8")
    return sorted(q.name for q in ordner.iterdir())


def bau_probeplatte():
    from . import probe_platte
    return probe_platte.baue_dateien(AUS / "probe-platte")

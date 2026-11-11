"""Passproben für die Mango-Platine: einfarbig, schnell gedruckt, vor dem Gehäuse.

Die Passproben sind keine eigenen Entwürfe, sondern Ausschnitte von Unterteil
und Deckel aus ``entwurf.py``: Was hier passt, passt im Gehäuse.

  Schablone      flaches Unterteil bis 2,5 mm über die Platine: Umriss, Spiel,
                 Auflagen, Stift, seitliche Lage aller Stecker; Kerben im Rand
                 zeigen, wo LEDs und Schalter erwartet werden.
  Steckerwand    die beiden Wände mit Steckern in voller Höhe: Höhen der
                 Öffnungen, ob Stecker mit Griff einrasten, Büroklammer im
                 Reset-Loch.
  Schachtprobe   ein Streifen des Deckels über der LED-Reihe, mit Falz,
                 Rastwulst, Lichtschacht und den drei Fenstern. Er wird auf
                 das gedruckte Unterteil gesetzt wie der Deckel. Zeigt, ob der
                 Schacht auf der Platine aufliegt, ohne den Deckel anzuheben,
                 und wo noch Licht austritt.

Die Fensterstufen (fünf Fenster von 0,2 bis 1,0 mm) haben am 09.10.2026
entschieden: 0,2 mm. Sie sind damit erledigt und nicht mehr Teil des Baus.
Die erste Schachtprobe (Schacht auf Füßen, in der Schablone) hat der Betreiber
am 09.10.2026 gedruckt: bestanden (massmodell.py). Sie ist durch den Streifen
ersetzt, seit der Schacht bis auf die Platine reicht.

Auch das Unterteil hat der Betreiber gedruckt (10.10.2026, mit dem ganzen
Gehäuse v0.1) und den Deckel v0.2 (gemeldet am 11.10.2026: "ich habe das
komplette gehäuse v0.2 gedruckt und es sitzt perfekt. Licht passt auch").
Beide stehen deshalb mit im festgehaltenen Stand.
"""
import hashlib
import json
from pathlib import Path

from build123d import Axis, chamfer

from . import massmodell as m
from .entwurf import UEBER, deckel, unterteil
from .formen import prisma, quader, rundquader
from .parameter import DECKEL_V02, STANDARD

RAND_UEBER_PLATINE = 2.5     # Oberkante des Schablonenrands über der Platinenoberseite
SCHABLONE_BODEN = 1.2
KERBE = (1.2, 1.0)           # Breite oben, Tiefe
STREIFEN = 7.0               # Breite des Bodens, der an der Steckerwand stehen bleibt

# Der festgehaltene Stand der Passproben: der, zu dem die Rückmeldung des
# Betreibers eingearbeitet ist. Die Prüfung meldet, wenn die Passproben davon
# abweichen; nach einer gewollten Änderung wird er neu festgehalten.
GEDRUCKT = Path(__file__).with_name("passproben_gedruckt.json")

SCHACHT_TIEFE = 6.0          # Streifen der Schachtprobe: so weit von der LED-Kante nach innen (y);
                             # endet vor dem zweiten Niederhalter, der bei y = 7 beginnt


def _kerbe(entlang, wo, a0, a1, z):
    """V-Kerbe im Rand; entlang "x": Kerbe liegt bei y = wo und läuft in x."""
    b, t = KERBE
    profil = [(wo - b / 2, z + UEBER), (wo, z - t), (wo + b / 2, z + UEBER)]
    return prisma(profil, entlang, a0, a1)


def schablone_kerben(p=STANDARD):
    """Was die Kerben im Rand markieren: Liste (Seite, Lage, Bedeutung)."""
    kerben = [("LED-Kante", float(x), f"LED {x.notiz.split(',')[0]}") for x in m.LED_X]
    # Die zweite Stellung liegt nur einen Hub daneben: Zwei Kerben ließen
    # dazwischen einen Zahn stehen, der schmaler ist als eine Bahn.
    kerben.append(("USB-Kante", float(m.SCHALTER_Y),
                   f"Schalterknopf; die zweite Stellung liegt {m.zahl(m.SCHALTER_HUB)} mm näher an der LED-Kante"))
    return kerben


def schablone(p=STANDARD):
    z1 = RAND_UEBER_PLATINE
    k = unterteil(p, anbauten=False, z_oben=z1, boden=SCHABLONE_BODEN)
    # Sichtfenster im Boden: von unten ist zu sehen, wo Bauteile der
    # Unterseite an Auflagen stoßen. Die Säule mit dem Stift bleibt stehen.
    zb = p.z_boden_innen
    fenster = rundquader(6.0, m.PLATINE_X - 6.0, m.LOCH_Y + 5.0, m.PLATINE_Y - 5.0,
                         zb - SCHABLONE_BODEN - UEBER, zb + UEBER, 2.0)
    schnitte = [fenster]
    for seite, lage, _ in schablone_kerben(p):
        if seite == "LED-Kante":
            schnitte.append(_kerbe("y", lage, p.ya0 - UEBER, p.yi0 + UEBER, z1))
        else:
            schnitte.append(_kerbe("x", lage, p.xa0 - UEBER, p.xi0 + UEBER, z1))
    return k - schnitte


def steckerwand(p=STANDARD):
    einfach = p.mit(lueftung=False, rastwulst=0.0, etikett="keins")
    k = unterteil(einfach, anbauten=False)
    z0, z1 = p.z_boden - 1.0, p.z_wand + 1.0
    winkel = quader(p.xa0 - 1.0, p.xa1 + 1.0, p.yi1 - STREIFEN, p.ya1 + 1.0, z0, z1)
    winkel += quader(p.xa0 - 1.0, p.xi0 + STREIFEN, p.ya0 - 1.0, p.ya1 + 1.0, z0, z1)
    k = k & winkel
    # Marke außen: bis hierher schließt später die Zunge des Deckels den
    # Schlitz über dem Netzwerkblock.
    zm = m.RJ45_HOEHE + p.oeffnung_luft
    r = m.rj45()
    marken = [quader(x0, x1, p.ya1 - 0.4, p.ya1 + UEBER, zm - 0.2, zm + 0.2)
              for x0, x1 in ((r.x0 - p.oeffnung_luft - 3.0, r.x0 - p.oeffnung_luft + UEBER),
                             (r.x1 + p.oeffnung_luft - UEBER, r.x1 + p.oeffnung_luft + 2.0))]
    return k - marken


def schachtprobe(p=STANDARD):
    """Der Lichtschacht des Deckels als Passprobe, in Platinenkoordinaten.

    Ein Streifen des Deckels über die ganze Breite, von der LED-Seite bis
    hinter den Schacht, ohne jede Zutat: Falz und Rastwulst der LED-Seite,
    Schacht, Fenster und ein Stück des Niederhalters auf der Antennenecke
    gehören dazu.
    Er liegt wie der Deckel auf der Oberkante von drei Wänden des Unterteils;
    damit prüft er dieselbe Maßkette (Wandoberkante bis Platine), an der der
    Schacht im Gehäuse hängt. Hinter dem Streifen bleibt das Unterteil offen:
    Von dort sieht man den Fuß des Schachts auf der Platine.
    Gedruckt wird er gewendet, mit den Fenstern auf der Platte, wie der Deckel.
    """
    streifen = quader(p.xa0 - 1.0, p.xa1 + 1.0, p.ya0 - 1.0, SCHACHT_TIEFE,
                      p.z_boden, p.z_deckel + 1.0)
    # ohne Beschriftung: Die Probe prüft den Schacht, und ihr Stand ist festgehalten
    return deckel(p.mit(beschriftung="keine"))["gehaeuse_weiss"] & streifen


def deckel_v02(p=STANDARD):
    """Der weiße Körper des Deckels v0.2 (ohne Beschriftung): Der Betreiber hat
    ihn mit dem ganzen Gehäuse v0.2 gedruckt, "es sitzt perfekt. Licht passt
    auch" (11.10.2026). Jeder beschriftete Deckel ist dieser Körper, aus dem
    nur die Schrift ausgespart ist."""
    return deckel(p.mit(**DECKEL_V02))["gehaeuse_weiss"]


PASSPROBEN = {"schablone": schablone, "steckerwand": steckerwand, "schachtprobe": schachtprobe}
# Was der Betreiber vom Gehäuse gedruckt hat und was weiter gelten soll:
# Name -> (Körper, Ordner unter aus/ mit dem STL, Datei des STL darin)
GEDRUCKTE_TEILE = {"unterteil": (unterteil, "gehaeuse", "unterteil.stl"),
                   "deckel_v02": (deckel_v02, "gehaeuse", "vergleich/deckel-ohne-beschriftung-gehaeuse_weiss.stl")}


# ---- Stand der gedruckten Passproben ---------------------------------------

def fingerabdruck(koerper):
    """Volumen, Oberfläche, Hüllquader und Schwerpunkt: ändert sich, sobald sich die Form ändert."""
    b, c = koerper.bounding_box(), koerper.center()
    return {"volumen": round(koerper.volume, 3), "flaeche": round(koerper.area, 3),
            "min": [round(v, 4) + 0.0 for v in (b.min.X, b.min.Y, b.min.Z)],   # + 0.0: nie "-0.0"
            "max": [round(v, 4) for v in (b.max.X, b.max.Y, b.max.Z)],
            "schwerpunkt": [round(v, 4) for v in (c.X, c.Y, c.Z)]}


def gedruckter_stand():
    return json.loads(GEDRUCKT.read_text(encoding="utf-8")) if GEDRUCKT.exists() else None


def _teile():
    """Alles, was im festgehaltenen Stand steht: Name -> (Körper, Abschnitt, Ordner des STL, Datei)."""
    teile = {name: (bau, "passproben", "passproben", f"{name}.stl") for name, bau in PASSPROBEN.items()}
    teile.update({name: (bau, "gehaeuse", ordner, datei) for name, (bau, ordner, datei) in GEDRUCKTE_TEILE.items()})
    return teile


def vergleich_mit_gedruckt(p=STANDARD, stl_ordner=None, toleranz=0.01):
    """Vergleicht Passproben und gedruckte Gehäuseteile mit dem festgehaltenen Stand.

    ``stl_ordner``: Abschnitt -> Ordner mit den STL. Rückgabe: Liste {name,
    abschnitt, gleich, abweichung, stl_gleich}; ``stl_gleich`` ist None, wenn
    kein STL zum Vergleichen da ist. Leer, wenn kein Stand festgehalten ist.
    """
    stand = gedruckter_stand()
    if not stand:
        return []
    teile, aus = _teile(), []
    for abschnitt in ("passproben", "gehaeuse"):
        for name, soll in stand.get(abschnitt, {}).items():
            zeile = {"name": name, "abschnitt": abschnitt, "gleich": False, "abweichung": float("inf"),
                     "stl_gleich": None}
            aus.append(zeile)
            if name not in teile:
                continue
            ist = fingerabdruck(teile[name][0](p))
            ab = max(abs(a - b) for k in ist
                     for a, b in zip(*[w if isinstance(w, list) else [w] for w in (ist[k], soll[k])]))
            ordner = (stl_ordner or {}).get(teile[name][2])
            datei = Path(ordner) / teile[name][3] if ordner else None
            if datei and datei.exists() and soll.get("stl_sha256"):
                zeile["stl_gleich"] = hashlib.sha256(datei.read_bytes()).hexdigest() == soll["stl_sha256"]
            zeile.update(gleich=ab <= toleranz, abweichung=round(ab, 4))
    return aus


def stand_festhalten(p=STANDARD, anlass="", stl_ordner=None):
    """Hält die jetzigen Passproben und gedruckten Teile als Stand fest (nach
    einer gewollten Änderung der Maße): python -m gehaeuse.passproben "Anlass"."""
    from datetime import date

    from .ausgabe import AUS
    from .bau import NAME
    stl_ordner = stl_ordner or {"passproben": AUS / "passproben", "gehaeuse": AUS / NAME}
    stand = {"stand": date.today().strftime("%d.%m.%Y"), "anlass": anlass, "passproben": {}, "gehaeuse": {}}
    for name, (bau, abschnitt, ordner, datei) in _teile().items():
        stand[abschnitt][name] = fingerabdruck(bau(p))
        stl = Path(stl_ordner[ordner]) / datei
        if stl.exists():
            stand[abschnitt][name]["stl_sha256"] = hashlib.sha256(stl.read_bytes()).hexdigest()
    GEDRUCKT.write_text(json.dumps(stand, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return stand


if __name__ == "__main__":
    import sys
    print(json.dumps(stand_festhalten(anlass=" ".join(sys.argv[1:])), indent=1, ensure_ascii=False))

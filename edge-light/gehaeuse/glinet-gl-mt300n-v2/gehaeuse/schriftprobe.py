"""Schriftprobe: die Wörter des Deckels in den Schriftgrößen, die zur Wahl stehen.

Zeigt in zwanzig Minuten, wie die Schrift gedruckt aussieht, bevor der Deckel
neu gedruckt wird. Gebaut wie der Deckel: Die Sichtseite liegt beim Druck auf
der Platte, die schwarze Schrift ist drei Schichten tief eingelegt.

Jede Zeile trägt die vier Wörter des Deckels in einer Größe aus
``parameter.SCHRIFTGROESSEN`` und dahinter ihre Höhe in Millimetern, von der
bisherigen (oben) zur kleinsten (unten). Jede Zeile ist so gebaut wie der
Deckel in dieser Größe: dieselben Zeichen, derselbe Strich, derselbe
Wandgenerator.

Zeilen mit verschiedenem Wandgenerator können nicht in einem Objekt liegen:
Bambu Studio stellt ihn je Objekt ein. Die Probe besteht deshalb aus zwei
Plättchen in einer Druckdatei: ``schriftprobe`` (Voreinstellung "klassisch")
und ``schriftprobe-fein`` (Arachne).
"""
from build123d import Compound
from shapely import affinity

from . import schrift
from .formen import rundquader
from .logo import einlage
from .parameter import SCHRIFTGROESSEN, STANDARD

DICKE = 1.2          # sechs Schichten: 0,6 mm Einlage, 0,6 mm Weiß dahinter
ECKRADIUS = 2.0
RAND = 2.5           # Schrift bis Plattenkante
ZEILENLUFT = 2.2
WORTLUFT = 2.4       # zwischen zwei Wörtern
ANGABENLUFT = 4.0    # zwischen dem letzten Wort und der Größenangabe
OBJEKTLUFT = 6.0     # zwischen den beiden Plättchen in der Druckdatei; der Slicer rückt sie um 2 mm zusammen
OBJEKTE = {"klassisch": "schriftprobe", "arachne": "schriftprobe-fein"}


def angabe(hoehe):
    """Die Höhe einer Zeile, wie sie auf der Probe steht: "4,5"."""
    return f"{hoehe:.1f}".replace(".", ",")


def zeilen(p=STANDARD):
    """Die Zeilen der Probe von oben nach unten: Liste dict mit ``name``
    (Kennung der Größe), ``q`` (die Stellgrößen des Deckels in dieser Größe),
    ``objekt`` und ``worte``. Jedes Wort: dict(name, text, form, zeichen,
    laenge, zugelaufen, angabe); die Flächen liegen mit der linken unteren
    Ecke der Zeile im Ursprung."""
    texte = [t.strip() for t in (p.text_wan, p.text_lan, p.text_strom, p.text_usb) if t.strip()]
    reihen = []
    for kennung, aenderung in SCHRIFTGROESSEN.items():
        q = p.mit(**aenderung)
        satz = (q.schrift_hoehe, q.schrift_strich, q.schrift_luft)
        worte, x = [], 0.0
        # die Größenangabe steht in den offenen Formen: Nur sie kennen das Komma
        for text, form, luft in [*((t, q.schrift_form, WORTLUFT) for t in texte),
                                 (angabe(q.schrift_hoehe), "offen", 0.0)]:
            ist_angabe = luft == 0.0
            if ist_angabe:
                x += ANGABENLUFT - WORTLUFT
            flaeche, breite, zu = schrift.flaeche(text, *satz, q.schrift_abstand, form)
            schiebe = lambda g, dx=x: affinity.translate(g, dx, 0)
            worte.append({"name": f"{kennung}/{text}", "text": text, "angabe": ist_angabe,
                          "form": schiebe(flaeche), "zugelaufen": zu,
                          "laenge": schrift.laenge(text, *satz, form),
                          "zeichen": [{**z, "form": schiebe(z["form"]), "linien": schiebe(z["linien"])}
                                      for z in schrift.zeichenweise(text, *satz, q.schrift_abstand, form)]})
            x += breite + luft
        reihen.append({"name": kennung, "q": q, "objekt": OBJEKTE[q.wandgenerator], "worte": worte,
                       "breite": x, "hoehe": q.schrift_hoehe})
    return reihen


def plan(p=STANDARD):
    """Legt die Zeilen auf die Plättchen: {Objektname: (Breite, Höhe, Zeilen)}.
    Alle Plättchen sind gleich breit; die Flächen liegen in den Koordinaten
    ihres Plättchens (Sichtseite, linke untere Ecke im Ursprung)."""
    reihen = zeilen(p)
    breite = max(z["breite"] for z in reihen) + 2 * RAND
    aus = {}
    for objekt in dict.fromkeys(z["objekt"] for z in reihen):
        eigene = [z for z in reihen if z["objekt"] == objekt]
        hoehe = sum(z["hoehe"] for z in eigene) + (len(eigene) - 1) * ZEILENLUFT + 2 * RAND
        y = hoehe - RAND
        for z in eigene:
            y -= z["hoehe"]
            for w in z["worte"]:
                schiebe = lambda g, dy=y: affinity.translate(g, RAND, dy)
                w["form"] = schiebe(w["form"])
                w["zeichen"] = [{**q, "form": schiebe(q["form"]), "linien": schiebe(q["linien"])}
                                for q in w["zeichen"]]
            y -= ZEILENLUFT
        aus[objekt] = (breite, hoehe, eigene)
    return aus


def baue(p=STANDARD):
    """Die Körper mit der Sichtseite oben (z = DICKE):
    {Objektname: {"gehaeuse_weiss", "schrift_schwarz"}}."""
    aus = {}
    for objekt, (breite, hoehe, reihen) in plan(p).items():
        platte = rundquader(0, breite, 0, hoehe, 0, DICKE, ECKRADIUS)
        schwarz = [k for z in reihen for w in z["worte"]
                   for k in einlage(schrift.flaechen(w["form"]), DICKE - p.einlage, p.einlage).solids()]
        aus[objekt] = {"gehaeuse_weiss": platte.cut(*schwarz), "schrift_schwarz": Compound(children=schwarz)}
    return aus

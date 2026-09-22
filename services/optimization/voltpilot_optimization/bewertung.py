"""AP-16 NW-1: reine Bewertung, ohne Uhr, Datenbank oder Einstufungs-Schreibweg.

Aus k_faelle.py (AP-16, 22.09.2026): menge, prozent und rangliste.
Reportbau und Beispielwelt entfallen. KR4 korrigiert den dortigen Vergleich
angezeigter Prozente: Schwellen werden ausschließlich per Kreuzprodukt geprüft.
Alle drei Zwillinge fahren docs/contracts/v2/bewertung-vectors.json.
"""
from decimal import Decimal, ROUND_HALF_UP, localcontext
from functools import wraps

STARTWERTE = dict(K1="10", K2="80", K3="100000", K5="90", K6="5", K7=12, K8="80", mindest_monate=3)
TRAEGER = ("Strom", "Gas", "Wärme", "Kälte", "Wasser", "Druckluft")
URTEILE = ["ueber_schwelle", "unter_schwelle", "nicht_anwendbar", "nicht_belastbar", "erfuellt", "vorbehalt_datenlage", "vorbehalt_ersatzwerte", "unter_zwoelf", "vorlaeufig"]
ABDECKUNG = ["gemessen", "geplant", "ersatz", "ungemessen"]
EINSTUFUNGEN = ["wesentlich", "nicht_wesentlich", "offen"]
UEBER, UNTER, NA, NB = "ueber_schwelle", "unter_schwelle", "nicht_anwendbar", "nicht_belastbar"


def dez(wert):
    return None if wert is None else Decimal(wert)


def text(wert):
    if wert is None:
        return None
    if wert == 0:
        return "0"
    value = format(wert, "f")
    return value.rstrip("0").rstrip(".") if "." in value else value


def exakt(funktion):
    """Eingangsabhängige Präzision auch für Mengen jenseits der Decimal-Vorgabe 28."""
    def stellen(wert):
        if isinstance(wert, dict):
            return sum(stellen(v) for v in wert.values())
        if isinstance(wert, (list, tuple)):
            return sum(stellen(v) for v in wert)
        return len(str(wert))

    @wraps(funktion)
    def rechnen(*args, **kwargs):
        with localcontext() as ctx:
            ctx.prec = max(50, stellen(args) + stellen(kwargs) + 32)
            return funktion(*args, **kwargs)
    return rechnen


def prozent(teil, ganzes):
    """Nur Anzeige: eine Nachkommastelle, HALF_UP; ein Nullnenner hat keinen Anteil."""
    if teil is None or ganzes is None or ganzes <= 0:
        return None
    with localcontext() as ctx:
        ctx.prec = max(50, len(teil.as_tuple().digits) + len(ganzes.as_tuple().digits) + 10)
        return format((teil * 100 / ganzes).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f")


def schwelle(teil, ganzes, grenze):
    if teil is None or ganzes is None or ganzes <= 0:
        return NA
    return UEBER if teil * 100 >= ganzes * dez(grenze) else UNTER


@exakt
def nenner(anlagen):
    werte = [None if not a["hauptzaehler"] or any(a[k] is None for k in ("zufluss", "abgabe", "laden"))
             else dez(a["zufluss"]) - dez(a["abgabe"]) - dez(a["laden"]) for a in anlagen]
    vorhanden = sum(w is not None for w in werte)
    return {"wert": text(sum(werte, Decimal(0))) if vorhanden == len(werte) else None,
            "vorhanden": vorhanden, "gesamt": len(werte),
            "zustand": "vollständig" if vorhanden == len(werte) else "unvollständig",
            "anlagen": [{"kennung": a["kennung"], "wert": text(w)} for a, w in zip(anlagen, werte)]}


def relevante(messstellen, traeger):
    if traeger not in TRAEGER:
        raise ValueError("traeger_unbekannt")
    result = [m for m in messstellen if m["traeger"] == traeger and m["direkt"] and not m["archiviert"] and m["art"] == "gemessen"]
    if len({m["kennung"] for m in result}) != len(result):
        raise ValueError("messstelle_doppelt")
    return result


@exakt
def menge(messstellen, traeger):
    ms = relevante(messstellen, traeger)
    werte = [dez(m["wert"]) for m in ms if m["wert"] is not None]
    ersatz = sum((dez(m["ersatz"]) for m in ms if m["wert"] is not None), Decimal(0))
    return {"menge": text(sum(werte, Decimal(0))) if werte else None,
            "ersatz": text(ersatz) if werte else None,
            "zustand": "keine Werte" if not werte else "unvollständig" if len(werte) != len(ms)
            else "mit Ersatzwert" if ersatz > 0 else "vollständig"}


@exakt
def rangliste(e):
    """Eine Trägergruppe; Qualitätsanteile stammen aus den vorhandenen Monatswerten."""
    if e["traeger"] not in TRAEGER:
        raise ValueError("traeger_unbekannt")
    k = e["kriterien"]
    n = dez(e["nenner"]["wert"]) if e["traeger"] == "Strom" and e["nenner"]["zustand"] == "vollständig" else None
    zeilen = sorted(e["einsaetze"], key=lambda x: (x["menge"] is None, -dez(x["menge"]) if x["menge"] is not None else 0, x["kennung"]))
    zugeordnet = sum((dez(x["menge"]) for x in zeilen if x["menge"] is not None), Decimal(0))
    k8 = schwelle(zugeordnet, n, k["K8"])
    k7 = "erfuellt" if e["monate"] >= k["K7"] else "vorlaeufig" if e["monate"] < k["mindest_monate"] else "unter_zwoelf"
    aus, kum = [], Decimal(0)
    for rang, x in enumerate(zeilen, 1):
        m = dez(x["menge"])
        k1 = schwelle(m, n, k["K1"])
        k2 = NA if e["traeger"] != "Strom" or m is None or zugeordnet == 0 else NB if k8 != UEBER else UEBER if kum * 100 < zugeordnet * dez(k["K2"]) else UNTER
        k3 = NA if e["traeger"] != "Strom" or m is None or e["monate"] != 12 else UEBER if m >= dez(k["K3"]) else UNTER
        kum += m if m is not None else Decimal(0)
        aus.append({"kennung": x["kennung"], "menge": text(m), "rang": rang if m is not None and e["traeger"] == "Strom" else None,
                    "anteil_prozent": prozent(m, n), "kumuliert_zugeordnet_prozent": prozent(kum, zugeordnet) if m is not None and e["traeger"] == "Strom" else None,
                    "K1": k1, "K2": k2, "K3": k3, "K4": x["begruendung"],
                    "K5": "erfuellt" if x["datenlage_prozent"] is not None and dez(x["datenlage_prozent"]) >= dez(k["K5"]) else "vorbehalt_datenlage",
                    "K6": "erfuellt" if x["ersatz_prozent"] is not None and dez(x["ersatz_prozent"]) <= dez(k["K6"]) else "vorbehalt_ersatzwerte",
                    "vorschlag": UEBER if UEBER in (k1, k2, k3) else UNTER,
                    "zustand": "keine Werte" if m is None else "unvollständig" if e["nenner"]["zustand"] != "vollständig" and e["traeger"] == "Strom" else "vollständig"})
    return {"nenner": text(n), "anlagen": f'{e["nenner"]["vorhanden"]} von {e["nenner"]["gesamt"]}',
            "zugeordnet": text(zugeordnet), "rest": text(n - zugeordnet) if n is not None else None,
            "abdeckung_prozent": prozent(zugeordnet, n), "K8": k8, "K7": k7, "einsaetze": aus}


@exakt
def abdeckung(e):
    """Derselbe Schnitt je Einsatz, Ort oder Umfang; Rest immer aus der Bilanz."""
    ms = relevante(e["messstellen"], e["traeger"])
    m = menge(ms, e["traeger"])
    restwerte = [dez(r["wert"]) for r in e["reste"]]
    rest = sum(restwerte, Decimal(0)) if all(r is not None for r in restwerte) else None
    n = dez(e["nenner"]) if e["traeger"] == "Strom" else None
    return {**m, "gemessen": [s["kennung"] for s in ms if s["wert"] is not None],
            "geplant": sorted(set(e["offene_bedarfe"] + [s["kennung"] for s in ms if s["wert"] is None])),
            "ersatz_messstellen": [s["kennung"] for s in ms if s["wert"] is not None and dez(s["ersatz"]) > 0],
            "ungemessen": text(rest) if e["reste"] else None,
            "abdeckung_prozent": prozent(dez(m["menge"]), n), "K8": schwelle(dez(m["menge"]), n, e["schwelle"])}


def prozess_summe_passt(gemessen, summen):
    return [{"summe": s["kennung"], "messstelle": t["messstelle"], "verteilung": t["verteilung"]}
            for s in summen for t in s["terme"] if t["messstelle"] not in gemessen]


@exakt
def toleranz(fuehrend, vergleich, grenze):
    a, b = dez(fuehrend), dez(vergleich)
    diff = abs(a - b) if a is not None and b is not None else None
    p = prozent(diff, a)
    return {"abweichung_prozent": p, "toleranz_prozent": grenze,
            "befund": None if p is None else diff * 100 > a * dez(grenze)}

"""AP-17 NW-1: Bezugsbasis — reine Rechnung, ohne Uhr, Datenbank oder Schreibweg.

Aus k_faelle.py (AP-17, 23.09.2026): fit1, pearson, erwartet und urteil. Reportbau
und Beispielwelt entfallen. Abweichend von dort rechnet diese Referenz mit exakten
Brüchen statt float und rundet kaufmännisch (``,5`` vom Nullpunkt weg) — ``r1``
dort rundete ``-2,05`` auf ``-2,0``; der Vertrag legt ``-2,1`` fest. Band und
Spannweite werden nie gerundet verglichen, sondern per Kreuzprodukt.
Alle drei Zwillinge fahren docs/contracts/v2/bezugsbasis-vectors.json.
"""
import re
from fractions import Fraction
from math import isqrt

STARTWERTE = dict(mindest_monate=12, toleranz_prozent="2", spannweite_prozent="10", abhaengig_r="0.9", wiedervorlage_monate=12)
METHODEN = ["verhaeltnis", "regression_eine_variable", "regression_zwei_variablen", "gradtage"]
URTEILE = ["besser", "schlechter", "im_rahmen", "ohne_urteil", "nicht_anwendbar"]
GRUENDE = ["basis_fehlt", "basis_beendet", "zu_wenig_perioden", "variable_fehlt", "variable_ausserhalb",
           "variablen_abhaengig", "keine_werte", "periode_nicht_zu_ende"]
DATENLAGE = ["vollstaendig", "vorlaeufig"]
RICHTUNGEN = ["mehr", "weniger", "gleich"]
ANPASSUNGSGRUENDE = ["referenzperiode_vervollstaendigt", "grundlage_korrigiert", "struktur_geaendert", "variable_geaendert",
                     "methode_geaendert", "nicht_mehr_anwendbar", "sonstiger"]
FAKTOR_ARTEN = ["flaeche", "standort", "anlage", "prozess", "kostenstelle", "wortlaut"]
BASIS_ZUSTAENDE = ["entwurf", "freigegeben", "anstoss_liegt_vor", "ueberpruefung_faellig", "beendet"]
FREIGABE_STATUS = ["beantragt", "freigegeben", "abgelehnt"]
NA, OHNE = "nicht_anwendbar", "ohne_urteil"
_PERIODE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])/(\d{4})-(0[1-9]|1[0-2])$")


def q(text):
    return None if text is None else Fraction(text)


def halb_auf(z, n):
    """Kaufmännisch: ``,5`` vom Nullpunkt weg — wie ``BigDecimal.HALF_UP``, nie ``round``."""
    negativ = (z < 0) != (n < 0)
    a, b = abs(z), abs(n)
    ganz, rest = divmod(a, b)
    if 2 * rest >= b:
        ganz += 1
    return -ganz if negativ else ganz


def _text(z, stellen):
    ziffern = str(abs(z)).rjust(stellen + 1, "0")
    ganz, bruch = ziffern[:len(ziffern) - stellen], ziffern[len(ziffern) - stellen:]
    return ("-" if z < 0 else "") + ganz + ("." + bruch if stellen else "")


def fest(x, stellen):
    """Auf ``stellen`` Nachkommastellen, kaufmännisch, mit festen Stellen (``2.0``)."""
    return None if x is None else _text(halb_auf(x.numerator * 10 ** stellen, x.denominator), stellen)


def kurz(x, stellen):
    """Gerundet wie ``fest``, ohne Null am Ende (``0.5``, ``10522.6206``)."""
    if x is None:
        return None
    t = fest(x, stellen)
    return t.rstrip("0").rstrip(".") if "." in t else t


def exakt(x):
    """Ein endlicher Dezimalbruch als Text; alles andere ist ein Programmfehler."""
    if x is None:
        return None
    n, stellen = x.denominator, 0
    while n != 1:
        if n % 2 and n % 5:
            raise ValueError(f"kein endlicher Dezimalbruch: {x}")
        n = n // 2 if n % 2 == 0 else n // 5
        stellen += 1
    return kurz(x, stellen) if stellen else str(x.numerator)


def wurzel_fest(x, stellen):
    """√x kaufmännisch auf ``stellen``: n = ⌊(⌊√⌊4·x·10^2k⌋⌋ + 1) / 2⌋ — exakt, ohne Gleitkomma."""
    v = x * 4 * 10 ** (2 * stellen)
    return _text((isqrt(v.numerator // v.denominator) + 1) // 2, stellen)


def de(text):
    """Zahl im Kennzeichen: Dezimalkomma, Tausender mit Leerzeichen (§5.8)."""
    minus = text.startswith("-")
    ganz, _, bruch = text.lstrip("-").partition(".")
    gruppen = []
    while len(ganz) > 3:
        gruppen.insert(0, ganz[-3:])
        ganz = ganz[:-3]
    gruppen.insert(0, ganz)
    return ("−" if minus else "") + " ".join(gruppen) + ("," + bruch if bruch else "")


def referenzperiode(text, laufender_monat):
    """P1: ganze, abgeschlossene Kalendermonate ``JJJJ-MM/JJJJ-MM``; P2: unter der Mindestlänge vorläufig."""
    m = _PERIODE.match(text or "")
    if not m:
        return dict(gueltig=False, monate=None, datenlage=None, fehler="referenzperiode_format")
    von, bis = int(m[1]) * 12 + int(m[2]) - 1, int(m[3]) * 12 + int(m[4]) - 1
    if bis < von:
        return dict(gueltig=False, monate=None, datenlage=None, fehler="referenzperiode_reihenfolge")
    jahr, monat = laufender_monat.split("-")
    if bis >= int(jahr) * 12 + int(monat) - 1:
        return dict(gueltig=False, monate=None, datenlage=None, fehler="periode_nicht_zu_ende")
    monate = bis - von + 1
    return dict(gueltig=True, monate=monate, datenlage=_datenlage(monate), fehler=None)


def _datenlage(monate):
    return "vorlaeufig" if monate < STARTWERTE["mindest_monate"] else "vollstaendig"


def _vorlaeufig(monate):
    return f"Bezugsbasis vorläufig ({monate} von {STARTWERTE['mindest_monate']} Monaten)"


def basiswert(grundlage):
    """M1: Σ Zähler ÷ Σ Nenner der Referenzperiode — Summe durch Summe, nie ein Mittel."""
    n = len(grundlage)
    if n == 0 or any(g["zaehler"] is None or g["nenner"] is None for g in grundlage):
        return dict(basiswert=None, monate=n, datenlage=None, grund="keine_werte", kennzeichen=[])
    zaehler, nenner = sum(q(g["zaehler"]) for g in grundlage), sum(q(g["nenner"]) for g in grundlage)
    if nenner <= 0:
        return dict(basiswert=None, monate=n, datenlage=None, grund="keine_werte", kennzeichen=[])
    datenlage = _datenlage(n)
    return dict(basiswert=kurz(zaehler / nenner, 4), monate=n, datenlage=datenlage, grund=None,
                kennzeichen=[_vorlaeufig(n)] if datenlage == "vorlaeufig" else [])


def _summen(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    return (sum((x - mx) ** 2 for x in xs), sum((x - mx) * (y - my) for x, y in zip(xs, ys)),
            sum((y - my) ** 2 for y in ys), mx, my)


def abhaengigkeit(x1, x2):
    """G4: Pearson r über die Referenzperiode; abhängig ab |r| ≥ 0,9 — geprüft als sxy² ≥ 0,81·sxx·syy."""
    sxx, sxy, syy, _, _ = _summen([q(x) for x in x1], [q(x) for x in x2])
    if sxx == 0 or syy == 0:
        return dict(r=None, abhaengig=False)
    r2 = sxy * sxy / (sxx * syy)
    r = wurzel_fest(r2, 3)
    return dict(r=("-" + r if sxy < 0 and r != "0.000" else r).rstrip("0").rstrip("."),
                abhaengig=r2 >= q(STARTWERTE["abhaengig_r"]) ** 2)


def _spannweite(xs):
    von, bis, p = min(xs), max(xs), q(STARTWERTE["spannweite_prozent"]) / 100
    return dict(von=exakt(von), bis=exakt(bis), toleriert_von=exakt(von * (1 - p)), toleriert_bis=exakt(bis * (1 + p)))


def modell(methode, reihe):
    """M2/M3: kleinste Quadrate aus den Monatspaaren; R², Streuung (in % des Mittels), Spannweite je Variable; G1, G4."""
    n = len(reihe)
    leer = dict(methode=methode, monate=n, basiswert=None, koeffizienten=None, r2=None, streuung_prozent=None,
                spannweite=[], abgelehnt=[])
    if n == 0 or any(r["zaehler"] is None or None in r["variablen"] for r in reihe):
        return {**leer, "grund": "keine_werte"}
    if n < STARTWERTE["mindest_monate"]:
        return {**leer, "grund": "zu_wenig_perioden"}
    ys = [q(r["zaehler"]) for r in reihe]
    spalten = [[q(r["variablen"][i]) for r in reihe] for i in range(len(reihe[0]["variablen"]))]
    abgelehnt = []
    if len(spalten) == 2:
        pruefung = abhaengigkeit(reihe_texte(spalten[0]), reihe_texte(spalten[1]))
        if pruefung["abhaengig"]:
            abgelehnt.append(dict(variable=2, grund="variablen_abhaengig", r=pruefung["r"]))
            spalten = spalten[:1]
    ergebnis = "regression_eine_variable" if methode == "regression_zwei_variablen" and len(spalten) == 1 else methode
    my = sum(ys) / n
    if len(spalten) == 1:
        sxx, sxy, syy, mx, _ = _summen(spalten[0], ys)
        if sxx == 0:
            return {**leer, "abgelehnt": abgelehnt, "grund": "zu_wenig_perioden"}
        b = sxy / sxx
        koeff = dict(a=my - b * mx, b=b)
        erwartet = [koeff["a"] + b * x for x in spalten[0]]
    else:
        x1, x2 = spalten
        s11, s1y, syy, m1, _ = _summen(x1, ys)
        s22, s2y, _, m2, _ = _summen(x2, ys)
        s12 = sum((a - m1) * (c - m2) for a, c in zip(x1, x2))
        det = s11 * s22 - s12 * s12
        if det == 0:
            return {**leer, "abgelehnt": abgelehnt, "grund": "zu_wenig_perioden"}
        b, c = (s1y * s22 - s2y * s12) / det, (s2y * s11 - s1y * s12) / det
        koeff = dict(a=my - b * m1 - c * m2, b=b, c=c)
        erwartet = [koeff["a"] + b * u + c * v for u, v in zip(x1, x2)]
    ss_res = sum((y - e) ** 2 for y, e in zip(ys, erwartet))
    ss_tot = sum((y - my) ** 2 for y in ys)
    frei = n - len(spalten) - 1
    return dict(methode=ergebnis, monate=n, basiswert=kurz(sum(ys) / sum(spalten[0]), 4) if sum(spalten[0]) > 0 else None,
                koeffizienten={k: kurz(v, 4) for k, v in koeff.items()},
                r2=kurz(1 - ss_res / ss_tot, 3) if ss_tot > 0 else None,
                streuung_prozent=wurzel_fest(ss_res / frei / (my * my) * 10000, 1) if my > 0 and frei > 0 else None,
                spannweite=[_spannweite(x) for x in spalten], abgelehnt=abgelehnt, grund=None)


def reihe_texte(werte):
    return [exakt(w) for w in werte]


def _bereinigt(f):
    v = f["variablen"]
    wo = f"Bezugsbasis {f['kennzeichen']}, Fassung {f['fassung']}"
    streuung = f"Streuung ± {de(fest(q(f['streuung_prozent']), 1))} %" if f.get("streuung_prozent") is not None else None
    match f["methode"]:
        case "verhaeltnis":
            return [f"bereinigt um {v[0]['name']} ({wo})"]
        case "regression_eine_variable":
            return [f"bereinigt um {v[0]['name']} (Modell mit einer Einflussgröße, {wo}; {streuung})"]
        case "regression_zwei_variablen":
            return [f"bereinigt um {v[0]['name']} und {v[1]['name']} (Modell mit zwei Einflussgrößen, {wo}; {streuung})"]
        case "gradtage":
            return [f"bereinigt um Gradtage (G20/15, {wo})", streuung]
    raise AssertionError(f"Ungeprüfte Methode: {f['methode']}")


def _basis_kennzeichen(f):
    liste = _bereinigt(f)
    if f["methode"] == "verhaeltnis" and f["variablen"][0]["art"] == "gradtagzahl":
        liste.append("ohne Grundlast")
    if f["monate"] < STARTWERTE["mindest_monate"]:
        liste.append(_vorlaeufig(f["monate"]))
    return liste


def _ergebnis(urteil, grund=None, gemessen=None, erwartet=None, delta=None, band=None, richtung=None, kennzeichen=()):
    return dict(urteil=urteil, grund=grund, gemessen=gemessen, erwartet=erwartet, delta_prozent=delta,
                band_prozent=band, richtung=richtung, kennzeichen=list(kennzeichen))


def _band(f):
    toleranz = q(f["toleranz_prozent"])
    streuung = q(f.get("streuung_prozent")) or Fraction(0)
    return max(toleranz, streuung)


def _urteil(g, e, band, unvollstaendig):
    """U2/U3: Δ in % des Erwarteten; im Rahmen, wenn |g − e|·100 ≤ Band·e — nie auf das Band gerundet."""
    richtung = "mehr" if g > e else "weniger" if g < e else "gleich"
    if unvollstaendig:
        return OHNE, richtung
    if abs(g - e) * 100 <= band * e:
        return "im_rahmen", richtung
    return ("besser" if g < e else "schlechter"), richtung


def _dazu(liste, weitere):
    for k in weitere:
        if k not in liste:
            liste.append(k)
    return liste


def vergleich(e):
    """U1–U4, G2, G3, G5: gemessen gegen erwartet einer freigegebenen Fassung, mit Grund statt Zahl, wo die Daten es nicht tragen."""
    f = e["fassung"]
    if f is None:
        return _ergebnis(NA, "basis_beendet" if e.get("basis_beendet") else "basis_fehlt")
    if not e["abgeschlossen"]:
        return _ergebnis(NA, "periode_nicht_zu_ende")
    gemessen = e["gemessen"]
    if gemessen["wert"] is None:
        return _ergebnis(NA, "keine_werte")
    variablen = e["variablen"]
    if len(variablen) < len(f["variablen"]) or any(v["wert"] is None for v in variablen[:len(f["variablen"])]):
        return _ergebnis(NA, "variable_fehlt", gemessen=gemessen["wert"])
    xs = [q(v["wert"]) for v in variablen[:len(f["variablen"])]]
    ausserhalb = [i for i, s in enumerate(f.get("spannweite") or [])
                  if xs[i] < q(s["toleriert_von"]) or xs[i] > q(s["toleriert_bis"])]
    kennzeichen = _basis_kennzeichen(f)
    if f["methode"] == "verhaeltnis":
        erwartet = q(f["basiswert"]) * xs[0]
        for i in ausserhalb:
            s, v = f["spannweite"][i], f["variablen"][i]
            kennzeichen.append(f"{v['name']} außerhalb der Basis-Spannweite ({de(s['von'])}–{de(s['bis'])} {v['einheit']})")
    else:
        if ausserhalb:
            return _ergebnis(NA, "variable_ausserhalb", gemessen=gemessen["wert"])
        k = f["koeffizienten"]
        erwartet = q(k["a"]) + q(k["b"]) * xs[0] + (q(k["c"]) * xs[1] if len(xs) > 1 else 0)
    if erwartet <= 0:
        return _ergebnis(NA, "keine_werte", gemessen=gemessen["wert"])
    g = q(gemessen["wert"])
    unvollstaendig = gemessen.get("zustand") == "unvollstaendig" or any(v.get("zustand") == "unvollstaendig" for v in variablen)
    urteil, richtung = _urteil(g, erwartet, _band(f), unvollstaendig)
    _dazu(kennzeichen, gemessen.get("kennzeichen", []))
    for v in variablen:
        _dazu(kennzeichen, v.get("kennzeichen", []))
    if unvollstaendig:
        _dazu(kennzeichen, ["unvollständig"])
    return _ergebnis(urteil, None, exakt(g), exakt(erwartet), fest((g - erwartet) * 100 / erwartet, 1),
                     fest(_band(f), 1), richtung, kennzeichen)


def zeitraum(e):
    """U5: Σ gemessen ÷ Σ erwartet über die Monate — nie ein Mittel der Monats-Δ; fehlt ein Monat: „x von y Monaten“."""
    f = e["fassung"]
    einzeln = [vergleich({"fassung": f, "basis_beendet": e.get("basis_beendet"), **m}) for m in e["monate"]]
    nutzbar = [x for x in einzeln if x["urteil"] != NA]
    y = e["soll_monate"]
    if not nutzbar:
        grund = einzeln[0]["grund"] if einzeln and f is None else "keine_werte"
        return {**_ergebnis(NA, grund), "monate": f"0 von {y}"}
    g, erw = sum(q(x["gemessen"]) for x in nutzbar), sum(q(x["erwartet"]) for x in nutzbar)
    unvollstaendig = len(nutzbar) < y or any(x["urteil"] == OHNE for x in nutzbar)
    urteil, richtung = _urteil(g, erw, _band(f), unvollstaendig)
    kennzeichen = _basis_kennzeichen(f)
    for x in nutzbar:
        _dazu(kennzeichen, x["kennzeichen"])
    if len(nutzbar) < y:
        _dazu(kennzeichen, [f"{len(nutzbar)} von {y} Monaten"])
    return {**_ergebnis(urteil, None, exakt(g), exakt(erw), fest((g - erw) * 100 / erw, 1), fest(_band(f), 1), richtung,
                        kennzeichen), "monate": f"{len(nutzbar)} von {y}"}


def roh(aktuell, vorher):
    """U1: die rohe Veränderung zur Vorperiode trägt nie ein Urteil."""
    a, v = q(aktuell), q(vorher)
    if a is None or v is None or v <= 0:
        return dict(delta_prozent=None, richtung=None, urteil=OHNE)
    return dict(delta_prozent=fest((a - v) * 100 / v, 1), richtung="mehr" if a > v else "weniger" if a < v else "gleich",
                urteil=OHNE)


def runden(wert, stellen):
    """M5: Anzeige-Rundung kaufmännisch; ``,5`` vom Nullpunkt weg in allen drei Sprachen."""
    return fest(q(wert), stellen)


def roh_und_bereinigt(e):
    """Plan-Abnahme (E8): dieselbe Periode roh gegen den Vormonat — ohne Urteil — und bereinigt gegen die Basis."""
    r = e["roh"]
    return dict(roh={**roh(r["gemessen"], r["vorher"]), "variable_delta_prozent": roh(r["variable"], r["variable_vorher"])["delta_prozent"]},
                bereinigt=vergleich(e["bereinigt"]))


def methoden_paar(e):
    """M3: dieselbe Periode gegen das Modell mit Konstante und gegen das Verhältnis ohne Grundlast."""
    return dict(modell=vergleich(e["modell"]), verhaeltnis=vergleich(e["verhaeltnis"]))

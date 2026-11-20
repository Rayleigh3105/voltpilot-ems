"""Pruefung des Bausteins FB_VP_WagoBild gegen die Vertragsvektoren des WAGO-Registerbilds.

Gerufen von pruefe.py. Fuer jeden Fall von docs/contracts/v2/wago-registerbild-vectors.json, dessen
Woerter ein Programm mit diesem Baustein schreiben kann, bildet sie die Eingaenge daraus, ruft den
Baustein auf und verlangt dieselben Woerter fuer jedes Wort, das der Vertrag liest (§5). Danach
liest der Leser der Box (edge-app/nodered/measurements/wago-registerbild.js, dessen Go-Zwilling an
denselben Vektoren haengt) das Bild des Bausteins mit Parameter und Soll des Falls, und das Ergebnis
muss genau die Erwartung des Falls sein.
"""

from __future__ import annotations

import json
import re
import subprocess

import st

REPO = None  # gesetzt von pruefe.py
KARTEN_MAX = 16
KOPF, BLOCK = 12, 42
PRUEFWERT = 0x01020304
INT32 = (3, 4, 5)  # Messwert-Nr. mit Datentyp Int32 (Vertrag §4.3)


class NichtErzeugbar(Exception):
    pass


def wert32(w: list[int], i: int, little: bool) -> int:
    hoch, nieder = (w[i + 1], w[i]) if little else (w[i], w[i + 1])
    return (hoch << 16) | nieder


def eingaenge(woerter: list[int]) -> dict:
    """Die Eingaenge, mit denen ein Anlagenprogramm genau dieses Bild meint."""
    w = woerter
    if len(w) < KOPF or w[0] != 0x5650 or w[1] != 0x5242:
        raise NichtErzeugbar("fremde Signatur")
    if w[2] != 1 or w[3] != 0:
        raise NichtErzeugbar(f"Fassung {w[2]}.{w[3]} - der Baustein schreibt 1.0")
    if w[4] != KOPF or w[5] != BLOCK:
        raise NichtErzeugbar(f"Laengen {w[4]}/{w[5]} - der Baustein schreibt 12/42")
    kartenzahl = w[6]
    if kartenzahl > KARTEN_MAX or len(w) != KOPF + kartenzahl * BLOCK:
        raise NichtErzeugbar(f"{kartenzahl} Karten in {len(w)} Woertern")
    if wert32(w, 8, False) == PRUEFWERT:
        little = False
    elif wert32(w, 8, True) == PRUEFWERT:
        little = True
    else:
        raise NichtErzeugbar("Pruefwert in keiner Wortfolge 16#01020304")
    karten = []
    for n in range(kartenzahl):
        b = KOPF + n * BLOCK
        bits = w[b + 3]
        if bits & 0xFFF0:
            raise NichtErzeugbar(f"Gueltigkeit {bits:#06x}: Bits 4-15 sind in 1.0 immer 0")
        karten.append({
            "uiSteckplatz": w[b], "uiKartentyp": w[b + 1], "uiVariante": w[b + 2],
            "xKarteGelesen": bool(bits & 1), "xKr32Gelesen": bool(bits & 2), "wKr32": w[b + 4],
            "xKr35Gelesen": bool(bits & 4), "wKr35": w[b + 5], "xStatusGelesen": bool(bits & 8),
            "awStatus": w[b + 6:b + 18],
            "adwMesswert": [wert32(w, b + 18 + 2 * k, little) for k in range(12)],
        })
    return {"udiControllerKennung": wert32(w, 10, little), "xWortfolgeLittle": little,
            "uiKartenzahl": kartenzahl, "astKarte": karten, "herzschlag": w[7]}


def gelesene_woerter(woerter: list[int]) -> list[int]:
    """Die Stellen, die der Leser des Vertrags liest (§5): Kopf ganz, je Karte Steckplatz, Typ,
    Variante, Gueltigkeit, und nur hinter gesetzten Bits Kartenregister, Statuswoerter, Messwerte."""
    stellen = list(range(KOPF))
    for n in range(woerter[6]):
        b = KOPF + n * BLOCK
        bits = woerter[b + 3]
        stellen += [b, b + 1, b + 2, b + 3]
        if bits & 1:
            stellen += [b + 4] if bits & 2 else []
            stellen += [b + 5] if bits & 4 else []
            stellen += list(range(b + 6, b + 18)) if bits & 8 else []
            stellen += list(range(b + 18, b + 42))
    return stellen


def baustein(p: st.Projekt, e: dict, inst=None, bild=None) -> list[int]:
    """Ein Aufruf von FB_VP_WagoBild; gibt das ganze Abbild zurueck."""
    if inst is None:
        inst = p.neue_instanz(p.pous["FB_VP_WagoBild"])
        if "herzschlag" in e:
            # Der Herzschlag zaehlt seit Programmstart; fuer den Vergleich steht er dort, wo der Fall ihn nennt.
            inst.werte.update(uiHerzschlag=e["herzschlag"], xGestartet=True, tLetzte=p.uhr_ms)
    w = inst.werte
    for k in ("udiControllerKennung", "xWortfolgeLittle", "uiKartenzahl"):
        w[k] = e[k]
    for n, karte in enumerate(e["astKarte"]):
        s = w["astKarte"].werte[n]
        for k, v in karte.items():
            if isinstance(v, list):
                s[k].werte[:] = v
            else:
                s[k] = v
    if bild is None:
        bild = p.anfang(st.Typ("ref", "T_VP_WagoBild"), None, {})
    w["aBild"] = bild
    p.lauf(inst.pou, w)
    return list(bild.werte)


def lies_mit_der_box(lesungen: list[dict]) -> list[dict]:
    """Der Leser der Box (JS) ueber alle Bilder in einem Aufruf."""
    leser = REPO / "edge-app" / "nodered" / "measurements" / "wago-registerbild.js"
    skript = ("const RB = require(process.argv[1]); let t = ''; process.stdin.on('data', (d) => { t += d; });"
              "process.stdin.on('end', () => { const l = JSON.parse(t);"
              "process.stdout.write(JSON.stringify(l.map((x) => RB.liesRegisterbild(x.woerter,"
              " { parameter: x.parameter, soll: x.soll })))); });")
    aus = subprocess.run(["node", "-e", skript, str(leser)], input=json.dumps(lesungen), capture_output=True,
                         text=True, check=True)
    return json.loads(aus.stdout)


def teil_gleich(ist, soll) -> bool:
    if isinstance(soll, dict):
        return isinstance(ist, dict) and all(teil_gleich(ist.get(k), v) for k, v in soll.items())
    if isinstance(soll, list):
        return isinstance(ist, list) and len(ist) == len(soll) and all(map(teil_gleich, ist, soll))
    return ist == soll


def pruefe_vertragsfaelle(b, projekt):
    faelle = json.loads((REPO / "docs" / "contracts" / "v2" / "wago-registerbild-vectors.json").read_text())["faelle"]
    zu_lesen, offen = [], []
    for fall in faelle:
        name = fall["name"].split()[0]
        woerter = fall["input"]["woerter"]
        try:
            e = eingaenge(woerter)
        except NichtErzeugbar as grund:
            b.info(f"WAGO {name}: nicht vom Baustein erzeugbar - {grund}")
            continue
        bild = baustein(projekt(), e)[:len(woerter)]
        abweichung = [f"[{i}]: {bild[i]:#06x} statt {woerter[i]:#06x}"
                      for i in gelesene_woerter(woerter) if bild[i] != woerter[i]]
        if abweichung:
            b.nein(f"WAGO {name}: " + "; ".join(abweichung[:6]))
            continue
        zu_lesen.append({"woerter": bild, "parameter": fall["input"]["parameter"], "soll": fall["input"]["soll"]})
        offen.append((name, fall["expected"]))
    expected_ohne = lambda x: {k: v for k, v in x.items() if k != "anfragen_mindestens"}  # noqa: E731
    for (name, erwartung), gelesen in zip(offen, lies_mit_der_box(zu_lesen)):
        if teil_gleich(gelesen, expected_ohne(erwartung)):
            b.ok(f"WAGO {name}: dieselben Woerter, von der Box gelesen wie erwartet ({erwartung['ergebnis']})")
        else:
            b.nein(f"WAGO {name}: gelesen {json.dumps(gelesen)[:300]} statt {json.dumps(erwartung)[:300]}")


def leer_eingaenge(kartenzahl: int, little: bool = False) -> dict:
    karte = {"uiSteckplatz": 1, "uiKartentyp": 495, "uiVariante": 25001, "xKarteGelesen": False,
             "xKr32Gelesen": False, "wKr32": 5, "xKr35Gelesen": False, "wKr35": 5, "xStatusGelesen": False,
             "awStatus": [5] * 12, "adwMesswert": [5] * 12}
    return {"udiControllerKennung": 0, "xWortfolgeLittle": little, "uiKartenzahl": kartenzahl,
            "astKarte": [dict(karte) for _ in range(kartenzahl)]}


def pruefe_unbekannt(b, projekt):
    """Ein Teil ohne sein Gueltigkeitsbit steht als Typ-Maximum im Bild, nie als 0 oder als Eingang;
    Bloecke hinter der Kartenzahl sind 0 (kein Rest einer gezogenen Karte)."""
    falsch = []
    for little in (False, True):
        p = projekt()
        inst = p.neue_instanz(p.pous["FB_VP_WagoBild"])
        bild = p.anfang(st.Typ("ref", "T_VP_WagoBild"), None, {})
        voll = leer_eingaenge(3, little)
        for k in voll["astKarte"]:
            k.update(xKarteGelesen=True, xKr32Gelesen=True, xKr35Gelesen=True, xStatusGelesen=True)
        baustein(p, voll, inst, bild)
        w = baustein(p, leer_eingaenge(1, little), inst, bild)
        b0 = KOPF
        if w[b0 + 3] != 0:
            falsch.append(f"Gueltigkeit {w[b0 + 3]:#06x}")
        if w[b0 + 4:b0 + 18] != [0xFFFF] * 14:
            falsch.append("Kartenregister/Statuswoerter")
        for nr in range(1, 13):
            soll = 0x7FFFFFFF if nr in INT32 else 0xFFFFFFFF
            if wert32(w, b0 + 16 + 2 * nr, little) != soll:
                falsch.append(f"Messwert {nr} ({'little' if little else 'big'})")
        if any(w[KOPF + BLOCK:]):
            falsch.append("Bloecke hinter der Kartenzahl nicht 0")
    if falsch:
        b.nein(f"WAGO unbekannt ist nicht das Typ-Maximum: {falsch}")
    else:
        b.ok("WAGO unbekannt: Typ-Maximum (Int32 16#7FFFFFFF), nie 0; Bloecke hinter der Kartenzahl 0")


def pruefe_herzschlag(b, projekt):
    p = projekt()
    inst = p.neue_instanz(p.pous["FB_VP_WagoBild"])
    bild = p.anfang(st.Typ("ref", "T_VP_WagoBild"), None, {})

    def zur(ms: int) -> int:
        p.uhr_ms = ms
        return baustein(p, leer_eingaenge(0), inst, bild)[7]

    folge = [zur(t) for t in (1000, 1500, 1999, 2000, 6500, 7000)]
    inst.werte["uiHerzschlag"] = 65534
    ueber = [zur(t) for t in (8000, 9000, 10000)]
    if folge != [0, 0, 0, 1, 5, 6] or ueber != [65535, 0, 1]:
        b.nein(f"WAGO Herzschlag: {folge} {ueber} statt [0, 0, 0, 1, 5, 6] [65535, 0, 1]")
    else:
        b.ok("WAGO Herzschlag (Wort 7): beim Start 0, +1 je Sekunde, 65535 -> 0")


def pruefe_pruefwert(b, quelle):
    ohne = re.sub(r"\(\*.*?\*\)", "", quelle.read_text(encoding="utf-8"), flags=re.S)
    if re.search(r"aBild\s*\[\s*(8|9)\s*\]\s*:=", ohne):
        b.nein("WAGO: der Pruefwert steht als Konstante in Wort 8/9 statt ueber VP_WagoSetze32")
    elif not re.search(r"VP_WagoSetze32\([^;]*uiAdresse\s*:=\s*8\s*,\s*dwWert\s*:=\s*16#01020304", ohne):
        b.nein("WAGO: der Pruefwert 16#01020304 geht nicht ueber VP_WagoSetze32 an Adresse 8")
    else:
        b.ok("WAGO Pruefwert ueber VP_WagoSetze32, wie jeder Messwert (Vertrag §3)")

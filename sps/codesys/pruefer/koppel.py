"""Das Koppelbild aus Sicht des Vertrags, gelesen aus koppelbild-vectors.json.

- faelle(): die Schrittfolgen der Vektor-Datei mit den Eingaengen der Anlage je Schritt
  (Uebertrag: ein Schritt ohne "sps" hat die Eingaenge des vorigen).
- telegramm(...): ein Telegramm der Edge, gebaut nur aus der Feldtabelle und dem Siegel der Datei -
  fuer die Pruefungen ueber die Faelle hinaus (Grundprogramm, Vorlagen, Ueberlauf von TIME()).
"""

from __future__ import annotations

import json
from pathlib import Path

WURZEL = Path(__file__).resolve().parents[3]
VEKTOREN = WURZEL / "docs" / "contracts" / "v2" / "koppelbild-vectors.json"

V = json.loads(VEKTOREN.read_text(encoding="utf-8"))
W = V["w"]
Q = V["q"]
ART = {v["name"]: v["code"] for v in V["vokabular"]["art"]}
ZIEL = {v["name"]: v["code"] for v in V["vokabular"]["ziel"]}
GRUND = {v["name"]: v["code"] for v in V["vokabular"]["grund"]}
GRUND_NAME = {v["code"]: v["name"] for v in V["vokabular"]["grund"]}
KOPF_URTEIL = {v["code"]: v["name"] for v in V["vokabular"]["kopf_urteil"]}
Q_URTEIL = {v["code"]: v["name"] for v in V["vokabular"]["q_urteil"]}
E_BITS = {b["name"]: b["bit"] for b in V["bitfelder"]["e_bits"]["bits"]}


def _w(feld: str) -> int:
    return next(f["adresse"] for f in W["kopf"] if f["feld"] == feld)


def _wp(feld: str) -> int:
    return next(f["adresse"] for f in W["platz"]["felder"] if f["feld"] == feld)


def crc16(woerter) -> int:
    c = V["siegel"]["start"]
    for w in woerter:
        for b in (w >> 8, w & 0xFF):
            c ^= b
            for _ in range(8):
                c = (c >> 1) ^ V["siegel"]["polynom_gespiegelt"] if c & 1 else c >> 1
    return c


def telegramm(sitzung: int, herzschlag: int, steuerung_id: int, frist_s: int = 60, e_bits=("steuerung_frei",),
              plaetze: dict | None = None) -> list[int]:
    """plaetze: {n: (art, wert, grund, folge)}"""
    w = [0] * W["woerter"]
    sig = next(f for f in W["kopf"] if f["feld"] == "signatur")["soll_woerter"]
    pruef = next(f for f in W["kopf"] if f["feld"] == "wortfolge")["soll_woerter"]
    w[0:2], w[2:4] = sig, pruef
    w[_w("version")] = V["koppelbild"]["version_wort"]
    w[_w("platz_anzahl")] = V["koppelbild"]["plaetze"]
    w[_w("sitzung")], w[_w("herzschlag")] = sitzung, herzschlag & 0xFFFF
    w[_w("steuerung_id")], w[_w("steuerung_id") + 1] = steuerung_id >> 16, steuerung_id & 0xFFFF
    w[_w("frist_s")] = frist_s
    w[_w("e_bits")] = sum(1 << E_BITS[b] for b in e_bits)
    for n in range(1, V["koppelbild"]["plaetze"] + 1):
        b = W["platz"]["basis"] + (n - 1) * W["platz"]["laenge"]
        art, wert, grund, folge = (plaetze or {}).get(n, ("keiner", 0x7FFFFFFF, "keiner", 0))
        u = wert & 0xFFFFFFFF
        w[b + _wp("w_art")], w[b + _wp("w_grund")] = ART[art], GRUND[grund]
        w[b + _wp("w_wert")], w[b + _wp("w_wert") + 1] = u >> 16, u & 0xFFFF
        w[b + _wp("w_folge")] = folge
    s = W["siegel_wort"]
    w[s] = crc16(w[:s] + w[s + 1:])
    return w


def faelle():
    """Je Fall die Schritte mit den gueltigen Eingaengen der Anlage."""
    for f in V["faelle"]:
        eingang = None
        schritte = []
        for s in f["schritte"]:
            eingang = s.get("sps", eingang)
            schritte.append((s, eingang))
        yield f, schritte

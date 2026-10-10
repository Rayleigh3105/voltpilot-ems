#!/usr/bin/env python3
"""Das Protokoll eines Laufs: die Messung der Anlage plus die Quittungen der Boxen.

Quelle der Zahlen ist allein der Anlagen-Prozess (M-1/M-2 am Netzpunkt); aus
dem Mitschnitt des Brokers (`mosquitto_sub -v 'ems/#'`, je Zeile mit
Empfangszeit) kommen die Quittungen und der Stand, den jede Box meldet.
Nur technische Angaben - keine Zugangsdaten, keine Kundendaten.

  protokoll.py --anlage … --mitschnitt … --nutzlasten … --sha … --aus …
  protokoll.py vergleiche <protokoll-a> <protokoll-b>   (Wiederholbarkeit)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

BOXEN = {"7a000000-0000-4000-8000-0000000000e1": "E-1",
         "7a000000-0000-4000-8000-0000000000e4": "E-4"}
QUITTUNGEN = ("v2/verbund-anteile-result", "v2/plan-result")


def lies_mitschnitt(text: str) -> list[tuple[int, str, str, dict | None]]:
    zeilen = []
    for z in text.splitlines():
        teile = z.split(" ", 2)
        if len(teile) < 3 or not teile[0].isdigit():
            continue
        try:
            nutz = json.loads(teile[2])
        except ValueError:
            nutz = None
        zeilen.append((int(teile[0]), teile[1], teile[2], nutz))
    return zeilen


def box_und_leaf(topic: str) -> tuple[str | None, str]:
    teile = topic.split("/")
    if len(teile) < 5:
        return None, ""
    return BOXEN.get(teile[3]), "/".join(teile[4:])


def quittungen(zeilen: list) -> dict:
    """Je Box: alle Quittungen in Reihenfolge und der letzte gemeldete Stand."""
    aus: dict[str, dict] = {b: {"quittungen": [], "stand": None, "herzschlaege": 0}
                            for b in BOXEN.values()}
    for ts, topic, _roh, d in zeilen:
        box, leaf = box_und_leaf(topic)
        if box is None:
            continue
        if leaf in QUITTUNGEN and d is not None:
            aus[box]["quittungen"].append({"topic": leaf, "empfangen": ts, "nutzlast": d})
        elif leaf == "status" and d is not None:
            aus[box]["herzschlaege"] += 1
            aus[box]["stand"] = d.get("version")
            aus[box]["letzter_herzschlag"] = {k: d.get(k) for k in
                                              ("version", "control_enabled", "anteile_kw", "mode")
                                              if k in d}
    return aus


def urteil(q: dict) -> dict:
    """Haben beide Boxen Anteils- und Plan-Dokument angenommen?"""
    ergebnis = {}
    for box, v in q.items():
        letzte = {}
        for e in v["quittungen"]:
            letzte[e["topic"]] = e["nutzlast"]
        a = letzte.get("v2/verbund-anteile-result") or {}
        p = letzte.get("v2/plan-result") or {}
        ergebnis[box] = {
            "anteile": a.get("urteil"), "anteile_wirksam": a.get("wirksam"),
            "plan": None if not p else ("angenommen" if p.get("angenommen") else "abgelehnt"),
            "plan_id": p.get("plan_id"),
        }
    return ergebnis


def flach(d, pfad=""):
    """{"a": {"b": 1}} -> {"a.b": 1}; Listen als ganze Werte."""
    if isinstance(d, dict):
        aus = {}
        for k, v in d.items():
            aus.update(flach(v, f"{pfad}.{k}" if pfad else k))
        return aus
    return {pfad: d}


VERGLEICH = ("quittiert", "anlage.einspeisung", "anlage.bezug", "anlage.boxen", "boxen")


def vergleich(a: dict, b: dict) -> tuple[list[str], list[tuple[str, object, object]]]:
    """Welche Felder zweier Protokolle gleich sind und welche nicht.
    Verglichen wird, was ein Lauf als Ergebnis trägt - nicht die Zeitreihe."""
    fa, fb = flach(a), flach(b)
    gleich, anders = [], []
    for k in sorted(set(fa) | set(fb)):
        if not k.startswith(VERGLEICH) or ".quittungen" in k or "herzschlag" in k:
            continue
        (gleich.append(k) if fa.get(k) == fb.get(k) else anders.append((k, fa.get(k), fb.get(k))))
    return gleich, anders


def main(argv: list[str] | None = None) -> int:
    import sys
    if argv is None:
        argv = sys.argv[1:]
    if argv[:1] == ["vergleiche"]:
        a, b = (json.loads(Path(x).read_text(encoding="utf-8")) for x in argv[1:3])
        gleich, anders = vergleich(a, b)
        print(f"gleich ({len(gleich)}): " + ", ".join(gleich))
        for k, x, y in anders:
            print(f"anders: {k}: {x!r} / {y!r}")
        return 0
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--anlage", type=Path, required=True)
    p.add_argument("--mitschnitt", type=Path, required=True)
    p.add_argument("--nutzlasten", type=Path, required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--bilder", default=None, help="Marke des Core-Bilds (Stempel im Blatt)")
    p.add_argument("--drehbuch", type=Path, default=None, help="drehbuch.log des Laufs")
    p.add_argument("--lokal", type=Path, default=None, help="Mitschnitt des lokalen Busses (A11)")
    p.add_argument("--aus", type=Path, required=True)
    a = p.parse_args(argv)
    anlage = json.loads(a.anlage.read_text(encoding="utf-8"))
    q = quittungen(lies_mitschnitt(a.mitschnitt.read_text(encoding="utf-8", errors="replace")))
    doc = {
        "bilder_aus_commit": a.sha,
        "core_bild": a.bilder,
        "drehbuch": ([z for z in a.drehbuch.read_text(encoding="utf-8").splitlines() if z]
                     if a.drehbuch else []),
        "lokaler_bus": ([z for z in a.lokal.read_text(encoding="utf-8").splitlines() if z][:200]
                        if a.lokal else []),
        "zugestellt": [z.split(" ", 1)[0] for z in a.nutzlasten.read_text().splitlines() if z],
        "quittiert": urteil(q),
        "boxen": q,
        "anlage": anlage,
    }
    a.aus.parent.mkdir(parents=True, exist_ok=True)
    a.aus.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    e, b = anlage["einspeisung"], anlage["bezug"]
    print(f"M-1 Einspeisung: höchstes Viertel {e['m1_hoechstes_viertel_kw']} kW "
          f"(Grenze {e['grenze_kw']}) · M-2: {e['m2_sekunden_ueber']} s über, längste "
          f"{e['m2_laengste_ueber_s']} s, größte +{e['m2_groesste_ueber_kw']} kW")
    print(f"M-1 Bezug: höchstes Viertel {b['m1_hoechstes_viertel_kw']} kW (Grenze {b['grenze_kw']})"
          f" · M-2: {b['m2_sekunden_ueber']} s über")
    print("Quittungen:", json.dumps(doc["quittiert"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

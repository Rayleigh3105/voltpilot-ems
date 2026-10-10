#!/usr/bin/env python3
"""X2: was die Cloud auf UEMS-Flaechen fuer den Stand sagt, den DIESE Box meldet.

Der Zwilling im Produktivcode ist services/api/.../uems/DatenquelleRegeln.faehigkeiten
(Vertrag docs/contracts/v2/data-source-assignment.md §7, Tabelle
docs/contracts/v2/edge-capabilities.json). Dieses Skript liest dieselbe Tabelle
und nennt den Satz - die api-Seite selbst wird von
services/api/.../uems/Nw3AusgeliefertesBoxImageTest.java gefahren, mit genau dem
Stand, den der Lauf hier aufgezeichnet hat.
"""
import argparse, json

p = argparse.ArgumentParser()
p.add_argument("--stand", required=True)
p.add_argument("--tabelle", required=True)
p.add_argument("--register", default="", help="Release-Register, Komma-getrennt")
p.add_argument("--aus", required=True)
a = p.parse_args()

tab = json.load(open(a.tabelle, encoding="utf-8"))
register = [r for r in a.register.split(",") if r]
fehlend = []
for f in tab["faehigkeiten"]:
    ab = f.get("ab_release")
    # Regel 3 des Vertrags: ein Stand, der zu keinem Release gehoert, beweist
    # keine Faehigkeit. Regel 2: gehoert er zu einem Release, hat er die
    # Faehigkeit nur, wenn dieses NICHT VOR `ab_release` liegt - und
    # `ab_release: null` heisst „kein ausgeliefertes Release traegt sie".
    gehoert = any(a.stand.startswith(r) for r in register)
    vorhanden = bool(ab) and gehoert
    if not vorhanden:
        fehlend.append(f["name"])

# Wortlaut wie DatenquelleRegeln.faehigkeiten: Kopf + " · " + Rest.
kopf = "Software " + a.stand if a.stand else "Software-Stand unbekannt"
rest = ("Update nötig für: " + ", ".join(fehlend)) if fehlend else "alle Fähigkeiten"
text = kopf + " · " + rest
json.dump({"stand": a.stand, "register": register, "fehlend": fehlend,
           "rest": rest, "text": text}, open(a.aus, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

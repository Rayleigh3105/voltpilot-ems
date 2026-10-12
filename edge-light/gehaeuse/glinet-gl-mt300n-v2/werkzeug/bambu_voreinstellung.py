"""Löst die Vererbung der Bambu-Studio-Voreinstellungen auf.

Die mitgelieferten JSON-Dateien verweisen per "inherits" auf Eltern; die
Kommandozeile von Bambu Studio braucht vollständige Dateien, sonst slict sie
mit halben Werten (bei uns: ein Filament "PLA" statt drei ASA, kein
Start- und Wechsel-G-Code des P1S).

Aufruf:  python bambu_voreinstellung.py <resources/profiles/BBL> <zielordner>
"""
import json
import os
import sys

AUSWAHL = [  # Ordner, Name der Voreinstellung, Zieldatei
    ("machine", "Bambu Lab P1S 0.4 nozzle", "maschine"),
    ("process", "0.20mm Standard @BBL X1C", "prozess"),   # gilt auch für den P1S
    ("filament", "Bambu ASA @BBL X1C", "asa"),
    ("filament", "Bambu ABS @BBL X1C", "abs"),          # für das Zeichen in ABS Azure
    ("filament", "Bambu PETG HF @BBL P1S 0.4 nozzle", "petg-hf"),
]


def flach(wurzel, art, name):
    """Eltern ("inherits") und Bausteine ("include", z. B. Start-G-Code) einmischen."""
    d = json.load(open(os.path.join(wurzel, art, name + ".json")))
    basis = flach(wurzel, art, d["inherits"]) if d.get("inherits") else {}
    for baustein in d.get("include", []):
        teil = flach(wurzel, art, baustein)
        basis.update({k: v for k, v in teil.items() if k not in ("name", "instantiation", "type")})
    basis.update(d)
    return basis


if __name__ == "__main__":
    wurzel, ziel = sys.argv[1], sys.argv[2]
    os.makedirs(ziel, exist_ok=True)
    for art, name, datei in AUSWAHL:
        d = flach(wurzel, art, name)
        d.pop("inherits", None)
        d.pop("include", None)
        json.dump(d, open(os.path.join(ziel, datei + ".json"), "w"), indent=1)
        print(f"{datei}.json  <-  {name}  ({len(d)} Werte)")

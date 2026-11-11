"""Liest das Ergebnis eines Laufs von bambu_pruefung.sh aus.

Aus <stamm>-bambu-ergebnis.json: Erfolg, Druckzeit, Filamentwechsel, Verbrauch.
Aus <stamm>-geslict.3mf: wie Bambu Studio die Datei verstanden hat (Objekte,
Teilnamen, Filamentplatz je Teil). Schreibt <stamm>-bambu.json und eine Zeile
Zusammenfassung.

Aufruf:  python bambu_auswertung.py <zielordner/name> <filamente>
"""
import json
import os
import sys
import xml.etree.ElementTree as ET
import zipfile


def objekte(pfad):
    """[(Objektname, [(Teilname, Filamentplatz)])] aus Metadata/model_settings.config."""
    wurzel = ET.fromstring(zipfile.ZipFile(pfad).read("Metadata/model_settings.config"))
    aus = []
    for o in wurzel.findall("object"):
        meta = {m.get("key"): m.get("value") for m in o.findall("metadata")}
        teile = []
        for t in o.findall("part"):
            tm = {m.get("key"): m.get("value") for m in t.findall("metadata")}
            teile.append((tm.get("name"), int(tm.get("extruder", meta.get("extruder", 1)))))
        aus.append((meta.get("name"), teile))
    return aus


def auswerten(stamm, filamente):
    ergebnis = stamm + "-bambu-ergebnis.json"
    if not os.path.exists(ergebnis):
        return {"erfolg": False, "meldung": "Bambu Studio hat kein Ergebnis geschrieben; siehe "
                + os.path.basename(stamm) + "-bambu.log"}
    r = json.load(open(ergebnis, encoding="utf-8"))
    aus = {"erfolg": r.get("return_code") == 0, "meldung": r.get("error_string"),
           "filamente": filamente}
    if not aus["erfolg"]:
        return aus
    p = r["sliced_plates"][0]
    aus.update({
        "druckzeit_min": round(p["total_predication"] / 60, 1),
        "filamentwechsel": p["filament_change_times"],
        "filament": [{"platz": f["id"], "im_teil_g": round(f["main_used_g"], 2),
                      "abfall_g": round(f["total_used_g"] - f["main_used_g"], 2)}
                     for f in p["filaments"]],
        "objekte": objekte(stamm + "-geslict.3mf"),
    })
    aus["im_teil_g"] = round(sum(f["im_teil_g"] for f in aus["filament"]), 2)
    aus["abfall_g"] = round(sum(f["abfall_g"] for f in aus["filament"]), 2)
    return aus


if __name__ == "__main__":
    stamm, filamente = sys.argv[1], sys.argv[2]
    a = auswerten(stamm, filamente)
    json.dump(a, open(stamm + "-bambu.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    if not a["erfolg"]:
        sys.exit(f"{os.path.basename(stamm)}: FEHLER: {a['meldung']}")
    print(f"{os.path.basename(stamm)}: {a['meldung']} | {a['druckzeit_min']} min | "
          f"{a['filamentwechsel']} Filamentwechsel | {a['im_teil_g']} g im Teil, "
          f"{a['abfall_g']} g Abfall")
    for name, teile in a["objekte"]:
        print(f"  Objekt {name}: " + ", ".join(f"{t} -> Filament {f}" for t, f in teile))

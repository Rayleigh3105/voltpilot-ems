"""Schreibt ein 3MF mit Objekten aus benannten, farbigen Teilen.

Aufbau nach 3MF-Kernspezifikation: je Teil ein Netz-Objekt mit Namen und
Anzeigefarbe; die Teile eines Objekts sind in einem Komponenten-Objekt
zusammengefasst, das auf der Bauplatte steht. Slicer laden das als EIN Objekt
mit mehreren Teilen: Die Teile bleiben zueinander ausgerichtet und lassen
sich je einem Filament zuordnen.

Zusätzlich liegt die Datei Metadata/model_settings.config bei. In diesem
Format legt Bambu Studio Teilnamen und Filamentplatz je Teil ab. Ohne sie
nennt Bambu Studio die Teile "name", "name_2", "name_3" und legt alle auf
Filament 1. Andere Slicer übergehen die Datei. Dieselbe Datei trägt
Einstellungen, die nur für ein Objekt gelten (etwa den Wandgenerator): Die
Kommandozeile von Bambu Studio 02.08 übernimmt sie; für die Oberfläche ist das
nicht geprüft.
"""
from dataclasses import dataclass

import lib3mf
import numpy as np
from lib3mf import get_wrapper


@dataclass
class Teil:
    name: str
    ecken: np.ndarray       # [n, 3] in mm, Drucklage
    dreiecke: np.ndarray    # [m, 3] Indizes
    farbe: str              # '#RRGGBB', nur Anzeige
    filament: int = 1       # Filamentplatz in Bambu Studio


def schreibe_3mf(pfad, objekte, einstellungen=None):
    """objekte: {Objektname: [Teil, ...]}; jedes Objekt steht einzeln auf der Platte.
    einstellungen: {Objektname: {Schlüssel: Wert}}, Einstellungen von Bambu
    Studio, die nur für dieses Objekt gelten (``wall_generator``: ``arachne``)."""
    w = get_wrapper()
    modell = w.CreateModel()
    modell.SetUnit(lib3mf.ModelUnit.MilliMeter)
    stoffe = modell.AddBaseMaterialGroup()
    zuordnung = []
    for objektname, teile in objekte.items():
        gruppe = modell.AddComponentsObject()
        gruppe.SetName(objektname)
        eintraege = []
        for teil in teile:
            netz = modell.AddMeshObject()
            netz.SetName(teil.name)
            punkte = []
            for x, y, z in teil.ecken:
                p = lib3mf.Position()
                p.Coordinates[0], p.Coordinates[1], p.Coordinates[2] = float(x), float(y), float(z)
                punkte.append(p)
            flaechen = []
            for a, b, c in teil.dreiecke:
                t = lib3mf.Triangle()
                t.Indices[0], t.Indices[1], t.Indices[2] = int(a), int(b), int(c)
                flaechen.append(t)
            netz.SetGeometry(punkte, flaechen)
            h = teil.farbe
            farbe = w.RGBAToColor(int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)
            netz.SetObjectLevelProperty(stoffe.GetResourceID(),
                                        stoffe.AddMaterial(f"{objektname}/{teil.name}", farbe))
            if not netz.IsManifoldAndOriented():
                raise RuntimeError(f"Netz {objektname}/{teil.name} ist nicht dicht")
            gruppe.AddComponent(netz, w.GetIdentityTransform())
            eintraege.append((netz.GetResourceID(), teil))
        modell.AddBuildItem(gruppe, w.GetIdentityTransform())
        zuordnung += [f'  <object id="{gruppe.GetResourceID()}">',
                      f'    <metadata key="name" value="{objektname}"/>',
                      f'    <metadata key="extruder" value="{teile[0].filament}"/>']
        zuordnung += [f'    <metadata key="{k}" value="{v}"/>'
                      for k, v in ((einstellungen or {}).get(objektname) or {}).items()]
        for nummer, teil in eintraege:
            zuordnung += [f'    <part id="{nummer}" subtype="normal_part">',
                          f'      <metadata key="name" value="{teil.name}"/>',
                          f'      <metadata key="extruder" value="{teil.filament}"/>',
                          '    </part>']
        zuordnung.append("  </object>")
    xml = "\n".join(['<?xml version="1.0" encoding="UTF-8"?>', "<config>", *zuordnung,
                     "</config>", ""])
    anhang = modell.AddAttachment("/Metadata/model_settings.config",
                                  "http://schemas.bambulab.com/package/2021/model-settings")
    anhang.ReadFromBuffer(xml.encode())
    modell.QueryWriter("3mf").WriteToFile(str(pfad))


def lies_3mf(pfad):
    """Kontrolle: Objekte, Namen, Dreieckszahlen und Bauplatten-Einträge."""
    w = get_wrapper()
    modell = w.CreateModel()
    modell.QueryReader("3mf").ReadFromFile(str(pfad))
    zeilen = []
    it = modell.GetObjects()
    while it.MoveNext():
        o = it.GetCurrentObject()
        if o.IsMeshObject():
            netz = modell.GetMeshObjectByID(o.GetResourceID())
            zeilen.append(f"Netz   id={o.GetResourceID()} name={o.GetName()!r} "
                          f"Dreiecke={netz.GetTriangleCount()} dicht={netz.IsManifoldAndOriented()}")
        else:
            c = modell.GetComponentsObjectByID(o.GetResourceID())
            zeilen.append(f"Gruppe id={o.GetResourceID()} name={o.GetName()!r} "
                          f"Teile={c.GetComponentCount()}")
    zeilen.append(f"Bauplatte: {modell.GetBuildItems().Count()} Eintrag/Einträge")
    return zeilen


if __name__ == "__main__":
    import sys
    print("\n".join(lies_3mf(sys.argv[1])))

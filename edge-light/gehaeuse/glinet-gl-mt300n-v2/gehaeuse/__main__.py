"""Baut alles nach aus/:  python -m gehaeuse [schritt ...]

Ohne Angabe laufen alle Schritte in dieser Reihenfolge:

  massbild     Zeichnung der Platine und Messblatt mit den eingetragenen Messwerten
  probeplatte  Probe-Platte 60 x 60 mm für Farben und Schwund
  passproben   Schablone, Steckerwand, Schachtprobe
  schriftprobe die Wörter des Deckels in den drei Schriftgrößen, die zur Wahl stehen
  entwurf      Gehäuse v0.4: Unterteil, Deckel mit Logo und Beschriftung in jeder Schriftgröße,
               Zubehör; Bilder, Zeichnungen der Beschriftung, Schnitte durch den Lichtschacht
  pruefung     Durchdringung, Regeln, Stege, Lichtschacht, Beschriftung in jeder Schriftgröße, Gedrucktes
               gegen den festgehaltenen Stand; schreibt aus/pruefung/pruefbericht.md
  bambu        jede 3MF durch Bambu Studio (nur, wenn es eingerichtet ist); fährt der Slicer jedes Zeichen
               der Schrift als geschlossene Bahn? Dazu die Bilder der ersten Schicht aus dem G-Code
  abgleich     Eingechecktes gegen diesen Bau: Gehören die 3MF unter druck/ und die Tabelle des
               Maßmodells in docs/ noch zum Programm?
"""
import sys
import time

SCHRITTE = ["massbild", "probeplatte", "passproben", "schriftprobe", "entwurf", "pruefung", "bambu", "abgleich"]


def lauf(schritt):
    from . import abgleich, bambu, bau, pruefung
    if schritt == "massbild":
        bau.bau_massbild()
    elif schritt == "probeplatte":
        bau.bau_probeplatte()
    elif schritt == "passproben":
        bau.bau_passproben()
    elif schritt == "schriftprobe":
        bau.bau_schriftprobe()
    elif schritt == "entwurf":
        bau.bau_entwurf()
    elif schritt == "pruefung":
        fehler = pruefung.pruefe()["fehler"]
        for f in fehler:
            print("  FEHLER:", f)
        return not fehler
    elif schritt == "bambu":
        daten = bambu.pruefe()
        return daten is None or not daten["fehler"]
    elif schritt == "abgleich":
        return abgleich.pruefe()
    return True


def main(argumente):
    schritte = argumente or SCHRITTE
    unbekannt = [s for s in schritte if s not in SCHRITTE]
    if unbekannt:
        sys.exit(f"Unbekannter Schritt: {', '.join(unbekannt)}\n{__doc__}")
    gut = True
    for schritt in schritte:
        t = time.time()
        print(f"== {schritt}", flush=True)
        gut = lauf(schritt) and gut
        print(f"   {time.time() - t:.0f} s", flush=True)
    sys.exit(0 if gut else 1)


if __name__ == "__main__":
    main(sys.argv[1:])

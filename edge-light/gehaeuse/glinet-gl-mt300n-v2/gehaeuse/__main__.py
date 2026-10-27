"""Baut alles nach aus/:  python -m gehaeuse [schritt ...]
Eine Box beschriften:      python -m gehaeuse --referenz edge-…

Ohne Angabe laufen alle Schritte in dieser Reihenfolge:

  massbild     Zeichnung der Platine und Messblatt mit den eingetragenen Messwerten
  probeplatte  Probe-Platte 60 x 60 mm für Farben und Schwund
  passproben   Schablone, Steckerwand, Schachtprobe
  schriftprobe die Wörter des Deckels in den drei Schriftgrößen, die zur Wahl stehen
  entwurf      Gehäuse v0.4: Unterteil, Deckel mit Logo und Beschriftung in jeder Schriftgröße,
               Zubehör; Bilder, Zeichnungen der Beschriftung, Schnitte durch den Lichtschacht; das
               Unterteil mit Kennung für die Probe-Referenz (aus/kennung/)
  pruefung     Durchdringung, Regeln, Stege, Lichtschacht, Beschriftung in jeder Schriftgröße, Gedrucktes
               gegen den festgehaltenen Stand, Kennung (Inhalt gleich dem Portal, Abstände); schreibt
               aus/pruefung/pruefbericht.md
  bambu        jede 3MF durch Bambu Studio (nur, wenn es eingerichtet ist); fährt der Slicer jedes Zeichen
               der Schrift als geschlossene Bahn? Ist der QR-Code aus dem G-Code lesbar? Dazu die Bilder
               der ersten Schicht aus dem G-Code
  abgleich     Eingechecktes gegen diesen Bau: Gehören die 3MF unter druck/ und die Tabelle des
               Maßmodells in docs/ noch zum Programm?

Mit --referenz baut und prüft der Lauf nur das Gehäuse dieser einen Box nach aus/kennung/<referenz>/:
gehaeuse-<referenz>.3mf (Unterteil mit Referenz und QR-Code, dazu der Deckel) und
unterteil-<referenz>.3mf. Rückgabewert 1, wenn eine Prüfung scheitert oder Bambu Studio fehlt (dann ist
die Lesbarkeit nicht geprüft).
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
        from .kennung import probe_referenz
        bau.bau_entwurf()
        bau.bau_kennung(probe_referenz())
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


def referenz(ref):
    """Das Gehäuse einer Box: bauen, Abstände und Inhalt prüfen, durch Bambu Studio, QR-Code lesen."""
    from . import bambu, bau, kennung, pruefung
    from .parameter import STANDARD
    ref = ref.strip().lower()   # so wie sie im Portal steht; die Klarschrift druckt groß
    if not kennung.gueltig(ref):
        sys.exit(f"Keine gültige Referenz: {ref!r}. Erwartet: edge- und sieben Zeichen mit Prüfzeichen, klein "
                 "geschrieben, so wie sie in der Werkstatt-Liste steht (etwa edge-wrk7abg).")
    ordner = bau.kennung_ordner(ref)
    t = time.time()
    print(f"== Gehäuse für {ref}", flush=True)
    bau.bau_kennung(ref)
    print("== Prüfung", flush=True)
    daten = pruefung.pruefe_kennung(STANDARD, ref)
    md = [f"# Gehäuse für {ref}", ""] + pruefung.kennung_md(daten, STANDARD)
    fehler = list(daten["fehler"])
    print("== Bambu Studio", flush=True)
    b = bambu.pruefe(bambu.kennung_laeufe(ref), ordner)
    if b is None:
        fehler.append("Bambu Studio fehlt (./einrichten.sh --bambu): Ob der Code gedruckt lesbar ist, ist nicht "
                      "geprüft")
    else:
        fehler += b["fehler"]
        md += [(ordner / "bambu.md").read_text(encoding="utf-8")]
    md[2:2] = ([f"- **Fehler:** {f}" for f in fehler] or ["- Keine verletzte Regel; der QR-Code ist aus dem "
                                                          "G-Code lesbar."]) + [""]
    (ordner / "pruefung.md").write_text("\n".join(md), encoding="utf-8")
    for f in fehler:
        print("  FEHLER:", f)
    print(f"   {time.time() - t:.0f} s")
    print(f"""
Zum Drucken (P1S, AMS): {ordner / f'gehaeuse-{ref}.3mf'}
  Unterteil mit Referenz und QR-Code und den Deckel auf einer Platte. Nur das Unterteil:
  {ordner / f'unterteil-{ref}.3mf'}
  Filament 1 weiß (ASA), 2 schwarz (ASA), 3 hellblau (ABS Azure, nur der Deckel).
  Bericht: {ordner / 'pruefung.md'}""")
    sys.exit(0 if not fehler else 1)


def main(argumente):
    if argumente[:1] == ["--referenz"]:
        if len(argumente) != 2:
            sys.exit("Aufruf: ./bauen.sh --referenz edge-…")
        referenz(argumente[1])
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

"""Vergleicht, was aus dem Programm entsteht und trotzdem eingecheckt ist, mit dem frischen Bau.

Das sind die Druckdateien unter ``druck/`` und die Tabelle des Maßmodells
``docs/massmodell-tabelle.md`` (damit man beides ohne Bau lesen und drucken kann).

Unter ``druck/`` liegt, was gedruckt wird: die 3MF des Standes, der als
fertig gilt. Einer 3MF sieht man nicht an, zu welchem Stand des Programms sie
gehört. Deshalb vergleicht dieser Schritt jede Datei dort mit der gleichnamigen
aus ``aus/<NAME>/`` und meldet einen Fehler, sobald sie auseinanderlaufen: Wer
eine Stellgröße ändert, merkt es beim Bauen. Die Tabelle des Maßmodells muss
Buchstabe für Buchstabe ``massmodell.tabelle_md()`` sein.

Byte für Byte gleich sind zwei Bauten derselben 3MF nie: lib3mf vergibt bei
jedem Schreiben neue Kennungen (``p:UUID``) für Objekte und Bauplatte.
Verglichen wird deshalb jede Datei im Archiv, die Kennungen ausgenommen; alles
andere (Ecken, Dreiecke, Namen, Farben, Filamentplätze, Einstellungen) muss
Byte für Byte stimmen.

Nach einer gewollten Änderung:  .venv/bin/python -m gehaeuse.abgleich uebernehmen
Danach in ``druck/README.md`` eintragen, was davon gedruckt und bestätigt ist.
"""
import hashlib
import re
import shutil
import sys
import zipfile

from . import massmodell
from .ausgabe import AUS
from .bau import NAME

DRUCK = AUS.parent / "druck"
TABELLE = AUS.parent / "docs" / "massmodell-tabelle.md"
SUMMEN = DRUCK / "SHA256SUMS"
TABELLE_KOPF = ("# Maßmodell: alle Zahlen mit Herkunft\n\n"
                "Erzeugt aus `gehaeuse/massmodell.py`; nicht von Hand ändern, sondern dort, und dann\n"
                "`.venv/bin/python -m gehaeuse.abgleich uebernehmen`. Was die Spalten bedeuten und woher die\n"
                "Zahlen stammen: [Maßmodell](massmodell.md). Alle Werte in Millimetern, Koordinaten ab der\n"
                "linken unteren Platinenecke.\n\n")
KENNUNG = re.compile(rb'p:UUID="[0-9a-fA-F-]{36}"')


def inhalt(pfad):
    """Dateien des Archivs in ihrer Reihenfolge: [(Name, Inhalt ohne Kennungen)]."""
    with zipfile.ZipFile(pfad) as z:
        return [(e.filename, KENNUNG.sub(b'p:UUID=""', z.read(e))) for e in z.infolist()]


def vergleiche():
    """Je eingecheckter 3MF: {datei, gleich, byte_gleich, grund}."""
    aus = []
    for soll in sorted(DRUCK.glob("*.3mf")):
        ist = AUS / NAME / soll.name
        zeile = {"datei": soll.name, "gleich": False, "byte_gleich": False, "grund": ""}
        aus.append(zeile)
        if not ist.exists():
            zeile["grund"] = f"fehlt im Bau (aus/{NAME}/): erst ./bauen.sh entwurf"
            continue
        zeile["byte_gleich"] = soll.read_bytes() == ist.read_bytes()
        a, b = inhalt(soll), inhalt(ist)
        if [n for n, _ in a] != [n for n, _ in b]:
            zeile["grund"] = "andere Dateien im Archiv"
            continue
        anders = [n for (n, x), (_, y) in zip(a, b) if x != y]
        zeile["gleich"] = not anders
        zeile["grund"] = ("weicht ab in " + ", ".join(anders) if anders else
                          "" if zeile["byte_gleich"] else "nur die Kennungen (p:UUID) sind andere")
    return aus


def summen_soll():
    """Inhalt von ``druck/SHA256SUMS``, wie ``sha256sum *.3mf`` ihn schreibt."""
    return "".join(f"{hashlib.sha256(d.read_bytes()).hexdigest()}  {d.name}\n" for d in sorted(DRUCK.glob("*.3mf")))


def summen_gleich():
    return SUMMEN.exists() and SUMMEN.read_text(encoding="utf-8") == summen_soll()


def tabelle_soll():
    return TABELLE_KOPF + massmodell.tabelle_md() + "\n"


def tabelle_gleich():
    return TABELLE.exists() and TABELLE.read_text(encoding="utf-8") == tabelle_soll()


def pruefe():
    """Schritt ``abgleich``: Ergebnis nach ``aus/pruefung/abgleich.md``; True, wenn alles stimmt."""
    zeilen = vergleiche()
    if not zeilen:
        print(f"  FEHLER: unter {DRUCK.name}/ liegt keine 3MF")
        return False
    md = ["## Eingecheckte Druckdateien gegen den Bau", "",
          f"Jede 3MF unter `druck/` gegen die gleichnamige aus `aus/{NAME}/`. Zwei Bauten sind nie Byte für "
          "Byte gleich, weil lib3mf bei jedem Schreiben neue Kennungen (`p:UUID`) vergibt; verglichen ist "
          "jede Datei im Archiv ohne diese Kennungen.", "",
          "| Datei | Inhalt gleich | Byte für Byte gleich | Bemerkung |", "|---|---|---|---|"]
    for z in zeilen:
        ja = lambda w: "ja" if w else "**nein**"   # noqa: E731
        md.append(f"| `{z['datei']}` | {ja(z['gleich'])} | {'ja' if z['byte_gleich'] else 'nein'} | {z['grund']} |")
        print(f"  {z['datei']}: {'gleich' if z['gleich'] else 'FEHLER'}{', ' + z['grund'] if z['grund'] else ''}")
    ziel = AUS / "pruefung"
    ziel.mkdir(parents=True, exist_ok=True)
    tabelle = tabelle_gleich()
    md += ["", f"Tabelle des Maßmodells (`docs/{TABELLE.name}`) entspricht `gehaeuse/massmodell.py`: "
           f"{'ja' if tabelle else '**nein**'}."]
    print(f"  docs/{TABELLE.name}: {'gleich' if tabelle else 'FEHLER, entspricht nicht massmodell.py'}")
    summen = summen_gleich()
    md += ["", f"Prüfsummen in `druck/{SUMMEN.name}` gehören zu den Dateien dort: {'ja' if summen else '**nein**'}."]
    print(f"  druck/{SUMMEN.name}: {'gleich' if summen else 'FEHLER, gehört nicht zu den Dateien'}")
    (ziel / "abgleich.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    gut = tabelle and summen and all(z["gleich"] for z in zeilen)
    if not gut:
        print("  FEHLER: Eingechecktes gehört nicht zu diesem Stand des Programms. Ist die Änderung gewollt: "
              ".venv/bin/python -m gehaeuse.abgleich uebernehmen, dann druck/README.md nachführen.")
    return gut


def uebernehmen():
    """Ersetzt jede 3MF unter ``druck/`` durch die gleichnamige aus dem Bau und
    schreibt die Tabelle des Maßmodells neu. Eine 3MF, deren Inhalt schon
    stimmt, bleibt liegen: Sonst änderten sich nur ihre Kennungen."""
    stimmt = {z["datei"] for z in vergleiche() if z["gleich"]}
    for soll in sorted(DRUCK.glob("*.3mf")):
        ist = AUS / NAME / soll.name
        if not ist.exists():
            sys.exit(f"{soll.name} fehlt im Bau (aus/{NAME}/): erst ./bauen.sh entwurf")
        if soll.name in stimmt:
            continue
        shutil.copyfile(ist, soll)
        print("übernommen:", soll.name)
    for datei, soll, gleich in ((TABELLE, tabelle_soll, tabelle_gleich), (SUMMEN, summen_soll, summen_gleich)):
        if not gleich():
            datei.write_text(soll(), encoding="utf-8")
            print("neu geschrieben:", datei.name)
    print("Jetzt druck/README.md nachführen: Was davon ist gedruckt und bestätigt?")


if __name__ == "__main__":
    if sys.argv[1:] == ["uebernehmen"]:
        uebernehmen()
    else:
        sys.exit(0 if pruefe() else 1)

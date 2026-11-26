#!/usr/bin/env python3
"""Paket-Anhang einer Edge-Light-Fassung bauen (edge-light-pakete.tar.gz).

    edge-light/scripts/pakete-paket.py <ausgabe.tar.gz> [pins.json]

Die OpenWrt-Pakete des Direktvermarkter-Anschlusses (Konzept
vp-direktvermarktung-konzept d2, E5/Stufe 5, PS-D10), gepinnt mit Fassung,
Pruefsumme und Quelle in edge-light/openwrt/pakete.json. Jede Datei kommt von
ihrer gepinnten Quelle (oder aus VP_PAKETE_QUELLE_DIR, etwa einem
Release-Zwischenspeicher ohne Internet) und wird NUR verwendet, wenn
Pruefsumme und Groesse exakt stimmen - kein Paket aus einer ungeprueften
Quelle (Konzept Abschnitt 8).

Ins Archiv kommen pakete/INHALT (Kopfzeilen openwrt/arch, dann je Paket
"<sha256>  <datei>") und pakete/<datei>. Gleicher Stand ergibt dieselben
Bytes (sortiert, Zeit 0, Besitzer 0, gzip ohne Namen und Zeit): die
Pruefsumme im signierten Manifest (vp-ota manifest --pakete) ist damit
wiederholbar. install.sh (Werkstatt, VP_PAKETE) und das Box-Programm
(Feld-Update) installieren die Pakete nur aus diesem gepruefter Anhang.
"""
import gzip
import hashlib
import io
import json
import os
import ssl
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PINS_VORGABE = os.path.join(HERE, "..", "openwrt", "pakete.json")


def lade(eintrag: dict, quelle_dir: str | None) -> bytes:
    datei = eintrag["datei"]
    if quelle_dir:
        with open(os.path.join(quelle_dir, datei), "rb") as f:
            return f.read()
    url = eintrag["quelle"]
    if not url.startswith("https://"):
        print(f"FEHLER: Quelle von {datei} ist nicht https: {url}", file=sys.stderr)
        raise SystemExit(1)
    try:
        with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 - https erzwungen
            return r.read()
    except urllib.error.URLError as e:
        # Ein Python ohne Wurzelzertifikate (python.org-Build auf macOS) kann
        # https nicht pruefen; curl nutzt den System-Speicher. Die Pruefsumme
        # unten gilt unabhaengig vom Transport.
        if not isinstance(getattr(e, "reason", None), ssl.SSLError):
            raise
        return subprocess.run(["curl", "-fsSL", "--max-time", "120", url],
                              check=True, stdout=subprocess.PIPE).stdout


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    ausgabe = sys.argv[1]
    pins_pfad = sys.argv[2] if len(sys.argv) == 3 else PINS_VORGABE
    with open(pins_pfad, encoding="utf-8") as f:
        pins = json.load(f)
    eintraege = pins.get("pakete", [])
    if not eintraege:
        print(f"FEHLER: {pins_pfad} pinnt keine Pakete", file=sys.stderr)
        return 1
    quelle_dir = os.environ.get("VP_PAKETE_QUELLE_DIR") or None

    inhalt = [f"openwrt {pins['openwrt']}", f"arch {pins['arch']}"]
    dateien: list[tuple[str, bytes]] = []
    gesehen: set[str] = set()
    for e in eintraege:
        datei, soll = e["datei"], e["sha256"]
        if datei in gesehen or "/" in datei or datei.startswith(".") or not datei.endswith(".apk"):
            print(f"FEHLER: Pin {datei!r} ist kein einfacher .apk-Dateiname oder doppelt", file=sys.stderr)
            return 1
        gesehen.add(datei)
        daten = lade(e, quelle_dir)
        ist = hashlib.sha256(daten).hexdigest()
        if ist != soll or len(daten) != e["groesse"]:
            print(f"FEHLER: {datei} hat sha256 {ist} ({len(daten)} Bytes), gepinnt ist "
                  f"{soll} ({e['groesse']} Bytes) - Datei wird NICHT verwendet", file=sys.stderr)
            return 1
        inhalt.append(f"{soll}  {datei}")
        dateien.append((datei, daten))

    roh = io.BytesIO()
    with tarfile.open(fileobj=roh, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        def lege(name: str, daten: bytes) -> None:
            info = tarfile.TarInfo(name="pakete/" + name)
            info.size = len(daten)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(daten))

        lege("INHALT", ("\n".join(inhalt) + "\n").encode())
        for name, daten in dateien:
            lege(name, daten)
    with open(ausgabe, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=f, compresslevel=9, mtime=0) as gz:
            gz.write(roh.getvalue())
    print(f"--- Paket-Anhang: {len(dateien)} Pakete (OpenWrt {pins['openwrt']}, {pins['arch']}) -> {ausgabe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

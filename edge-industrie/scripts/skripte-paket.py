#!/usr/bin/env python3
"""Skriptstand einer Edge-Industrie-Fassung als Release-Anhang packen.

    edge-industrie/scripts/skripte-paket.py <ausgabe.tar.gz>

Packt die von Git verwalteten Dateien, die der Werkstatt-Dienst beim Einrichten
eines WAGO PFC200 und für einen Fernlauf durch den Wartungstunnel braucht, als
edge-industrie/... in ein tar.gz: install.sh, wartung.sh, fernlauf.sh und alles
unter files/. Gleicher Stand ergibt dieselben Bytes
(sortiert, Zeit 0, Besitzer 0, gzip ohne Namen und Zeit): die Prüfsumme im
signierten Manifest ist damit wiederholbar. Keine ungetrackten Dateien, keine
Verweise, keine ._-Dateien von macOS. Nicht im Paket: der Quelltext des
Tunnel-Programms (wartung/), Proben und Bau-Skripte.

Der Werkstatt-Dienst packt genau dieses Format aus
(services/werkstatt-dienst/internal/fassungen, AuspackenPFC200) und prüft es im
Test TestEchterSkriptstandPFC200. Das Gegenstück der Mango:
edge-light/scripts/skripte-paket.py.
"""
import gzip
import io
import os
import subprocess
import sys
import tarfile

PFLICHT = (
    "edge-industrie/install.sh",
    "edge-industrie/wartung.sh",
    "edge-industrie/fernlauf.sh",
    "edge-industrie/files/etc/init.d/vp-edge-industrie",
    "edge-industrie/files/etc/init.d/vp-wartung",
    "edge-industrie/files/home/voltpilot/libexec/boot.sh",
)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    ausgabe = sys.argv[1]
    industrie = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo = os.path.dirname(industrie)
    namen = subprocess.run(
        ["git", "-C", repo, "ls-files", "-z", "--",
         "edge-industrie/install.sh", "edge-industrie/wartung.sh", "edge-industrie/fernlauf.sh",
         "edge-industrie/files"],
        check=True, capture_output=True,
    ).stdout.decode().split("\0")
    namen = sorted(n for n in namen if n)
    for p in PFLICHT:
        if p not in namen:
            print(f"FEHLER: {p} fehlt", file=sys.stderr)
            return 1
    roh = io.BytesIO()
    with tarfile.open(fileobj=roh, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for n in namen:
            pfad = os.path.join(repo, n)
            if os.path.islink(pfad) or not os.path.isfile(pfad):
                print(f"FEHLER: {n} ist keine gewöhnliche Datei", file=sys.stderr)
                return 1
            with open(pfad, "rb") as f:
                daten = f.read()
            info = tarfile.TarInfo(name=n)
            info.size = len(daten)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if os.access(pfad, os.X_OK) else 0o644
            tar.addfile(info, io.BytesIO(daten))
    with open(ausgabe, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=f, compresslevel=9, mtime=0) as gz:
            gz.write(roh.getvalue())
    print(f"--- Skriptstand: {len(namen)} Dateien -> {ausgabe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

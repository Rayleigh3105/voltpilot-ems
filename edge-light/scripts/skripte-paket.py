#!/usr/bin/env python3
"""Skriptstand einer Edge-Light-Fassung als Release-Anhang packen.

    edge-light/scripts/skripte-paket.py <ausgabe.tar.gz>

Packt die von Git verwalteten Dateien unter edge-light/openwrt/ als
openwrt/... (install.sh, service-tunnel.sh, files/) in ein tar.gz. Gleicher
Stand ergibt dieselben Bytes (sortiert, Zeit 0, Besitzer 0, gzip ohne Namen und
Zeit): die Prüfsumme in der Freigabe der Werkstatt ist damit wiederholbar.
Keine ungetrackten Dateien, keine Verweise, keine ._-Dateien von macOS.

Der Werkstatt-Dienst packt genau dieses Format aus
(services/werkstatt-dienst/internal/fassungen, Auspacken) und prüft es im Test
TestEchterSkriptstand.
"""
import gzip
import io
import os
import subprocess
import sys
import tarfile


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    ausgabe = sys.argv[1]
    light = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo = os.path.dirname(light)
    namen = subprocess.run(
        ["git", "-C", repo, "ls-files", "-z", "--", "edge-light/openwrt"],
        check=True, capture_output=True,
    ).stdout.decode().split("\0")
    namen = sorted(n for n in namen if n)
    if "edge-light/openwrt/install.sh" not in namen or "edge-light/openwrt/service-tunnel.sh" not in namen:
        print("FEHLER: install.sh oder service-tunnel.sh fehlt in edge-light/openwrt", file=sys.stderr)
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
            info = tarfile.TarInfo(name=n[len("edge-light/"):])
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

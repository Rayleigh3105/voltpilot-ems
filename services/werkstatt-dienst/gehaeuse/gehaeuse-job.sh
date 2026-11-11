#!/bin/bash
# Ein Auftrag des Werkstatt-Dienstes im Bau-Image: das Gehäuse einer Box.
#
#   gehaeuse-job <referenz>
#
# Baut und prüft mit dem Gehäuse-Programm (bauen.sh --referenz). Alles landet
# in aus/ des Programms, dort hängt der Job den Unterordner der Ablage ein:
# aus/kennung/<referenz>/ und aus/ausgabe.log. Rückgabewert wie bauen.sh:
# 0 nur, wenn keine Prüfung scheitert und der QR-Code aus dem G-Code lesbar ist.
set -uo pipefail
if [ $# -ne 1 ]; then
    echo "Aufruf: gehaeuse-job <referenz>" >&2
    exit 2
fi
cd /opt/vp/edge-light/gehaeuse/glinet-gl-mt300n-v2
./bauen.sh --referenz "$1" 2>&1 | tee aus/ausgabe.log
exit "${PIPESTATUS[0]}"

#!/bin/bash
# Baut alles nach aus/: Zeichnungen, Probe-Platte, Passproben, Gehäuse,
# Prüfbericht; vergleicht am Ende, was eingecheckt ist (Druckdateien unter
# druck/, Tabelle des Maßmodells), mit dem Bau. Einzelne Schritte als Argument:
#
#   ./bauen.sh                       alles (rund eine Viertelstunde)
#   ./bauen.sh entwurf pruefung      nur diese Schritte
#   ./bauen.sh --hilfe               Liste der Schritte
#
# Der Schritt "bambu" läuft nur, wenn Bambu Studio eingerichtet ist
# (./einrichten.sh --bambu). Rückgabewert 1, wenn die Prüfung einen Fehler meldet
# oder Eingechecktes nicht mehr zum Programm gehört.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
if [ ! -x .venv/bin/python ]; then
    echo "Die Umgebung fehlt: erst ./einrichten.sh" >&2
    exit 2
fi
if [ "${1:-}" = "--hilfe" ]; then
    .venv/bin/python -c "import gehaeuse.__main__ as h; print(h.__doc__)"
    exit 0
fi
# niedrige Priorität: Die Maschine wird mit anderen geteilt
exec nice -n 10 .venv/bin/python -m gehaeuse "$@"

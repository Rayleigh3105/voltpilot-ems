#!/bin/bash
# Legt die Umgebung an: ohne Root-Rechte, ohne Bildschirm.
#
#   ./einrichten.sh            Python-Umgebung in .venv (rund 1,1 GB, eine Minute)
#   ./einrichten.sh --bambu    zusätzlich Bambu Studio für die Prüfung der 3MF
#                              (rund 0,8 GB, lädt 230 MB)
#
# Debian liefert python3 ohne ensurepip; deshalb entsteht die Umgebung ohne
# pip und wird vom pip des Benutzers gefüllt (pip >= 23, Option --python).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
if [ ! -x .venv/bin/python ]; then
    python3 -m venv --without-pip .venv
fi
pip --python .venv/bin/python install --quiet -r anforderungen.txt
.venv/bin/python -c "import build123d, lib3mf; print('Python-Umgebung bereit: build123d', build123d.__version__)"
if [ "${1:-}" = "--bambu" ]; then
    werkzeug/bambu_einrichten.sh
fi

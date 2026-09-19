#!/usr/bin/env bash
# Tor-Pruefer der ersten UEMS-Produktfreigabe (AP-14 IP-21).
#
# Legt je Tor vor, was belegt ist und was fehlt. Das Werkzeug urteilt NICHT
# darueber, ob das Tor oeffnet - das tut der Betreiber selbst.
#
#   bash tools/freigabe/pruefe-tor.sh G0
#   bash tools/freigabe/pruefe-tor.sh G1 --stand /BETREIBER/freigabe-stand.yaml \
#        --laeufe /LAEUFE/surefire-reports --blatt /BETREIBER/q01-q18.txt \
#        --generalprobe /BETREIBER/generalprobe
#
# Exit 0 = kein Punkt offen · 1 = mindestens ein Punkt offen · 2 = Aufruffehler.
set -euo pipefail
# Kein Shell-Tracing: Argumente koennen auf Betreiberdateien zeigen.
set +x
exec python3 "$(dirname "$0")/pruefe_tor.py" "$@"

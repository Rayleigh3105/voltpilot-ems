#!/usr/bin/env bash
# AP-15 IP-28 (NW-3): Störungen am laufenden Simulator-Aufbau - wiederholbar.
#
#   stoerung.sh <zeile>     Störung setzen (Start in Simulator-Sekunden ins Protokoll)
#   stoerung.sh zurueck     jede aktive Störung aufheben (Ende ins Protokoll)
#   stoerung.sh liste       die Zeilen
#
# Zeilen (Matrix §5.1 des Konzepts AP-15):
#   A1   Box Verwaltung (mitsteuernd) Strom weg: core-e4 + nodered-e4 hart gestoppt
#   A2   Box Halle 1 (führend) Strom weg:        core-e1 + nodered-e1 hart gestoppt
#   A3   Cloud stumm, Broker erreichbar: der Viertelstunden-Lauf der Cloud bleibt aus
#   A4   Broker angehalten (docker pause) - für ALLE Boxen weg
#   A5   einseitig: Box Verwaltung vom Broker-Netz getrennt (docker network disconnect)
#   A5f  einseitig: Box Halle 1 vom Broker-Netz getrennt
#   A7   Netzzähler friert ein: dieselbe Zahl, frisch gelesen (Anlage; A7e im NW-2)
#   A7x  Netzzähler UND Abgangszähler fehlen: sie antworten nicht (Anlage; A7 im NW-2)
#   A8+  Uhr der Box +840 s / A8- −840 s: im Container NICHT fahrbar (siehe README)
#   A13  Neustart mitten im Eingriff: Box Halle 1 neu gestartet (core-e1 + nodered-e1)
#   A13v Neustart von Box Verwaltung
#   A15  Box Halle 1 lebt, erreicht ihr Gerät nicht (Modbus antwortet nicht)
#
# Umgebung wie verbund.sh (VB_PROJEKT, VB_ARBEIT).
set -euo pipefail

PROJEKT="${VB_PROJEKT:-uems-verbund}"
ARBEIT="${VB_ARBEIT:-${TMPDIR:-/tmp}/uems-verbund-$PROJEKT}"
AKTIV="$ARBEIT/stoerung.aktiv"
WAN="${PROJEKT}_wan"

mkdir -p "$ARBEIT"
touch "$AKTIV"

# Über die Compose-Labels statt `docker compose ps`: das bräuchte die
# Bild-Variablen, die nur verbund.sh setzt - die Störung soll auch allein gehen.
id_von() { # <dienst>
  local id
  id="$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJEKT" \
    --filter "label=com.docker.compose.service=$1")"
  [ -n "$id" ] || { echo "kein Container $1 im Aufbau $PROJEKT" >&2; return 1; }
  echo "$id"
}

# Jede Störung meldet sich bei der Anlage an: so steht sie mit Start und Ende
# in Simulator-Sekunden im Protokoll, auch wenn sie am Container geschieht.
melden() { # <zeile> <art> <box> <phase>
  docker exec "$(id_von anlage)" python3 /app/uems_verbund.py steuer \
    "{\"cmd\":\"stoerung\",\"zeile\":\"$1\",\"art\":\"$2\",\"box\":\"$3\",\"phase\":\"$4\"}"
}

box_dienste() { case "$1" in E-1) echo "core-e1 nodered-e1" ;; E-4) echo "core-e4 nodered-e4" ;; esac; }

strom_weg() { # <box>
  local d
  for d in $(box_dienste "$1"); do docker kill "$(id_von "$d")" >/dev/null; done
}
strom_da() { # <box>
  local d
  for d in $(box_dienste "$1"); do docker start "$(id_von "$d")" >/dev/null; done
}

setzen() { # <zeile>
  local z="$1"
  if grep -qx "$z" "$AKTIV"; then echo "$z ist schon aktiv" >&2; return 1; fi
  case "$z" in
    A1)   melden A1 strom_weg E-4 start; strom_weg E-4 ;;
    A2)   melden A2 strom_weg E-1 start; strom_weg E-1 ;;
    A3)   melden A3 cloud_stumm "" start; touch "$ARBEIT/cloud.stumm" ;;
    A4)   melden A4 broker_angehalten "" start; docker pause "$(id_von cloud-broker)" >/dev/null ;;
    A5)   melden A5 getrennt E-4 start; docker network disconnect "$WAN" "$(id_von core-e4)" ;;
    A5f)  melden A5f getrennt E-1 start; docker network disconnect "$WAN" "$(id_von core-e1)" ;;
    A7)   melden A7 zaehler_friert E-1 start ;;
    A7x)  melden A7x zaehler_fehlt E-1 start; melden A7x zaehler_fehlt E-4 start ;;
    A13)  melden A13 neustart E-1 start; strom_weg E-1; strom_da E-1 ;;
    A13v) melden A13v neustart E-4 start; strom_weg E-4; strom_da E-4 ;;
    A15)  melden A15 lan_weg E-1 start ;;
    A8+|A8-)
      cat >&2 <<'TEXT'
A8 ist in diesem Aufbau nicht fahrbar: die Uhr eines Containers ist die Uhr des
Docker-Hosts (CLOCK_REALTIME hat keinen Namensraum), und der Go-Core ist
statisch gebaut (CGO_ENABLED=0) und liest die Zeit direkt - `faketime`
(LD_PRELOAD) greift nicht. Den Zeitstempel setzt der Core selbst (Node-RED
schickt im Simulator-Tab keinen `ts`). Nötig wäre eine Prüf-Verstellung der
Uhr im Core (Box-Code) - Befund, nicht Umfang von IP-28.
TEXT
      return 3 ;;
    *) echo "unbekannte Zeile $z ($0 liste)" >&2; return 2 ;;
  esac
  echo "$z" >> "$AKTIV"
  echo "Störung $z gesetzt"
}

aufheben() { # <zeile>
  case "$1" in
    A1)   strom_da E-4; melden A1 strom_weg E-4 ende ;;
    A2)   strom_da E-1; melden A2 strom_weg E-1 ende ;;
    A3)   [ -n "$ARBEIT" ] && [ -e "$ARBEIT/cloud.stumm" ] && rm "$ARBEIT/cloud.stumm"; melden A3 cloud_stumm "" ende ;;
    A4)   docker unpause "$(id_von cloud-broker)" >/dev/null; melden A4 broker_angehalten "" ende ;;
    A5)   docker network connect --alias core-e4 "$WAN" "$(id_von core-e4)"; melden A5 getrennt E-4 ende ;;
    A5f)  docker network connect --alias core-e1 "$WAN" "$(id_von core-e1)"; melden A5f getrennt E-1 ende ;;
    A7)   melden A7 zaehler_friert E-1 ende ;;
    A7x)  melden A7x zaehler_fehlt E-1 ende; melden A7x zaehler_fehlt E-4 ende ;;
    A13)  melden A13 neustart E-1 ende ;;
    A13v) melden A13v neustart E-4 ende ;;
    A15)  melden A15 lan_weg E-1 ende ;;
  esac
  echo "Störung $1 aufgehoben"
}

case "${1:-}" in
  liste) sed -n '9,21p' "$0" ;;
  zurueck)
    while read -r z; do [ -n "$z" ] && aufheben "$z"; done < "$AKTIV"
    : > "$AKTIV" ;;
  "") sed -n '2,23p' "$0"; exit 2 ;;
  *) setzen "$1" ;;
esac

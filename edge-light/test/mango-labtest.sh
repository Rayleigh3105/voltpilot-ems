#!/usr/bin/env bash
# Labortest auf einem ECHTEN Mango (oder jedem OpenWrt-Geraet mit mipsle):
# Edge Light von Hand starten und messen - ohne Loader, ohne Download-Server,
# OHNE Kontakt zum Produktivportal.
#
#   edge-light/test/mango-labtest.sh <mango-ip>
#   edge-light/test/mango-labtest.sh <mango-ip> <deye-ip> <logger-seriennummer> [modell-id]
#   edge-light/test/mango-labtest.sh stop <mango-ip>
#
# Was passiert:
#   1. das MIPS-Programm wird (falls noetig) gebaut und per SSH nach /tmp
#      kopiert (RAM; nichts landet im Flash), Pruefsumme auf dem Geraet geprueft,
#   2. gestartet mit Datenverzeichnis in /tmp und einer UNERREICHBAREN
#      Portal-Adresse - die Box versucht die Kopplung, erreicht aber nichts,
#   3. gemessen: Startzeit, Speicher (VmRSS), freier RAM, CPU,
#   4. mit Deye-Angaben: Wechselrichter auf :8484 einrichten, Messwerte und
#      "Verbindung testen" pruefen. VORHER Home Assistant fuer diesen Logger
#      abschalten - der Logger bedient nur EINEN Client.
#
# Das Programm laeuft danach weiter (Web-App: http://<mango-ip>:8484), bis
# "stop" aufgerufen oder der Mango neu gestartet wird. Ein Neustart entfernt
# alles, was dieser Test angelegt hat.
#
# ⚠ Ungetestet gegen echte Hardware (geschrieben ohne Zugang zum Mango);
# Voraussetzungen am Geraet sind geprueft: edge-light/docs/mango.md.
# Die Befehle an remote werden bewusst erst auf dem Mango ausgewertet:
# shellcheck disable=SC2016,SC2029
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

if [ "${1:-}" = "stop" ]; then
  MANGO="${2:?Mango-IP fehlt}"
  ssh "${SSH_OPTS[@]}" "root@$MANGO" 'killall vp-edge-light 2>/dev/null; rm -rf /tmp/vp-edge-light /tmp/vp-labtest /tmp/vp-labtest.log; echo gestoppt'
  exit 0
fi

MANGO="${1:?Mango-IP fehlt (edge-light/test/mango-labtest.sh <mango-ip> [deye-ip seriennummer [modell]])}"
DEYE_IP="${2:-}"
DEYE_SERIAL="${3:-}"
DEYE_MODEL="${4:-sun-12k-sg04lp3}"
WEB="http://$MANGO:8484"
BIN="$LIGHT_DIR/dist/vp-edge-light-linux-mipsle"
remote() { ssh "${SSH_OPTS[@]}" "root@$MANGO" "$@"; }

command -v curl >/dev/null 2>&1 || { echo "FEHLER: curl fehlt" >&2; exit 1; }

# -f statt -x: Git-Bash unter Windows haelt ein ELF-Programm nie fuer ausfuehrbar.
if [ ! -f "$BIN" ]; then
  echo "--- baue Edge Light fuer mipsle"
  "$LIGHT_DIR/scripts/build.sh" mipsle
fi
local_sum="$(sha256sum "$BIN" | awk '{print $1}')"

echo "--- Ausgangslage auf $MANGO"
remote 'cat /tmp/sysinfo/model; awk "/MemAvailable/ {printf \"RAM verfuegbar: %d MB\n\", \$2/1024}" /proc/meminfo; df -h /overlay /tmp | tail -2'

echo "--- kopiere das Programm nach /tmp (RAM)"
# cat|ssh statt scp: Dropbear auf OpenWrt bringt oft kein scp/sftp mit.
remote 'killall vp-edge-light 2>/dev/null; cat > /tmp/vp-edge-light.part' <"$BIN"
remote_sum="$(remote 'sha256sum /tmp/vp-edge-light.part' | awk '{print $1}')"
[ "$local_sum" = "$remote_sum" ] || { echo "FEHLER: Pruefsumme auf dem Geraet stimmt nicht" >&2; exit 1; }
remote 'chmod 0755 /tmp/vp-edge-light.part && mv /tmp/vp-edge-light.part /tmp/vp-edge-light'

echo "--- starte (Datenverzeichnis /tmp/vp-labtest, Portal unerreichbar)"
start="$(date +%s)"
# setsid statt nohup: die OpenWrt-BusyBox bringt kein nohup mit.
remote 'mkdir -p /tmp/vp-labtest && cd /tmp && \
  VP_DATA_DIR=/tmp/vp-labtest VP_PORTAL_BASE_URL=http://127.0.0.1:9 \
  VP_HTTP_ADDR=:8484 VP_LOCAL_MQTT_ADDR=127.0.0.1:1883 GOMEMLIMIT=48MiB \
  setsid /tmp/vp-edge-light >/tmp/vp-labtest.log 2>&1 </dev/null &'

fail_start() {
  echo "FEHLER: $1. Protokoll:" >&2
  remote 'tail -30 /tmp/vp-labtest.log' >&2
  exit 1
}
for i in $(seq 1 120); do
  curl -fsS -m 2 "$WEB/health" >/dev/null 2>&1 && break
  # alle 10 s: ist der Prozess ueberhaupt noch da? Sonst nicht weiter warten.
  if [ $((i % 10)) -eq 3 ] && ! remote 'pidof vp-edge-light >/dev/null'; then
    fail_start "vp-edge-light laeuft nicht (mehr)"
  fi
  sleep 1
done
curl -fsS -m 2 "$WEB/health" >/dev/null 2>&1 || fail_start "$WEB/health antwortet nicht"
echo "    Web-App antwortet nach $(($(date +%s) - start)) s"

measure() {
  remote 'pid="$(pidof vp-edge-light)"; [ -n "$pid" ] || { echo "    PROZESS LAEUFT NICHT"; exit 1; }
    awk "/VmRSS/ {printf \"    Prozess (VmRSS): %d MB\n\", \$2/1024}" /proc/$pid/status
    awk "/MemAvailable/ {printf \"    RAM verfuegbar:  %d MB\n\", \$2/1024}" /proc/meminfo
    top -b -n 1 | awk -v p="$pid" "\$1 == p {print \"    CPU (top):       \" \$7}"'
}
echo "--- Messung direkt nach dem Start"
measure

if [ -n "$DEYE_IP" ]; then
  [ -n "$DEYE_SERIAL" ] || { echo "FEHLER: Logger-Seriennummer fehlt" >&2; exit 1; }
  body="{\"brand\":\"deye\",\"model\":\"$DEYE_MODEL\",\"connection\":{\"ip\":\"$DEYE_IP\",\"port\":8899,\"serial\":\"$DEYE_SERIAL\"}}"

  echo "--- Verbindung testen ($DEYE_MODEL an $DEYE_IP)"
  curl -fsS -m 20 -X POST -H 'Content-Type: application/json' "$WEB/api/test-connection" -d "$body"
  echo

  echo "--- Wechselrichter einrichten"
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' "$WEB/api/inverter" -d "$body" >/dev/null
  for _ in $(seq 1 60); do
    st="$(curl -fsS -m 5 "$WEB/api/state" || true)"
    echo "$st" | grep -q '"inverter_link":"up"' && break
    sleep 1
  done
  if echo "$st" | grep -q '"inverter_link":"up"'; then
    echo "    Messwerte im Kern:"
    echo "$st" | grep -o '"last_reading":{[^}]*}' | sed 's/^/    /'
  else
    echo "    KEIN Messwert nach 60 s - Protokoll:"
    remote 'grep -i layer1 /tmp/vp-labtest.log | tail -10'
  fi
fi

echo "--- Messung nach 60 s Betrieb"
sleep 60
measure

echo
echo "Laeuft weiter: $WEB  ·  Protokoll: ssh root@$MANGO tail -f /tmp/vp-labtest.log"
echo "Stoppen:       $0 stop $MANGO"
echo "Bitte die Messwerte in edge-light/docs/mango.md eintragen."

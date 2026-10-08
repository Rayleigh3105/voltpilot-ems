#!/usr/bin/env bash
# Smoke-Test der ECHTEN Mango-Variante (linux/mipsle, softfloat) - ohne Mango:
# das MIPS-Programm laeuft unter qemu-user-Emulation in einem Container, gegen
# einen simulierten Deye-Datenlogger (vp-solarman-sim). Geprueft wird der Weg,
# den ein Kunde geht:
#
#   1. Edge Light startet (Web-App :8484, lokaler Bus, OCPP, Schluessel),
#   2. Wechselrichter-Auswahl ueber die lokale Web-API (wie auf :8484),
#   3. die Go-Schicht 1 liest den Logger -> Messwerte im Kern (/api/state),
#   4. "Verbindung testen" antwortet ueber den Kern.
#
# Braucht nur Docker. Laufzeit ca. 1 Minute (Emulation ist langsam - auf dem
# echten Mango ist der Start deutlich schneller als hier).
#
#   edge-light/test/qemu-smoke.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

command -v docker >/dev/null 2>&1 || { echo "FEHLER: Docker fehlt" >&2; exit 1; }

DIST="$LIGHT_DIR/dist"
TOOLS="$DIST/tools"
mkdir -p "$TOOLS"

echo "--- baue Edge Light fuer mipsle"
"$LIGHT_DIR/scripts/build.sh" mipsle >/dev/null

native="$(docker info --format '{{.Architecture}}')"
case "$native" in
  x86_64 | amd64) simarch=amd64 ;;
  aarch64 | arm64) simarch=arm64 ;;
  *) echo "FEHLER: unbekannte Docker-Architektur $native" >&2; exit 1 ;;
esac
echo "--- baue den Logger-Simulator ($simarch)"
go_run GOOS=linux "GOARCH=$simarch" CGO_ENABLED=0 -- build -o "$(core_rel "$TOOLS/vp-solarman-sim")" ./cmd/vp-solarman-sim

echo "--- starte Edge Light (mipsle) unter qemu"
docker run --rm -v "$DIST":/dist:ro debian:bookworm-slim sh -euc '
  apt-get update -qq >/dev/null && apt-get install -y -qq qemu-user curl >/dev/null 2>&1
  /dist/tools/vp-solarman-sim -addr 127.0.0.1:8899 >/tmp/sim.log 2>&1 &
  mkdir -p /tmp/vp
  VP_DATA_DIR=/tmp/vp VP_HTTP_ADDR=127.0.0.1:8484 VP_LOCAL_MQTT_ADDR=127.0.0.1:1883 \
  VP_PORTAL_BASE_URL=http://127.0.0.1:9 VP_MIRROR_PORT=11502 \
  qemu-mipsel /dist/vp-edge-light-linux-mipsle >/tmp/light.log 2>&1 &
  LIGHT=$!

  fail() { echo "FEHLER: $1"; echo "--- Edge-Light-Protokoll"; tail -40 /tmp/light.log; exit 1; }

  for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8484/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS http://127.0.0.1:8484/health >/dev/null || fail "Web-App kam nicht hoch"
  echo "    1. /health antwortet nach ${i}s"

  curl -fsS -X POST -H "Content-Type: application/json" http://127.0.0.1:8484/api/inverter \
    -d "{\"brand\":\"deye\",\"model\":\"sun-12k-sg04lp3\",\"connection\":{\"ip\":\"127.0.0.1\",\"port\":8899,\"serial\":\"2985159064\"}}" \
    >/dev/null || fail "Wechselrichter-Auswahl abgelehnt"
  echo "    2. Wechselrichter gewaehlt (Deye SUN-12K-SG04LP3 am simulierten Logger)"

  for i in $(seq 1 60); do
    st="$(curl -fsS http://127.0.0.1:8484/api/state || true)"
    echo "$st" | grep -q "\"inverter_link\":\"up\"" && break
    sleep 1
  done
  echo "$st" | grep -q "\"inverter_link\":\"up\"" || fail "kein Messwert im Kern"
  echo "$st" | grep -q "\"pv_power_kw\":2.2" || fail "PV-Wert falsch: $st"
  echo "    3. Messwerte im Kern nach ${i}s (PV 2,2 kW, Verbindung up)"

  tr="$(curl -fsS -X POST -H "Content-Type: application/json" http://127.0.0.1:8484/api/test-connection \
    -d "{\"brand\":\"deye\",\"model\":\"sun-12k-sg04lp3\",\"connection\":{\"ip\":\"127.0.0.1\",\"port\":8899,\"serial\":\"2985159064\"}}")"
  echo "$tr" | grep -q "\"ok\":true" || fail "Verbindungstest: $tr"
  echo "    4. Verbindung testen: ok ($tr)"

  kill -0 $LIGHT 2>/dev/null || fail "Edge Light ist abgestuerzt"
  if grep -E "panic|fatal error|SIGBUS" /tmp/light.log; then fail "Laufzeitfehler im Protokoll"; fi
  echo "--- Smoke-Test bestanden"
'

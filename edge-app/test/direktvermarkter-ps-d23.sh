#!/usr/bin/env bash
# PS-D23 (vp-direktvermarktung-konzept d2 §10): "ein gestellter luox liest und
# schreibt im Container." A staged luox (vp-luox-sim) polls the
# direktvermarkter data-mirror server (edge-app/core/internal/direktvermarkter)
# over real Modbus TCP, in a real second container - covers a known read, a
# set-point write, a band violation, watchdog expiry and a server restart.
#
# Same two rules as test/e2e-compose.sh (Forgejo-Lauf 281): no bind mount
# (the image carries the binaries built in the Dockerfile, nothing from the
# workspace is mounted) and no request to a published port over the runner's
# own 127.0.0.1 - everything goes through a sidecar INSIDE the docker
# network, by container name. Requires Docker; never touches a live
# voltpilot-* stack (own network, own container names, no compose file).
set -euo pipefail

cd "$(dirname "$0")/.."   # edge-app/

RUN_ID="$$"
IMAGE="vp-direktvermarkter-test:${RUN_ID}"
NET="vp-dv-ps-d23-${RUN_ID}"
SERVER="vp-dv-server-${RUN_ID}"
POLLER="vp-dv-poller-${RUN_ID}"
PROBE_IMAGE="${VP_E2E_PROBE_IMAGE:-python:3.12-alpine}"
PROBE=""

cleanup() {
  echo "--- cleanup"
  [ -n "$PROBE" ] && docker rm -f "$PROBE" >/dev/null 2>&1
  docker rm -f "$SERVER" "$POLLER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

fail() { echo "PS-D23 FAILED: $*" >&2; exit 1; }

echo "==> environment"
echo "    docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"

echo "==> build (context edge-app/core, Dockerfile test/Dockerfile.direktvermarkter)"
docker build -q -f test/Dockerfile.direktvermarkter -t "$IMAGE" core >/dev/null \
  || fail "Image-Build fehlgeschlagen"

echo "==> network + Seitenwagen"
docker network create "$NET" >/dev/null || fail "Netz liess sich nicht anlegen"
docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 \
  || docker pull -q "$PROBE_IMAGE" >/dev/null \
  || fail "Anfrage-Seitenwagen ${PROBE_IMAGE} liess sich nicht holen"
PROBE="$(docker run -d --network "$NET" "$PROBE_IMAGE" sleep 900)" || fail "Seitenwagen startete nicht"

# req/post/assert_json run Python INSIDE the sidecar - the request leaves the
# sidecar's own network stack and reaches the other containers by NAME
# ($SERVER, $POLLER), exactly like a real second box would.
post() { # url json-body
  docker exec -i -e VP_URL="$1" -e VP_BODY="$2" "$PROBE" python3 - <<'PY'
import os, sys, urllib.request
req = urllib.request.Request(
    os.environ["VP_URL"], data=os.environ["VP_BODY"].encode(),
    method="POST", headers={"Content-Type": "application/json"})
try:
    urllib.request.urlopen(req, timeout=5).read()
except Exception as e:
    print(e, file=sys.stderr)
    sys.exit(1)
PY
}

assert_json() { # url python-expr-on-d desc
  docker exec -i -e VP_URL="$1" -e VP_EXPR="$2" -e VP_DESC="$3" "$PROBE" python3 - <<'PY'
import os, sys, json, urllib.request
try:
    with urllib.request.urlopen(os.environ["VP_URL"], timeout=5) as resp:
        d = json.loads(resp.read().decode())
except Exception as e:
    print(f"{os.environ['VP_DESC']}: Anfrage fehlgeschlagen: {e}", file=sys.stderr)
    sys.exit(1)
if not eval(os.environ["VP_EXPR"]):
    print(f"{os.environ['VP_DESC']}: {json.dumps(d)}", file=sys.stderr)
    sys.exit(1)
print(f"OK {os.environ['VP_DESC']}: {json.dumps(d)}")
PY
}

wait_until() { # url python-expr-on-d desc tries delay_s
  local url="$1" expr="$2" desc="$3" tries="${4:-20}" delay="${5:-0.5}"
  local i=0
  while ! assert_json "$url" "$expr" "$desc" 2>/tmp/ps-d23-last-error; do
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then
      cat /tmp/ps-d23-last-error >&2
      fail "$desc: nicht erreicht nach $tries Versuchen"
    fi
    sleep "$delay"
  done
}

# modbus_check sends one raw MBAP request straight from the sidecar (plain
# socket, no library) and compares the raw response byte for byte - the same
# telegram-vector style as catalog/direktvermarkter/vectors/luox.json, but
# across real containers.
modbus_check() { # host port request-hex want-hex desc
  docker exec -i -e VP_HOST="$1" -e VP_PORT="$2" -e VP_REQ="$3" -e VP_WANT="$4" -e VP_DESC="$5" "$PROBE" python3 - <<'PY'
import os, socket, sys
host, port = os.environ["VP_HOST"], int(os.environ["VP_PORT"])
req = bytes.fromhex(os.environ["VP_REQ"])
want = bytes.fromhex(os.environ["VP_WANT"])
s = socket.create_connection((host, port), timeout=5)
s.sendall(req)
head = b""
while len(head) < 7:
    head += s.recv(7 - len(head))
length = int.from_bytes(head[4:6], "big")
body = b""
while len(body) < length - 1:
    body += s.recv(length - 1 - len(body))
got = head + body
s.close()
if got != want:
    print(f"{os.environ['VP_DESC']}: got {got.hex()}, want {want.hex()}", file=sys.stderr)
    sys.exit(1)
print(f"OK {os.environ['VP_DESC']}: {got.hex()}")
PY
}

SERVER_URL="http://${SERVER}:8080"
POLLER_URL="http://${POLLER}:8081"

echo "==> Server starten (Lebenszeichen-Frist auf 3s verkürzt für einen schnellen Lauf), noch ohne den Abfrager"
docker run -d --name "$SERVER" --network "$NET" "$IMAGE" \
  vp-direktvermarkter-server -modbus :1502 -http :8080 -watchdog-deadline 3s >/dev/null \
  || fail "Server startete nicht"
wait_until "$SERVER_URL/zustand" "True" "Server erreichbar" 20 0.5

echo "==> Review 25.11.2026 (PR #1999): Schreiben im Band wird IMMER angenommen, auch ohne je das Lebenszeichen geschrieben zu haben"
modbus_check "$SERVER" 1502 "000800000006010600020028" "000800000006010600020028" \
  "FC6 Vorgabe 40% ohne Lebenszeichen wird angenommen (kein 0x03)" \
  || fail "Schreiben ohne Lebenszeichen wurde fälschlich abgelehnt"
modbus_check "$SERVER" 1502 "000900000006010300020001" "0009000000050103020028" \
  "Register hält 40% trotz fehlendem Lebenszeichen" \
  || fail "Register spiegelt den Schreibzugriff nicht wider"
assert_json "$SERVER_URL/zustand" "d['vorgabe_pct']==100 and not d['vorgabe_aktiv']" \
  "wirksame Grenze bleibt bei 100%, solange kein frisches Lebenszeichen da ist (das Register hält trotzdem 40%)"

echo "==> gestellter luox starten"
docker run -d --name "$POLLER" --network "$NET" "$IMAGE" \
  vp-luox-sim -server "${SERVER}:1502" -interval 1s -http :8081 >/dev/null \
  || fail "Abfrager startete nicht"
wait_until "$POLLER_URL/status" "True" "Abfrager erreichbar" 20 0.5

echo "==> Messwerte einspielen (nie ein Gerätelesen - nur der Zwischenspeicher)"
post "$SERVER_URL/werte" '{"werte":{"nvp_einspeisung_w":2350,"erzeugung_w":3100,"netzbetreiber_vorgabe_pct":100,"referenz_w":10000}}' \
  || fail "Messwerte liessen sich nicht einspielen"

echo "==> PS-D23: Register bei bekannter Einspeisung lesen - Wert gleich der Messung"
wait_until "$POLLER_URL/status" "d['gelesen'].get('nvp_einspeisung_w') == 2350" "gelesener Wert = Messung" 20 0.5

echo "==> Vorgabe setzen (30%, innerhalb des Bands)"
post "$POLLER_URL/vorgabe" '{"pct":30}' || fail "Vorgabe liess sich nicht setzen"
wait_until "$SERVER_URL/zustand" "d['zustand']=='vorgabe_aktiv' and d['vorgabe_pct']==30 and d['vorgabe_aktiv']" \
  "Vorgabe 30% aktiv" 20 0.5

echo "==> Band-Verstoss (150%) - Ausnahme 0x03, Vorgabe bleibt bei 30%"
post "$POLLER_URL/vorgabe" '{"pct":150}' || fail "Vorgabe liess sich nicht setzen"
wait_until "$POLLER_URL/status" "d['vorgabe_antwort'].get('angenommen')==False and d['vorgabe_antwort'].get('ausnahme')==3" \
  "Band-Verstoss abgelehnt (0x03)" 20 0.5
assert_json "$SERVER_URL/zustand" "d['vorgabe_pct']==30" "Vorgabe nach Band-Verstoss unverändert (30%)"

echo "==> zurück in Band (30%) vor dem Lebenszeichen-Test"
post "$POLLER_URL/vorgabe" '{"pct":30}' || fail "Vorgabe liess sich nicht setzen"
wait_until "$SERVER_URL/zustand" "d['vorgabe_pct']==30 and d['vorgabe_aktiv']" "Vorgabe wieder 30% aktiv" 20 0.5

echo "==> Lebenszeichen-Ablauf: Abfrager hört auf, es zu schreiben"
post "$POLLER_URL/lebenszeichen" '{"aktiv":false}' || fail "Lebenszeichen liess sich nicht anhalten"
wait_until "$SERVER_URL/zustand" "d['zustand']=='abgelaufen' and d['vorgabe_pct']==100 and not d['vorgabe_aktiv']" \
  "Lebenszeichen abgelaufen, Vorgabe zurück auf Ruhewert 100%" 20 1
echo "    -> der Abfrager schreibt weiter 30% in das Register (das Schreiben selbst wird nicht gesperrt),"
echo "       aber die WIRKSAME Grenze bleibt bei 100%, solange kein frisches Lebenszeichen da ist:"
wait_until "$POLLER_URL/status" "d['vorgabe_antwort'].get('angenommen')==True" \
  "weitere Schreibversuche werden angenommen (kein 0x03 nur wegen des fehlenden Lebenszeichens)" 20 0.5
assert_json "$SERVER_URL/zustand" "d['vorgabe_pct']==100 and not d['vorgabe_aktiv']" \
  "wirksame Grenze bleibt trotz angenommener Schreibzugriffe bei 100%"

echo "==> Lebenszeichen wieder aktiv - Vorgabe erneut wirksam"
post "$POLLER_URL/lebenszeichen" '{"aktiv":true}' || fail "Lebenszeichen liess sich nicht fortsetzen"
wait_until "$SERVER_URL/zustand" "d['zustand']=='vorgabe_aktiv' and d['vorgabe_pct']==30" \
  "Vorgabe nach erneuertem Lebenszeichen wieder aktiv" 20 1

echo "==> Neustart: Register beginnen wieder beim Ruhewert"
docker stop "$POLLER" >/dev/null || fail "Abfrager liess sich nicht anhalten"
docker restart "$SERVER" >/dev/null || fail "Server-Neustart fehlgeschlagen"
wait_until "$SERVER_URL/zustand" "d['zustand']=='wartet_auf_abfrage' and d['vorgabe_pct']==100 and not d['vorgabe_aktiv']" \
  "nach Neustart: Ruhewert 100%, keine frühere Vorgabe fortgesetzt" 30 0.5
docker start "$POLLER" >/dev/null || fail "Abfrager liess sich nicht fortsetzen"

echo
echo "PS-D23 bestanden: Vorgabe, Band-Verstoss, Lebenszeichen-Ablauf und Neustart - alles im Container, über echtes Modbus TCP."

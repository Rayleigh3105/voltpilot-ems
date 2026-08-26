#!/usr/bin/env bash
# Isolated end-to-end bring-up test of the VoltPilot Edge-App compose:
#
#   SunSpec sim (Modbus) -> Node-RED "SunSpec (Simulator)" flow (vp-palette)
#     -> core local bus -> core cloud link -> stand-in cloud broker
#   retained schedule (cloud) -> core guards -> local bus -> Node-RED
#     -> Modbus write observed in the sim log
#
# Runs under its OWN compose project name with high host ports - it never
# touches a live voltpilot-* stack. Requires Docker.
#
# ⚠ ZWEI REGELN, OHNE DIE DIESES RIG AUF EINEM CONTAINERISIERTEN RUNNER NICHT
# LAEUFT (Forgejo-Lauf 281, 26.08.2026 - der Job faehrt SELBST in einem
# Container und spricht den Docker-Daemon des HOSTS an):
#
#   1. KEIN Bind-Mount aus dem Arbeitsverzeichnis. Der Daemon loest ihn gegen
#      SEIN Dateisystem auf, und dort gibt es den Workspace-Pfad des Jobs
#      nicht. Linux-Docker legt die fehlende Quelle als leeres VERZEICHNIS an
#      und scheitert dann daran, ein Verzeichnis auf eine DATEI zu mounten.
#      Begruendung + der Weg (Build-Kontext statt Bind): Dockerfile.broker.
#   2. KEINE Anfrage an einen VEROEFFENTLICHTEN Port ueber 127.0.0.1. `ports:`
#      veroeffentlicht auf dem DOCKER-HOST; das eigene 127.0.0.1 des Jobs ist
#      nicht dessen Loopback. Jede Anfrage laeuft deshalb in einem Seitenwagen
#      INNERHALB des Compose-Netzes und erreicht die Dienste bei ihrem Namen
#      (core:8484, core:1502) - derselbe Weg auf dem Laptop wie auf dem Runner.
#      Dieselbe Lehre und dieselbe Loesung wie in
#      frontend/portal/test/smoke-lib.sh (CI-Lauf #183): ein Rueckfall, den nur
#      die kaputte Umgebung faehrt, ist ein Pfad, den niemand testet.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="vpedge-e2e-$$"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f test/docker-compose.e2e.yml --profile sim)
# Die veroeffentlichten Ports bleiben Teil des GERAETE-Composes und werden hier
# nur hoch und unwahrscheinlich gelegt, damit das Rig nie mit einem laufenden
# Stack kollidiert. Das Rig BENUTZT sie nicht mehr (Regel 2 oben).
# ⚠ ALLE FUENF VEROEFFENTLICHTEN Ports des Geraete-Composes werden gesetzt
# (VP_MQTT_PORT ist keiner - das ist der Ziel-Port der Cloud). Eine
# ausgelassene faellt auf ihre Vorgabe zurueck und das Rig BESETZT damit
# den echten Port auf dem Host (8887 OCPP, 502 Modbus) - das kollidiert
# mit einem laufenden Stack, mit einem zweiten Rig und auf einem geteilten
# Runner mit irgendwem sonst. Wer dem Compose einen Port hinzufuegt, setzt
# ihn hier mit.
export VP_WEB_PORT=18484 VP_NODERED_PORT=11881 VP_BUS_PORT=11884 VP_MIRROR_PORT=11502 VP_OCPP_PORT=18887
# settings.js fails closed without a non-default editor password (S2).
export VP_NODERED_PASSWORD=vp-e2e-editor-pass

T_BASE="ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003"
NET="${PROJECT}_default"

# Der Seitenwagen traegt NUR eine Laufzeit fuer Anfragen (HTTP + roher TCP), und
# er ist gepinnt, damit ein rotes Rig nie ein Upstream-Image ist, das sich unter
# uns geaendert hat. Ein Runner mit eigenem Spiegel ueberstimmt ihn per Env.
PROBE_IMAGE="${VP_E2E_PROBE_IMAGE:-python:3.12-alpine}"
PROBE=""
# Innerhalb des Compose-Netzes erreichbar - was jede Zusicherung benutzt.
CORE_HTTP="http://core:8484"
MIRROR_HOST="core"
MIRROR_PORT=1502

cleanup() {
  echo "--- cleanup"
  # Der Seitenwagen ZUERST: er haengt am Compose-Netz, und ein noch
  # angeschlossener Container laesst `down` das Netz nicht entfernen.
  [ -n "$PROBE" ] && docker rm -f "$PROBE" >/dev/null 2>&1
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

fail() { echo "E2E FAILED: $*" >&2; exit 1; }

# Der Selbstbericht. Er existiert, damit der NAECHSTE rote Lauf sich selbst
# erklaert, statt einen Menschen zum Nachstellen zu brauchen - Lauf 281 gab
# ausser der Mount-Zeile keine verwertbare Spur.
in_container() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods|libpod)' /proc/1/cgroup 2>/dev/null && return 0
  return 1
}
echo "==> environment"
echo "    job runs in: $(in_container && echo container || echo host)"
echo "    docker:      $(docker version --format '{{.Client.Version}} (server {{.Server.Version}})' 2>/dev/null || echo unavailable)"
echo "    compose:     $(docker compose version --short 2>/dev/null || echo unavailable)"
echo "    probe image: ${PROBE_IMAGE}"

probe_start() {
  docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 \
    || docker pull -q "$PROBE_IMAGE" >/dev/null \
    || fail "konnte den Anfrage-Seitenwagen ${PROBE_IMAGE} nicht holen"
  PROBE="$(docker run -d --network "$NET" "$PROBE_IMAGE" sleep 3600)" \
    || fail "Anfrage-Seitenwagen liess sich nicht starten"
}

# `req <pfad> [json-rumpf]` - dieselbe Semantik wie das frueher hier stehende
# `curl -fsS`: der Rumpf geht nach stdout, ein HTTP- oder Transportfehler ist
# ein Exit != 0. Nur der WEG ist ein anderer (im Netz statt ueber den Host).
req() {
  docker exec -i -e VP_URL="${CORE_HTTP}$1" -e VP_BODY="${2-}" "$PROBE" python3 - <<'PY'
import os, sys, urllib.request, urllib.error
body = os.environ.get("VP_BODY") or ""
r = urllib.request.Request(
    os.environ["VP_URL"],
    data=body.encode() if body else None,
    headers={"Content-Type": "application/json"} if body else {},
)
try:
    with urllib.request.urlopen(r, timeout=10) as resp:
        sys.stdout.write(resp.read().decode())
except urllib.error.HTTPError:
    sys.exit(22)   # wie curl -f
except OSError:
    sys.exit(7)    # wie curl "couldn't connect"
PY
}

# Python IM Seitenwagen. Der Zustandsrumpf reist als Umgebungsvariable, das
# Skript ueber stdin - so bleibt jede Zusicherung woertlich die von vorher.
probe_py() { # [STATE-json]
  docker exec -i -e STATE="${1-}" -e MIRROR_HOST="$MIRROR_HOST" -e MIRROR_PORT="$MIRROR_PORT" \
    "$PROBE" python3 -
}

# Der Waechter gegen die ganze KLASSE, nicht gegen den einen Fall: er faellt,
# sobald irgendein Dienst dieses Rigs wieder einen Bind-Mount traegt - egal ob
# aus dem Geraete-Compose oder aus dem Overlay. Er laeuft VOR `up`, damit der
# Fehlschlag die REGEL nennt statt einer Mount-Meldung aus dem Daemon, die erst
# jemand einordnen muss (genau die zwei Runden, die Lauf 281 gekostet hat).
echo "--- Waechter: kein Bind-Mount im aufgeloesten Compose (Regel 1)"
# ⚠ Das aufgeloeste Compose geht ueber eine DATEI, nicht durch eine Pipe:
# `cmd | python3 - <<PY` kann nicht funktionieren - das Here-Dokument ersetzt
# die Pipe als stdin, python bekommt das Skript und die Daten nie.
CFG_JSON="$(mktemp)"
"${COMPOSE[@]}" config --format json > "$CFG_JSON" \
  || fail "docker compose config schlug fehl - die Compose-Dateien sind kaputt"
python3 - "$CFG_JSON" <<'PY' || fail "Bind-Mount im Rig - siehe test/Dockerfile.broker fuer den Weg (Build-Kontext statt Bind)"
import json, sys
cfg = json.load(open(sys.argv[1]))
bad = [(n, v.get("source"), v.get("target"))
       for n, svc in sorted(cfg.get("services", {}).items())
       for v in (svc.get("volumes") or [])
       if v.get("type") == "bind"]
for n, src, dst in bad:
    print(f"  {n}: BIND {src} -> {dst}", file=sys.stderr)
if bad:
    print("Ein Bind-Mount wird vom DAEMON aufgeloest. Faehrt der Job selbst in\n"
          "einem Container (Forgejo-Runner), gibt es den Workspace-Pfad dort\n"
          "nicht - Linux-Docker legt ihn als leeres Verzeichnis an und der\n"
          "Dienst startet falsch oder gar nicht.", file=sys.stderr)
sys.exit(1 if bad else 0)
PY
rm -f "$CFG_JSON"

echo "--- build + up (project $PROJECT)"
"${COMPOSE[@]}" up -d --build

echo "--- Anfrage-Seitenwagen im Compose-Netz starten"
probe_start

echo "--- wait for core health"
for i in $(seq 1 30); do
  if req /health >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && fail "core /health never came up"
  sleep 2
done

echo "--- wait for contract telemetry at the cloud broker (sim -> nodered -> core -> cloud)"
MSG=$(docker run --rm --network "$NET" eclipse-mosquitto:2 \
  mosquitto_sub -h cloud-broker -p 1883 -t "$T_BASE/telemetry" -C 1 -W 120) \
  || fail "no telemetry arrived at the cloud broker within 120s"
echo "$MSG"
echo "$MSG" | grep -q '"schema_version":"1.0"' || fail "telemetry not contract-shaped (schema_version)"
echo "$MSG" | grep -q '"pv_power_kw"' || fail "telemetry missing measurements"
echo "$MSG" | grep -q '"device_id":"00000000-0000-0000-0000-000000000003"' || fail "telemetry identity wrong"

echo "--- core state shows cloud connected + fresh telemetry"
STATE=$(req /api/state)
echo "$STATE" | grep -q '"cloud_connected":true' || fail "core not cloud-connected: $STATE"
echo "$STATE" | grep -q '"pairing_state":"verbunden"' || fail "pairing state not verbunden: $STATE"

echo "--- publish a retained schedule; expect the sim to log the setpoint write"
# Anchor the slot to the current 15-min boundary (UTC).
START=$(python3 - <<'EOF'
from datetime import datetime, timezone
now = datetime.now(timezone.utc)
slot = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
print(slot.strftime('%Y-%m-%dT%H:%M:%SZ'))
EOF
)
docker run --rm --network "$NET" eclipse-mosquitto:2 \
  mosquitto_pub -h cloud-broker -p 1883 -t "$T_BASE/schedule" -q 1 -r -m "{
    \"schema_version\":\"1.0\",
    \"tenant_id\":\"00000000-0000-0000-0000-000000000001\",
    \"site_id\":\"00000000-0000-0000-0000-000000000002\",
    \"device_id\":\"00000000-0000-0000-0000-000000000003\",
    \"plan_id\":\"e2e00000-0000-0000-0000-000000000001\",
    \"generated_at\":\"$START\",
    \"horizon_slots\":2,\"slot_minutes\":15,
    \"grid_import_limit_kw\":60.0,\"peak_reserve_soc_pct\":25,
    \"slots\":[
      {\"start\":\"$START\",\"battery_setpoint_kw\":-25.0},
      {\"start\":\"$(python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.strptime('$START','%Y-%m-%dT%H:%M:%SZ')+timedelta(minutes=15)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\",\"battery_setpoint_kw\":-25.0}
    ]}"

for i in $(seq 1 30); do
  if "${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = -25.00 kW'; then
    echo "sim received the schedule setpoint write (-25.00 kW)"
    break
  fi
  [ "$i" = 30 ] && { "${COMPOSE[@]}" logs edge-sim | tail -20; fail "sim never logged the -25 kW setpoint write"; }
  sleep 2
done

echo "--- core state shows Fahrplan mode + the PS-3 peak module"
STATE=$(req /api/state)
echo "$STATE" | grep -q '"mode":"fahrplan"' || fail "core not in fahrplan mode: $STATE"
# The plan-carried peak target/reserve surface on /api/state (Betrieb card);
# the sim's import mean sits far below 60 kW, so the -25 setpoint is unshaved.
echo "$STATE" | grep -q '"peak_target_kw":60' || fail "peak target not exposed: $STATE"
echo "$STATE" | grep -q '"peak_reserve_soc_pct":25' || fail "peak reserve not exposed: $STATE"
echo "$STATE" | grep -q '"inverter_link":"up"' || fail "inverter link not reported up: $STATE"

echo "--- control write -> readback -> match (sim control adapter writes reg 40/41/42, reads them back)"
# The setpoint loop writes -25 kW (reg 40) + enable (reg 41) + the pv-limit
# sentinel (reg 42), reads all three back via FC3 and publishes the per-register
# verdict on edge/control/readback; the core folds it into state.control.
CTRL_OK=""
for i in $(seq 1 30); do
  STATE=$(req /api/state)
  if probe_py "$STATE" <<'PY'
import json, os, sys
s = json.loads(os.environ["STATE"])
c = s.get("control")
if not c or not c.get("all_match"): sys.exit(1)
regs = {r["role"]: r for r in c.get("registers", [])}
bp = regs.get("battery_power")
ok = bp and abs((bp.get("actual_kw") or 0) - (-25.0)) < 0.01 and c.get("control_enabled") and c.get("certified")
sys.exit(0 if ok else 1)
PY
  then CTRL_OK=1; break; fi
  sleep 2
done
[ -n "$CTRL_OK" ] || { echo "$STATE"; fail "control readback never confirmed reg 40 = -25 kW (all_match)"; }
echo "control readback confirmed: -25 kW written to reg 40, read back and matched"

echo "--- Modbus-Datenspiegel: off by default, VP map (unit 100) after enabling, writes refused"
# Disabled (the shipped default): nothing may answer on the mapped port. Vom
# Compose-Netz aus gibt es keinen Userland-Proxy mehr, der den Connect
# annehmen wuerde - abgewiesen, sofort geschlossen oder still sind alle
# richtig; Antwortbytes sind der Fehlschlag.
probe_py <<'PY' || fail "mirror answered a request while DISABLED"
import os, socket, struct, sys
s = socket.socket()
s.settimeout(3)
try:
    s.connect((os.environ["MIRROR_HOST"], int(os.environ["MIRROR_PORT"])))
    s.sendall(struct.pack(">HHHBBHH", 9, 0, 6, 100, 3, 0, 1))
    data = s.recv(16)
except OSError:
    sys.exit(0)  # refused / closed / silent - correct
sys.exit(1 if data else 0)
PY

req /api/mirror '{"enabled":true}' | grep -q '"enabled":true' \
  || fail "POST /api/mirror did not enable the mirror"

# Read the VoltPilot standard map over the mapped port and compare it with the
# telemetry the core itself reports; then prove a write (FC6) is refused.
MIRROR_OK=""
for i in $(seq 1 15); do
  STATE=$(req /api/state)
  if probe_py "$STATE" <<'PY'
import json, os, socket, struct, sys
state = json.loads(os.environ["STATE"])
s = socket.socket(); s.settimeout(5)
s.connect((os.environ["MIRROR_HOST"], int(os.environ["MIRROR_PORT"])))
def rx(n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise EOFError
        b += c
    return b
# FC3 unit 100, regs 0..14 (the frozen VP map v1)
s.sendall(struct.pack(">HHHBBHH", 1, 0, 6, 100, 3, 0, 15))
h = rx(9)
if h[7] != 3: sys.exit(1)  # exception (e.g. no data yet) - retry
regs = struct.unpack(">15H", rx(30))
if regs[0] != 0x5650 or regs[1] != 1: sys.exit(1)
if regs[3] != 0: sys.exit(1)  # quality not ok yet
soc = regs[12] / 10.0
if abs(soc - state["soc_pct"]) >= 2.0: sys.exit(1)
pv = struct.unpack(">i", struct.pack(">HH", regs[4], regs[5]))[0] / 1000.0
if abs(pv - state["pv_kw"]) >= 5.0: sys.exit(1)
# FC6 write attempt -> exception 0x01 ILLEGAL FUNCTION (read-only mirror)
s.sendall(struct.pack(">HHHBBHH", 2, 0, 6, 100, 6, 0, 0xDEAD))
h = rx(9)
sys.exit(0 if (h[7] == 0x86 and h[8] == 0x01) else 1)
PY
  then MIRROR_OK=1; break; fi
  sleep 2
done
[ -n "$MIRROR_OK" ] || fail "mirror never served the VP map matching /api/state (or refused-write check failed)"
echo "mirror serves unit 100 from the gated telemetry; FC6 write refused with ILLEGAL FUNCTION"

echo
echo "E2E OK: full loop verified (sim -> nodered/vp-palette -> core -> cloud broker; schedule -> guards -> sim; control write -> readback -> match; read-only Modbus mirror)."

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
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="vpedge-e2e-$$"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f test/docker-compose.e2e.yml --profile sim)
export VP_WEB_PORT=18484 VP_NODERED_PORT=11881 VP_BUS_PORT=11884 VP_MIRROR_PORT=11502
# settings.js fails closed without a non-default editor password (S2).
export VP_NODERED_PASSWORD=vp-e2e-editor-pass

T_BASE="ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003"
NET="${PROJECT}_default"

cleanup() {
  echo "--- cleanup"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "E2E FAILED: $*" >&2; exit 1; }

echo "--- build + up (project $PROJECT)"
"${COMPOSE[@]}" up -d --build

echo "--- wait for core health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/health" >/dev/null 2>&1; then break; fi
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
STATE=$(curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/api/state")
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
STATE=$(curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/api/state")
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
  STATE=$(curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/api/state")
  if printf '%s' "$STATE" | python3 -c '
import json, sys
s = json.load(sys.stdin)
c = s.get("control")
if not c or not c.get("all_match"): sys.exit(1)
regs = {r["role"]: r for r in c.get("registers", [])}
bp = regs.get("battery_power")
ok = bp and abs((bp.get("actual_kw") or 0) - (-25.0)) < 0.01 and c.get("control_enabled") and c.get("certified")
sys.exit(0 if ok else 1)
'; then CTRL_OK=1; break; fi
  sleep 2
done
[ -n "$CTRL_OK" ] || { echo "$STATE"; fail "control readback never confirmed reg 40 = -25 kW (all_match)"; }
echo "control readback confirmed: -25 kW written to reg 40, read back and matched"

echo "--- Modbus-Datenspiegel: off by default, VP map (unit 100) after enabling, writes refused"
# Disabled (the shipped default): nothing may answer on the mapped port.
# Docker's userland proxy accepts the TCP connect even with no listener in the
# container, so the honest check is "a request gets NO Modbus answer" (refused
# connect, immediate close or silence all pass; any response bytes fail).
python3 - <<'EOF' || fail "mirror answered a request while DISABLED"
import socket, struct, sys
s = socket.socket()
s.settimeout(3)
try:
    s.connect(("127.0.0.1", 11502))
    s.sendall(struct.pack(">HHHBBHH", 9, 0, 6, 100, 3, 0, 1))
    data = s.recv(16)
except OSError:
    sys.exit(0)  # refused / closed / silent - correct
sys.exit(1 if data else 0)
EOF

curl -fsS -X POST -H 'Content-Type: application/json' -d '{"enabled":true}' \
  "http://127.0.0.1:${VP_WEB_PORT}/api/mirror" | grep -q '"enabled":true' \
  || fail "POST /api/mirror did not enable the mirror"

# Read the VoltPilot standard map over the mapped port and compare it with the
# telemetry the core itself reports; then prove a write (FC6) is refused.
MIRROR_OK=""
for i in $(seq 1 15); do
  STATE=$(curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/api/state")
  if printf '%s' "$STATE" | python3 -c '
import json, socket, struct, sys
state = json.load(sys.stdin)
s = socket.socket(); s.settimeout(5)
s.connect(("127.0.0.1", 11502))
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
'; then MIRROR_OK=1; break; fi
  sleep 2
done
[ -n "$MIRROR_OK" ] || fail "mirror never served the VP map matching /api/state (or refused-write check failed)"
echo "mirror serves unit 100 from the gated telemetry; FC6 write refused with ILLEGAL FUNCTION"

echo
echo "E2E OK: full loop verified (sim -> nodered/vp-palette -> core -> cloud broker; schedule -> guards -> sim; control write -> readback -> match; read-only Modbus mirror)."

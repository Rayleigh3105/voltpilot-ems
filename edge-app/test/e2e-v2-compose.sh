#!/usr/bin/env bash
# September-Gate rig (Meilenstein M2; spec docs/contracts/v2/edge-simulator-v2.md):
# the isolated compose proof of the FULL v2 chain against the certified
# sunspec simulator family -
#
#   retained entity-registry push  ->  per-entity configs + guards (E1a)
#   compiled flow artifact (flowc) ->  retained deployment on …/v2/flows
#     ->  core verifies (hash/gates/capabilities) + materializes the @vp-flow
#         tab via the Node-RED Admin API  ->  heartbeat `flows` ack
#   NR executes the compiled flow  ->  vp-desired publishes a DESIRED
#     ->  core arbitration + per-entity guard chain  ->  retained command +
#         v1 setpoint  ->  certified sunspec write (reg 40)  ->  readback
#   direct desired probes          ->  P2 clamp (guard stage), P3 conflict
#   retained v2 plan (…/v2/plan)   ->  market preempts the flow (P5),
#         override elevates above market and the plan resumes (P4),
#         an AGED redelivery is stale -> failsafe + producer release (P5)
#   the v1 telemetry path runs untouched alongside (P7).
#
# Own compose project + high host ports (never touches a live stack).
# Requires Docker + node (flowc compiles the rig flow at test time).
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="vpedge-e2e-v2-$$"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f test/docker-compose.e2e.yml -f test/docker-compose.e2e-v2.yml --profile sim)
export VP_WEB_PORT=28484 VP_NODERED_PORT=21881 VP_BUS_PORT=21884
export VP_NODERED_PASSWORD=vp-e2e-v2-editor-pass

TENANT="00000000-0000-0000-0000-000000000001"
SITE="00000000-0000-0000-0000-000000000002"
DEVICE="00000000-0000-0000-0000-000000000003"
T_BASE="ems/$TENANT/$SITE/$DEVICE"
NET="${PROJECT}_default"
BATT="batt-main"
PV="pv-sim"
WORK="$(mktemp -d)"

cleanup() {
  echo "--- cleanup"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "E2E-V2 FAILED: $*" >&2; exit 1; }
pass() { echo "  PASS  $*"; }

# mqtt helpers against the STAND-IN CLOUD broker and the CORE'S LOCAL BUS.
# -i on the pub helpers: payloads arrive via stdin (-s / -f /dev/stdin).
cloud_pub() { docker run --rm -i --network "$NET" eclipse-mosquitto:2 mosquitto_pub -h cloud-broker -p 1883 "$@"; }
cloud_sub() { docker run --rm --network "$NET" eclipse-mosquitto:2 mosquitto_sub -h cloud-broker -p 1883 "$@"; }
bus_pub()   { docker run --rm -i --network "$NET" eclipse-mosquitto:2 mosquitto_pub -h core -p 1883 "$@"; }
bus_sub()   { docker run --rm --network "$NET" eclipse-mosquitto:2 mosquitto_sub -h core -p 1883 "$@"; }

command -v node >/dev/null 2>&1 || fail "node is required (flowc compiles the rig flow)"

# --- Rig fixtures -------------------------------------------------------------

# Entity registry push: the battery entity IS the certified sunspec simulator
# (registry band 30 kW - TIGHTER than the device config's 50, so a clamp at 30
# proves the REGISTRY guard chain bit), plus a producer for the plan/release
# proof. charge_from_grid_allowed stays ABSENT (D-8) - every rig setpoint is a
# DISCHARGE, which solar-only never touches (deterministic day and night).
registry_push() {
  cat <<JSON
{"schema_version":"1.0","tenant_id":"$TENANT","site_id":"$SITE","device_id":"$DEVICE",
 "revision":"rig-1","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[
  {"entity_id":"$BATT","entity_type":"battery-hybrid",
   "capabilities":{"measure":[{"channel":"soc_pct","unit":"%"}],
     "actuate":[{"command":"setpoint_kw","min":-30,"max":30},{"command":"limit_kw"}]},
   "guards":{"limits":{"max_charge_kw":30,"max_discharge_kw":30,"soc_min_pct":5,"soc_max_pct":95},
     "failsafe":{"behavior":"self-consumption"}}},
  {"entity_id":"$PV","entity_type":"producer",
   "capabilities":{"measure":[{"channel":"pv_power_kw","unit":"kW"}],
     "actuate":[{"command":"limit_kw","max":27}]},
   "guards":{"limits":{"max_generation_kw":27},"failsafe":{"behavior":"release"}}}
 ]}
JSON
}

# desired probe payloads (the vp-sim-assert role, spec §3.3).
desired_payload() { # node_id kw ttl override
  cat <<JSON
{"schema_version":"1.0","entity_id":"$BATT","request_id":"$1-$(date +%s)",
 "source":{"kind":"flow","flow_id":"9e1c2b3a-5d6e-4f70-8123-456789abcde9","flow_version":1,"node_id":"$1"},
 "priority":"flow","override":$4,
 "command":{"type":"setpoint_kw","value":$2},
 "ttl_s":$3,"issued_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
}

# v2 plan whose single slot covers now (battery discharge + producer cap).
plan_v2() { # generated_at battKw pvLimit
  local slot
  slot=$(python3 -c "from datetime import datetime,timezone; n=datetime.now(timezone.utc); print(n.replace(minute=(n.minute//15)*15,second=0,microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  cat <<JSON
{"schema_version":"2.0","tenant_id":"$TENANT","site_id":"$SITE","device_id":"$DEVICE",
 "plan_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","generated_at":"$1",
 "horizon_slots":1,"slot_minutes":15,
 "entities":[
  {"entity_id":"$BATT","kind":"storage",
   "slots":[{"start":"$slot","commands":{"setpoint_kw":$2}}]},
  {"entity_id":"$PV","kind":"pv-generation",
   "slots":[{"start":"$slot","commands":{"limit_kw":$3}}]}
 ]}
JSON
}

# Compile the rig flow with flowc: Zeitplan (always active) -> Wenn/Dann
# (then_value -7) -> Entität steuern (setpoint_kw, ttl 120), interval 20 s.
# Wrapped into a retained deployment set for this device.
node - "$WORK" <<'NODE'
const fs = require('fs');
const path = require('path');
const { compile } = require(path.join(process.cwd(), 'nodered', 'flowc', 'compile'));
const work = process.argv[2];
const graph = {
  schema_version: '1.0',
  flow_id: 'aa1c2b3a-5d6e-4f70-8123-456789abcdaa',
  flow_version: 1,
  name: 'Rig: Dauerentladung 7 kW',
  runtime: 'edge',
  site_id: '00000000-0000-0000-0000-000000000002',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  nodes: [
    { id: 'w1', type: 'vp.schedule.window', type_version: '1.0.0',
      parameters: { from: '00:00', to: '23:59' } },
    { id: 'i1', type: 'vp.logic.if', type_version: '1.0.0',
      parameters: { then_value: -7 } },
    { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0',
      parameters: { entity_id: 'batt-main', command: 'setpoint_kw', ttl_s: 120 },
      claims: [{ entity_id: 'batt-main', commands: ['setpoint_kw'] }] },
  ],
  edges: [
    { id: 'e1', from: { node: 'w1', port: 'active' }, to: { node: 'i1', port: 'condition' } },
    { id: 'e2', from: { node: 'i1', port: 'value' }, to: { node: 'c1', port: 'value' } },
  ],
  triggers: [{ id: 't1', kind: 'interval', every_s: 20 }],
};
const artifact = compile(graph, { compiledAt: new Date().toISOString() });
const deployment = {
  schema_version: '1.0', kind: 'deployment',
  tenant_id: graph.tenant_id, site_id: graph.site_id,
  device_id: '00000000-0000-0000-0000-000000000003',
  deployed_at: new Date().toISOString(),
  artifacts: [artifact],
};
fs.writeFileSync(path.join(work, 'deployment.json'), JSON.stringify(deployment));
fs.writeFileSync(path.join(work, 'artifact-hash.txt'), artifact.content_hash + '\n');
console.log('rig flow compiled:', artifact.content_hash);
NODE
HASH="$(cat "$WORK/artifact-hash.txt")"

# --- Bring the stack up -------------------------------------------------------
# Plain `docker build` per image (NOT `compose build`): the rig must also run
# on hosts whose buildx is too old for compose-delegated builds; the v2
# overlay pins pull_policy:never so `up -d` uses exactly these local images.
echo "--- build images (plain docker build)"
docker build -t git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest core >/dev/null
docker build -t git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:latest nodered >/dev/null
docker build -t git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-sim:latest ../edge/sim >/dev/null

echo "--- up (project $PROJECT)"
"${COMPOSE[@]}" up -d

echo "--- wait for core health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${VP_WEB_PORT}/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && fail "core /health never came up"
  sleep 2
done

echo "--- P7: the untouched v1 telemetry path (sim -> nodered -> core -> cloud)"
MSG=$(cloud_sub -t "$T_BASE/telemetry" -C 1 -W 120) || fail "no v1 telemetry at the cloud broker"
echo "$MSG" | grep -q '"schema_version":"1.0"' || fail "v1 telemetry not contract-shaped"
pass "v1 telemetry flows unchanged"

echo "--- push the retained entity registry (…/v2/entities)"
registry_push | cloud_pub -t "$T_BASE/v2/entities" -q 1 -r -s
CFG=$(bus_sub -t "edge/entities/$BATT/config" -C 1 -W 60) || fail "battery entity config never appeared on the local bus"
echo "$CFG" | grep -q '"self-consumption"' || fail "entity config payload wrong: $CFG"
pass "registry push -> retained per-entity config on the local bus"

echo "--- heartbeat acks the registry revision"
for i in $(seq 1 10); do
  HB=$(cloud_sub -t "$T_BASE/status" -C 1 -W 30) || true
  echo "$HB" | grep -q '"revision":"rig-1"' && break
  [ "$i" = 10 ] && fail "heartbeat never acked registry revision rig-1: $HB"
done
pass "heartbeat entities ack (revision rig-1)"

echo "--- P2: a beyond-band desired is CLAMPED (registry band 30) and the sim receives the CLAMPED write"
# The event collector runs for a FIXED window and is never killed: the file is
# only read after its -W expiry, so stdio buffering can swallow nothing.
EV_FILE="$WORK/events.txt"
( bus_sub -t "edge/entities/$BATT/arbitration" -W 55 > "$EV_FILE" 2>/dev/null || true ) &
EV_PID=$!
sleep 2
desired_payload probe-clamp -80 25 false | bus_pub -t "edge/entities/$BATT/desired" -q 1 -s
for i in $(seq 1 20); do
  if "${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = -30.00 kW'; then break; fi
  [ "$i" = 20 ] && { "${COMPOSE[@]}" logs edge-sim | tail -10; fail "sim never received the CLAMPED -30 kW write"; }
  sleep 2
done
pass "sim wrote the CLAMPED -30 kW - never the raw -80 wish"

echo "--- P3: a same-class challenger is rejected (conflict), the device never oscillates"
desired_payload probe-conflict 5 20 false | bus_pub -t "edge/entities/$BATT/desired" -q 1 -s
sleep 5
"${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = 5.00 kW' \
  && fail "the rejected challenger reached the device (oscillation!)"
echo "    (waiting out the event-collector window + probe TTLs)"
wait "$EV_PID" 2>/dev/null || true
grep -q '"outcome":"clamped"' "$EV_FILE" || { cat "$EV_FILE"; fail "no clamped arbitration event"; }
grep -q 'guard:rated_band' "$EV_FILE" || fail "clamp reasons must name guard:rated_band"
grep -q 'arbitration:conflict' "$EV_FILE" || { cat "$EV_FILE"; fail "no conflict rejection event"; }
pass "clamped event (guard:rated_band) + conflict rejection observed on …/arbitration"

echo "--- P1+P6: deploy the flowc-compiled artifact via the retained deployment set"
docker run --rm --network "$NET" -v "$WORK":/w eclipse-mosquitto:2 \
  mosquitto_pub -h cloud-broker -p 1883 -t "$T_BASE/v2/flows" -q 1 -r -f /w/deployment.json
for i in $(seq 1 12); do
  HB=$(cloud_sub -t "$T_BASE/status" -C 1 -W 30) || true
  echo "$HB" | grep -q '"state":"active"' && echo "$HB" | grep -q "$HASH" && break
  [ "$i" = 12 ] && { echo "$HB"; fail "heartbeat never acked the artifact active with hash $HASH"; }
done
pass "deployment applied + acked active in the heartbeat flows block (hash-exact)"

echo "--- NR executes the flow: compiler-stamped desired -> arbitration -> guards -> sunspec write"
DES=$(bus_sub -t "edge/entities/$BATT/desired" -C 1 -W 90) || fail "the deployed flow never emitted a desired"
echo "$DES" | grep -q '"flow_id":"aa1c2b3a-5d6e-4f70-8123-456789abcdaa"' || fail "desired not compiler-stamped: $DES"
echo "$DES" | grep -q '"node_id":"c1"' || fail "desired missing the action node id: $DES"
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = -7.00 kW'; then break; fi
  [ "$i" = 30 ] && { "${COMPOSE[@]}" logs edge-sim | tail -10; fail "sim never received the flow's -7 kW"; }
  sleep 2
done
CMD=$(bus_sub -t "edge/entities/$BATT/command" -C 1 -W 30) || fail "no retained entity command"
echo "$CMD" | grep -q '"source":"desired"' || fail "entity command source wrong: $CMD"
pass "flow artifact -> NR -> desired -> arbitration -> command -> certified sunspec write (-7 kW)"

echo "--- readback proves the register (write -> FC3 read-back -> match)"
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
sys.exit(0 if bp and abs((bp.get("actual_kw") or 0) - (-7.0)) < 0.01 else 1)
'; then CTRL_OK=1; break; fi
  sleep 2
done
[ -n "$CTRL_OK" ] || { echo "$STATE"; fail "readback never confirmed reg 40 = -7 kW (all_match)"; }
pass "register-level readback: commanded -7 kW == actual (all_match)"

echo "--- P5: a fresh v2 plan preempts the flow (market > flow) and caps the producer"
plan_v2 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" -12 20 | cloud_pub -t "$T_BASE/v2/plan" -q 1 -r -s
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = -12.00 kW'; then break; fi
  [ "$i" = 30 ] && fail "the v2 plan's -12 kW never reached the sim (market must preempt flow)"
  sleep 2
done
PVCMD=$(bus_sub -t "edge/entities/$PV/command" -C 1 -W 30) || fail "no retained producer command"
echo "$PVCMD" | grep -q '"limit_kw":20' || fail "producer cap wrong: $PVCMD"
echo "$PVCMD" | grep -q '"source":"plan"' || fail "producer command source wrong: $PVCMD"
pass "v2 plan drives BOTH entities (battery -12 kW via sunspec write, producer capped 20 kW)"

echo "--- P4: an override desired elevates above market; the plan resumes on TTL expiry"
desired_payload probe-boost -9 30 true | bus_pub -t "edge/entities/$BATT/desired" -q 1 -s
for i in $(seq 1 20); do
  if "${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -q 'setpoint write: battery = -9.00 kW'; then break; fi
  [ "$i" = 20 ] && fail "override -9 kW never reached the sim"
  sleep 2
done
BEFORE_RESUME=$("${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -c 'setpoint write: battery = -12.00 kW' || true)
for i in $(seq 1 30); do
  NOW_RESUME=$("${COMPOSE[@]}" logs edge-sim 2>/dev/null | grep -c 'setpoint write: battery = -12.00 kW' || true)
  [ "$NOW_RESUME" -gt "$BEFORE_RESUME" ] && break
  [ "$i" = 30 ] && fail "the plan never re-took the battery after override expiry"
  sleep 2
done
pass "override -9 kW superseded the plan; plan resumed -12 kW on TTL expiry"

echo "--- P5 staleness: an AGED redelivery is stale immediately; producer releases, battery falls through"
plan_v2 "$(python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)-timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))")" -12 20 \
  | cloud_pub -t "$T_BASE/v2/plan" -q 1 -r -s
# The producer's release failsafe CLEARS its retained command: a fresh
# subscriber gets NO retained message within the window.
sleep 8
if bus_sub -t "edge/entities/$PV/command" -C 1 -W 8 >/dev/null 2>&1; then
  fail "producer command was not cleared on plan staleness (release failsafe)"
fi
# The battery falls to the still-standing flow desire (-7, refreshed every
# 20 s by the deployed flow) - the next-highest active desired, not market.
for i in $(seq 1 30); do
  CMD=$(bus_sub -t "edge/entities/$BATT/command" -C 1 -W 15) || CMD=""
  echo "$CMD" | grep -q '"source":"desired"' && echo "$CMD" | grep -q '"setpoint_kw":-7' && break
  [ "$i" = 30 ] && { echo "$CMD"; fail "battery never fell back to the flow desire after plan staleness"; }
  sleep 2
done
pass "aged plan stale immediately: producer released (retained clear), flow desire resumed the battery"

echo
echo "E2E-V2 OK: September-Gate chain proven on the rig -"
echo "  registry push -> configs/guards; flowc artifact -> deployment -> NR -> desired ->"
echo "  arbitration -> guard clamp -> certified sunspec write -> register readback;"
echo "  P2 clamp, P3 conflict, P4 override/resume, P5 multi-entity plan + staleness, P7 v1 untouched."

#!/usr/bin/env bash
# Steuerarten der Verbraucher auf Edge Light - das echte Programm vp-edge-light
# gegen simulierte Verbraucher, ohne Hardware, ohne Docker, ohne Cloud.
#
# Das Gegenstueck zu den Rig-Schritten C1 und C5 der Docker-Box
# (edge-app/test/e2e-v2-compose.sh), mit denselben Nutzlasten:
#
#   P1  Fahrplan-Slot (so laufen „Feste Zeiten", „Günstige Stunden" und
#       „Fertig bis"): ein Heizstab-Slot on_off=true kommt beim Verbraucher an
#       und endet mit seinem Fenster im Ausfallverhalten.
#   P2  Reaktive Regel (so laeuft „Überschuss" an einer Schaltlast, die
#       SG-Ready-Freigabe und jede Regel mit lokalem Signal): das von flowc
#       kompilierte Artefakt mit vp-consumer-policy - auf der Docker-Box in
#       Node-RED - laeuft hier im Go-Zwilling. Fahrzeug an -> Pflicht-Wunsch
#       mit override -> 22-kW-Wunsch auf das 11-kW-Band geklemmt -> Fahrzeug ab
#       -> Abfallverzoegerung -> der Wunsch laeuft ohne Erneuerung aus.
#
# Die "Cloud" ist der eigene lokale Bus der Box (VP_DEV_CLOUD_URL, wie L14 in
# edge-app/test/e2e-ocpp.sh): Registry, Fahrplan und Flow-Satz kommen als
# echte Downlinks. Braucht Go >= 1.24, node und python3. Laufzeit ca. 2 min.
#
#   edge-light/test/verbraucherregel-probe.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

have_local_go || { echo "FEHLER: Go >= 1.24 fehlt (die Probe startet die Programme auf diesem Rechner)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FEHLER: node fehlt (flowc kompiliert die Regel)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-verbraucherregel-probe.XXXXXX")"
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "    Arbeitsordner: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $1"
  echo "--- Edge-Light-Protokoll (Ende)"; tail -30 "$WORK/light.log" || true
  for f in "$WORK"/sim-*.log; do echo "--- $f"; tail -8 "$f" || true; done
  exit 1
}
pass() { echo "    ok: $1"; }
waitfor() { # <sekunden> <beschreibung> <befehl...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done
  fail "Zeitueberschreitung: $what"
}
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

echo "--- baue vp-edge-light, Verbraucher-Simulator und Bus-Werkzeug (fuer diesen Rechner)"
for c in vp-edge-light vp-consumer-sim vp-mqtt-pub; do
  go_run CGO_ENABLED=0 -- build -o "$WORK/$c" "./cmd/$c"
done

TENANT=00000000-0000-0000-0000-000000000001
SITE=00000000-0000-0000-0000-000000000002
DEVICE=00000000-0000-0000-0000-000000000003
T_BASE="ems/${TENANT}/${SITE}/${DEVICE}"
WB=wb-rig
ROD=rod-rig
BUS_PORT="$(port)"; WEB_PORT="$(port)"; MIRROR_PORT="$(port)"
BUS="tcp://127.0.0.1:${BUS_PORT}"
BOX="http://127.0.0.1:${WEB_PORT}"

echo "--- starte Edge Light (Cloud = eigener lokaler Bus)"
mkdir -p "$WORK/data"
VP_DATA_DIR="$WORK/data" VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" VP_MIRROR_PORT="${MIRROR_PORT}" \
VP_PORTAL_BASE_URL=http://127.0.0.1:9 VP_OCPP_ENABLED=false \
VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
VP_DEV_TENANT_ID="$TENANT" VP_DEV_SITE_ID="$SITE" VP_DEV_DEVICE_ID="$DEVICE" \
VP_DEV_CLOUD_URL="$BUS" \
  "$WORK/vp-edge-light" >"$WORK/light.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Edge Light antwortet" curl -sf "$BOX/health" -o /dev/null
pass "vp-edge-light laeuft"

"$WORK/vp-consumer-sim" --bus "$BUS" --entity "$WB" --preset wallbox --available=false \
  --telemetry-interval 2s >"$WORK/sim-wb.log" 2>&1 &
PIDS+=($!)
"$WORK/vp-consumer-sim" --bus "$BUS" --entity "$ROD" --preset heating-rod \
  --telemetry-interval 2s >"$WORK/sim-rod.log" 2>&1 &
PIDS+=($!)

pub() { "$WORK/vp-mqtt-pub" -broker "$BUS" "$@" >/dev/null || fail "Veroeffentlichen fehlgeschlagen: $*"; }
state() { curl -sf "$BOX/api/state"; }
# py <ausdruck ueber s> - wertet /api/state aus (s = geparstes JSON)
py() { state | python3 -c "import json,sys; s=json.load(sys.stdin); sys.exit(0 if ($1) else 1)"; }

echo "--- Registry (dieselben Verbraucher wie Rig C1/C5)"
cat >"$WORK/registry.json" <<JSON
{"schema_version":"1.0","tenant_id":"$TENANT","site_id":"$SITE","device_id":"$DEVICE",
 "revision":"probe-1","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[
  {"entity_id":"$WB","entity_type":"wallbox","label":"Wallbox Probe",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"},{"channel":"vehicle_connected"}],
     "actuate":[{"command":"setpoint_kw","min":0,"max":11},{"command":"on_off"}]},
   "guards":{"limits":{"max_consumption_kw":11},"failsafe":{"behavior":"release"}}},
  {"entity_id":"$ROD","entity_type":"heating-rod","label":"Heizstab Probe",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],
     "actuate":[{"command":"on_off"}]},
   "guards":{"limits":{"max_consumption_kw":6,"min_off_seconds":45},
     "failsafe":{"behavior":"off"}}}
 ]}
JSON
pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry.json"
waitfor 30 "Registry angewandt" py "'$ROD' in json.dumps(s) and '$WB' in json.dumps(s)"
pass "Registry angewandt"

# ---------------------------------------------------------------- P1
echo "--- P1: Fahrplan-Slot (1 min): Heizstab EIN kommt an und endet mit dem Fenster"
SLOT_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$WORK/plan.json" <<JSON
{"schema_version":"2.0","tenant_id":"$TENANT","site_id":"$SITE","device_id":"$DEVICE",
 "plan_id":"8d0f7780-8536-41ef-a55c-f18fd2f01bf8","generated_at":"$SLOT_START",
 "horizon_slots":2,"slot_minutes":1,
 "entities":[{"entity_id":"$ROD","kind":"consumer",
   "slots":[{"start":"$SLOT_START","commands":{"on_off":true}}]}]}
JSON
pub -topic "$T_BASE/v2/plan" -retain -file "$WORK/plan.json"
waitfor 30 "Heizstab-Simulator fuehrt den Slot aus" grep -q 'applied on=true 6.000 kW mismatch=false' "$WORK/sim-rod.log"
pass "Plan-Slot erreicht den Verbraucher (6 kW, Rueckmeldung stimmt)"
waitfor 120 "Heizstab faellt nach dem Fenster ins Ausfallverhalten" grep -q 'applied on=false' "$WORK/sim-rod.log"
pass "das Fenster endet: Heizstab aus (Ausfallverhalten off)"

# ---------------------------------------------------------------- P2
echo "--- P2: reaktive Verbraucherregel (flowc-Artefakt, auf der Docker-Box in Node-RED)"
(cd "$REPO_ROOT/edge-app" && node - "$WORK" "$WB" <<'NODE'
const fs = require('fs');
const path = require('path');
const { compile } = require(path.join(process.cwd(), 'nodered', 'flowc', 'compile'));
const [work, wb] = process.argv.slice(2);
const reactive = {
  schema_version: '1.0',
  flow_id: 'bb2d3c4b-6e7f-4081-9234-56789abcdebb',
  flow_version: 1,
  name: 'Verbraucherregel Probe: Wallbox',
  runtime: 'edge',
  site_id: '00000000-0000-0000-0000-000000000002',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  origin: { kind: 'consumer-policy',
    policy_id: 'cc3e4d5c-7f80-4192-a345-6789abcdefcc', policy_version: 1, entity_id: wb },
  nodes: [
    { id: 'reaktiv', type: 'vp.consumer.reactive', type_version: '1.0.0',
      parameters: { entity_id: wb, command: 'setpoint_kw',
        ttl_s: 30, renew_s: 10, off_delay_s: 10,
        requirements: [
          { id: 'laden-wenn-verbunden', must_run: true, value: 22.0,
            condition: { signal: 'consumer.vehicle_connected', source: 'entity',
              channel: 'vehicle_connected', op: 'eq', value: 1, max_age_s: 60 } },
        ] },
      claims: [{ entity_id: wb, commands: ['setpoint_kw'] }] },
  ],
  edges: [],
  triggers: [{ id: 'tick', kind: 'interval', every_s: 10 }],
};
const artifact = compile(reactive, { compiledAt: new Date().toISOString() });
fs.writeFileSync(path.join(work, 'flows.json'), JSON.stringify({
  schema_version: '1.0', kind: 'deployment',
  tenant_id: reactive.tenant_id, site_id: reactive.site_id,
  device_id: '00000000-0000-0000-0000-000000000003',
  deployed_at: new Date().toISOString(), artifacts: [artifact],
}));
fs.writeFileSync(path.join(work, 'hash.txt'), artifact.content_hash);
NODE
) || fail "flowc konnte die Regel nicht kompilieren"
HASH="$(cat "$WORK/hash.txt")"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows.json"
waitfor 30 "Artefakt aktiv quittiert" py "any(f.get('content_hash')=='$HASH' and f.get('state')=='active' for f in s.get('active_control',{}).get('flows',[]))"
pass "Artefakt hash-genau als aktiv quittiert (laeuft im Go-Zwilling)"
grep -q 'Verbraucherregel gestartet' "$WORK/light.log" || fail "der Zwilling hat die Regel nicht gestartet"

vehicle() { pub -topic "edge/entities/$WB/sim/availability" -payload "$1"; }
echo "--- P2a: Fahrzeug an -> Pflicht-Wunsch (override) -> 22 kW auf 11 kW geklemmt"
vehicle 1
waitfor 40 "Wallbox fuehrt den geklemmten Wunsch aus" grep -q 'applied on=true 11.000 kW' "$WORK/sim-wb.log"
pass "22-kW-Wunsch kommt als 11 kW an (Klemme des Core)"
waitfor 30 "Halter der Wallbox ist die Regel" py "any(e.get('entity_id')=='$WB' and e.get('holder')=='flow' for e in s.get('active_control',{}).get('entities',[]))"
pass "Arbitrierung: die Regel (Klasse flow) haelt die Wallbox"

echo "--- P2b: Fahrzeug ab -> Abfallverzoegerung -> Wunsch laeuft ohne Erneuerung aus"
vehicle 0
waitfor 90 "die Regel gibt die Wallbox frei" py "not any(e.get('entity_id')=='$WB' and e.get('holder')=='flow' for e in s.get('active_control',{}).get('entities',[]))"
pass "Wallbox freigegeben (TTL ohne Erneuerung)"

echo "--- P2c: Flow-Satz geleert -> die Regel endet, ein Fahrzeug startet nichts mehr"
pub -topic "$T_BASE/v2/flows" -retain -payload ''
waitfor 30 "Regel beendet" grep -q 'Verbraucherregel beendet' "$WORK/light.log"
before="$(grep -c 'applied on=true 11.000 kW' "$WORK/sim-wb.log" || true)"
vehicle 1
sleep 15
after="$(grep -c 'applied on=true 11.000 kW' "$WORK/sim-wb.log" || true)"
[ "$before" = "$after" ] || fail "nach dem Leeren hat die Regel die Wallbox wieder gestartet"
py "not any(e.get('entity_id')=='$WB' and e.get('holder')=='flow' for e in s.get('active_control',{}).get('entities',[]))" \
  || fail "nach dem Leeren haelt noch eine Regel die Wallbox"
pass "geleerter Satz: keine Regel mehr"

echo "--- alles gruen"

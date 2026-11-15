#!/usr/bin/env bash
# Steuerlogik Stufe 6, Zusammenfuehren, Ende zu Ende je Box-Art mit den echten
# Programmen: eine Regel des Regel-Baukastens ("Wenn mehr als 2,0 kW
# Sonnenstrom uebrig sind: Pumpe einschalten", das Dokument der
# Gleichheitsvektoren regel-kern-vectors.json) wird vom Logik-Dienst
# uebersetzt (POST /aus-regel), als Artefakt gebaut (POST /artefakt), von der
# Box im Satz auf v2/flows angenommen und schaltet ueber Schiedsrichter und
# Schutzgrenzen einen gestellten Shelly (vp-shelly-sim) - so, wie die API den
# Satz je Steuerweg zusammenstellt (FlowActivationService + SteuerwegService).
#
# Docker-Box (vp-edge-core, mit einem gestellten Node-RED fuer den alten Weg):
#   D1  Mitlauf: der Satz traegt das Node-RED-Artefakt der Regel (von flowc
#       kompiliert) UND die mitlaufende Uebersetzung; beide aktiv quittiert,
#       der Regel-Tab liegt in Node-RED.
#   D2  Sonnenstrom 3 kW: der Kern "wuerde schalten" (Wunsch an), geschaltet
#       wird nichts - der Herzschlag zaehlt die Abweichung.
#   D3  Uebernehmen: der Satz ohne Node-RED-Artefakt, mit der scharfen
#       Uebersetzung; Node-RED verliert den Regel-Tab, die Pumpe geht an.
#   D4  Die Hysterese des alten Wegs: 1,8 kW halten die Pumpe, 1,5 kW nicht.
#   D5  Zurueck: der Satz nur mit dem Node-RED-Artefakt - der Kern laesst los,
#       der Regel-Tab liegt wieder in Node-RED.
# Edge Light (vp-edge-light):
#   L1  Der Satz mit Node-RED-Artefakt und scharfer Uebersetzung: das
#       Node-RED-Artefakt lehnt die Box ab wie bisher, die Uebersetzung laeuft;
#       sie meldet steuerlogik_regeln.
#   L2  Sonnenstrom 3 kW: die Pumpe geht an (echte Switch.Set-Anfragen),
#       1,5 kW: aus.
#
# Die "Cloud" ist der eigene lokale Bus der Box (VP_DEV_CLOUD_URL) wie in
# steuerlogik-scharf-probe.sh. Dauer je Box-Art etwa drei Minuten. Braucht
# Go >= 1.24, node und python3 mit paho-mqtt.
#
#   edge-light/test/regel-kern-probe.sh [docker|light]   (ohne Angabe: beide)
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

have_local_go || { echo "FEHLER: Go >= 1.24 fehlt (die Probe startet die Programme auf diesem Rechner)" >&2; exit 1; }
command -v node >/dev/null || { echo "FEHLER: node fehlt (flowc kompiliert das Node-RED-Artefakt)" >&2; exit 1; }
python3 -c 'import paho.mqtt.client' 2>/dev/null || { echo "FEHLER: python3 mit paho-mqtt fehlt (liest den Herzschlag)" >&2; exit 1; }

ARTEN="${1:-docker light}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-regel-kern-probe.XXXXXX")"
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "    Arbeitsordner: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $1"
  echo "--- Box-Protokoll (Ende)"; tail -40 "$WORK/box.log" || true
  echo "--- Shelly (Ende)"; tail -15 "$WORK/shelly.log" || true
  echo "--- letzter Herzschlag (flows, logik)"
  python3 -c "import json,sys; h=json.load(open(sys.argv[1])); print(json.dumps({'flows': h.get('flows'), 'logik': h.get('logik')}, ensure_ascii=False)[:3000])" \
    "$WORK/herzschlag.json" 2>/dev/null || true
  exit 1
}
pass() { echo "    ok: $1"; }
waitfor() { # <sekunden> <beschreibung> <befehl...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done
  fail "Zeitueberschreitung: $what"
}
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

echo "--- baue vp-edge-core, vp-edge-light, vp-logik-dienst, vp-shelly-sim und Bus-Werkzeug (fuer diesen Rechner)"
for c in vp-edge-core vp-edge-light vp-logik-dienst vp-shelly-sim vp-mqtt-pub; do
  go_run CGO_ENABLED=0 -- build -o "$WORK/$c" "./cmd/$c"
done

TENANT=00000000-0000-0000-0000-000000000001
SITE=00000000-0000-0000-0000-000000000002
DEVICE=00000000-0000-0000-0000-000000000003
T_BASE="ems/${TENANT}/${SITE}/${DEVICE}"
REGEL=9b2d4f60-1c3e-4a5b-8d7f-0e1f2a3b4c5d
# Die Kennungen der Vektoren: Netzanschluss und Pumpe.
NETZ=11111111-1111-4111-8111-111111111111
PUMPE=44444444-4444-4444-8444-444444444444
VEKTOREN="$REPO_ROOT/docs/contracts/v2/regel-kern-vectors.json"
DIENST_PORT="$(port)"; SHELLY_PORT="$(port)"; NR_PORT="$(port)"
DIENST="http://127.0.0.1:${DIENST_PORT}"
SHELLY="http://127.0.0.1:${SHELLY_PORT}"

"$WORK/vp-shelly-sim" -addr "127.0.0.1:${SHELLY_PORT}" -ausgaenge 1 >"$WORK/shelly.log" 2>&1 &
PIDS+=($!)
waitfor 20 "Shelly antwortet" curl -sf "$SHELLY/shelly" -o /dev/null
LOGIK_DIENST_PORT="$DIENST_PORT" LOGIK_DIENST_BIND=127.0.0.1 "$WORK/vp-logik-dienst" >"$WORK/dienst.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Logik-Dienst antwortet" curl -sf "$DIENST/health" -o /dev/null

# Der Registry-Push der Anlage: der Netz-Zaehler und die Pumpe an einem Shelly mit einem Relais. Die Box fuehrt
# das Relais selbst (ohne frischen Befehl schreibt sie "aus" und liest zurueck): das ist der beobachtete Stand
# des Vergleichs im Mitlauf.
python3 - "$TENANT" "$SITE" "$DEVICE" "$NETZ" "$PUMPE" "$SHELLY_PORT" >"$WORK/registry.json" <<'PY'
import json, sys, datetime
t, s, d, netz, pumpe, port = sys.argv[1:]
print(json.dumps({"schema_version": "1.0", "tenant_id": t, "site_id": s, "device_id": d, "revision": "probe-1",
    "published_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "entities": [
        {"entity_id": netz, "entity_type": "grid-meter", "label": "Netzanschluss",
         "capabilities": {"measure": [{"channel": "power_kw", "unit": "kW"}], "actuate": []}, "guards": {}},
        {"entity_id": pumpe, "entity_type": "pump", "label": "Pumpe", "owner_claimed": True,
         "capabilities": {"measure": [], "actuate": [{"command": "on_off"}]},
         "guards": {"failsafe": {"behavior": "off"}},
         "driver": {"brand": "shelly", "communication": "shelly_http",
                    "connection": {"ip": "127.0.0.1", "port": int(port), "channel": 0}}}]}))
PY

# ---------------------------------------------------------------- Uebersetzen und bauen
echo "--- der Logik-Dienst uebersetzt die Regel, flowc kompiliert sie fuer Node-RED"
python3 - "$VEKTOREN" "$WORK/registry.json" "$REGEL" >"$WORK/regel.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
f = v["faelle"][0]
doc = dict(f["dokument"]); doc["flow_id"] = sys.argv[3]; doc["flow_version"] = 3
print(json.dumps({"dokument": doc, "name": f["name"], "fassung": 3, "registry": json.load(open(sys.argv[2]))}))
PY
code="$(curl -s -o "$WORK/uebersetzt.json" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/regel.json" "$DIENST/aus-regel")"
[ "$code" = 200 ] || fail "der Dienst hat die Regel nicht uebersetzt ($code): $(cat "$WORK/uebersetzt.json")"
python3 -c "import json,sys; a=json.load(open(sys.argv[1])); assert a['uebersetzt'] and 'site.grid' in a['text'] and '(Fassung 3)' in a['text'], a" "$WORK/uebersetzt.json" \
  || fail "die Uebersetzung liest nicht site.grid oder nennt die Fassung nicht"
# Die Kennung der Uebersetzung wie SteuerwegService.logikIdFuer (Java UUID.nameUUIDFromBytes: MD5, Version 3).
LOGIK="$(python3 -c '
import hashlib, sys, uuid
b = bytearray(hashlib.md5(("steuerlogik-regel:" + sys.argv[1]).encode()).digest())
b[6] = (b[6] & 0x0f) | 0x30; b[8] = (b[8] & 0x3f) | 0x80
print(uuid.UUID(bytes=bytes(b)))' "$REGEL")"
artefakt() { # <armed true|false> <ausgabe>
  python3 - "$WORK/uebersetzt.json" "$WORK/registry.json" "$LOGIK" "$1" >"$WORK/auftrag.json" <<'PY'
import json, sys
text = json.load(open(sys.argv[1]))["text"]
print(json.dumps({"text": text, "flow_id": sys.argv[3], "flow_version": 1 if sys.argv[4] == "false" else 2,
                  "armed": sys.argv[4] == "true", "registry": json.load(open(sys.argv[2])),
                  "site": {"timezone": "Europe/Berlin", "latitude": 48.1, "longitude": 11.6}}))
PY
  curl -s -o "$2" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/auftrag.json" "$DIENST/artefakt"
}
[ "$(artefakt false "$WORK/mit.json")" = 200 ] || fail "mitlaufendes Artefakt abgelehnt: $(cat "$WORK/mit.json")"
[ "$(artefakt true "$WORK/scharf.json")" = 200 ] || fail "scharfes Artefakt abgelehnt: $(cat "$WORK/scharf.json")"
python3 - "$WORK/scharf.json" "$PUMPE" <<'PY' || fail "das scharfe Artefakt verlangt nicht actuate:on_off an der Pumpe"
import json, sys
a = json.load(open(sys.argv[1]))["artifact"]
assert a["bundle"]["armed"] is True
assert a["required_entities"] == [{"entity_id": sys.argv[2], "capabilities": ["actuate:on_off"]}], a["required_entities"]
PY
( cd "$REPO_ROOT/edge-app/nodered/flowc" && node -e '
const { compile } = require("./compile");
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify({ artifact: compile(r.dokument) }));
' "$WORK/regel.json" ) >"$WORK/nodered.json" || fail "flowc hat die Regel nicht kompiliert"
pass "uebersetzt (Logik $LOGIK), mitlaufend und scharf gebaut, Node-RED-Artefakt kompiliert"

satz() { # <ausgabe> <artefakt-json...>
  local ziel="$1"; shift
  python3 - "$TENANT" "$SITE" "$DEVICE" "$@" >"$ziel" <<'PY'
import json, sys
arts = [json.load(open(p))["artifact"] for p in sys.argv[4:]]
print(json.dumps({"schema_version": "1.0", "kind": "deployment", "tenant_id": sys.argv[1], "site_id": sys.argv[2],
                  "device_id": sys.argv[3], "deployed_at": "2026-11-15T12:00:00Z", "artifacts": arts}))
PY
}
hash_von() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['artifact']['content_hash'])" "$1"; }
H_NR="$(hash_von "$WORK/nodered.json")"; H_MIT="$(hash_von "$WORK/mit.json")"; H_SCHARF="$(hash_von "$WORK/scharf.json")"

# ---------------------------------------------------------------- Box starten
start_box() { # <art>
  local art="$1" bin=vp-edge-light extra=()
  BUS_PORT="$(port)"; WEB_PORT="$(port)"; MIRROR_PORT="$(port)"
  BUS="tcp://127.0.0.1:${BUS_PORT}"; BOX="http://127.0.0.1:${WEB_PORT}"
  rm -rf "$WORK/data" "$WORK/herzschlag.json"; mkdir -p "$WORK/data"
  if [ "$art" = docker ]; then
    bin=vp-edge-core
    extra=(VP_NODERED_ADMIN_URL="http://127.0.0.1:${NR_PORT}" VP_NODERED_USER=probe VP_NODERED_PASSWORD=probe)
  fi
  env VP_DATA_DIR="$WORK/data" VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
    VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" VP_MIRROR_PORT="${MIRROR_PORT}" \
    VP_PORTAL_BASE_URL=http://127.0.0.1:9 VP_OCPP_ENABLED=false \
    VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
    VP_DEV_TENANT_ID="$TENANT" VP_DEV_SITE_ID="$SITE" VP_DEV_DEVICE_ID="$DEVICE" \
    VP_DEV_CLOUD_URL="$BUS" ${extra[@]+"${extra[@]}"} \
    "$WORK/$bin" >"$WORK/box.log" 2>&1 &
  PIDS+=($!)
  BOX_PID=$!
  waitfor 40 "$bin antwortet" curl -sf "$BOX/health" -o /dev/null
  python3 - "$BUS_PORT" "$T_BASE/status" "$WORK/herzschlag.json" >"$WORK/hoerer.log" 2>&1 <<'PY' &
import os, sys
import paho.mqtt.client as mqtt
port, topic, ziel = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def on_message(_c, _u, msg):
    tmp = ziel + ".tmp"
    with open(tmp, "wb") as f:
        f.write(msg.payload)
    os.replace(tmp, ziel)
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="regel-kern-hoerer")
c.on_connect = lambda cl, *_: cl.subscribe(topic, 1)
c.on_message = on_message
c.connect("127.0.0.1", port)
c.loop_forever()
PY
  PIDS+=($!)
  HOERER_PID=$!
  # Die Messwerte der Anlage, laufend: das Netz aus $WORK/netz (negativ = Einspeisung).
  echo 0.5 >"$WORK/netz"
  (
    while true; do
      printf '{"ts":"%s","power_kw":%s,"pv_power_kw":4.0,"soc_pct":50.0,"load_kw":1.0}' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat "$WORK/netz")" >"$WORK/tel.json"
      "$WORK/vp-mqtt-pub" -broker "$BUS" -topic edge/telemetry -file "$WORK/tel.json" >/dev/null 2>&1
      sleep 2
    done
  ) &
  PIDS+=($!)
  TEL_PID=$!
  pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry.json"
}
stop_box() {
  kill "$BOX_PID" "$HOERER_PID" "$TEL_PID" 2>/dev/null || true
  wait "$BOX_PID" "$HOERER_PID" "$TEL_PID" 2>/dev/null || true
}
pub() { "$WORK/vp-mqtt-pub" -broker "$BUS" "$@" >/dev/null || fail "Veroeffentlichen fehlgeschlagen: $*"; }
# hs <ausdruck> - der letzte Herzschlag (h = JSON, l = der Lauf der Uebersetzung oder None, g = ihr Geraet,
# a = die Quittungen nach Hash)
hs() {
  [ -s "$WORK/herzschlag.json" ] || return 1
  python3 - "$WORK/herzschlag.json" "$LOGIK" "$1" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
l = next((x for x in (h.get("logik") or {}).get("laeufe", []) if x.get("flow_id") == sys.argv[2]), None)
g = ((l or {}).get("geraete") or {}).get("geraet") or {}
a = {f.get("content_hash"): f for f in (h.get("flows") or {}).get("applied", [])}
sys.exit(0 if eval(sys.argv[3]) else 1)
PY
}
# sh <ausdruck> - der Zustand des Shelly (on = Liste der Ausgaenge, a = Schaltanfragen)
sh() {
  curl -sf "$SHELLY/probe/zustand" -o "$WORK/shelly.json" || return 1
  python3 - "$WORK/shelly.json" "$1" <<'PY'
import json, sys
z = json.load(open(sys.argv[1])); on, a = z["on"], z["anfragen"]
sys.exit(0 if eval(sys.argv[2]) else 1)
PY
}
anfragen_an() { curl -sf "$SHELLY/probe/zustand" | python3 -c "import json,sys; print(len([x for x in json.load(sys.stdin)['anfragen'] if x['on']]))"; }

# ---------------------------------------------------------------- Docker-Box
docker_box() {
  echo "=== Docker-Box (vp-edge-core)"
  # Ein gestelltes Node-RED: Anmeldung, Palette, Flows lesen und schreiben (die Admin-API, die die Box spricht).
  python3 - "$NR_PORT" "$WORK/nodered-flows.json" >"$WORK/nodered.log" 2>&1 <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port, ablage = int(sys.argv[1]), sys.argv[2]
json.dump([], open(ablage, "w"))
class H(BaseHTTPRequestHandler):
    def _antwort(self, doc):
        b = json.dumps(doc).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/nodes":
            self._antwort([{"module": "@voltpilot/node-red-vp-palette", "version": "9.9.9"}])
        elif self.path == "/flows":
            self._antwort(json.load(open(ablage)))
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.path == "/auth/token":
            self._antwort({"access_token": "probe"})
        elif self.path == "/flows":
            json.dump(json.loads(body), open(ablage, "w"))
            self._antwort({"rev": "probe"})
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a):
        print(self.command, self.path, flush=True)
HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
  PIDS+=($!)
  local nr_pid=$!
  waitfor 20 "Node-RED-Stellvertreter antwortet" curl -sf "http://127.0.0.1:${NR_PORT}/flows" -o /dev/null
  start_box docker
  tab() { python3 -c "import json,sys; print(any(n.get('type')=='tab' and sys.argv[2] in (n.get('info') or '') for n in json.load(open(sys.argv[1]))))" "$WORK/nodered-flows.json" "$REGEL"; }

  echo "--- D1: Mitlauf - Node-RED-Artefakt und mitlaufende Uebersetzung im Satz"
  satz "$WORK/satz-mit.json" "$WORK/nodered.json" "$WORK/mit.json"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-mit.json"
  waitfor 75 "beide aktiv quittiert" hs "a.get('$H_NR',{}).get('state')=='active' and a.get('$H_MIT',{}).get('state')=='active'"
  hs "'steuerlogik_regeln' in h.get('supports', [])" || fail "die Box meldet steuerlogik_regeln nicht"
  waitfor 30 "Regel-Tab in Node-RED" test "$(tab)" = True
  waitfor 30 "Uebersetzung laeuft mit" hs "l is not None and l['zustand']=='mitlaufend'"
  pass "Node-RED hat den Regel-Tab, der Kern laeuft mit (Fassung 1), steuerlogik_regeln gemeldet"

  echo "--- D2: 3 kW Sonnenstrom - der Kern wuerde schalten, geschaltet wird nichts"
  echo -3.0 >"$WORK/netz"
  waitfor 90 "Wunsch an, Abweichung gezaehlt" hs "(g.get('wunsch') or {}).get('ein') is True and (g.get('abweichend_s') or 0) > 0"
  [ "$(anfragen_an)" = 0 ] || fail "im Mitlauf hat etwas eingeschaltet"
  pass "Wunsch an, ist aus: $(python3 -c "import json,sys; h=json.load(open(sys.argv[1])); l=next(x for x in h['logik']['laeufe'] if x['flow_id']==sys.argv[2]); g=l['geraete']['geraet']; print(g.get('abweichend_s'), 's verschieden von', g.get('verglichen_s'), 's')" "$WORK/herzschlag.json" "$LOGIK"), keine Schaltanfrage"

  echo "--- D3: Uebernehmen - der Satz ohne Node-RED-Artefakt, die Uebersetzung scharf"
  satz "$WORK/satz-kern.json" "$WORK/scharf.json"
  T0="$(date +%s)"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-kern.json"
  waitfor 30 "Pumpe an" sh "on == [True]"
  echo "    eingeschaltet nach $(( $(date +%s) - T0 )) s"
  waitfor 30 "Regel-Tab aus Node-RED genommen" test "$(tab)" = False
  waitfor 75 "Lauf scharf, der Schiedsrichter haelt fuer die Logik" hs "l is not None and l['zustand']=='scharf' and h['entities']['arbitration']['$PUMPE']['holder']=='steuerlogik'"
  pass "Node-RED gibt die Regel ab, die Box schaltet sie: Pumpe an"

  echo "--- D4: die Hysterese - 1,8 kW halten, 1,5 kW nicht"
  echo -1.8 >"$WORK/netz"
  sleep 12
  sh "on == [True]" || fail "1,8 kW Sonnenstrom (innerhalb der Hysterese) haben die Pumpe ausgeschaltet"
  echo -1.5 >"$WORK/netz"
  waitfor 40 "Pumpe aus" sh "on == [False]"
  pass "1,8 kW: an, 1,5 kW: aus - wie der Schwellwert des alten Wegs (2 kW, 0,3 kW Hysterese)"

  echo "--- D5: Zurueck - der Satz nur mit dem Node-RED-Artefakt"
  echo -3.0 >"$WORK/netz"
  waitfor 30 "Pumpe wieder an" sh "on == [True]"
  satz "$WORK/satz-alt.json" "$WORK/nodered.json"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-alt.json"
  waitfor 30 "Regel-Tab wieder in Node-RED" test "$(tab)" = True
  waitfor 75 "die Uebersetzung laeuft nicht mehr" hs "l is None and h['entities']['arbitration']['$PUMPE'].get('holder','') != 'steuerlogik'"
  pass "der Kern laesst los, Node-RED hat die Regel wieder"
  stop_box
  kill "$nr_pid" 2>/dev/null || true
}

# ---------------------------------------------------------------- Edge Light
light_box() {
  echo "=== Edge Light (vp-edge-light)"
  curl -sf -X POST "$SHELLY/rpc/Switch.Set?id=0&on=false" -o /dev/null || true
  start_box light
  echo "--- L1: Node-RED-Artefakt und scharfe Uebersetzung im Satz"
  satz "$WORK/satz-light.json" "$WORK/nodered.json" "$WORK/scharf.json"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-light.json"
  waitfor 75 "Uebersetzung aktiv, Node-RED-Artefakt abgelehnt" hs "a.get('$H_SCHARF',{}).get('state')=='active' and a.get('$H_NR',{}).get('state') not in (None, 'active')"
  hs "'steuerlogik_regeln' in h.get('supports', [])" || fail "die Edge Light meldet steuerlogik_regeln nicht"
  pass "die Edge Light lehnt den alten Weg ab wie bisher und fuehrt die Uebersetzung aus"

  echo "--- L2: 3 kW Sonnenstrom: an, 1,5 kW: aus"
  local vorher; vorher="$(anfragen_an)"
  echo -3.0 >"$WORK/netz"
  waitfor 40 "Pumpe an" sh "on == [True]"
  [ "$(anfragen_an)" -gt "$vorher" ] || fail "keine Einschaltanfrage am Shelly"
  waitfor 75 "Lauf scharf, Halter die Logik" hs "l is not None and l['zustand']=='scharf' and h['entities']['arbitration']['$PUMPE']['holder']=='steuerlogik'"
  echo -1.5 >"$WORK/netz"
  waitfor 40 "Pumpe aus" sh "on == [False]"
  pass "die Regel schaltet auf der Edge Light: an bei 3 kW, aus bei 1,5 kW"
  stop_box
}

for art in $ARTEN; do
  case "$art" in
    docker) docker_box ;;
    light) light_box ;;
    *) fail "unbekannte Box-Art: $art" ;;
  esac
done
echo "--- alles gruen"

#!/usr/bin/env bash
# Steuerlogik Stufe 6, Zusammenfuehren, dritter Teil, Ende zu Ende je Box-Art
# mit den echten Programmen: die Steuerart "Solar-Ueberschuss" einer Pumpe (die
# generierte Verbraucherregel, wie ConsumerPolicyCompiler sie baut) und der
# Heizstab-Regler eines Heizstabs an einem Shelly Pro 3 (Parameterblock
# heizstab) werden vom Logik-Dienst uebersetzt (POST /aus-steuerart,
# POST /aus-heizstab), als Artefakt gebaut (POST /artefakt), von der Box im Satz
# auf v2/flows angenommen und schalten ueber Schiedsrichter und Schutzgrenzen
# zwei gestellte Shellys (vp-shelly-sim) - so, wie die API Satz und Registry je
# Schalter der Anlage zusammenstellt (SteuerwegGeraete).
#
# Je Box-Art (Docker-Box mit einem gestellten Node-RED, Edge Light mit dem
# Go-Zwilling der Verbraucherregel):
#   1  Mitlauf: der Satz traegt den alten Weg (das flowc-Artefakt der
#      Verbraucherregel) UND beide mitlaufenden Uebersetzungen, die Registry
#      den Block des Heizstabs; alles aktiv quittiert, steuerlogik_steuerarten
#      gemeldet.
#   2  Sonne: der Heizstab-Regler der Box schaltet Stufe fuer Stufe; die
#      Uebersetzung rechnet mit und will dieselbe Stufe (der Herzschlag
#      vergleicht). Auf Edge Light schaltet der Go-Zwilling die Pumpe.
#   3  Uebernehmen: erst der Satz mit den scharfen Uebersetzungen ohne das
#      Artefakt der Verbraucherregel, dann die Registry ohne Block; die Logik
#      haelt beide Geraete, die Stufe des Heizstabs bleibt.
#   4  Weniger Sonne: die Logik nimmt die Stufe zurueck und schaltet die Pumpe
#      nach der Ausschaltverzoegerung aus.
#   5  Zurueck: erst die Registry mit Block, dann der Satz mit dem alten Weg;
#      der Regler fuehrt den Heizstab wieder, die Logik laeuft nicht mehr.
#
# Die "Cloud" ist der eigene lokale Bus der Box (VP_DEV_CLOUD_URL) wie in
# regel-kern-probe.sh. Dauer je Box-Art etwa sechs Minuten. Braucht
# Go >= 1.24, node und python3 mit paho-mqtt.
#
#   edge-light/test/steuerart-kern-probe.sh [docker|light]   (ohne Angabe: beide)
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

have_local_go || { echo "FEHLER: Go >= 1.24 fehlt (die Probe startet die Programme auf diesem Rechner)" >&2; exit 1; }
command -v node >/dev/null || { echo "FEHLER: node fehlt (flowc kompiliert die Verbraucherregel)" >&2; exit 1; }
python3 -c 'import paho.mqtt.client' 2>/dev/null || { echo "FEHLER: python3 mit paho-mqtt fehlt (Herzschlag und Messwerte)" >&2; exit 1; }

ARTEN="${1:-docker light}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-steuerart-kern-probe.XXXXXX")"
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
  echo "--- Pro 3 (Ende)"; tail -10 "$WORK/stab.log" || true
  echo "--- letzter Herzschlag (flows, logik, Schiedsrichter)"
  python3 -c "import json,sys; h=json.load(open(sys.argv[1])); print(json.dumps({'flows': h.get('flows'), 'logik': h.get('logik'), 'arb': (h.get('entities') or {}).get('arbitration')}, ensure_ascii=False)[:4000])" \
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
NETZ=11111111-1111-4111-8111-111111111111
PUMPE=44444444-4444-4444-8444-444444444444
STAB=33333333-3333-4333-8333-333333333333
DIENST_PORT="$(port)"; PUMPE_PORT="$(port)"; STAB_PORT="$(port)"; NR_PORT="$(port)"
DIENST="http://127.0.0.1:${DIENST_PORT}"
SH_PUMPE="http://127.0.0.1:${PUMPE_PORT}"
SH_STAB="http://127.0.0.1:${STAB_PORT}"
# Der Block des Heizstabs, wie HeizstabPush ihn baut; kurze Schutzzeiten, damit die Probe in Minuten laeuft.
BLOCK='{"modus":"ueberschuss","vorrang":"speicher_zuerst","mindestlauf_s":20,"mindestpause_s":20,"haltezeit_s":20}'

"$WORK/vp-shelly-sim" -addr "127.0.0.1:${PUMPE_PORT}" -ausgaenge 1 >"$WORK/pumpe.log" 2>&1 &
PIDS+=($!)
"$WORK/vp-shelly-sim" -addr "127.0.0.1:${STAB_PORT}" -ausgaenge 3 >"$WORK/stab.log" 2>&1 &
PIDS+=($!)
waitfor 20 "Shellys antworten" curl -sf "$SH_STAB/shelly" -o /dev/null
LOGIK_DIENST_PORT="$DIENST_PORT" LOGIK_DIENST_BIND=127.0.0.1 "$WORK/vp-logik-dienst" >"$WORK/dienst.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Logik-Dienst antwortet" curl -sf "$DIENST/health" -o /dev/null

# Der Registry-Push der Anlage: Netz-Zaehler, die Pumpe an einem Relais, der Heizstab an einem Pro 3 (drei
# Elemente je 2 kW, Stufen 1 bis 3); "registry-alt.json" traegt den Block des Heizstabs, "registry-kern.json" nicht.
registry() { # <mit_block true|false>
  python3 - "$TENANT" "$SITE" "$DEVICE" "$NETZ" "$PUMPE" "$STAB" "$PUMPE_PORT" "$STAB_PORT" "$BLOCK" "$1" <<'PY'
import json, sys, datetime
t, s, d, netz, pumpe, stab, pport, sport, block, mit = sys.argv[1:]
stab_e = {"entity_id": stab, "entity_type": "heating-rod", "label": "Heizstab", "owner_claimed": True,
          "capabilities": {"measure": [], "actuate": [{"command": "on_off"}, {"command": "setpoint_kw"}]},
          "guards": {"failsafe": {"behavior": "off"}},
          "driver": {"brand": "shelly", "communication": "shelly_http",
                     "connection": {"ip": "127.0.0.1", "port": int(sport), "channels": [0, 1, 2],
                                    "output_kw": [2, 2, 2], "stages": [1, 2, 3]}}}
if mit == "true":
    stab_e["heizstab"] = json.loads(block)
print(json.dumps({"schema_version": "1.0", "tenant_id": t, "site_id": s, "device_id": d,
    "revision": "probe-" + mit,
    "published_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "entities": [
        {"entity_id": netz, "entity_type": "grid-meter", "label": "Netzanschluss",
         "capabilities": {"measure": [{"channel": "power_kw", "unit": "kW"}], "actuate": []}, "guards": {}},
        {"entity_id": pumpe, "entity_type": "pump", "label": "Pumpe", "owner_claimed": True,
         "capabilities": {"measure": [], "actuate": [{"command": "on_off"}]},
         "guards": {"failsafe": {"behavior": "off"}},
         "driver": {"brand": "shelly", "communication": "shelly_http",
                    "connection": {"ip": "127.0.0.1", "port": int(pport), "channel": 0}}},
        stab_e]}))
PY
}
registry true >"$WORK/registry-alt.json"
registry false >"$WORK/registry-kern.json"

# ---------------------------------------------------------------- Uebersetzen und bauen
echo "--- der Logik-Dienst uebersetzt Steuerart und Heizstab-Regler, flowc kompiliert die Verbraucherregel"
FLOW=7b5f3c2e-9d1a-3f4b-8c6e-5a4b3c2d1e0f
python3 - "$PUMPE" "$FLOW" "$WORK/registry-alt.json" >"$WORK/steuerart.json" <<'PY'
import json, sys
pumpe, flow = sys.argv[1], sys.argv[2]
doc = {"schema_version": "1.0", "flow_id": flow, "flow_version": 3, "name": "Verbraucherregel: Pumpe", "runtime": "edge",
       "site_id": "00000000-0000-0000-0000-000000000002", "tenant_id": "00000000-0000-0000-0000-000000000001",
       "origin": {"kind": "consumer-policy", "policy_id": "7c1e0c9a-0000-4000-8000-000000000001", "policy_version": 3,
                  "entity_id": pumpe},
       "nodes": [{"id": "reaktiv", "type": "vp.consumer.reactive", "type_version": "1.0.0", "label": "Reaktive Regeln: Pumpe",
                  "parameters": {"entity_id": pumpe, "command": "on_off", "ttl_s": 45, "renew_s": 15, "off_delay_s": 15,
                                 "requirements": [{"id": "ueberschuss", "must_run": False, "value": True,
                                                   "condition": {"signal": "site.pv_surplus_kw", "source": "site",
                                                                 "channel": "pv_surplus_kw", "op": "gt", "value": 1.5,
                                                                 "reset_value": 1.125, "max_age_s": 120}}]},
                  "claims": [{"entity_id": pumpe, "commands": ["on_off"]}]}],
       "edges": [], "triggers": [{"id": "tick", "kind": "interval", "every_s": 15}]}
print(json.dumps({"dokument": doc, "name": doc["name"], "fassung": 3, "registry": json.load(open(sys.argv[3]))}))
PY
code="$(curl -s -o "$WORK/steuerart-text.json" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/steuerart.json" "$DIENST/aus-steuerart")"
[ "$code" = 200 ] || fail "der Dienst hat die Steuerart nicht uebersetzt ($code): $(cat "$WORK/steuerart-text.json")"
python3 - "$STAB" "$BLOCK" "$WORK/registry-alt.json" >"$WORK/heizstab.json" <<'PY'
import json, sys
print(json.dumps({"entity": sys.argv[1], "block": json.loads(sys.argv[2]), "registry": json.load(open(sys.argv[3]))}))
PY
code="$(curl -s -o "$WORK/heizstab-text.json" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/heizstab.json" "$DIENST/aus-heizstab")"
[ "$code" = 200 ] || fail "der Dienst hat den Heizstab-Regler nicht uebersetzt ($code): $(cat "$WORK/heizstab-text.json")"
python3 -c "
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
assert a['uebersetzt'] and 'site.surplus' in a['text'], a
assert b['uebersetzt'] and 'default: 20 s' in b['text'] and '>= 6 kW' in b['text'], b
" "$WORK/steuerart-text.json" "$WORK/heizstab-text.json" || fail "die Uebersetzungen lesen nicht, was sie sollen"
# Die Kennungen der Uebersetzungen wie SteuerwegGeraete.logikIdSteuerart/logikIdHeizstab (Java nameUUIDFromBytes).
kennung() { python3 -c '
import hashlib, sys, uuid
b = bytearray(hashlib.md5(sys.argv[1].encode()).digest())
b[6] = (b[6] & 0x0f) | 0x30; b[8] = (b[8] & 0x3f) | 0x80
print(uuid.UUID(bytes=bytes(b)))' "$1"; }
L_PUMPE="$(kennung "steuerlogik-steuerart:$PUMPE")"
L_STAB="$(kennung "steuerlogik-heizstab:$STAB")"
artefakt() { # <text.json> <logik> <armed true|false> <ausgabe>
  python3 - "$1" "$WORK/registry-alt.json" "$2" "$3" >"$WORK/auftrag.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))
print(json.dumps({"text": a["text"], "flow_id": sys.argv[3], "flow_version": 1 if sys.argv[4] == "false" else 2,
                  "armed": sys.argv[4] == "true", "pflicht": bool(a.get("pflicht")),
                  "registry": json.load(open(sys.argv[2])),
                  "site": {"timezone": "Europe/Berlin", "latitude": 48.1, "longitude": 11.6}}))
PY
  curl -s -o "$4" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/auftrag.json" "$DIENST/artefakt"
}
for x in "steuerart-text $L_PUMPE pumpe" "heizstab-text $L_STAB stab"; do
  set -- $x
  [ "$(artefakt "$WORK/$1.json" "$2" false "$WORK/$3-mit.json")" = 200 ] || fail "mitlaufendes Artefakt ($3) abgelehnt: $(cat "$WORK/$3-mit.json")"
  [ "$(artefakt "$WORK/$1.json" "$2" true "$WORK/$3-scharf.json")" = 200 ] || fail "scharfes Artefakt ($3) abgelehnt: $(cat "$WORK/$3-scharf.json")"
done
( cd "$REPO_ROOT/edge-app/nodered/flowc" && node -e '
const { compile } = require("./compile");
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify({ artifact: compile(r.dokument) }));
' "$WORK/steuerart.json" ) >"$WORK/alt.json" || fail "flowc hat die Verbraucherregel nicht kompiliert"
pass "uebersetzt (Pumpe $L_PUMPE, Heizstab $L_STAB), mitlaufend und scharf gebaut, Verbraucherregel kompiliert"

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
H_ALT="$(hash_von "$WORK/alt.json")"
H_PM="$(hash_von "$WORK/pumpe-mit.json")"; H_SM="$(hash_von "$WORK/stab-mit.json")"
H_PS="$(hash_von "$WORK/pumpe-scharf.json")"; H_SS="$(hash_von "$WORK/stab-scharf.json")"
satz "$WORK/satz-mitlauf.json" "$WORK/alt.json" "$WORK/pumpe-mit.json" "$WORK/stab-mit.json"
satz "$WORK/satz-kern.json" "$WORK/pumpe-scharf.json" "$WORK/stab-scharf.json"
satz "$WORK/satz-alt.json" "$WORK/alt.json"

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
  # Herzschlag mitlesen und die Messwerte der Anlage senden: das Netz sieht den Heizstab (Elemente je 2 kW),
  # Sonne und Haus aus $WORK/sonne und $WORK/haus.
  echo 0 >"$WORK/sonne"; echo 0.6 >"$WORK/haus"
  python3 - "$BUS_PORT" "$T_BASE/status" "$WORK/herzschlag.json" "$SH_STAB" "$WORK" >"$WORK/anlage.log" 2>&1 <<'PY' &
import json, os, sys, threading, time, urllib.request, datetime
import paho.mqtt.client as mqtt
port, topic, ziel, stab, work = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
def on_message(_c, _u, msg):
    tmp = ziel + ".tmp"
    with open(tmp, "wb") as f:
        f.write(msg.payload)
    os.replace(tmp, ziel)
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="steuerart-kern-anlage")
c.on_connect = lambda cl, *_: cl.subscribe(topic, 1)
c.on_message = on_message
c.connect("127.0.0.1", port)
c.loop_start()
while True:
    try:
        on = json.load(urllib.request.urlopen(stab + "/probe/zustand", timeout=2))["on"]
        sonne = float(open(os.path.join(work, "sonne")).read())
        haus = float(open(os.path.join(work, "haus")).read())
        last = haus + 2.0 * sum(1 for x in on if x)
        tel = {"ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "power_kw": round(last - sonne, 3), "pv_power_kw": sonne, "load_kw": round(last, 3), "soc_pct": 50.0}
        c.publish("edge/telemetry", json.dumps(tel))
    except Exception as e:
        print("Messwert:", e, flush=True)
    time.sleep(1)
PY
  PIDS+=($!)
  ANLAGE_PID=$!
}
stop_box() {
  kill "$BOX_PID" "$ANLAGE_PID" 2>/dev/null || true
  wait "$BOX_PID" "$ANLAGE_PID" 2>/dev/null || true
}
pub() { "$WORK/vp-mqtt-pub" -broker "$BUS" "$@" >/dev/null || fail "Veroeffentlichen fehlgeschlagen: $*"; }
# hs <ausdruck> - der letzte Herzschlag: h = JSON, lp/ls = die Laeufe der Uebersetzungen (oder None),
# gp/gs = ihre Geraete, a = die Quittungen nach Hash, arb = die Halter des Schiedsrichters je Geraet
hs() {
  [ -s "$WORK/herzschlag.json" ] || return 1
  python3 - "$WORK/herzschlag.json" "$L_PUMPE" "$L_STAB" "$PUMPE" "$STAB" "$1" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
laeufe = (h.get("logik") or {}).get("laeufe", [])
lp = next((x for x in laeufe if x.get("flow_id") == sys.argv[2]), None)
ls = next((x for x in laeufe if x.get("flow_id") == sys.argv[3]), None)
gp = ((lp or {}).get("geraete") or {}).get("geraet") or {}
gs = ((ls or {}).get("geraete") or {}).get("heizstab") or {}
a = {f.get("content_hash"): f for f in (h.get("flows") or {}).get("applied", [])}
arbs = (h.get("entities") or {}).get("arbitration") or {}
arb = {"pumpe": (arbs.get(sys.argv[4]) or {}).get("holder", ""), "stab": (arbs.get(sys.argv[5]) or {}).get("holder", "")}
sys.exit(0 if eval(sys.argv[6]) else 1)
PY
}
# an <url> - wie viele Ausgaenge eines Shelly an sind
an() { curl -sf "$1/probe/zustand" | python3 -c "import json,sys; print(sum(1 for x in json.load(sys.stdin)['on'] if x))"; }
ist() { [ "$(an "$1")" = "$2" ]; }
anfragen() { curl -sf "$1/probe/zustand" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['anfragen']))"; }

ablauf() { # <art>
  local art="$1"
  echo "--- 1: Mitlauf - der alte Weg und beide Uebersetzungen im Satz, der Block in der Registry"
  pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry-alt.json"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-mitlauf.json"
  waitfor 75 "alles aktiv quittiert" hs "a.get('$H_ALT',{}).get('state')=='active' and a.get('$H_PM',{}).get('state')=='active' and a.get('$H_SM',{}).get('state')=='active'"
  hs "'steuerlogik_steuerarten' in h.get('supports', [])" || fail "die Box meldet steuerlogik_steuerarten nicht"
  waitfor 30 "beide laufen mit" hs "lp is not None and ls is not None and lp['zustand']=='mitlaufend' and ls['zustand']=='mitlaufend'"
  pass "alter Weg aktiv, beide Uebersetzungen laufen mit, steuerlogik_steuerarten gemeldet"
  # Eine ruhige halbe Minute: die Uebersetzung zaehlt Mindestpause und Haltezeit ab ihrem Start (20 s).
  sleep 30

  echo "--- 2: Sonne 9 kW - der Regler schaltet Stufe fuer Stufe, die Uebersetzung will dieselbe Stufe"
  echo 9 >"$WORK/sonne"
  waitfor 90 "der Regler schaltet die erste Stufe" ist "$SH_STAB" 1
  waitfor 30 "der Regler haelt den Heizstab" hs "arb['stab']=='heizstab'"
  waitfor 30 "die Uebersetzung will Stufe 1" hs "(gs.get('wunsch') or {}).get('stufe')==1"
  waitfor 120 "Stufe 3" ist "$SH_STAB" 3
  waitfor 30 "die Uebersetzung will Stufe 3" hs "(gs.get('wunsch') or {}).get('stufe')==3 and (gs.get('ist') or {}).get('stufe')==3"
  # Verglichen wird der Wunsch der Uebersetzung mit dem, was der Pro 3 zurueckliest: je Wechsel hinkt die
  # Ruecklesung ein paar Sekunden hinter der Entscheidung her. Laenger darf keine Abweichung dauern.
  hs "(gs.get('laengste_abweichung_s') or 0) <= 6 and (gs.get('wunsch_wechsel') or 0) == 3" || fail "Regler und Uebersetzung weichen laenger als das Schalten ab: $(python3 -c "import json,sys; h=json.load(open(sys.argv[1])); print([x['geraete'] for x in h['logik']['laeufe']])" "$WORK/herzschlag.json")"
  if [ "$art" = light ]; then
    waitfor 40 "der Go-Zwilling schaltet die Pumpe" ist "$SH_PUMPE" 1
  fi
  waitfor 30 "die Uebersetzung der Pumpe will an" hs "(gp.get('wunsch') or {}).get('ein') is True"
  pass "Stufe 3 vom Regler, die Uebersetzung rechnet gleich ($(python3 -c "import json,sys; h=json.load(open(sys.argv[1])); g=[x for x in h['logik']['laeufe'] if x['flow_id']==sys.argv[2]][0]['geraete']['heizstab']; print(g.get('wunsch_wechsel'),'Wechsel, laengste Abweichung',g.get('laengste_abweichung_s'),'s (Schaltzeit)')" "$WORK/herzschlag.json" "$L_STAB"))"

  echo "--- 3: Uebernehmen - erst der Satz mit den scharfen Uebersetzungen, dann die Registry ohne Block"
  local vorher; vorher="$(anfragen "$SH_STAB")"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-kern.json"
  waitfor 75 "scharf quittiert" hs "a.get('$H_PS',{}).get('state')=='active' and a.get('$H_SS',{}).get('state')=='active'"
  hs "arb['stab']=='heizstab'" || fail "solange der Block reist, muss der Regler fuehren"
  pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry-kern.json"
  waitfor 40 "die Logik haelt beide Geraete" hs "arb['stab']=='steuerlogik' and arb['pumpe']=='steuerlogik'"
  waitfor 30 "die Pumpe ist an" ist "$SH_PUMPE" 1
  ist "$SH_STAB" 3 || fail "die Uebergabe hat den Heizstab geschaltet ($(an "$SH_STAB") Phasen)"
  [ "$(anfragen "$SH_STAB")" -le $((vorher + 6)) ] || fail "die Uebergabe hat am Pro 3 geschaltet"
  pass "die Logik fuehrt Pumpe und Heizstab, Stufe 3 bleibt"

  echo "--- 4: Sonne 3 kW - die Logik nimmt die Stufe zurueck, die Pumpe geht nach der Verzoegerung aus"
  echo 3 >"$WORK/sonne"
  waitfor 90 "eine kleinere Stufe" ist "$SH_STAB" 1
  echo 0.5 >"$WORK/sonne"
  waitfor 120 "Heizstab aus" ist "$SH_STAB" 0
  waitfor 60 "Pumpe aus" ist "$SH_PUMPE" 0
  pass "die Logik schaltet den Heizstab zurueck und aus, die Pumpe nach dem Rueckfallwert aus"

  echo "--- 5: Zurueck - erst die Registry mit Block, dann der Satz mit dem alten Weg"
  echo 9 >"$WORK/sonne"
  pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry-alt.json"
  waitfor 40 "der Regler fuehrt wieder" hs "arb['stab']=='heizstab'"
  pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/satz-alt.json"
  waitfor 75 "die Uebersetzungen laufen nicht mehr" hs "lp is None and ls is None and arb['pumpe']!='steuerlogik'"
  waitfor 120 "der Regler schaltet wieder" ist "$SH_STAB" 1
  pass "der Regler fuehrt den Heizstab wieder, die Logik hat losgelassen"
}

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
  ablauf docker
  python3 -c "import json,sys; sys.exit(0 if any(n.get('type')=='tab' and sys.argv[2] in (n.get('info') or '') for n in json.load(open(sys.argv[1]))) else 1)" \
    "$WORK/nodered-flows.json" "$FLOW" || fail "die Verbraucherregel liegt nach dem Zurueck nicht wieder in Node-RED"
  pass "Node-RED hat die Verbraucherregel wieder"
  stop_box
  kill "$nr_pid" 2>/dev/null || true
}

# ---------------------------------------------------------------- Edge Light
light_box() {
  echo "=== Edge Light (vp-edge-light)"
  for u in "$SH_PUMPE" "$SH_STAB"; do
    for i in 0 1 2; do curl -sf -X POST "$u/rpc/Switch.Set?id=$i&on=false" -o /dev/null || true; done
  done
  start_box light
  ablauf light
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

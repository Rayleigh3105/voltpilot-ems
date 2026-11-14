#!/usr/bin/env bash
# Steuerlogik Stufe 2 Ende zu Ende mit den echten Programmen, ohne Hardware,
# ohne Docker, ohne Cloud: der Logik-Dienst (vp-logik-dienst) baut das
# Artefakt aus dem Beispiel der Waermepumpe im Vertrag, das echte Programm
# vp-edge-light nimmt es aus dem Satz auf v2/flows an, laesst es mitlaufen und
# meldet es im Herzschlag - und schaltet dabei nichts.
#
#   S1  Der Dienst lehnt die 1:1-Fassung der Heizung ab (eine Probe besteht
#       nicht, E5) und baut das Artefakt der Waermepumpe.
#   S2  Die Box quittiert es hash-genau als aktiv und meldet steuerlogik_mitlauf.
#   S3  Ohne Fuehlerwert: der Block logik nennt den Fuehler unbekannt, die Lage
#       ist "Stoerung Fuehler" - nichts wird erfunden.
#   S4  Mit Netz und Fuehler als echte lokale Nachrichten: keine Luecke mehr,
#       die Lage wechselt, Fassung und Hash stimmen.
#   S5  Geschaltet wurde nichts: der Simulator des Kontakts hat keinen Befehl
#       bekommen, und die Box haelt kein Geraet.
#   S6  Ein geleerter Satz stoppt die Logik: der Block verschwindet.
#
# Die "Cloud" ist der eigene lokale Bus der Box (VP_DEV_CLOUD_URL) wie in
# verbraucherregel-probe.sh. Braucht Go >= 1.24 und python3 mit paho-mqtt.
#
#   edge-light/test/steuerlogik-probe.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

have_local_go || { echo "FEHLER: Go >= 1.24 fehlt (die Probe startet die Programme auf diesem Rechner)" >&2; exit 1; }
python3 -c 'import paho.mqtt.client' 2>/dev/null || { echo "FEHLER: python3 mit paho-mqtt fehlt (liest den Herzschlag)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-steuerlogik-probe.XXXXXX")"
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
  echo "--- Dienst-Protokoll (Ende)"; tail -10 "$WORK/dienst.log" || true
  echo "--- letzter Herzschlag"; tail -c 3000 "$WORK/herzschlag.json" 2>/dev/null || true
  exit 1
}
pass() { echo "    ok: $1"; }
waitfor() { # <sekunden> <beschreibung> <befehl...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done
  fail "Zeitueberschreitung: $what"
}
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

echo "--- baue vp-edge-light, vp-logik-dienst, Verbraucher-Simulator und Bus-Werkzeug (fuer diesen Rechner)"
for c in vp-edge-light vp-logik-dienst vp-consumer-sim vp-mqtt-pub; do
  go_run CGO_ENABLED=0 -- build -o "$WORK/$c" "./cmd/$c"
done

TENANT=00000000-0000-0000-0000-000000000001
SITE=00000000-0000-0000-0000-000000000002
DEVICE=00000000-0000-0000-0000-000000000003
T_BASE="ems/${TENANT}/${SITE}/${DEVICE}"
LOGIK=5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b
WP=waermepumpe-1
# Der Fuehler dieser Anlage: das Beispiel nennt ihn erfunden "fuehler-puffer-oben";
# eine echte Logik nennt die Kennung des Geraets, und Messproben tragen eine UUID.
FUEHLER=6d1c3b2a-4f5e-4a7b-8c9d-0e1f2a3b4c5d
BEISPIELE="$REPO_ROOT/docs/contracts/v2/steuerlogik"
BUS_PORT="$(port)"; WEB_PORT="$(port)"; MIRROR_PORT="$(port)"; DIENST_PORT="$(port)"
BUS="tcp://127.0.0.1:${BUS_PORT}"
BOX="http://127.0.0.1:${WEB_PORT}"
DIENST="http://127.0.0.1:${DIENST_PORT}"

# ---------------------------------------------------------------- S1
echo "--- S1: der Logik-Dienst prueft und baut"
LOGIK_DIENST_PORT="$DIENST_PORT" LOGIK_DIENST_BIND=127.0.0.1 "$WORK/vp-logik-dienst" >"$WORK/dienst.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Logik-Dienst antwortet" curl -sf "$DIENST/health" -o /dev/null
auftrag() { # <beispiel> <ausgabe>
  python3 - "$BEISPIELE/$1.logic.yaml" "$LOGIK" "$FUEHLER" >"$WORK/auftrag-$1.json" <<'PY'
import json, sys
text = open(sys.argv[1], encoding="utf-8").read().replace("fuehler-puffer-oben", sys.argv[3])
print(json.dumps({"text": text, "flow_id": sys.argv[2], "flow_version": 1,
                  "site": {"timezone": "Europe/Berlin", "latitude": 48.1, "longitude": 11.6}}))
PY
  curl -s -o "$2" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/auftrag-$1.json" "$DIENST/artefakt"
}
code="$(auftrag heizung-treu "$WORK/treu.json")"
[ "$code" = 422 ] || fail "die 1:1-Fassung muss gesperrt sein, Antwort $code"
python3 -c "import json,sys; b=json.load(open(sys.argv[1]))['bericht']; sys.exit(0 if b['sperrt'] and any(not p['besteht'] for p in b['proben']) else 1)" "$WORK/treu.json" \
  || fail "die Sperre nennt keine nicht bestandene Probe"
pass "1:1-Fassung gesperrt (eine Probe besteht nicht)"
code="$(auftrag waermepumpe "$WORK/wp.json")"
[ "$code" = 200 ] || fail "das Beispiel der Waermepumpe wurde abgelehnt ($code): $(cat "$WORK/wp.json")"
python3 - "$WORK/wp.json" "$TENANT" "$SITE" "$DEVICE" >"$WORK/flows.json" <<'PY'
import json, sys
art = json.load(open(sys.argv[1]))["artifact"]
print(json.dumps({"schema_version": "1.0", "kind": "deployment", "tenant_id": sys.argv[2], "site_id": sys.argv[3],
                  "device_id": sys.argv[4], "deployed_at": art["compiled_at"], "artifacts": [art]}))
PY
HASH="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['artifact']['content_hash'])" "$WORK/wp.json")"
pass "Artefakt gebaut ($HASH)"

# ---------------------------------------------------------------- Box
echo "--- starte Edge Light (Cloud = eigener lokaler Bus, Steuerung aus wie am Piloten)"
mkdir -p "$WORK/data"
VP_DATA_DIR="$WORK/data" VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" VP_MIRROR_PORT="${MIRROR_PORT}" \
VP_PORTAL_BASE_URL=http://127.0.0.1:9 VP_OCPP_ENABLED=false \
VP_CONTROL_ENABLED=false VP_CONSUMER_CONTROL_ENABLED=false \
VP_DEV_TENANT_ID="$TENANT" VP_DEV_SITE_ID="$SITE" VP_DEV_DEVICE_ID="$DEVICE" \
VP_DEV_CLOUD_URL="$BUS" \
  "$WORK/vp-edge-light" >"$WORK/light.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Edge Light antwortet" curl -sf "$BOX/health" -o /dev/null
pass "vp-edge-light laeuft"

# Der Kontakt der Waermepumpe: ein Simulator, der jeden Befehl protokolliert.
"$WORK/vp-consumer-sim" --bus "$BUS" --entity "$WP" --preset heating-rod \
  --telemetry-interval 2s >"$WORK/sim-wp.log" 2>&1 &
PIDS+=($!)

# Den Herzschlag der Box mitlesen: jede Nachricht auf .../status, die letzte gewinnt.
python3 - "$BUS_PORT" "$T_BASE/status" "$WORK/herzschlag.json" >"$WORK/hoerer.log" 2>&1 <<'PY' &
import os, sys
import paho.mqtt.client as mqtt
port, topic, ziel = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def on_message(_c, _u, msg):
    tmp = ziel + ".tmp"
    with open(tmp, "wb") as f:
        f.write(msg.payload)
    os.replace(tmp, ziel)
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="steuerlogik-probe-hoerer")
c.on_connect = lambda cl, *_: cl.subscribe(topic, 1)
c.on_message = on_message
c.connect("127.0.0.1", port)
c.loop_forever()
PY
PIDS+=($!)

pub() { "$WORK/vp-mqtt-pub" -broker "$BUS" "$@" >/dev/null || fail "Veroeffentlichen fehlgeschlagen: $*"; }
# hs <ausdruck ueber h> - wertet den letzten Herzschlag aus (h = geparstes JSON, l = der Lauf der Probe oder None)
hs() {
  [ -s "$WORK/herzschlag.json" ] || return 1
  python3 - "$WORK/herzschlag.json" "$LOGIK" "$1" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
l = next((x for x in (h.get("logik") or {}).get("laeufe", []) if x.get("flow_id") == sys.argv[2]), None)
sys.exit(0 if eval(sys.argv[3]) else 1)
PY
}

cat >"$WORK/registry.json" <<JSON
{"schema_version":"1.0","tenant_id":"$TENANT","site_id":"$SITE","device_id":"$DEVICE",
 "revision":"probe-1","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[
  {"entity_id":"$WP","entity_type":"heating-rod","label":"Waermepumpe Kontakt",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],"actuate":[{"command":"on_off"}]},
   "guards":{"limits":{"max_consumption_kw":3},"failsafe":{"behavior":"off"}}}
 ]}
JSON
pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry.json"

# ---------------------------------------------------------------- S2
echo "--- S2: Auslieferung ueber v2/flows"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows.json"
waitfor 60 "Box quittiert das Artefakt aktiv" hs "any(f.get('content_hash')=='$HASH' and f.get('state')=='active' for f in (h.get('flows') or {}).get('applied', []))"
pass "Artefakt hash-genau als aktiv quittiert"
hs "'steuerlogik_mitlauf' in h.get('supports', [])" || fail "die Box meldet steuerlogik_mitlauf nicht"
pass "Faehigkeit steuerlogik_mitlauf gemeldet"
grep -q 'Logik läuft mit (schaltet nichts)' "$WORK/light.log" || fail "der Mitlauf hat nicht begonnen"

# ---------------------------------------------------------------- S3
echo "--- S3: ohne Messwerte ist alles unbekannt, nichts erfunden"
waitfor 40 "Block logik mit unbekanntem Fuehler" hs "l is not None and l['zustand']=='mitlaufend' and 'puffer' in l.get('unbekannt', []) and 'netz' in l.get('unbekannt', []) and (l.get('lage') or {}).get('titel')=='Störung Fühler'"
pass "Fuehler und Netz unbekannt, Lage \"Stoerung Fuehler\""

# ---------------------------------------------------------------- S4
echo "--- S4: Netz und Fuehler als lokale Nachrichten"
telemetrie() {
  python3 - <<PY >"$WORK/tel.json"
import json, datetime
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
print(json.dumps({"ts": now, "power_kw": -3.0, "pv_power_kw": 5.0, "soc_pct": 80.0, "load_kw": 2.0}))
PY
  pub -topic edge/telemetry -file "$WORK/tel.json"
  python3 - <<PY >"$WORK/fuehler.json"
import json, datetime
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
print(json.dumps({"catalog_version": "probe", "observed_at": now, "samples": [{
  "point_key": "shelly.gen2plus.temperature[100].tc", "raw": 42.0, "decoded": 42.0, "quality": "good",
  "observed_at": now, "entity_id": "$FUEHLER"}]}))
PY
  pub -topic edge/measurements/samples -file "$WORK/fuehler.json"
}
fresh() { telemetrie; hs "$1"; }
waitfor 60 "Lage ohne Luecke" fresh "l is not None and not l.get('unbekannt') and (l.get('lage') or {}).get('titel')=='Wartet auf Sonnenstrom'"
hs "l['flow_version']==1 and l['content_hash']=='$HASH' and l['name']=='Wärmepumpe' and l['geraete']['wp']['entity_id']=='$WP' and l['geraete']['wp']['wunsch']=={'ein': False}" \
  || fail "Fassung, Hash oder Wunsch im Block stimmen nicht"
pass "keine Luecke mehr, Lage \"Wartet auf Sonnenstrom\", Wunsch: Kontakt offen"
hs "'ist' not in l['geraete']['wp'] and l['geraete']['wp']['verglichen_s']==0" \
  || fail "ohne gelesenen Schaltstand darf nichts verglichen sein"
pass "Schaltstand ohne Quelle unbekannt, nicht verglichen (nie \"aus\")"

# ---------------------------------------------------------------- S5
echo "--- S5: geschaltet wurde nichts"
if grep -q 'applied on=true' "$WORK/sim-wp.log"; then fail "der Kontakt hat einen Einschaltbefehl bekommen"; fi
hs "h['entities']['arbitration']['$WP']['source']=='failsafe'" \
  || fail "im Schiedsrichter haelt jemand den Kontakt"
pass "kein Befehl am Kontakt, im Schiedsrichter nur das Ausfallverhalten"

# ---------------------------------------------------------------- S6
echo "--- S6: ein geleerter Satz stoppt die Logik"
pub -topic "$T_BASE/v2/flows" -retain -payload ''
waitfor 40 "Block logik verschwindet" hs "l is None"
grep -q 'Logik gestoppt' "$WORK/light.log" || fail "der Mitlauf wurde nicht gestoppt"
pass "Logik gestoppt, Block weg"

echo "--- alles gruen"

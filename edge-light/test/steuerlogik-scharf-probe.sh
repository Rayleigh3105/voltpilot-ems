#!/usr/bin/env bash
# Steuerlogik Stufe 3 ("scharf") Ende zu Ende mit den echten Programmen, ohne
# Hardware, ohne Docker, ohne Cloud: der Logik-Dienst (vp-logik-dienst) baut
# das SCHARFE Artefakt aus dem Warmwasser-Beispiel im Vertrag, das echte
# Programm vp-edge-light nimmt es aus dem Satz auf v2/flows an, und seine
# Wuensche gehen ueber Schiedsrichter und Schutzgrenzen als echte HTTP-
# Schaltanfragen an einen gestellten Shelly Pro 3 (vp-shelly-sim).
#
#   S1  Der Dienst baut das scharfe Artefakt mit gestellten Werten; es verlangt
#       actuate:setpoint_kw am Heizstab.
#   S2  Die Box quittiert es hash-genau als aktiv, meldet steuerlogik_scharf
#       und den Lauf als "scharf".
#   S3  Speicher 35 Grad, "Nie kaelter als" 42 Grad: bis dahin haelt die Box
#       die Ausgaenge aus (sie schreibt "aus", die Logik will Stufe 0), nach zwei
#       Minuten schaltet sie alle drei ein - echte Switch.Set-Anfragen; Befehl und
#       gelesener Stand im Herzschlag sind 3 Phasen, der Halter ist die Logik.
#   S4  Speicher warm: die Logik will aus, die Mindestlaufzeit (45 s) haelt den
#       Stab an und steht als Schutz im Herzschlag; danach geht er aus.
#   S5  Ein gestellter Wert (Stand 2) gilt ohne Neustart: derselbe Lauf.
#   S6  Fassung 2 heizt mit einer Phase und uebernimmt den Zustand; "Zurueck"
#       auf Fassung 1 schaltet im naechsten Takt wieder drei Phasen.
#   S7  "Stilllegen" (der Satz ohne die Logik): der Wunsch ist sofort weg, die
#       Ausgaenge gehen aus, der Block verschwindet.
#   S8  Ein zweiter Herr wird abgewiesen: fuehrt der Heizstab-Regler der Box den
#       Stab (Block heizstab), bekommt die Logik ihn nicht - der Herzschlag nennt
#       den Konflikt, und auch wenn sie 3 Phasen will, schaltet nichts ein.
#
# Die "Cloud" ist der eigene lokale Bus der Box (VP_DEV_CLOUD_URL) wie in
# steuerlogik-probe.sh. Dauer etwa zehn Minuten (die Logik wartet zweimal ihre
# zwei Minuten ab). Braucht Go >= 1.24 und python3 mit paho-mqtt.
#
#   edge-light/test/steuerlogik-scharf-probe.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

have_local_go || { echo "FEHLER: Go >= 1.24 fehlt (die Probe startet die Programme auf diesem Rechner)" >&2; exit 1; }
python3 -c 'import paho.mqtt.client' 2>/dev/null || { echo "FEHLER: python3 mit paho-mqtt fehlt (liest den Herzschlag)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-steuerlogik-scharf-probe.XXXXXX")"
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "    Arbeitsordner: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $1"
  echo "--- Edge-Light-Protokoll (Ende)"; tail -40 "$WORK/light.log" || true
  echo "--- Shelly (Ende)"; tail -15 "$WORK/shelly.log" || true
  echo "--- letzter Herzschlag (logik)"
  python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get('logik'), ensure_ascii=False)[:3000])" \
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

echo "--- baue vp-edge-light, vp-logik-dienst, vp-shelly-sim und Bus-Werkzeug (fuer diesen Rechner)"
for c in vp-edge-light vp-logik-dienst vp-shelly-sim vp-mqtt-pub; do
  go_run CGO_ENABLED=0 -- build -o "$WORK/$c" "./cmd/$c"
done

TENANT=00000000-0000-0000-0000-000000000001
SITE=00000000-0000-0000-0000-000000000002
DEVICE=00000000-0000-0000-0000-000000000003
T_BASE="ems/${TENANT}/${SITE}/${DEVICE}"
LOGIK=5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b
# Heizstab und Fuehler tragen Kennungen wie echte Komponenten (UUIDs).
STAB=7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f
FUEHLER=6d1c3b2a-4f5e-4a7b-8c9d-0e1f2a3b4c5d
BEISPIEL="$REPO_ROOT/docs/contracts/v2/steuerlogik/wasser.logic.yaml"
BUS_PORT="$(port)"; WEB_PORT="$(port)"; MIRROR_PORT="$(port)"; DIENST_PORT="$(port)"; SHELLY_PORT="$(port)"
BUS="tcp://127.0.0.1:${BUS_PORT}"
BOX="http://127.0.0.1:${WEB_PORT}"
DIENST="http://127.0.0.1:${DIENST_PORT}"
SHELLY="http://127.0.0.1:${SHELLY_PORT}"

"$WORK/vp-shelly-sim" -addr "127.0.0.1:${SHELLY_PORT}" >"$WORK/shelly.log" 2>&1 &
PIDS+=($!)
waitfor 20 "Shelly antwortet" curl -sf "$SHELLY/shelly" -o /dev/null

# registry <mit-heizstab-block 0|1> - der Registry-Push der Anlage: ein Heizstab ueber die drei Ausgaenge (3 x 2 kW,
# Stufen 1/2/3), Mindestlaufzeit 45 s; mit 1 fuehrt ihn der Heizstab-Regler der Box (Steuerart Solar-Ueberschuss).
registry() {
  python3 - "$TENANT" "$SITE" "$DEVICE" "$STAB" "$SHELLY_PORT" "$1" <<'PY'
import json, sys, datetime
t, s, d, stab, port, block = sys.argv[1:]
e = {"entity_id": stab, "entity_type": "heating-rod", "label": "Heizstab Warmwasser",
     "capabilities": {"measure": [], "actuate": [{"command": "on_off"}, {"command": "setpoint_kw"}]},
     "guards": {"limits": {"max_consumption_kw": 6, "min_on_seconds": 45}, "failsafe": {"behavior": "off"}},
     "driver": {"brand": "shelly", "communication": "shelly_http",
                "connection": {"ip": "127.0.0.1", "port": int(port), "channels": [0, 1, 2],
                               "output_kw": [2, 2, 2], "stages": [1, 2, 3]}}}
if block == "1":
    e["heizstab"] = {"modus": "ueberschuss"}
    e["owner_claimed"] = True
print(json.dumps({"schema_version": "1.0", "tenant_id": t, "site_id": s, "device_id": d,
                  "revision": "probe-" + block, "published_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                  "entities": [e]}))
PY
}

# ---------------------------------------------------------------- S1
echo "--- S1: der Logik-Dienst baut das scharfe Artefakt"
LOGIK_DIENST_PORT="$DIENST_PORT" LOGIK_DIENST_BIND=127.0.0.1 "$WORK/vp-logik-dienst" >"$WORK/dienst.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Logik-Dienst antwortet" curl -sf "$DIENST/health" -o /dev/null
registry 0 >"$WORK/registry.json"
# artefakt <fassung> <stand> <mindest> <ausgabe> [ausgang-ersetzen]
artefakt() {
  python3 - "$BEISPIEL" "$LOGIK" "$FUEHLER" "$STAB" "$1" "$2" "$3" "$WORK/registry.json" "${5:-}" >"$WORK/auftrag.json" <<'PY'
import json, sys
pfad, logik, fuehler, stab, fassung, stand, mindest, registry, ausgang = sys.argv[1:]
text = open(pfad, encoding="utf-8").read().replace("fuehler-speicher-oben", fuehler).replace("heizstab-warmwasser", stab)
if ausgang:
    # Fassung 2: aus dem Netz nur mit einer Phase; die Probe des kalten Morgens folgt.
    text = text.replace('heizstab: {level: "if(netzheizen, 3, if(frei, stufe, 0))"}',
                        'heizstab: {level: "if(netzheizen, 1, if(frei, stufe, 0))"}')
    text = text.replace("expect: {netzheizen: on, heizstab.level: 3,", "expect: {netzheizen: on, heizstab.level: 1,")
# Netzheizen rund um die Uhr (gleiche Grenzen heissen rund um die Uhr), damit die Probe zu jeder Tageszeit laeuft.
werte = {"mindest": mindest, "netz_ab": "00:00", "netz_bis": "00:00"}
print(json.dumps({"text": text, "flow_id": logik, "flow_version": int(fassung), "armed": True,
                  "registry": json.load(open(registry)),
                  "settings": {"revision": int(stand), "values": werte},
                  "site": {"timezone": "Europe/Berlin", "latitude": 48.1, "longitude": 11.6}}))
PY
  curl -s -o "$4" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$WORK/auftrag.json" "$DIENST/artefakt"
}
satz() { # <ausgabe> <artefakt-json...>
  local ziel="$1"; shift
  python3 - "$TENANT" "$SITE" "$DEVICE" "$@" >"$ziel" <<'PY'
import json, sys
arts = [json.load(open(p))["artifact"] for p in sys.argv[4:]]
print(json.dumps({"schema_version": "1.0", "kind": "deployment", "tenant_id": sys.argv[1], "site_id": sys.argv[2],
                  "device_id": sys.argv[3], "deployed_at": "2026-11-14T12:00:00Z", "artifacts": arts}))
PY
}
code="$(artefakt 1 1 "42 °C" "$WORK/f1.json")"
[ "$code" = 200 ] || fail "der Dienst hat das scharfe Artefakt abgelehnt ($code): $(cat "$WORK/f1.json")"
python3 - "$WORK/f1.json" "$STAB" <<'PY' || fail "das Artefakt ist nicht scharf oder verlangt den falschen Befehl"
import json, sys
a = json.load(open(sys.argv[1]))["artifact"]
assert a["bundle"]["armed"] is True and a["bundle"]["settings"]["revision"] == 1
assert a["required_entities"] == [{"entity_id": sys.argv[2], "capabilities": ["actuate:setpoint_kw"]}], a["required_entities"]
PY
HASH1="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['artifact']['content_hash'])" "$WORK/f1.json")"
pass "scharfes Artefakt gebaut ($HASH1), verlangt actuate:setpoint_kw"

# ---------------------------------------------------------------- Box
echo "--- starte Edge Light (Cloud = eigener lokaler Bus, beide Schalter der Box an)"
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

python3 - "$BUS_PORT" "$T_BASE/status" "$WORK/herzschlag.json" >"$WORK/hoerer.log" 2>&1 <<'PY' &
import os, sys
import paho.mqtt.client as mqtt
port, topic, ziel = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def on_message(_c, _u, msg):
    tmp = ziel + ".tmp"
    with open(tmp, "wb") as f:
        f.write(msg.payload)
    os.replace(tmp, ziel)
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="steuerlogik-scharf-hoerer")
c.on_connect = lambda cl, *_: cl.subscribe(topic, 1)
c.on_message = on_message
c.connect("127.0.0.1", port)
c.loop_forever()
PY
PIDS+=($!)

pub() { "$WORK/vp-mqtt-pub" -broker "$BUS" "$@" >/dev/null || fail "Veroeffentlichen fehlgeschlagen: $*"; }
# hs <ausdruck> - wertet den letzten Herzschlag aus (h = JSON, l = der Lauf der Logik oder None, g = ihr Heizstab)
hs() {
  [ -s "$WORK/herzschlag.json" ] || return 1
  python3 - "$WORK/herzschlag.json" "$LOGIK" "$1" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
l = next((x for x in (h.get("logik") or {}).get("laeufe", []) if x.get("flow_id") == sys.argv[2]), None)
g = ((l or {}).get("geraete") or {}).get("heizstab") or {}
sys.exit(0 if eval(sys.argv[3]) else 1)
PY
}
# sh <ausdruck> - wertet den Zustand des Shelly aus (on = Liste der Ausgaenge, a = Schaltanfragen)
sh() {
  curl -sf "$SHELLY/probe/zustand" -o "$WORK/shelly.json" || return 1
  python3 - "$WORK/shelly.json" "$1" <<'PY'
import json, sys
z = json.load(open(sys.argv[1])); on, a = z["on"], z["anfragen"]
sys.exit(0 if eval(sys.argv[2]) else 1)
PY
}
phasen() { curl -sf "$SHELLY/probe/zustand" | python3 -c "import json,sys; print(sum(json.load(sys.stdin)['on']))"; }

# Messwerte der Anlage, laufend: Netz leicht im Bezug, Batterie ruht, und der Fuehler mit der Temperatur aus $WORK/temp.
echo 35 >"$WORK/temp"
(
  while true; do
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '{"ts":"%s","power_kw":0.1,"pv_power_kw":0.0,"soc_pct":50.0,"load_kw":0.1}' "$now" >"$WORK/tel.json"
    "$WORK/vp-mqtt-pub" -broker "$BUS" -topic edge/telemetry -file "$WORK/tel.json" >/dev/null 2>&1
    printf '{"catalog_version":"probe","observed_at":"%s","samples":[{"point_key":"shelly.gen2plus.temperature[100].tc","raw":%s,"decoded":%s,"quality":"good","observed_at":"%s","entity_id":"%s"}]}' \
      "$now" "$(cat "$WORK/temp")" "$(cat "$WORK/temp")" "$now" "$FUEHLER" >"$WORK/fuehler.json"
    "$WORK/vp-mqtt-pub" -broker "$BUS" -topic edge/measurements/samples -file "$WORK/fuehler.json" >/dev/null 2>&1
    sleep 3
  done
) &
PIDS+=($!)

# ---------------------------------------------------------------- S2
echo "--- S2: Auslieferung des scharfen Artefakts ueber v2/flows"
pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry.json"
satz "$WORK/flows1.json" "$WORK/f1.json"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows1.json"
waitfor 60 "Box quittiert das Artefakt aktiv" hs "any(f.get('content_hash')=='$HASH1' and f.get('state')=='active' for f in (h.get('flows') or {}).get('applied', []))"
hs "'steuerlogik_scharf' in h.get('supports', [])" || fail "die Box meldet steuerlogik_scharf nicht"
waitfor 30 "Lauf ist scharf" hs "l is not None and l['zustand']=='scharf' and l.get('scharf_seit') and (l.get('stellwerte') or {}).get('stand')==1"
pass "hash-genau aktiv quittiert, steuerlogik_scharf gemeldet, Lauf scharf mit Stand 1"

# ---------------------------------------------------------------- S3
echo "--- S3: Speicher 35 Grad unter 42 Grad - nach zwei Minuten heizt die Box aus dem Netz"
sh "not any(x['on'] for x in a)" || fail "vor den zwei Minuten hat schon etwas eingeschaltet"
waitfor 170 "drei Ausgaenge eingeschaltet" sh "on == [True, True, True]"
sh "len([x for x in a if x['on']]) >= 3" || fail "keine Einschaltanfragen am Shelly"
waitfor 40 "Herzschlag: Befehl und Stand 3 Phasen, Halter die Logik" hs "(g.get('befehl') or {}).get('stufe')==3 and (g.get('ist') or {}).get('stufe')==3 and not g.get('halter') and h['entities']['arbitration']['$STAB']['holder']=='steuerlogik'"
pass "echte Schaltanfragen: $(grep -c 'on=true' "$WORK/shelly.log") Einschaltungen, 3 Phasen, der Schiedsrichter haelt fuer die Logik"

# ---------------------------------------------------------------- S4
echo "--- S4: Speicher warm - die Mindestlaufzeit haelt den Stab, dann aus"
echo 55 >"$WORK/temp"
waitfor 40 "Schutz im Herzschlag" hs "(g.get('wunsch') or {}).get('stufe')==0 and (g.get('schutz') or {}).get('code')=='guard_min_on'"
[ "$(phasen)" = 3 ] || fail "die Mindestlaufzeit hat den Stab nicht gehalten"
pass "Logik will aus, Schutz 'guard_min_on' haelt drei Phasen"
waitfor 90 "Stab aus nach der Mindestlaufzeit" sh "on == [False, False, False]"
pass "nach der Mindestlaufzeit aus"

# ---------------------------------------------------------------- S5
echo "--- S5: ein gestellter Wert gilt ohne Neustart"
SEIT="$(python3 -c "import json,sys; h=json.load(open(sys.argv[1])); print(next(x for x in h['logik']['laeufe'] if x['flow_id']==sys.argv[2])['seit'])" "$WORK/herzschlag.json" "$LOGIK")"
code="$(artefakt 1 2 "45 °C" "$WORK/f1b.json")"
[ "$code" = 200 ] || fail "Stand 2 abgelehnt ($code)"
satz "$WORK/flows1b.json" "$WORK/f1b.json"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows1b.json"
waitfor 40 "Stand 2 uebernommen, derselbe Lauf" hs "(l.get('stellwerte') or {}).get('stand')==2 and l['seit']=='$SEIT' and any(w['kennung']=='mindest' and w['wert']=='45 °C' for w in l['stellwerte']['werte'])"
pass "Stand 2 (Nie kaelter als 45 Grad) uebernommen, Lauf seit $SEIT unveraendert"

# ---------------------------------------------------------------- S6
echo "--- S6: Fassung 2 mit einer Phase, dann Zurueck auf Fassung 1"
echo 35 >"$WORK/temp"
waitfor 170 "Fassung 1 heizt wieder mit drei Phasen" sh "on == [True, True, True]"
T_AN="$(date +%s)"
code="$(artefakt 2 2 "45 °C" "$WORK/f2.json" eine-phase)"
[ "$code" = 200 ] || fail "Fassung 2 abgelehnt ($code): $(cat "$WORK/f2.json")"
satz "$WORK/flows2.json" "$WORK/f2.json"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows2.json"
waitfor 30 "Fassung 2: eine Phase" sh "sum(on) == 1"
waitfor 75 "Box meldet Fassung 2 im Herzschlag" hs "l is not None and l['flow_version']==2"
pass "Fassung 2 uebernimmt den Zustand und heizt sofort mit einer Phase"
T_ZURUECK="$(date +%s)"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows1b.json"
waitfor 20 "Zurueck: drei Phasen" sh "on == [True, True, True]"
echo "    Zurueck geschaltet nach $(( $(date +%s) - T_ZURUECK )) s (Takt 1 s, Schaltdurchgang alle 5 s)"
waitfor 75 "Box meldet wieder Fassung 1 im Herzschlag" hs "l is not None and l['flow_version']==1"
pass "Zurueck auf Fassung 1: nach $(( $(date +%s) - T_AN )) s seit dem Einschalten wieder drei Phasen"

# ---------------------------------------------------------------- S7
echo "--- S7: Stilllegen wirkt sofort"
while [ $(( $(date +%s) - T_AN )) -lt 50 ]; do sleep 1; done  # die Mindestlaufzeit der Phasen ist um
T_STILL="$(date +%s)"
pub -topic "$T_BASE/v2/flows" -retain -payload ''
waitfor 20 "alle Ausgaenge aus" sh "on == [False, False, False]"
echo "    Stilllegen geschaltet nach $(( $(date +%s) - T_STILL )) s"
waitfor 75 "Block logik verschwindet" hs "l is None"
hs "h['entities']['arbitration']['$STAB'].get('holder','') != 'steuerlogik'" || fail "nach dem Stilllegen haelt die Logik noch"
pass "Logik gestoppt, Wunsch weg, Ausgaenge aus"

# ---------------------------------------------------------------- S8
echo "--- S8: ein zweiter Herr wird abgewiesen"
registry 1 >"$WORK/registry-heizstab.json"
pub -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry-heizstab.json"
cp "$WORK/registry-heizstab.json" "$WORK/registry.json"
code="$(artefakt 1 2 "45 °C" "$WORK/f1c.json")"
[ "$code" = 200 ] || fail "das Artefakt fuer S8 abgelehnt ($code)"
satz "$WORK/flows1c.json" "$WORK/f1c.json"
ANFRAGEN="$(curl -sf "$SHELLY/probe/zustand" | python3 -c "import json,sys; print(len([x for x in json.load(sys.stdin)['anfragen'] if x['on']]))")"
pub -topic "$T_BASE/v2/flows" -retain -file "$WORK/flows1c.json"
waitfor 40 "Konflikt im Herzschlag" hs "(g.get('konflikt') or {}).get('code')=='zweiter_herr'"
waitfor 170 "die Logik will drei Phasen" hs "(g.get('wunsch') or {}).get('stufe')==3 and (g.get('konflikt') or {}).get('code')=='zweiter_herr'"
sh "on == [False, False, False] and len([x for x in a if x['on']]) == $ANFRAGEN" || fail "trotz zweitem Herrn wurde eingeschaltet"
hs "h['entities']['arbitration']['$STAB'].get('holder','') != 'steuerlogik'" || fail "der Schiedsrichter haelt fuer die Logik"
pass "die Logik will drei Phasen, der Heizstab-Regler fuehrt den Stab: keine Einschaltung, Konflikt gemeldet"

echo "--- alles gruen"

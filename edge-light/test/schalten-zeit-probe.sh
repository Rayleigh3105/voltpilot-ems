#!/usr/bin/env bash
# Schalten in 3 Sekunden (vp-schalten-3s): das echte Programm vp-edge-light gegen
# einen simulierten Shelly Pro 3 als Heizstab mit drei Phasen und dem Profil der
# Kundenanlage (Mindestlauf und Mindestpause je 300 s). Die "Cloud" ist der
# eigene lokale Bus der Box (VP_DEV_CLOUD_URL, wie in den anderen Proben); der
# Handeingriff kommt als genau der Umschlag, den die API sendet
# (ConsumerOverridePublisher, request_id mit Schaltspur), und die Probe misst die
# Zeit bis zu dem HERZSCHLAG, der das Ergebnis trägt:
#
#   Z1  "L1 an" (Phasen-Wahl, frei)        -> Herzschlag: L1 an, von Hand
#   Z2  sofort danach "Aus"                 -> Herzschlag: gehalten, guard_min_on
#                                              (die Mindestlaufzeit hält L1 an)
#
# Beide Antworten müssen binnen 3 s im Herzschlag stehen. Eine Box ab dem
# Release mit Schaltspur meldet dazu ihre eigenen Zeitpunkte (consumers.{id}.trace).
#
#   edge-light/test/schalten-zeit-probe.sh
#   VP_LIGHT_BIN=/pfad/zu/vp-edge-light edge-light/test/schalten-zeit-probe.sh   # ein anderes Programm messen
#   SCHALTEN_GRENZE_MS=40000 ...                                                    # nur messen, nicht scheitern
#
# Simulatorbeleg, keine Hardware: was der echte Shelly im Heimnetz, das Internet
# und die Uhr der echten Box beitragen, zeigt nur die Schaltspur an der Anlage.
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

python3 -c 'import paho.mqtt.client' 2>/dev/null || { echo "FEHLER: python3 mit paho-mqtt fehlt" >&2; exit 1; }
GRENZE_MS="${SCHALTEN_GRENZE_MS:-3000}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vp-schalten-zeit-probe.XXXXXX")"
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
  echo "--- Shelly (Ende)"; tail -10 "$WORK/shelly.log" || true
  exit 1
}
pass() { echo "    ok: $1"; }
waitfor() { # <sekunden> <beschreibung> <befehl...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done
  fail "Zeitueberschreitung: $what"
}
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

echo "--- baue vp-shelly-sim und Bus-Werkzeug$( [ -z "${VP_LIGHT_BIN:-}" ] && echo " und vp-edge-light") (fuer diesen Rechner)"
have_local_go || { echo "FEHLER: Go >= 1.24 fehlt" >&2; exit 1; }
for c in vp-shelly-sim vp-mqtt-pub; do
  go_run CGO_ENABLED=0 -- build -o "$WORK/$c" "./cmd/$c"
done
LIGHT="${VP_LIGHT_BIN:-}"
if [ -z "$LIGHT" ]; then
  go_run CGO_ENABLED=0 -- build -o "$WORK/vp-edge-light" ./cmd/vp-edge-light
  LIGHT="$WORK/vp-edge-light"
fi

TENANT=00000000-0000-0000-0000-000000000001
SITE=00000000-0000-0000-0000-000000000002
DEVICE=00000000-0000-0000-0000-000000000003
STAB=7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f
T_BASE="ems/${TENANT}/${SITE}/${DEVICE}"
BUS_PORT="$(port)"; WEB_PORT="$(port)"; MIRROR_PORT="$(port)"; SHELLY_PORT="$(port)"
BUS="tcp://127.0.0.1:${BUS_PORT}"

"$WORK/vp-shelly-sim" -addr "127.0.0.1:${SHELLY_PORT}" >"$WORK/shelly.log" 2>&1 &
PIDS+=($!)
waitfor 20 "Shelly antwortet" curl -sf "http://127.0.0.1:${SHELLY_PORT}/shelly" -o /dev/null

echo "--- starte Edge Light ($(basename "$LIGHT"); Cloud = eigener lokaler Bus, beide Schalter an)"
mkdir -p "$WORK/data"
VP_DATA_DIR="$WORK/data" VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" VP_MIRROR_PORT="${MIRROR_PORT}" \
VP_PORTAL_BASE_URL=http://127.0.0.1:9 VP_OCPP_ENABLED=false \
VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
VP_DEV_TENANT_ID="$TENANT" VP_DEV_SITE_ID="$SITE" VP_DEV_DEVICE_ID="$DEVICE" \
VP_DEV_CLOUD_URL="$BUS" \
  "$LIGHT" >"$WORK/light.log" 2>&1 &
PIDS+=($!)
waitfor 30 "Edge Light antwortet" curl -sf "http://127.0.0.1:${WEB_PORT}/health" -o /dev/null
pass "vp-edge-light laeuft"

# Der Registry-Push des Heizstabs wie aus der Cloud: drei Phasen je 1,5 kW, Stufen 1/2/3, Mindestlauf und
# Mindestpause des Stufenprofils je 300 s (heizstab-shelly.md), Ausfallverhalten aus.
python3 - "$TENANT" "$SITE" "$DEVICE" "$STAB" "$SHELLY_PORT" >"$WORK/registry.json" <<'PY'
import json, sys, datetime
t, s, d, stab, port = sys.argv[1:]
e = {"entity_id": stab, "entity_type": "heating-rod", "label": "Heizstab",
     "capabilities": {"measure": [], "actuate": [{"command": "setpoint_kw"}]},
     "guards": {"limits": {"max_consumption_kw": 4.5, "min_on_seconds": 300, "min_off_seconds": 300},
                "failsafe": {"behavior": "off"}},
     "driver": {"brand": "shelly", "communication": "shelly_http",
                "connection": {"ip": "127.0.0.1", "port": int(port), "channels": [0, 1, 2],
                               "output_kw": [1.5, 1.5, 1.5], "stages": [1, 2, 3]}}}
print(json.dumps({"schema_version": "1.0", "tenant_id": t, "site_id": s, "device_id": d, "revision": "probe-1",
                  "published_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
                  .replace("+00:00", "Z"), "entities": [e]}))
PY
"$WORK/vp-mqtt-pub" -broker "$BUS" -topic "$T_BASE/v2/entities" -retain -file "$WORK/registry.json" >/dev/null \
  || fail "Registry-Push nicht veroeffentlicht"

# Die Messung: ein Hörer auf dem Herzschlag, der Umschlag der API, die Zeit bis zur Antwort.
python3 - "$BUS_PORT" "$T_BASE" "$STAB" "$GRENZE_MS" "$WORK/messung.json" <<'PY' || fail "Messung gescheitert (siehe oben)"
import json, sys, time, uuid, datetime, threading
import paho.mqtt.client as mqtt

port, base, stab, grenze, ziel = int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
lock = threading.Lock()
herzschlaege = []  # (monotone Zeit, Eintrag des Heizstabs)

def on_message(_c, _u, msg):
    try:
        e = json.loads(msg.payload).get("consumers", {}).get(stab)
    except Exception:
        return
    if e is not None:
        with lock:
            herzschlaege.append((time.monotonic(), e))

c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="schalten-zeit-hoerer")
c.on_connect = lambda cl, *_: cl.subscribe(base + "/status", 1)
c.on_message = on_message
c.connect("127.0.0.1", port)
c.loop_start()

def warte(sekunden, was, ok):
    ende = time.monotonic() + sekunden
    while time.monotonic() < ende:
        with lock:
            for t, e in herzschlaege:
                if ok(e):
                    return t, e
        time.sleep(0.02)
    print(f"FEHLER: Zeitüberschreitung ({sekunden} s): {was}")
    with lock:
        print("    letzter Eintrag:", json.dumps(herzschlaege[-1][1] if herzschlaege else None)[:600])
    sys.exit(1)

warte(60, "der erste Herzschlag mit dem Heizstab und seiner Rücklesung",
      lambda e: (e.get("stage") or {}).get("confirmed") is not None)

def klick(command, art):
    spur = str(uuid.uuid4())
    rid = f"override:{stab}:{spur}"
    env = {"schema_version": "1.0", "entity_id": stab, "request_id": rid, "source": {"kind": "local-ui"},
           "priority": "flow", "override": True, "ttl_s": 7200,
           "issued_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
           "command": command}
    with lock:
        herzschlaege.clear()
    t0 = time.monotonic()
    c.publish(base + "/v2/desired", json.dumps(env), qos=1, retain=False).wait_for_publish()
    return t0, rid

ergebnisse = {}
def bericht(name, t0, rid, treffer):
    t, e = treffer
    ms = round((t - t0) * 1000)
    trace = e.get("trace") if (e.get("trace") or {}).get("request_id") == rid else None
    ergebnisse[name] = {"ms": ms, "state": e.get("state"), "reason_code": e.get("reason_code"),
                        "outputs_on": (e.get("stage") or {}).get("outputs_on"), "trace": trace}
    spur = "eigene Zeitpunkte: " + json.dumps(trace) if trace else "keine eigenen Zeitpunkte (Box ohne Schaltspur)"
    print(f"    {name}: {ms} ms bis zum Herzschlag ({e.get('state')}, {e.get('reason_code') or 'ohne Grund'}, "
          f"Ausgänge {(e.get('stage') or {}).get('outputs_on')}); {spur}")

# Z1: "L1 an" - die Phasen-Wahl des Portals (eine Box mit heizstab_phasen schaltet genau Kanal 0).
t0, rid = klick({"type": "setpoint_kw", "value": 1.5, "outputs": [0]}, "start")
bericht("Z1 L1 an", t0, rid, warte(40, "L1 an, von Hand",
        lambda e: e.get("state") == "running_manual" and (e.get("stage") or {}).get("outputs_on") == [0]))

# Z2: sofort "Aus" - die Mindestlaufzeit (300 s) hält L1; die ehrliche Antwort ist "gehalten".
t0, rid = klick({"type": "setpoint_kw", "value": 0}, "stop")
bericht("Z2 Aus (gehalten)", t0, rid, warte(40, "der Herzschlag nennt die Mindestlaufzeit",
        lambda e: e.get("reason_code") == "guard_min_on"))

json.dump(ergebnisse, open(ziel, "w"), indent=2)
zu_lang = {k: v["ms"] for k, v in ergebnisse.items() if v["ms"] > grenze}
if zu_lang:
    print(f"FEHLER: länger als {grenze} ms: {zu_lang}")
    sys.exit(1)
PY
pass "beide Antworten binnen ${GRENZE_MS} ms im Herzschlag"
if [ -n "${SCHALTEN_MESSUNG:-}" ]; then cp "$WORK/messung.json" "$SCHALTEN_MESSUNG"; fi
echo "--- Probe bestanden"

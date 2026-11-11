#!/usr/bin/env bash
# „Günstig" OHNE Ladeziel an einer OCPP-Säule - der Fehler aus dem Bericht
# `vp-wallbox-modi-konzept` §3.4, so nah am Kunden nachgestellt, wie es ohne
# echte Säule geht.
#
# Gefahren wird die GANZE Kette ab der Policy: das Dokument, das die API für
# „Günstig" schreibt, geht durch den ECHTEN Optimierer (`compile_consumer` ->
# `co_optimize` -> `build_plan_v2_payload`, Helfer `guenstig-plan.py`), der
# fertige v2-Plan über einen echten MQTT-Downlink in den ECHTEN Kern
# (`vp-edge-core`), und der Kern verteilt an eine ECHTE OCPP-Säule
# (`vp-ocpp-sim`) über echte Websockets. Gemessen wird, was die Säule ZIEHEN
# WÜRDE - abgeleitet aus dem Ladeprofil, das der Kern ihr installiert hat.
#
# Die Zusage des Portals: „Lädt, solange der Preis unter der Grenze liegt."
#
#   G1  der Bezugspreis liegt JETZT über der Grenze -> die Säule lädt nicht
#       (Grund „plan"), obwohl ein Wagen steckt
#   G2  der Bezugspreis liegt JETZT unter der Grenze -> sie lädt voll
#   G3  es gibt KEINEN frischen Plan (Wolke weg, Preise fehlen) -> kein
#       Netzstrom zu einem unbekannten Preis: die Säule fährt ihre Bahn
#       („nur_sonne"), und ohne Sonnenüberschuss lädt sie nicht
#
# Die Bahn, die die API für „Günstig" an die Säule schreibt, steht in
# GUENSTIG_BAHN (SteuerartProjektion.bahnAus; SteuerartApiTest pinnt sie).
# Ohne Docker, wie `e2e-ocpp.sh`; der Optimierer braucht sein Paket samt
# Solver (`pip install -e 'services/optimization[solver]'`), OPT_PYTHON nennt
# den Interpreter.
#
#   edge-app/test/e2e-guenstig.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
OPT_PYTHON="${OPT_PYTHON:-$REPO/services/optimization/.venv/bin/python}"
GUENSTIG_BAHN="${GUENSTIG_BAHN:-nur_sonne}"

WORK="$(mktemp -d)"
CORE_PID=""
SIM_PID=""

# Hohe, unwahrscheinliche Ports, getrennt von denen in e2e-ocpp.sh.
WEB_PORT=28685
BUS_PORT=28686
OCPP_PORT=28687
G1_STATUS=127.0.0.1:28691
BOX="http://127.0.0.1:${WEB_PORT}"

cleanup() {
  echo "--- cleanup"
  [ -n "$SIM_PID" ] && kill "$SIM_PID" 2>/dev/null || true
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  PASS  $*"; }

nearly() {
  awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN{d=a-b; if(d<0)d=-d; exit (d<=t)?0:1}'
}

waitfor() { # waitfor <sekunden> <beschreibung> <kommando...>
  local secs="$1" what="$2"; shift 2
  local deadline=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  fail "timeout ($secs s) beim Warten auf: $what"
}

# haelt <warte-s> <halte-s> <beschreibung> <kommando...> - der Zustand muss
# eintreten UND halten (ein Regelkreis trifft den Wert sonst im Vorbeigehen).
haelt() {
  local secs="$1" hold="$2" what="$3"; shift 3
  local deadline=$(( $(date +%s) + secs )) seen=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then seen=1; break; fi
    sleep 0.3
  done
  [ "$seen" -eq 1 ] || { echo "  timeout ($secs s) beim Warten auf: $what" >&2; return 1; }
  deadline=$(( $(date +%s) + hold ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    "$@" >/dev/null 2>&1 || { echo "  der Zustand haelt nicht ($hold s): $what" >&2; return 1; }
    sleep 0.5
  done
}

g1_kw() {
  curl -sf "http://${G1_STATUS}/status" |
    tr '{' '\n' | sed -n 's/.*"id":1,"draw_kw":\([-0-9.e]*\).*/\1/p' | head -1
}
box_json() { curl -sf "${BOX}/api/ocpp" | sed -e 's/.*"ocpp":{//' -e 's/,"settings":{.*//'; }
g1_reason() { box_json | sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' | head -1; }
g1_paused() { awk -v d="$(g1_kw)" 'BEGIN{exit (d<1)?0:1}'; }
g1_full() { nearly "$(g1_kw)" 11 0.6; }
lage() { echo "    Säule zieht $(g1_kw) kW, Grund „$(g1_reason)\""; }

echo "=== „Günstig\" ohne Ziel - Rig (Bahn der API: ${GUENSTIG_BAHN}) ==="
[ -x "$OPT_PYTHON" ] || fail "kein Optimierer-Python unter $OPT_PYTHON (OPT_PYTHON setzen)"
"$OPT_PYTHON" -c 'import highspy, voltpilot_optimization' \
  || fail "dem Optimierer-Python fehlt das Paket oder der Solver"

echo "--- bauen"
( cd core && go build -o "$WORK/vp-edge-core" ./cmd/vp-edge-core )
( cd core && go build -o "$WORK/vp-ocpp-sim" ./cmd/vp-ocpp-sim )
( cd core && go build -o "$WORK/vp-mqtt-pub" ./cmd/vp-mqtt-pub )

T_TEN=00000000-0000-0000-0000-000000000001
T_SITE=00000000-0000-0000-0000-000000000002
T_DEV=00000000-0000-0000-0000-000000000003
T_BASE="ems/${T_TEN}/${T_SITE}/${T_DEV}"
ENT_ID=11111111-2222-3333-4444-555555555555

echo "--- Kern starten (die Wolke ist der eigene lokale Bus)"
mkdir -p "$WORK/data"
VP_DATA_DIR="$WORK/data" \
VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" \
VP_OCPP_ENABLED=true VP_OCPP_PORT="${OCPP_PORT}" \
VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
VP_DEV_TENANT_ID="$T_TEN" VP_DEV_SITE_ID="$T_SITE" VP_DEV_DEVICE_ID="$T_DEV" \
VP_DEV_CLOUD_URL="tcp://127.0.0.1:${BUS_PORT}" \
  "$WORK/vp-edge-core" >"$WORK/core.log" 2>&1 &
CORE_PID=$!
waitfor 30 "der Kern antwortet" curl -sf "${BOX}/health"

pub() { # pub <topic> <datei>  - retained, wie die Wolke
  "$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT}" -topic "$1" -retain -file "$2" \
    || fail "$1 liess sich nicht veroeffentlichen"
}

curl -sf -X POST "${BOX}/api/ocpp/settings" -H 'Content-Type: application/json' \
  -d '{"grid_limit_kw":277,"house_reserve_kw":0,"margin_pct":10,"min_power_kw":4,"max_house_load_kw":180}' \
  >/dev/null || fail "Einstellungen abgelehnt"
curl -sf -X POST "${BOX}/api/ocpp/chargers" -H 'Content-Type: application/json' \
  -d '{"id":"SAEULE-G1","connectors":1,"rated_kw":11}' >/dev/null \
  || fail "SAEULE-G1 liess sich nicht eintragen"
"$WORK/vp-ocpp-sim" --csms "ws://127.0.0.1:${OCPP_PORT}/ocpp" --id SAEULE-G1 \
  --connectors 1 --status "$G1_STATUS" >"$WORK/g1.log" 2>&1 &
SIM_PID=$!
waitfor 30 "die Säule ist verbunden" curl -sf "http://${G1_STATUS}/status"
curl -sf -X POST "http://${G1_STATUS}/plug?connector=1&demand=11&min=4" >/dev/null \
  || fail "Wagen liess sich nicht einstecken"
waitfor 60 "der Wagen lädt (noch keine Steuerart)" g1_full

echo "--- die Wolke: Komponente + Steuerart „Günstig\" (Bahn ${GUENSTIG_BAHN})"
cat >"$WORK/registry.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "revision":"rig-guenstig","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[{"entity_id":"${ENT_ID}","entity_type":"ev-charger","label":"Stellplatz 1",
   "charge_point_id":"SAEULE-G1",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],
     "actuate":[{"command":"limit_kw","min":0,"max":11}]},
   "guards":{"limits":{"max_consumption_kw":11},"failsafe":{"behavior":"release"}}}]}
JSON
pub "${T_BASE}/v2/entities" "$WORK/registry.json"
waitfor 30 "die Box kennt die Ladepunkt-Komponente" sh -c "curl -sf '${BOX}/api/state' | grep -q '${ENT_ID}'"

cat >"$WORK/cfg.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","grid_limit_kw":277,
 "charge_points":[{"id":"SAEULE-G1","rated_kw":11,"connectors":1,"source":"${GUENSTIG_BAHN}"}]}
JSON
pub "${T_BASE}/v2/charging-config" "$WORK/cfg.json"

plan() { # plan <teuer|billig> - der echte Optimierer rechnet, die Wolke schickt
  "$OPT_PYTHON" test/guenstig-plan.py --jetzt "$1" --tenant "$T_TEN" --site "$T_SITE" \
    --device "$T_DEV" --entity "$ENT_ID" --out "$WORK/plan.json" \
    || fail "der Optimierer hat keinen Plan gerechnet"
  pub "${T_BASE}/v2/plan" "$WORK/plan.json"
}

# --- G1: teuer -----------------------------------------------------------
echo "--- G1: der Bezugspreis liegt jetzt ÜBER der Grenze"
plan teuer
haelt 60 10 "die Säule wartet auf den günstigen Preis" g1_paused || { lage; fail "G1: lädt zum teuren Preis"; }
[ "$(g1_reason)" = "plan" ] || { lage; fail "G1: die Pause nennt nicht den Plan"; }
pass "G1: teuer - die Säule lädt nicht ($(g1_kw) kW, Grund „$(g1_reason)\")"

# --- G2: billig ----------------------------------------------------------
echo "--- G2: der Bezugspreis liegt jetzt UNTER der Grenze"
plan billig
haelt 60 10 "die Säule lädt im günstigen Fenster voll" g1_full || { lage; fail "G2: lädt im günstigen Fenster nicht"; }
pass "G2: billig - die Säule lädt $(g1_kw) kW"

# --- G3: kein Plan -------------------------------------------------------
# Der retained Plan wird zurückgenommen - für die Box dasselbe wie ein
# Plan, der veraltet (plan2.StaleAfter): der Wunsch des Plans fällt weg.
echo "--- G3: kein frischer Plan (Wolke weg, keine Preise)"
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT}" -topic "${T_BASE}/v2/plan" \
  -retain -payload '' || fail "G3: Plan liess sich nicht zuruecknehmen"
haelt 60 10 "ohne Preisfenster kein Netzstrom" g1_paused || { lage; fail "G3: lädt ohne Preisfenster mit Netzstrom"; }
pass "G3: kein Plan - die Säule fährt ihre Bahn und lädt ohne Sonne nicht ($(g1_kw) kW, Grund „$(g1_reason)\")"

echo "=== alle Fälle bestanden ==="

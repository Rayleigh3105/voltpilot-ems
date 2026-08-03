#!/usr/bin/env bash
# Gemeinsame Bausteine der OTA-Fehlerinjektions-Matrix (OTA Stufe 3).
#
# Diese Datei wird von run.sh gesourct und ist nicht eigenstaendig lauffaehig.
# shellcheck shell=bash

set -euo pipefail

# --- Rahmen ---------------------------------------------------------------
# Ein EIGENES Compose-Projekt, eigene hohe Ports, eigene Volumes: die Matrix
# darf niemals einen echten Edge-Stack anfassen. Zusammen mit der Regel „immer
# nur EIN Stapel gleichzeitig" (run.sh raeumt nach JEDEM Fall ab) bleibt der
# Rechner benutzbar.
PROJECT="vp-ota-soak"
REG_PORT="${VP_SOAK_REG_PORT:-5999}"
REG="127.0.0.1:${REG_PORT}"

SOAK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EDGE_DIR="$(cd "${SOAK_DIR}/../.." && pwd -P)"
CORE_DIR="${EDGE_DIR}/core"
WORK="${SOAK_DIR}/.work"
DATA="${WORK}/data"
DEPLOY="${WORK}/deploy"
KEYS="${WORK}/keys"
OUT="${WORK}/out"

C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_0=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s>> %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '   %sPASS%s  %s\n' "$C_G" "$C_0" "$*"; }
# shellcheck disable=SC2034  # von run.sh je Fall ausgewertet
bad()  { printf '   %sFAIL%s  %s\n' "$C_R" "$C_0" "$*" >&2; SCENARIO_FAILED=1; }
note() { printf '   ....  %s\n' "$*"; }
warn() { printf '   %s!%s     %s\n' "$C_Y" "$C_0" "$*"; }

dc() { docker compose -p "$PROJECT" --project-directory "$DEPLOY" -f "${DEPLOY}/docker-compose.yml" "$@"; }

# --- Aufbau ---------------------------------------------------------------

require_docker() {
  command -v docker >/dev/null 2>&1 || { say "docker fehlt - die Matrix braucht ihn."; exit 2; }
  docker info >/dev/null 2>&1 || { say "der docker-Daemon antwortet nicht."; exit 2; }
  docker compose version >/dev/null 2>&1 || { say "docker compose v2 fehlt."; exit 2; }
}

# check_disk warnt frueh: die Matrix zieht Images und legt Archive an.
check_disk() {
  local avail
  avail="$(df -Pk "$SOAK_DIR" | awk 'NR==2 {print $4}')"
  if [ "${avail:-0}" -lt 2097152 ]; then
    say "Weniger als 2 GiB frei - die Matrix wird nicht gestartet."
    exit 2
  fi
  note "$(df -h "$SOAK_DIR" | awk 'NR==2 {print $4" frei auf "$6}')"
}

# ceremony erzeugt die WEGWERF-Signaturkette dieser Matrix.
#
# Sie ist die ECHTE Zeremonie (docs/ota-signing.md), nur mit einer Wurzel, die
# nach dem Lauf weggeworfen wird. Nichts davon gehoert je in ein ausgeliefertes
# Image.
ceremony() {
  mkdir -p "$KEYS" "$OUT"
  "${OUT}/vp-ota" keygen --role root --id root-soak --out "$KEYS" >/dev/null
  "${OUT}/vp-ota" keygen --role release --id rel-soak --out "$KEYS" >/dev/null
  "${OUT}/vp-ota" trust-set --key "${KEYS}/rel-soak.pub" --out "${OUT}/trust-set.json" >/dev/null
  "${OUT}/vp-ota" sign --domain trust-set --in "${OUT}/trust-set.json" \
    --key "${KEYS}/root-soak.key" --out "${OUT}/trust-set.json.sig" >/dev/null
}

# build_updater backt die Wegwerf-Wurzel in ein Sidecar-Image.
#
# **Das ist bewusst der einzige Weg.** Der Sidecar hat KEINEN Umgebungs- oder
# Pfad-Schalter fuer den Vertrauensanker - genau die Uebernahme, gegen die die
# kalt/heiss-Trennung gebaut ist. Der Anker wird eingebacken, also backt die
# Matrix ihn ebenso ein. Damit prueft sie nebenbei den Weg, den die echte
# Zeremonie spaeter geht, und das ausgelieferte Image bleibt fail-closed.
build_updater() {
  local src="${WORK}/updater-src"
  rm -rf "$src"; mkdir -p "$src"
  # cp -R statt eines Volume-Mounts: der Bau darf den Arbeitsbaum nicht anfassen.
  cp -R "${CORE_DIR}/go.mod" "${CORE_DIR}/go.sum" "${CORE_DIR}/cmd" "${CORE_DIR}/internal" \
        "${CORE_DIR}/Dockerfile.updater" "$src/"
  local pub
  pub="$(sed -n 's/.*"public_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${KEYS}/root-soak.pub")"
  [ -n "$pub" ] || { bad "der oeffentliche Wurzel-Schluessel ist nicht lesbar"; return 1; }
  cat > "${src}/internal/otaverify/rootkeys.json" <<EOF
{
  "schema_version": "1.0",
  "keys": [
    { "key_id": "root-soak", "alg": "ed25519", "public_key": "${pub}" }
  ]
}
EOF
  docker build -q -f "${src}/Dockerfile.updater" -t "${PROJECT}-updater:soak" "$src" >/dev/null
}

# build_components baut die STELLVERTRETER fuer core und nodered.
#
# Absichtlich winzig: geprueft wird die ORCHESTRIERUNG (holen, pinnen, tauschen,
# zuruecknehmen), nicht das Verhalten der echten Edge-Software. Ein halbes
# Gigabyte Node-RED je Fall waere reine Wartezeit - und die echten Images
# tragen ohnehin keine der hier injizierten Fehler.
build_components() {
  local v="$1"
  local dir="${WORK}/comp-${v}"
  rm -rf "$dir"; mkdir -p "$dir"
  cat > "${dir}/Dockerfile" <<EOF
FROM alpine:3.20
LABEL vp-soak=1
RUN echo "${v}" > /vp-version
CMD ["sh","-c","while :; do sleep 3600; done"]
EOF
  local ref
  for comp in core nodered; do
    ref="${REG}/soak/${comp}:${v}"
    docker build -q -t "$ref" "$dir" >/dev/null
  done
  push_components "$v"
}

# push_components legt die Stellvertreter (erneut) in die Registry.
#
# Noetig VOR JEDEM Fall: die Registry gehoert zum Wegwerf-Stapel und wird beim
# Abraeumen mitsamt ihren Daten entfernt - genau so, wie der Rechner nach der
# Matrix nichts von ihr behalten soll. Ein erneuter Push derselben lokalen
# Images ergibt DENSELBEN Digest, die einmal ermittelten Referenzen bleiben
# also gueltig.
push_components() {
  local v="$1" comp
  for comp in core nodered; do
    docker push -q "${REG}/soak/${comp}:${v}" >/dev/null
  done
}

digest_of() { # digest_of <component> <version> -> repo@sha256:...
  local ref="${REG}/soak/$1:$2" d
  d="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>/dev/null || true)"
  if ! printf '%s' "$d" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    d="sha256:$(docker buildx imagetools inspect --raw "$ref" | shasum -a 256 | cut -d' ' -f1)"
  fi
  printf '%s/soak/%s@%s' "$REG" "$1" "$d"
}

write_compose() {
  mkdir -p "$DEPLOY" "$DATA"
  cat > "${DEPLOY}/docker-compose.yml" <<EOF
name: ${PROJECT}

services:
  registry:
    image: registry:2
    restart: unless-stopped
    ports: ["127.0.0.1:${REG_PORT}:5000"]

  core:
    image: \${VP_EDGE_CORE_IMAGE}
    pull_policy: never
    restart: unless-stopped

  nodered:
    image: \${VP_EDGE_NODERED_IMAGE}
    pull_policy: never
    restart: unless-stopped

  updater:
    image: ${PROJECT}-updater:soak
    pull_policy: never
    restart: unless-stopped
    network_mode: none
    environment:
      VP_OTA_AUTONOMOUS: \${VP_OTA_AUTONOMOUS:-true}
      VP_OTA_NEUTRAL_VERIFIED: \${VP_OTA_NEUTRAL_VERIFIED:-}
      VP_OTA_TICK_SECONDS: \${VP_OTA_TICK_SECONDS:-2}
      VP_OTA_WATCHDOG_SECONDS: \${VP_OTA_WATCHDOG_SECONDS:-120}
      VP_OTA_DISK_GUARD_MB: \${VP_OTA_DISK_GUARD_MB:-1}
      VP_OTA_ACK_WAIT_SECONDS: \${VP_OTA_ACK_WAIT_SECONDS:-5}
      VP_OTA_HEALTH_WAIT_SECONDS: \${VP_OTA_HEALTH_WAIT_SECONDS:-60}
      VP_OTA_CMD_TIMEOUT_SECONDS: \${VP_OTA_CMD_TIMEOUT_SECONDS:-120}
    volumes:
      - ${DATA}:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DEPLOY}:/deploy
EOF
}

set_env() { # set_env KEY VALUE
  mkdir -p "$DEPLOY"
  local f="${DEPLOY}/.env" tmp
  tmp="$(mktemp)"
  [ -f "$f" ] && grep -v "^$1=" "$f" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$f"
}

# --- Die Rolle des KERNS ---------------------------------------------------
# Der Kern ist hier bewusst ein Stellvertreter: unter Test steht der SIDECAR.
# Die Kern-Haelfte (Zustandskanal, durabler Bericht, Selbsttest) ist in Go
# unit-getestet (internal/agent/ota_autonomy_test.go).

core_signal() { # core_signal [feld=wert ...]
  local control=false dispatching=false neutral="" ack_token="" acked="" ackfailed=false
  local version="${SOAK_RUNNING_VERSION:-edge-2026.07.2-aaaaaaaaaaaa}"
  for kv in "$@"; do
    case "$kv" in
      control=*) control="${kv#*=}" ;;
      dispatching=*) dispatching="${kv#*=}" ;;
      neutral=*) neutral="${kv#*=}" ;;
      version=*) version="${kv#*=}" ;;
      ackfailed=*) ackfailed="${kv#*=}" ;;
    esac
  done
  # Den Ack-Token uebernehmen, wenn der Sidecar einen anfordert - das ist die
  # Rolle, die sonst der Kern spielt (durabler `applying`-Bericht).
  if [ -f "${DATA}/ota/updater-state.json" ]; then
    ack_token="$(json_field "${DATA}/ota/updater-state.json" ack_token)"
  fi
  if [ -n "$ack_token" ]; then
    if [ "$ackfailed" = "true" ]; then acked=""; else acked="$(now_iso)"; fi
  fi
  mkdir -p "${DATA}/ota"
  cat > "${DATA}/ota/core-signal.json.tmp" <<EOF
{
  "updated_at": "$(now_iso)",
  "version": "${version}",
  "healthy": true,
  "cloud_connected": true,
  "control_active": ${control},
  "inverter_family": "hybrid_3p",
  "dispatching": ${dispatching},
  "neutral_held_since": "${neutral}",
  "ack_token": "${ack_token}",
  "applying_acked_at": "${acked}",
  "ack_failed": ${ackfailed}
}
EOF
  mv "${DATA}/ota/core-signal.json.tmp" "${DATA}/ota/core-signal.json"
}

# core_selftest schreibt das Urteil, das sonst der NEUE Kern schreibt.
core_selftest() { # core_selftest true|false [grund]
  local token
  token="$(json_field "${DATA}/ota/pending-confirm.json" token)"
  [ -n "$token" ] || return 1
  cat > "${DATA}/ota/self-test.json.tmp" <<EOF
{ "token": "${token}", "passed": $1, "reason": "${2:-}" }
EOF
  mv "${DATA}/ota/self-test.json.tmp" "${DATA}/ota/self-test.json"
}

# SIGNAL_ARGS sind die Felder, mit denen der Kern-Stellvertreter waehrend
# des laufenden Falles meldet (z. B. control=true, ackfailed=true).
#
# Es gibt BEWUSST keinen Hintergrundprozess: er verwaiste bei einem
# Fehlschlag, hielt die Ausgabe-Pipe offen und war der einzige
# nicht-deterministische Teil der Matrix. Stattdessen frischt JEDER
# Warteschritt den Zustand selbst auf - genau so oft, wie der Sidecar ihn
# liest, und keinen Takt oefter.
SIGNAL_ARGS=""
set_signal() { SIGNAL_ARGS="$*"; core_signal_now; }
# shellcheck disable=SC2086  # bewusst ungequotet: leer = keine Argumente
core_signal_now() {
  # __frozen__ ist die Uhr-Sprung-Injektion: der Kern meldet sich ab jetzt
  # NICHT mehr, und genau das muss den Tausch verhindern.
  [ "$SIGNAL_ARGS" = "__frozen__" ] && return 0
  core_signal $SIGNAL_ARGS
}

# settle laesst Zeit vergehen und haelt den Kern-Zustand dabei frisch.
settle() {
  local i=0
  while [ "$i" -lt "$1" ]; do core_signal_now; sleep 1; i=$((i+1)); done
}

# --- Das Release -----------------------------------------------------------

assign() { # assign <release> <seq> <core-digest> <nodered-digest> [--urgent]
  local rel="$1" seq="$2"
  local cd="$3" nd="$4"
  shift 4
  # KEIN Array fuer das optionale Flag: bash 3.2 (die Vorgabe auf macOS)
  # bricht unter `set -u` beim Expandieren eines LEEREN Arrays ab.
  local urgent=""
  [ "${1:-}" = "--urgent" ] && urgent="--urgent"
  # shellcheck disable=SC2086  # bewusst ungequotet: leer = kein Argument
  "${OUT}/vp-ota" manifest --release "$rel" --seq "$seq" --commit 3bf8c038a1b2 \
    --artifact "core=${cd}" --artifact "nodered=${nd}" \
    --state-schema 3 --key-id rel-soak $urgent \
    --out "${OUT}/release.json" >/dev/null
  "${OUT}/vp-ota" sign --domain release --in "${OUT}/release.json" \
    --key "${KEYS}/rel-soak.key" --out "${OUT}/release.json.sig" >/dev/null

  mkdir -p "${DATA}/ota"
  cp "${OUT}/trust-set.json" "${OUT}/trust-set.json.sig" "${DATA}/ota/"
  python3 - "$rel" "$seq" "${OUT}/release.json" "${OUT}/release.json.sig" \
           "${DATA}/ota/target.json" <<'PY'
import base64, json, sys
rel, seq, mpath, spath, out = sys.argv[1:6]
env = {
  "schema_version": "1.0", "type": "update_target",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "site_id": "00000000-0000-0000-0000-000000000002",
  "device_id": "00000000-0000-0000-0000-000000000003",
  "release": rel, "release_seq": int(seq), "channel": "canary",
  "manifest_b64": base64.b64encode(open(mpath, "rb").read()).decode(),
  "signature_b64": base64.b64encode(open(spath, "rb").read()).decode(),
}
open(out + ".tmp", "w").write(json.dumps(env))
import os; os.replace(out + ".tmp", out)
PY
}

clear_assignment() { rm -f "${DATA}/ota/target.json"; }

# --- Beobachtung + Zusicherungen ------------------------------------------

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000000000Z; }

json_field() { # json_field <datei> <feld>
  [ -f "$1" ] || return 0
  python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2], '') or '')
except Exception: pass" "$1" "$2"
}

updater_state() { json_field "${DATA}/ota/updater-state.json" state; }
updater_reason() { json_field "${DATA}/ota/updater-state.json" reason; }

running_version() { # welche Stand-in-Fassung laeuft?
  local cid
  cid="$(dc ps -q "$1" 2>/dev/null | head -n1 || true)"
  [ -n "$cid" ] || { printf 'KEINER'; return; }
  docker exec "$cid" cat /vp-version 2>/dev/null | tr -d '\n' || printf 'UNLESBAR'
}

# wait_for_state wartet auf EINEN Zustand - und haelt fest, was im Moment des
# Treffers dort stand.
#
# Das Festhalten ist tragend, nicht Bequemlichkeit: mehrere Zustaende sind
# ABSICHTLICH fluechtig. Ein gescheiterter Pull meldet `deferred` und faengt
# zwei Sekunden spaeter von vorn an; eine Ruecknahme meldet ihren Grund und
# wird beim naechsten Takt vom Halt „wurde bereits zurueckgenommen" abgeloest.
# Ein zweites Lesen der Datei traefe dann etwas anderes an - und der Test
# prueft nicht, was er zu pruefen glaubt.
SEEN_STATE=""
SEEN_REASON=""
wait_for_state() { # wait_for_state <state> <sekunden>
  local want="$1" secs="$2" i=0
  SEEN_STATE=""; SEEN_REASON=""
  while [ "$i" -lt "$secs" ]; do
    core_signal_now
    if [ "$(updater_state)" = "$want" ]; then
      SEEN_STATE="$want"
      SEEN_REASON="$(updater_reason)"
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  return 1
}

wait_for_pending() { # wartet auf eine Brotkrume in der genannten Phase
  local want="$1" secs="$2" i=0
  while [ "$i" -lt "$secs" ]; do
    core_signal_now
    [ "$(json_field "${DATA}/ota/pending-confirm.json" phase)" = "$want" ] && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

# DIE Zusicherung der ganzen Matrix, an jedem Ausgang jedes Falles:
# **entweder der alte Stapel laeuft, oder der neue ist bestaetigt - nie eine
# tote Box.**
assert_alive() { # assert_alive <erwartete-fassung: v1|v2|beliebig>
  local want="${1:-beliebig}" c n
  c="$(running_version core)"; n="$(running_version nodered)"
  if [ "$c" = "KEINER" ] || [ "$n" = "KEINER" ]; then
    bad "TOTE BOX: core=${c} nodered=${n}"
    return 1
  fi
  case "$want" in
    beliebig) ok "die Box lebt (core=${c}, nodered=${n})" ;;
    *)
      if [ "$c" = "$want" ] && [ "$n" = "$want" ]; then
        ok "die Box lebt auf dem erwarteten Stand (${want})"
      else
        bad "erwartet ${want}, laeuft core=${c} nodered=${n}"
      fi ;;
  esac
}

assert_state() { # assert_state <state> [beschreibung]
  # Was ein wait_for_state gesehen hat, gilt - siehe dort.
  local got; got="${SEEN_STATE:-$(updater_state)}"
  if [ "$got" = "$1" ]; then
    ok "${2:-Zustand} = ${1}"
  else
    bad "${2:-Zustand}: erwartet ${1}, ist '${got}' (Grund: $(updater_reason))"
  fi
}

# assert_log_mentions prueft das LOG des Sidecars statt der Zustandsdatei.
#
# Noetig fuer alles, was ABSICHTLICH fluechtig ist: nach einer Ruecknahme steht
# nur Millisekunden spaeter schon der Halt „wurde bereits zurueckgenommen" in
# der Datei (beide melden `rolled_back`, mit verschiedenen Gruenden). Das Log
# ist der durable Beleg.
assert_log_mentions() {
  if dc logs --no-color updater 2>&1 | grep -qF -- "$1"; then
    ok "das Log belegt '${1}'"
  else
    bad "das Log belegt '${1}' nicht"
  fi
}

# assert_state_in prueft, dass der Zustand in einer MENGE liegt.
#
# Fuer Faelle, in denen der genaue Zustand vom Abtast-Zeitpunkt abhaengt, die
# SICHERHEITS-Aussage aber eindeutig ist: ein haengender Pull wechselt zwischen
# „laedt" und „verschoben" - entscheidend ist, dass er NIE bei „wendet an"
# ankommt.
assert_state_in() { # assert_state_in <beschreibung> <state> [state ...]
  local desc="$1"; shift
  local got; got="$(updater_state)"
  local want
  for want in "$@"; do
    if [ "$got" = "$want" ]; then
      ok "${desc}: ${got}"
      return 0
    fi
  done
  bad "${desc}: '${got}' liegt nicht in [$*] (Grund: $(updater_reason))"
}

assert_reason_mentions() {
  local got; got="${SEEN_REASON:-$(updater_reason)}"
  case "$got" in
    *"$1"*) ok "der Grund benennt '${1}'" ;;
    *) bad "der Grund nennt '${1}' nicht: '${got}'" ;;
  esac
}

# --- Auf- und Abbau --------------------------------------------------------

stack_up() {
  dc up -d --remove-orphans >/dev/null 2>&1
  # Auf die Registry warten, sonst scheitert der erste Push/Pull.
  local i=0
  while [ "$i" -lt 30 ]; do
    curl -fsS "http://${REG}/v2/" >/dev/null 2>&1 && return 0
    sleep 1; i=$((i+1))
  done
  return 0
}

# keep_evidence sichert bei einem Fehlschlag den Protokollstand UND das Log des
# Sidecars, BEVOR abgeraeumt wird. Ohne das ist ein Fehlschlag nicht
# nachvollziehbar - und genau diese Nachvollziehbarkeit braucht der Betreiber,
# wenn die Matrix spaeter auf echter Hardware laeuft.
keep_evidence() {
  local dest="${SOAK_DIR}/last-failure"
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "${DATA}/ota" "$dest/" 2>/dev/null || true
  dc logs --no-color --tail 200 updater > "${dest}/updater.log" 2>&1 || true
  cp "${DEPLOY}/.env" "${dest}/env" 2>/dev/null || true
  warn "Belege des Fehlschlags liegen unter ${dest}"
}

# stack_down raeumt ALLES ab: Container, Netz, Volumes, Arbeitsdateien.
# Wird nach JEDEM Fall aufgerufen - „immer nur EIN Stapel gleichzeitig".
stack_down() {
  SIGNAL_ARGS=""
  docker compose -p "$PROJECT" --project-directory "$DEPLOY" \
    -f "${DEPLOY}/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$(docker ps -aq --filter "name=vp-edge-lkg-" 2>/dev/null)" >/dev/null 2>&1 || true
  rm -rf "$DATA"
  rm -f "${DEPLOY}/.env"
}

# purge_all raeumt am Ende auch die Images der Matrix weg (nur die EIGENEN -
# ein `docker system prune -a` auf einem fremden Rechner waere unverzeihlich).
purge_all() {
  stack_down
  docker rm -f "$(docker ps -aq --filter "label=vp-soak=1" 2>/dev/null)" >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E "^(${REG}/soak/|${PROJECT}-updater)" \
    | xargs -r docker rmi -f >/dev/null 2>&1 || true
  docker images -q --filter "label=vp-soak=1" 2>/dev/null | xargs -r docker rmi -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
}

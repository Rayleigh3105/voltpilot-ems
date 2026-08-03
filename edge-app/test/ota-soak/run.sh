#!/usr/bin/env bash
# OTA Stufe 3 - die Fehlerinjektions-Matrix.
#
#   ./run.sh                 alle Faelle
#   ./run.sh happy prune     nur diese
#   ./run.sh --list          die Liste
#
# WAS HIER GEPRUEFT WIRD: der ECHTE `vp-edge-updater` gegen einen ECHTEN
# docker-Daemon, mit einer ECHTEN Signaturkette und einer ECHTEN
# Registry - nur die beiden getauschten Komponenten sind winzige
# Stellvertreter (geprueft wird die Orchestrierung, nicht Node-RED).
#
# DIE EINE ZUSICHERUNG, an jedem Ausgang jedes Falles:
#   **entweder der alte Stapel laeuft, oder der neue ist bestaetigt -
#     nie eine tote Box.**
#
# SICHERHEIT DES RECHNERS, an dem das laeuft:
#   * eigenes Compose-Projekt (vp-ota-soak), eigene hohe Ports, eigene Volumes;
#   * immer nur EIN Stapel gleichzeitig - nach JEDEM Fall wird abgeraeumt;
#   * es wird NIE ein `docker system prune` ausgefuehrt. Der prune-Fall raeumt
#     ausschliesslich die EIGENEN Images weg (das ist genau das, was prune -a
#     mit ihnen taete) und beweist die Ueberlebensregel zusaetzlich mit einem
#     LABEL-GEFILTERTEN echten `docker image prune -a`.
#
# Die Ausfuehrung auf echter Hardware (Pilsting) ist AUSDRUECKLICH nicht Teil
# dieses Skripts - Betreiber-Ablauf: docs/ota-autonomie.md.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

SCENARIOS=(autonomy_off happy selftest_fail prune registry_outage wedged_pull
           mid_flip_reboot clock_skew broker_outage disk_full)

usage() {
  cat <<EOF
OTA-Fehlerinjektions-Matrix (Stufe 3)

  ./run.sh [fall ...]      alle bzw. die genannten Faelle
  ./run.sh --list          die Liste der Faelle
  ./run.sh --keep          nach dem Lauf nicht aufraeumen (Diagnose)

Faelle: ${SCENARIOS[*]}
EOF
}

KEEP=0
WANTED=()
for a in "$@"; do
  case "$a" in
    --list) printf '%s\n' "${SCENARIOS[@]}"; exit 0 ;;
    --keep) KEEP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) WANTED+=("$a") ;;
  esac
done
[ ${#WANTED[@]} -eq 0 ] && WANTED=("${SCENARIOS[@]}")

# =========================================================================
# Vorbereitung - EINMAL fuer den ganzen Lauf.
# =========================================================================
prepare() {
  require_docker
  check_disk
  rm -rf "$WORK"; mkdir -p "$WORK" "$OUT" "$DEPLOY" "$DATA"

  step "Werkzeug + Wegwerf-Signaturkette"
  ( cd "$CORE_DIR" && go build -o "${OUT}/vp-ota" ./cmd/vp-ota )
  ceremony
  note "Wurzel + Release-Schluessel + root-signiertes Trust-Set erzeugt (Wegwerf)."

  step "Sidecar-Image mit der Wegwerf-Wurzel bauen"
  build_updater
  note "${PROJECT}-updater:soak"

  step "Registry + Stellvertreter-Images"
  write_compose
  set_env VP_EDGE_CORE_IMAGE "alpine:3.20"
  set_env VP_EDGE_NODERED_IMAGE "alpine:3.20"
  docker compose -p "$PROJECT" --project-directory "$DEPLOY" \
    -f "${DEPLOY}/docker-compose.yml" up -d registry >/dev/null 2>&1
  local i=0
  while [ "$i" -lt 30 ]; do
    curl -fsS "http://${REG}/v2/" >/dev/null 2>&1 && break
    sleep 1; i=$((i+1))
  done
  build_components v1
  build_components v2
  CORE_V1="$(digest_of core v1)"; NR_V1="$(digest_of nodered v1)"
  CORE_V2="$(digest_of core v2)"; NR_V2="$(digest_of nodered v2)"
  note "v1 core=${CORE_V1##*@}"
  note "v2 core=${CORE_V2##*@}"
  docker compose -p "$PROJECT" --project-directory "$DEPLOY" \
    -f "${DEPLOY}/docker-compose.yml" down >/dev/null 2>&1 || true
}

# start_on_v1 bringt den Ausgangszustand hoch: v1 laeuft, kein Ziel zugewiesen.
start_on_v1() {
  rm -rf "$DATA"; mkdir -p "${DATA}/ota"
  set_env VP_EDGE_CORE_IMAGE "$CORE_V1"
  set_env VP_EDGE_NODERED_IMAGE "$NR_V1"
  stack_up
  # Die Registry ist frisch (sie stirbt mit jedem Abraeumen) - die
  # Stellvertreter muessen wieder hinein, bevor der Sidecar sie holen kann.
  push_components v1
  push_components v2
  # Der Kern-Stellvertreter meldet ab jetzt seinen Zustand - aufgefrischt bei
  # jedem Warteschritt, nicht aus einem Hintergrundprozess.
  set_signal "$@"
  settle 2
}

# =========================================================================
# Die Faelle
# =========================================================================

# Der Ausgangsfall: OHNE Schalter passiert nichts. Er steht ganz vorn, weil
# er die Vorgabe der ganzen Stufe ist.
scenario_autonomy_off() {
  SEEN_STATE=""; SEEN_REASON=""
  set_env VP_OTA_AUTONOMOUS "false"
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  settle 8
  assert_state idle "ohne Schalter"
  if [ -f "${DATA}/ota/pending-confirm.json" ]; then
    bad "es ist ein Vorgang entstanden, obwohl die Autonomie aus ist"
  else
    ok "kein Vorgang entstanden"
  fi
  assert_alive v1
  set_env VP_OTA_AUTONOMOUS "true"
}

# Die Referenz: alles geht gut.
scenario_happy() {
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_pending self_test 90 || { bad "die Selbsttest-Phase wurde nicht erreicht ($(updater_state): $(updater_reason))"; assert_alive; return; }
  ok "beide Komponenten getauscht, der neue Stand prueft sich"
  SOAK_RUNNING_VERSION="edge-2026.08.0"
  core_selftest true
  wait_for_state succeeded 60 || bad "nicht bestaetigt ($(updater_state): $(updater_reason))"
  assert_state succeeded "nach bestandenem Selbsttest"
  assert_alive v2
  SOAK_RUNNING_VERSION=""
}

# Der wichtigste Fall ueberhaupt: ein kaputter neuer Stand kommt zurueck.
scenario_selftest_fail() {
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_pending self_test 90 || { bad "die Selbsttest-Phase wurde nicht erreicht"; assert_alive; return; }
  core_selftest false "Der Steuerpfad hat den Trockenlauf nicht bestanden"
  wait_for_state rolled_back 90 || bad "nicht zurueckgenommen ($(updater_state): $(updater_reason))"
  assert_state rolled_back "nach fehlgeschlagenem Selbsttest"
  assert_reason_mentions "Steuerpfad"
  assert_alive v1
}

# `docker system prune -a` mitten im Vorgang: das Rueckfall-Image ist weg -
# das ARCHIV traegt die Ruecknahme.
scenario_prune() {
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_pending self_test 90 || { bad "die Selbsttest-Phase wurde nicht erreicht"; assert_alive; return; }

  # 1. Die Ueberlebensregel real belegen - LABEL-gefiltert, damit auf diesem
  #    Rechner garantiert nichts Fremdes verschwindet.
  docker rm -f vp-soak-prune-probe >/dev/null 2>&1 || true
  docker build -q -t vp-soak-prune-probe:1 - >/dev/null <<'EOF'
FROM alpine:3.20
LABEL vp-soak-probe=1
EOF
  docker create --name vp-soak-prune-probe vp-soak-prune-probe:1 >/dev/null
  docker image prune -af --filter label=vp-soak-probe=1 >/dev/null 2>&1 || true
  if docker image inspect vp-soak-prune-probe:1 >/dev/null 2>&1; then
    ok "ECHTES 'docker image prune -a' verschont ein Image, auf das ein GESTOPPTER Container zeigt"
  else
    bad "die Ueberlebensregel des Rueckfall-Images gilt auf diesem Daemon NICHT"
  fi
  docker rm -f vp-soak-prune-probe >/dev/null 2>&1 || true
  docker rmi -f vp-soak-prune-probe:1 >/dev/null 2>&1 || true

  # 2. Jetzt der harte Fall: das Rueckfall-Image UND sein Halter sind weg
  #    (jemand hat mit Gewalt aufgeraeumt). Nur das Archiv bleibt.
  # NUR ueber NAMEN entfernen, nie ueber die Image-Kennung: dieselbe Kennung
  # traegt auch die `:v1`-Tags, die die uebrigen Faelle brauchen. Der Sidecar
  # kennt ohnehin nur diese beiden Referenzen - genau sie werden ihm genommen.
  docker rm -f vp-edge-lkg-core vp-edge-lkg-nodered >/dev/null 2>&1 || true
  docker rmi -f vp-edge-lkg-core:lkg vp-edge-lkg-nodered:lkg >/dev/null 2>&1 || true
  docker rmi -f "$CORE_V1" "$NR_V1" >/dev/null 2>&1 || true
  note "Rueckfall-Images, Halter-Container und Tags entfernt (was prune -a mit ihnen taete)"

  # Auch `rolled_back` ist fluechtig: der naechste Takt loest es durch den Halt
  # „wurde bereits zurueckgenommen" ab. wait_for_state haelt den Moment fest.
  core_selftest false "kaputt"
  wait_for_state rolled_back 120 || bad "nicht zurueckgenommen ($(updater_state): $(updater_reason))"
  assert_state rolled_back "nach dem Aufraeumen"
  # Der Grund der Ruecknahme ist fluechtig - Millisekunden spaeter steht dort
  # schon der Halt „wurde bereits zurueckgenommen" (beide melden
  # `rolled_back`). Belegt wird deshalb am Log.
  assert_log_mentions "Rueckfall aus dem lokalen Archiv"
  # Die Box laeuft wieder - jetzt unter dem lokalen Rueckfall-Tag, weil ein
  # Archiv keinen Registry-Digest zurueckbringen kann (live nachgemessen).
  local c n
  c="$(running_version core)"; n="$(running_version nodered)"
  if [ "$c" = "v1" ] && [ "$n" = "v1" ]; then
    ok "die Box laeuft wieder auf dem alten Stand - aus dem Archiv"
  else
    bad "erwartet v1 aus dem Archiv, laeuft core=${c} nodered=${n}"
  fi
  # Den Digest fuer die naechsten Faelle wieder verfuegbar machen.
  docker pull -q "$CORE_V1" >/dev/null 2>&1 || true
  docker pull -q "$NR_V1" >/dev/null 2>&1 || true
}

# Die Registry ist weg: verschieben, nichts stoppen.
scenario_registry_outage() {
  start_on_v1
  dc stop registry >/dev/null 2>&1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_state deferred 60 || true
  assert_state deferred "bei ausgefallener Registry"
  assert_reason_mentions "nicht geladen werden"
  if [ -f "${DATA}/ota/pending-confirm.json" ]; then
    bad "ein gescheiterter Pull darf keinen Vorgang hinterlassen"
  else
    ok "kein Vorgang hinterlassen"
  fi
  assert_alive v1
  dc start registry >/dev/null 2>&1
  settle 3
}

# Ein PULL, der haengt (die Gegenstelle nimmt an und antwortet nie).
scenario_wedged_pull() {
  # 203.0.113.0/24 ist der dokumentierte TEST-NET-3-Bereich: garantiert nicht
  # geroutet, also blockiert der Verbindungsaufbau statt abgelehnt zu werden.
  set_env VP_OTA_CMD_TIMEOUT_SECONDS "10"
  start_on_v1
  local blackhole_core="203.0.113.7:5000/soak/core@${CORE_V2##*@}"
  local blackhole_nr="203.0.113.7:5000/soak/nodered@${NR_V2##*@}"
  # Der Zustand wechselt hier ABSICHTLICH schnell zwischen „laedt" und
  # „verschoben" (Deckel zu, melden, sofort erneut versuchen) - welchen von
  # beiden eine Abtastung trifft, ist Zufall. Die SICHERHEITS-Aussage ist
  # eindeutig und wird genau so geprueft: er kommt NIE bei „wendet an" an.
  assign edge-2026.08.0 12 "$blackhole_core" "$blackhole_nr"
  settle 40
  assert_state_in "bei haengendem Pull" downloading deferred
  if [ -f "${DATA}/ota/pending-confirm.json" ]; then
    bad "ein haengender Pull darf keinen Vorgang hinterlassen"
  else
    ok "der Aufruf wurde gedeckelt und hat nichts hinterlassen"
  fi
  assert_alive v1
  set_env VP_OTA_CMD_TIMEOUT_SECONDS "120"
}

# Neustart MITTEN im Tausch: die Brotkrume traegt den Vorgang zu Ende.
scenario_mid_flip_reboot() {
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  # Auf den ERSTEN Tausch warten, dann den Sidecar hart abschiessen.
  local i=0
  while [ "$i" -lt 90 ]; do
    case "$(json_field "${DATA}/ota/pending-confirm.json" phase)" in
      swap_core|swap_node|self_test) break ;;
    esac
    sleep 1; i=$((i+1))
  done
  local phase; phase="$(json_field "${DATA}/ota/pending-confirm.json" phase)"
  [ -n "$phase" ] || { bad "der Tausch hat nicht begonnen"; assert_alive; return; }
  note "harter Abschuss in Phase '${phase}'"
  docker kill "$(dc ps -q updater)" >/dev/null 2>&1 || true
  settle 3
  dc up -d updater >/dev/null 2>&1
  note "Sidecar neu gestartet - er muss den LAUFENDEN Vorgang fortsetzen"

  wait_for_pending self_test 120 || { bad "der Vorgang wurde nicht fortgesetzt ($(updater_state))"; assert_alive; return; }
  ok "der angefangene Vorgang wurde fortgesetzt, nicht neu begonnen"
  SOAK_RUNNING_VERSION="edge-2026.08.0"
  core_selftest true
  wait_for_state succeeded 90 || bad "nicht bestaetigt ($(updater_state): $(updater_reason))"
  assert_alive v2
  SOAK_RUNNING_VERSION=""
}

# Uhr-Sprung: `valid_until` ist ADVISORY und darf nie ablehnen; ein alter
# Kern-Zustand dagegen MUSS den Tausch verhindern.
scenario_clock_skew() {
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  # a) Der Kern-Zustand ist uralt (die Uhr sprang nach vorn): Blindflug
  #    verhindern. Der Zustand wird ab jetzt NICHT mehr aufgefrischt.
  SIGNAL_ARGS="__frozen__"
  python3 - "${DATA}/ota/core-signal.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["updated_at"] = "2020-01-01T00:00:00.000000000Z"
json.dump(d, open(p, "w"))
PY
  wait_for_state deferred 60 || true
  assert_state deferred "bei uraltem Kern-Zustand"
  assert_reason_mentions "meldet seinen Zustand nicht"
  if [ -f "${DATA}/ota/pending-confirm.json" ]; then
    bad "im Blindflug darf kein Vorgang entstehen"
  else
    ok "kein Vorgang im Blindflug"
  fi
  assert_alive v1

  # b) Zeitstempel wieder frisch, dafuer ein laengst abgelaufenes
  #    `valid_until`: es ist ADVISORY, der Tausch muss trotzdem laufen.
  set_signal
  "${OUT}/vp-ota" manifest --release edge-2026.08.1 --seq 13 --commit 3bf8c038a1b2 \
    --artifact "core=${CORE_V2}" --artifact "nodered=${NR_V2}" \
    --state-schema 3 --key-id rel-soak --valid-until 2021-01-01T00:00:00Z \
    --out "${OUT}/release.json" >/dev/null
  "${OUT}/vp-ota" sign --domain release --in "${OUT}/release.json" \
    --key "${KEYS}/rel-soak.key" --out "${OUT}/release.json.sig" >/dev/null
  python3 - edge-2026.08.1 13 "${OUT}/release.json" "${OUT}/release.json.sig" \
           "${DATA}/ota/target.json" <<'PY'
import base64, json, os, sys
rel, seq, mpath, spath, out = sys.argv[1:6]
env = {"schema_version": "1.0", "type": "update_target",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "site_id": "00000000-0000-0000-0000-000000000002",
  "device_id": "00000000-0000-0000-0000-000000000003",
  "release": rel, "release_seq": int(seq), "channel": "canary",
  "manifest_b64": base64.b64encode(open(mpath, "rb").read()).decode(),
  "signature_b64": base64.b64encode(open(spath, "rb").read()).decode()}
open(out + ".tmp", "w").write(json.dumps(env)); os.replace(out + ".tmp", out)
PY
  wait_for_pending self_test 120 || { bad "ein abgelaufenes valid_until hat den Tausch VERHINDERT - es ist advisory"; assert_alive; return; }
  ok "abgelaufenes valid_until ist advisory und hat nicht abgelehnt"
  SOAK_RUNNING_VERSION="edge-2026.08.1"
  core_selftest true
  wait_for_state succeeded 90 || bad "nicht bestaetigt ($(updater_state))"
  assert_alive v2
  SOAK_RUNNING_VERSION=""
}

# Kein Broker: der durable `applying`-Bericht kann nicht abgesetzt werden.
# Eine Box ohne Cloud-Verbindung muss trotzdem aktualisierbar bleiben.
scenario_broker_outage() {
  start_on_v1 ackfailed=true
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_pending self_test 120 || { bad "ohne durablen Bericht wurde nicht getauscht ($(updater_state): $(updater_reason))"; assert_alive; return; }
  ok "der Tausch laeuft auch ohne bestaetigten durablen Bericht"
  SOAK_RUNNING_VERSION="edge-2026.08.0"
  core_selftest true
  wait_for_state succeeded 90 || bad "nicht bestaetigt ($(updater_state))"
  assert_alive v2
  SOAK_RUNNING_VERSION=""
}

# Kein Platz: es wird nicht einmal geholt.
scenario_disk_full() {
  set_env VP_OTA_DISK_GUARD_MB "9999999"
  start_on_v1
  assign edge-2026.08.0 12 "$CORE_V2" "$NR_V2"
  wait_for_state deferred 60 || true
  assert_state deferred "ohne freien Speicherplatz"
  assert_reason_mentions "Speicherplatz"
  assert_alive v1
  set_env VP_OTA_DISK_GUARD_MB "1"
}

# =========================================================================
# Lauf
# =========================================================================
prepare

FAILED=()
for name in "${WANTED[@]}"; do
  if ! declare -F "scenario_${name}" >/dev/null; then
    say "Unbekannter Fall: ${name}"; exit 2
  fi
  step "Fall: ${name}"
  SCENARIO_FAILED=0
  "scenario_${name}" || SCENARIO_FAILED=1
  [ "$SCENARIO_FAILED" -eq 0 ] || keep_evidence
  # IMMER abraeumen - auch nach einem Fehlschlag. Nie zwei Stapel gleichzeitig.
  stack_down
  if [ "$SCENARIO_FAILED" -eq 0 ]; then
    printf '   %s== %s bestanden ==%s\n' "$C_G" "$name" "$C_0"
  else
    printf '   %s== %s FEHLGESCHLAGEN ==%s\n' "$C_R" "$name" "$C_0"
    FAILED+=("$name")
  fi
done

if [ "$KEEP" -eq 0 ]; then
  step "Aufraeumen"
  purge_all
  note "Container, Images und Arbeitsdateien der Matrix entfernt."
else
  warn "--keep: der Arbeitsstand bleibt unter ${WORK}"
fi

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '%s== Matrix bestanden (%d Faelle) ==%s\n' "$C_G" "${#WANTED[@]}" "$C_0"
  exit 0
fi
printf '%s== %d von %d Faellen FEHLGESCHLAGEN: %s ==%s\n' \
  "$C_R" "${#FAILED[@]}" "${#WANTED[@]}" "${FAILED[*]}" "$C_0"
exit 1

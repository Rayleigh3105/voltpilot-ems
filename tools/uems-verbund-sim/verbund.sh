#!/usr/bin/env bash
# AP-15 IP-28 (NW-3): der Simulator-Aufbau - zwei echte Boxen in EINER Anlage.
#
#   verbund.sh bilder            Bilder einmal aus dem AKTUELLEN Arbeitsbaum bauen
#   verbund.sh r1 [--protokoll <datei>] [--stoerung "<zeile> <sek> <dauer>"]
#                                hoch, Nutzlasten zustellen, R1 durchfahren,
#                                Protokoll schreiben, IMMER abbauen
#   verbund.sh hoch | zustellen | start | stand | protokoll <datei> | runter
#                                die Schritte einzeln (Fehlersuche; `runter` nicht vergessen)
#
# Umgebung: VB_PROJEKT (Vorgabe uems-verbund), VB_DAUER_S (2700 = 45 min
# Messung), VB_ANLAUF_S (300), VB_T0_S (600), VB_PROFIL (mittag), VB_ARBEIT.
#
# Maschinenregel: vor `up` höchstens zwei Testcontainers anderer Bahnen (sonst
# Exit 75, „paused"), nie zwei Aufbauten zugleich, nach jedem Lauf `down -v`.
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HIER/../.." && pwd)"
PROJEKT="${VB_PROJEKT:-uems-verbund}"
ARBEIT="${VB_ARBEIT:-${TMPDIR:-/tmp}/uems-verbund-$PROJEKT}"
# Die Marke der Box-Bilder ist der letzte Commit, der die Box berührt - ein
# Commit nur unter tools/ baut keine neue Box. Das Anlagen-Bild ist billig und
# wird bei jedem `bilder` neu gebaut.
SHA="$(git -C "$REPO" log -1 --format=%H -- edge-app edge/sim)"
MARKE="${SHA:0:12}"
export VB_CORE_IMAGE="vb-edge-core:$MARKE" VB_NODERED_IMAGE="vb-edge-nodered:$MARKE"
export VB_BROKER_IMAGE="vb-broker:$MARKE" VB_ANLAGE_IMAGE="vb-anlage:lokal"
export VB_PROFIL="${VB_PROFIL:-mittag}" VB_ANLAUF_S="${VB_ANLAUF_S:-300}"
export VB_DAUER_S="${VB_DAUER_S:-2700}" VB_T0_S="${VB_T0_S:-600}"

TEN=7a000000-0000-4000-8000-000000000001
SIT=7a000000-0000-4000-8000-0000000000a1
# bash 3.2 (macOS) kennt keine assoziativen Felder
geraet() { case "$1" in E-1) echo 7a000000-0000-4000-8000-0000000000e1 ;; E-4) echo 7a000000-0000-4000-8000-0000000000e4 ;; esac; }
DC=(docker compose -p "$PROJEKT" -f "$HIER/verbund.yml")

mkdir -p "$ARBEIT"

id_von() { "${DC[@]}" ps -q "$1"; }
anlage() { docker exec "$(id_von anlage)" python3 /app/uems_verbund.py steuer "$1"; }

bilder() {
  # Aus dem AKTUELLEN Stand, nicht aus einem Release-Tag: der Aufbau prüft den
  # Bau, nicht das Artefakt. Stempel wie edge-images.yaml, nur mit „uems-".
  local fehlt=0 b
  docker build -q --build-context "referenz=$REPO/docs/contracts/v2" -t "$VB_ANLAGE_IMAGE" "$HIER" >/dev/null
  for b in "$VB_CORE_IMAGE" "$VB_NODERED_IMAGE" "$VB_BROKER_IMAGE"; do
    docker image inspect "$b" >/dev/null 2>&1 || fehlt=1
  done
  [ -n "$(git -C "$REPO" status --porcelain -- edge-app edge/sim)" ] \
    && echo "WARNUNG: edge-app/ hat ungesicherte Änderungen - die Marke $MARKE trifft sie nicht"
  if [ "$fehlt" = 0 ] && [ "${VB_NEU_BAUEN:-0}" != 1 ]; then
    echo "==> Box-Bilder für $MARKE vorhanden (letzter Commit an edge-app/, edge/sim)"; return 0
  fi
  echo "==> baue Box-Bilder aus $SHA (letzter Commit an edge-app/, edge/sim)"
  docker build -q --build-arg "VERSION=uems-$MARKE" -t "$VB_CORE_IMAGE" "$REPO/edge-app/core" >/dev/null
  docker build -q --build-arg "VERSION=uems-$MARKE" -t "$VB_NODERED_IMAGE" "$REPO/edge-app/nodered" >/dev/null
  docker build -q -t "$VB_BROKER_IMAGE" -f "$REPO/edge-app/test/Dockerfile.broker" "$REPO/edge-app/test" >/dev/null
}

# Das Tor zählt nur die Testcontainers ANDERER Bahnen (firstmate 22.09.2026):
# die eigenen Container zählen nicht, und andere Bahnen zählen diese nicht.
fenster_frei() {
  local n
  n="$(docker ps -q --filter label=org.testcontainers=true | wc -l | tr -d ' ')"
  if [ "$n" -gt 2 ]; then
    echo "paused: $n Testcontainers anderer Bahnen laufen (Regel: höchstens 2 vor dem Aufbau)" >&2
    return 75
  fi
  if "${DC[@]}" ps -q 2>/dev/null | grep -q .; then
    echo "Aufbau $PROJEKT steht schon - erst '$0 runter'" >&2
    return 75
  fi
}

broker() { id_von cloud-broker; }

mitschnitt_start() {
  docker exec "$(broker)" sh -c ": > /tmp/mitschnitt.txt"
  docker exec -d "$(broker)" sh -c \
    "mosquitto_sub -h 127.0.0.1 -q 1 -v -t 'ems/#' | while IFS= read -r z; do echo \"\$(date -u +%s) \$z\"; done >> /tmp/mitschnitt.txt"
  sleep 1
}

mitschnitt() { docker exec "$(broker)" cat /tmp/mitschnitt.txt; }

# Letzte Nachricht eines Topics (ohne Zeitstempel und Topic).
letzte() { # <box> <leaf>
  mitschnitt | awk -v t="ems/$TEN/$SIT/$(geraet "$1")/$2" '$2==t {sub(/^[^ ]+ [^ ]+ /,""); l=$0} END{print l}'
}

warte_auf() { # <box> <leaf> <pyausdruck ueber d> <sekunden>
  local i=0
  while [ "$i" -lt "$4" ]; do
    if letzte "$1" "$2" | python3 -c "
import json,sys
roh=sys.stdin.read().strip()
if not roh: sys.exit(1)
try: d=json.loads(roh)
except Exception: sys.exit(1)
sys.exit(0 if ($3) else 1)" 2>/dev/null; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

hoch() {
  fenster_frei || return $?
  echo "==> Aufbau $PROJEKT hoch (Bilder $MARKE, Profil $VB_PROFIL)"
  "${DC[@]}" up -d >/dev/null
  mitschnitt_start
  local b
  for b in E-1 E-4; do
    warte_auf "$b" status 'd.get("version")' 120 \
      || { echo "Box $b meldete keinen Herzschlag"; "${DC[@]}" logs --tail 30; return 1; }
    echo "    Box $b meldet Stand $(letzte "$b" status | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  done
}

# Wie die Cloud: retained, QoS 1, auf das Topic der jeweiligen Box.
senden() { # <verzeichnis> <liste>
  local topic datei
  while read -r topic datei; do
    docker exec -i "$(broker)" sh -c 'cat > /tmp/n.json' < "$1/$datei"
    docker exec "$(broker)" mosquitto_pub -h 127.0.0.1 -q 1 -r -t "$topic" -f /tmp/n.json
  done < "$2"
}

zustellen() {
  local nl="$ARBEIT/nutzlasten"
  python3 "$HIER/nutzlast.py" --aus "$nl" > "$ARBEIT/nutzlasten.txt"
  senden "$nl" "$ARBEIT/nutzlasten.txt"
  echo "==> $(wc -l < "$ARBEIT/nutzlasten.txt" | tr -d ' ') Nutzlasten zugestellt (Registry, Anteile, Ladepark, Fahrplan v1, Plan v2 je Box)"
  local b
  for b in E-1 E-4; do
    warte_auf "$b" v2/verbund-anteile-result 'd.get("urteil")' 60 \
      || echo "    WARNUNG: Box $b hat das Anteils-Dokument nicht quittiert"
    warte_auf "$b" v2/plan-result '"angenommen" in d' 60 \
      || echo "    WARNUNG: Box $b hat den Plan nicht quittiert"
    echo "    Box $b: Anteile $(letzte "$b" v2/verbund-anteile-result | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["urteil"], d.get("grund") or "", "wirksam", d.get("wirksam"))')"
    echo "    Box $b: Plan    $(letzte "$b" v2/plan-result | python3 -c 'import json,sys; d=json.load(sys.stdin); print("angenommen" if d["angenommen"] else "abgelehnt", d.get("grund") or "", d["plan_id"])')"
  done
}

# Der Takt der Cloud: jede Viertelstunde (Wanduhr) ein neuer Lauf für beide
# Boxen - Fahrplan v1 und Plan v2, eine neue plan_id. Ohne ihn fährt die Box den
# Plan nur 20 Minuten und fällt dann auf `execution.mode: fallback` (A3). Die
# Störung A3 (stoerung.sh) legt $ARBEIT/cloud.stumm an: dann bleibt der Lauf aus.
cloud_takt() {
  local runde=1 warte nl
  while :; do
    warte=$(( 900 - $(date +%s) % 900 + 2 ))
    sleep "$warte"
    if [ -e "$ARBEIT/cloud.stumm" ]; then
      echo "$(date -u +%FT%TZ) stumm" >> "$ARBEIT/cloud-takt.log"; continue
    fi
    runde=$((runde + 1)); nl="$ARBEIT/runde-$runde"
    python3 "$HIER/nutzlast.py" --aus "$nl" --runde "$runde" --nur-plan > "$nl.txt"
    senden "$nl" "$nl.txt"
    echo "$(date -u +%FT%TZ) runde $runde" >> "$ARBEIT/cloud-takt.log"
  done
}

start() { anlage '{"cmd":"start"}'; }
stand() { anlage '{"cmd":"stand"}'; }

warte_lauf() {
  local gesamt=$((VB_ANLAUF_S + VB_DAUER_S)) s=0
  while :; do
    s="$(stand | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["sim_s"], d["fertig"], d["netz_kw"])')"
    case "$s" in *True*) break ;; esac
    if [ $(( ${s%% *} % 300 )) -lt 10 ]; then echo "    Sim-Sekunde ${s%% *}/$gesamt, Netzpunkt ${s##* } kW"; fi
    sleep 10
  done
}

protokoll() { # <datei>
  local ziel="$1"
  anlage '{"cmd":"protokoll"}' > "$ARBEIT/anlage.json"
  mitschnitt > "$ARBEIT/mitschnitt.txt"
  "${DC[@]}" logs --no-color core-e1 core-e4 > "$ARBEIT/core.log" 2>&1 || true
  python3 "$HIER/protokoll.py" --anlage "$ARBEIT/anlage.json" --mitschnitt "$ARBEIT/mitschnitt.txt" \
    --nutzlasten "$ARBEIT/nutzlasten.txt" --sha "$SHA" --aus "$ziel"
  echo "==> Protokoll $ziel"
}

TAKT_PID=""
STOER_PID=""
aufraeumen() {
  [ -z "$TAKT_PID" ] || kill "$TAKT_PID" 2>/dev/null || true
  [ -z "$STOER_PID" ] || kill "$STOER_PID" 2>/dev/null || true
  runter
}

runter() {
  echo "==> Aufbau $PROJEKT abbauen"
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

# Eine Störung während des Laufs: "<zeile> <messsekunde> <dauer_s>" (stoerung.sh).
stoerung_im_lauf() { # <zeile> <ab_mess_s> <dauer_s>
  local zeile="$1" ab="$2" dauer="$3" m
  while :; do
    m="$(stand | python3 -c 'import json,sys; print(json.load(sys.stdin)["mess_s"])')"
    [ "$m" -ge "$ab" ] && break
    sleep 1
  done
  VB_PROJEKT="$PROJEKT" VB_ARBEIT="$ARBEIT" "$HIER/stoerung.sh" "$zeile"
  sleep "$dauer"
  VB_PROJEKT="$PROJEKT" VB_ARBEIT="$ARBEIT" "$HIER/stoerung.sh" zurueck
}

r1() {
  local ziel="$ARBEIT/r1-protokoll.json" stoer=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --protokoll) ziel="$2"; shift 2 ;;
      --stoerung) stoer="$2"; shift 2 ;;
      *) echo "unbekanntes Argument $1" >&2; return 2 ;;
    esac
  done
  bilder
  local rc=0
  hoch || rc=$?
  if [ "$rc" = 75 ]; then return 75; fi
  trap aufraeumen EXIT
  [ "$rc" = 0 ] || return "$rc"
  zustellen
  cloud_takt &
  TAKT_PID=$!
  start >/dev/null
  echo "==> Lauf: $VB_ANLAUF_S s Anlauf + $VB_DAUER_S s Messung (Echtzeit), T0 = Messsekunde $VB_T0_S"
  local stoer_pid=""
  if [ -n "$stoer" ]; then
    # shellcheck disable=SC2086
    stoerung_im_lauf $stoer &
    stoer_pid=$!
    STOER_PID=$stoer_pid
  fi
  warte_lauf
  # Eine Störung, die bis zum Ende des Laufs anhält (A7 wie A7e im
  # Zwei-Agenten-Test), wird nicht mehr aufgehoben - der Aufbau geht ohnehin ab.
  if [ -n "$stoer_pid" ]; then kill "$stoer_pid" 2>/dev/null || true; wait "$stoer_pid" 2>/dev/null || true; fi
  kill "$TAKT_PID" 2>/dev/null || true
  protokoll "$ziel"
}

case "${1:-}" in
  bilder) bilder ;;
  r1) shift; r1 "$@" ;;
  hoch) bilder; hoch ;;
  zustellen) zustellen ;;
  start) start ;;
  stand) stand ;;
  protokoll) protokoll "${2:?Zieldatei}" ;;
  runter) runter ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# NW-3 — das AUSGELIEFERTE Box-Image gegen die neue Cloud (AP-14 IP-6, X1/X2/X7, U4).
#
# Was dieses Werkzeug beweist und was nicht
# ----------------------------------------
# Jeder bisherige Mischbetrieb-Nachweis im Baum faehrt QUELLSTAND gegen
# QUELLSTAND (ist/C §8.2: „kein Test startet das Release-Image"). Dieses
# Werkzeug startet die ECHTE Box-Software eines Release-Standes als Prozesse
# und laesst sie die Nutzlasten lesen, die die HEUTIGE Cloud erzeugt.
#
# Echt sind: der Go-Core, die Node-RED-Palette, der SunSpec-Simulator (alle drei
# aus dem Release-Tag gebaut), ein echter MQTT-Broker (Mosquitto), und - wenn
# --strecke mitgegeben wird - die echte Datenannahme (services/ingest), ein
# echtes Redpanda, der echte Writer (services/timescale-writer) und eine echte
# TimescaleDB. Die Cloud-Seite ist KEIN api-Prozess: dieses Werkzeug stellt die
# festgenagelten Nutzlasten des Standes zu (docs/contracts/v2/examples/*, an die
# der api-Erzeuger per Test gebunden ist) - siehe README §„Was echt ist".
#
# Hausregeln: eigene Container mit Praefix, eigenes Netz, KEIN fester Port der
# Betreiber-Umgebung (Ports = 0 -> Docker waehlt), am Ende nur Eigenes abraeumen.
#
# Aufruf:  tools/nw3-box-image/nw3.sh [--paare <datei>] [--protokoll <datei>]
#                                     [--strecke] [--behalten]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PAARE="$REPO/tools/nw3-box-image/paare.json"
PROTOKOLL=""
STRECKE=0
BEHALTEN=0
ARBEIT="${TMPDIR:-/tmp}/nw3-$$"

while [ $# -gt 0 ]; do
  case "$1" in
    --paare)     PAARE="$2"; shift 2 ;;
    --protokoll) PROTOKOLL="$2"; shift 2 ;;
    --strecke)   STRECKE=1; shift ;;
    --behalten)  BEHALTEN=1; shift ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROTOKOLL" ] || PROTOKOLL="$ARBEIT/nw3-protokoll.json"

mkdir -p "$ARBEIT"
BEFUNDE="$ARBEIT/befunde.jsonl"
: > "$BEFUNDE"

# Die Identitaet, auf die JEDE festgenagelte Nutzlast des Standes lautet und die
# das Entwickler-Tor des Cores annimmt (docker-compose.e2e.yml VP_DEV_*).
TEN=00000000-0000-0000-0000-000000000001
SIT=00000000-0000-0000-0000-000000000002
DEV=00000000-0000-0000-0000-000000000003
BASIS="ems/$TEN/$SIT/$DEV"

PROJEKT=""
SPROJEKT=""
TAGWT=""
BROKER=""

aufraeumen() {
  local rc=$?
  if [ "$BEHALTEN" = "1" ]; then
    echo "--- behalten: Projekt $PROJEKT${SPROJEKT:+ + $SPROJEKT}, Arbeitsbaum $TAGWT, Arbeitsordner $ARBEIT"
    return $rc
  fi
  echo "--- aufraeumen (nur Eigenes)"
  if [ -n "$SPROJEKT" ]; then
    docker compose -p "$SPROJEKT" -f "$REPO/tools/nw3-box-image/nw3-strecke.yml" \
      down -v --remove-orphans >/dev/null 2>&1 || true
    # Nur die beiden Bilder DIESES Laufs (Marke = eigene PID), nie ein fremdes.
    docker image rm -f "nw3-ingest:$$" "nw3-writer:$$" >/dev/null 2>&1 || true
  fi
  if [ -n "$PROJEKT" ]; then
    docker compose -p "$PROJEKT" -f "$TAGWT/edge-app/docker-compose.yml" \
      -f "$TAGWT/edge-app/test/docker-compose.e2e.yml" \
      -f "$REPO/tools/nw3-box-image/nw3-overlay.yml" --profile sim \
      down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ -n "$TAGWT" ] && [ -d "$TAGWT" ]; then
    git -C "$REPO" worktree remove --force "$TAGWT" >/dev/null 2>&1 || true
  fi
  return $rc
}
trap aufraeumen EXIT

melde() { # <punkt> <urteil gruen|rot|nicht_gefahren> <satz> [beleg]
  python3 - "$BEFUNDE" "$1" "$2" "$3" "${4-}" <<'PY'
import json, sys
datei, punkt, urteil, satz, beleg = sys.argv[1:6]
with open(datei, "a", encoding="utf-8") as f:
    f.write(json.dumps({"punkt": punkt, "urteil": urteil, "satz": satz,
                        "beleg": beleg}, ensure_ascii=False) + "\n")
PY
  printf '    [%s] %s — %s\n' "$2" "$1" "$3"
}

# --- Cloud-Seite: Zustellen und Mithoeren am ECHTEN Broker -------------------
zustellen() { # <leaf> <datei> [-r]
  local leaf="$1" datei="$2" retain="${3-}"
  docker exec -i "$BROKER" sh -c 'cat > /tmp/nutzlast.json' < "$datei"
  # shellcheck disable=SC2086
  docker exec "$BROKER" mosquitto_pub -h 127.0.0.1 -q 1 $retain \
    -t "$BASIS/$leaf" -f /tmp/nutzlast.json
}

mitschnitt_start() {
  docker exec "$BROKER" sh -c ": > /tmp/mitschnitt.txt"
  docker exec -d "$BROKER" sh -c \
    "mosquitto_sub -h 127.0.0.1 -q 1 -v -t 'ems/#' >> /tmp/mitschnitt.txt 2>&1"
  sleep 1
}

mitschnitt() { docker exec "$BROKER" cat /tmp/mitschnitt.txt; }

# Letzte Nachricht eines Themas aus dem Mitschnitt, als JSON auf stdout.
letzte() { # <leaf>
  mitschnitt | awk -v t="$BASIS/$1" '$1==t {sub(/^[^ ]+ /,""); l=$0} END{print l}'
}

# Wartet, bis das Thema eine Nachricht traegt, die <pyausdruck> erfuellt.
warte_auf() { # <leaf> <pyausdruck ueber d> <sekunden>
  local leaf="$1" ausdruck="$2" grenze="$3" i=0
  while [ "$i" -lt "$grenze" ]; do
    if letzte "$leaf" | python3 -c "
import json,sys
roh=sys.stdin.read().strip()
if not roh: sys.exit(1)
try: d=json.loads(roh)
except Exception: sys.exit(1)
sys.exit(0 if ($ausdruck) else 1)
" 2>/dev/null; then return 0; fi
    i=$((i+1)); sleep 1
  done
  return 1
}

# --- Schritt 1: das ausgelieferte Image beschaffen ---------------------------
# Das Release-Artefakt ist ein Container-Image-Paar in der PRIVATEN Registry
# (edge-app/docker-compose.yml: git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-*).
# Ohne Zugangsdaten ist es nicht abrufbar - dieses Werkzeug fragt keine an und
# probiert keinen Login. Es baut statt dessen REPRODUZIERBAR aus dem Tag, mit
# der Bauanleitung DES TAGS und dem Versionsstempel, den die CI vergibt.
bauen() { # <core_ref> <palette_ref>
  local core_ref="$1" pal_ref="$2"
  [ "$core_ref" = "$pal_ref" ] || {
    echo "Dieses Werkzeug baut ein Paar aus EINEM Tag; core=$core_ref palette=$pal_ref" >&2
    echo "Fuer ein gemischtes Paar zwei Arbeitsbaeume anlegen (X6: Core und Palette" >&2
    echo "werden gemeinsam ausgeliefert, ein gemischtes Paar entsteht nie aus einem" >&2
    echo "regulaeren Release)." >&2
    return 3
  }
  TAGWT="$ARBEIT/tag-$core_ref"
  git -C "$REPO" worktree add --detach "$TAGWT" "$core_ref" >/dev/null 2>&1
  local sha stempel
  sha="$(git -C "$TAGWT" rev-parse HEAD)"
  # Versionsstempel exakt wie .forgejo/workflows/edge-images.yaml „Compute
  # version stamp": <tag>-<erste 12 Zeichen der SHA>.
  stempel="$core_ref-${sha:0:12}"
  echo "==> baue aus dem Tag $core_ref ($sha), Versionsstempel $stempel"
  docker build -q --build-arg "VERSION=$stempel" \
    -t "nw3-edge-core:$core_ref" "$TAGWT/edge-app/core" >/dev/null
  docker build -q --build-arg "VERSION=$stempel" \
    -t "nw3-edge-nodered:$core_ref" "$TAGWT/edge-app/nodered" >/dev/null
  docker build -q -t "nw3-edge-sim:$core_ref" "$TAGWT/edge/sim" >/dev/null
  docker build -q -t "nw3-broker:$core_ref" \
    -f "$TAGWT/edge-app/test/Dockerfile.broker" "$TAGWT/edge-app/test" >/dev/null
  BROKER_IMAGE="nw3-broker:$core_ref"
  STEMPEL="$stempel"
  SHA="$sha"
  # Was sich am gebauten Paar gegen das Release pruefen laesst.
  KERN_STEMPEL="$(docker run --rm --entrypoint /bin/sh "nw3-edge-core:$core_ref" -c \
    "strings /usr/local/bin/vp-edge-core | grep -o '$core_ref-[0-9a-f]\{12\}' | head -1")"
  PAL_STEMPEL="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' \
    "nw3-edge-nodered:$core_ref")"
  PAL_MARKE="$(docker run --rm --entrypoint /bin/sh "nw3-edge-nodered:$core_ref" -c \
    'cat /opt/vp-template/.vp-template-version')"
  PAL_PRUEFUNG="$(cd "$TAGWT/catalog/measurement-points" \
    && python3 tools/package_edge_runtime.py --check 2>&1 | tail -1)"
}

# --- Der Stack -----------------------------------------------------------
stack_hoch() { # <ref>
  local ref="$1"
  PROJEKT="nw3-$$"
  echo "==> Stack $PROJEKT hoch (eigenes Netz, Ports 0 = Docker waehlt)"
  VP_EDGE_CORE_IMAGE="nw3-edge-core:$ref" \
  VP_EDGE_NODERED_IMAGE="nw3-edge-nodered:$ref" \
  NW3_SIM_IMAGE="nw3-edge-sim:$ref" \
  NW3_BROKER_IMAGE="nw3-broker:$ref" \
  VP_WEB_PORT=0 VP_NODERED_PORT=0 VP_BUS_PORT=0 VP_MIRROR_PORT=0 VP_OCPP_PORT=0 \
  VP_NODERED_PASSWORD=nw3-pruefstand \
    docker compose -p "$PROJEKT" \
      -f "$TAGWT/edge-app/docker-compose.yml" \
      -f "$TAGWT/edge-app/test/docker-compose.e2e.yml" \
      -f "$REPO/tools/nw3-box-image/nw3-overlay.yml" \
      --profile sim up -d >/dev/null
  BROKER="$(docker compose -p "$PROJEKT" -f "$TAGWT/edge-app/docker-compose.yml" \
      -f "$TAGWT/edge-app/test/docker-compose.e2e.yml" \
      -f "$REPO/tools/nw3-box-image/nw3-overlay.yml" ps -q cloud-broker)"
  KERN="$(docker compose -p "$PROJEKT" -f "$TAGWT/edge-app/docker-compose.yml" \
      -f "$TAGWT/edge-app/test/docker-compose.e2e.yml" \
      -f "$REPO/tools/nw3-box-image/nw3-overlay.yml" ps -q core)"
  NETZ="${PROJEKT}_default"
  mitschnitt_start
  echo "    warte auf den ersten Herzschlag der Box"
  warte_auf "status" 'd.get("version")' 90 \
    || { echo "Box meldete keinen Herzschlag"; docker logs --tail 40 "$KERN"; return 1; }
  STAND="$(letzte status | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  echo "    Box meldet Stand: $STAND"
  wechselrichter_waehlen
}

# Die EINE Einstellung, die am Geraet selbst getroffen wird und nicht aus der
# Cloud kommt: welcher Wechselrichter an der Box haengt. Ohne sie veroeffentlicht
# der Core kein retained `edge/inverter/config`, die Messlaufzeit findet zur
# LESEZEIT keine Verbindung und sendet gar nichts - unabhaengig davon, welchen
# Punkt die Cloud waehlt. Im Feld macht diese Wahl der Installateur in der
# lokalen Weboberflaeche der Box; hier geht sie ueber genau dieselbe Route
# (POST /api/inverter, internal/web/web.go:521) an den ECHTEN Core des Tags.
# Gewaehlt wird `generic_modbus/sunspec` - das im Core hinterlegte Registerbild
# des SIMULATORS (modbus-tcp.js: „the SIMULATOR's fixed layout, NOT real SunSpec").
wechselrichter_waehlen() {
  echo "    waehle den Wechselrichter an der Box (lokale Weboberflaeche, wie der Installateur)"
  local antwort
  antwort="$(docker run --rm --network "$NETZ" "$BROKER_IMAGE" wget -q -O - \
      --header 'Content-Type: application/json' \
      --post-data '{"brand":"generic_modbus","family":"sunspec","connection":{"ip":"edge-sim"}}' \
      "http://core:8484/api/inverter" 2>&1 || true)"
  WR="$(printf '%s' "$antwort" | python3 -c '
import json,sys
try: print(json.load(sys.stdin)["selection"]["communication"])
except Exception: print("")
' 2>/dev/null)"
  [ -n "$WR" ] || echo "    WARNUNG: die Box hat keine Wechselrichter-Wahl angenommen: $antwort"
}

# --- Die zweite Container-Gruppe: die Strecke dieses Standes -----------------
# Datenannahme -> Redpanda -> Writer -> TimescaleDB, alles aus DIESEM Arbeitsbaum
# gebaut. Eigenes Projekt, eigenes Netz, kein Host-Port.
#
# Das SCHEMA der Datenbank ist der Spiegel, den der Writer selbst fuer seine
# Tests haelt (services/timescale-writer/src/test/resources/writer-schema.sql)
# plus die VIER echten api-Migrationen der Ereignis-Tabelle - dieselbe Kette, die
# `EreignisTabelleImTest` fahrt. Das ist eine BENANNTE Grenze wie „kein
# api-Prozess": gefahren wird die Strecke, nicht Flyway.
strecke_hoch() {
  SPROJEKT="nw3s-$$"
  local sc=("docker" "compose" "-p" "$SPROJEKT" "-f" "$REPO/tools/nw3-box-image/nw3-strecke.yml")
  echo "==> Strecke $SPROJEKT: Bilder aus diesem Arbeitsbaum bauen"
  docker build -q -t "nw3-ingest:$$" "$REPO/services/ingest" >/dev/null
  docker build -q -t "nw3-writer:$$" "$REPO/services/timescale-writer" >/dev/null
  export NW3_INGEST_IMAGE="nw3-ingest:$$" NW3_WRITER_IMAGE="nw3-writer:$$"
  echo "    Datenbank und Redpanda hoch"
  "${sc[@]}" up -d --wait timescaledb redpanda >/dev/null
  SDB="$("${sc[@]}" ps -q timescaledb)"
  SRP="$("${sc[@]}" ps -q redpanda)"
  SNETZ="${SPROJEKT}_default"
  for t in measurements.raw events.raw telemetry.raw telemetry-v2.raw; do
    docker exec "$SRP" rpk topic create "$t" --brokers localhost:29092 -p 1 -r 1 >/dev/null 2>&1 || true
  done
  echo "    Schema (Writer-Spiegel + die vier Ereignis-Migrationen der api) und Stammdaten"
  psql_admin < "$REPO/services/timescale-writer/src/test/resources/writer-schema.sql"
  local m="$REPO/services/api/src/main/resources/db/migration"
  for f in V20260911260000__uems_messreihe_ereignis.sql V20260912220000__uems_zaehler_ueberlauf.sql \
           V20260913130000__uems_luecken_vokabular.sql V20260913170000__uems_luecken_zuwachs.sql; do
    sed -e 's/${appDbUser}/voltpilot_app/g' -e 's/${adminDbUser}/voltpilot_admin/g' "$m/$f" | psql_admin
  done
  psql_admin < "$REPO/tools/nw3-box-image/strecke-seed.sql"
  echo "    Datenannahme und Writer anlegen, Datenannahme in das Netz der BOX haengen (Broker-Bruecke)"
  "${sc[@]}" create ingest writer >/dev/null
  SING="$("${sc[@]}" ps -aq ingest)"
  SWRI="$("${sc[@]}" ps -aq writer)"
  docker network connect "$NETZ" "$SING" >/dev/null
  "${sc[@]}" start ingest writer >/dev/null
  local i=0
  while [ "$i" -lt 90 ]; do
    if metrik_text | grep -q '^voltpilot_'; then break; fi
    i=$((i+1)); sleep 2
  done
  [ "$i" -lt 90 ] || { echo "    WARNUNG: der Writer hat /metrics nicht beantwortet"; docker logs --tail 25 "$SWRI"; }
}

psql_admin() { docker exec -i "$SDB" psql -q -v ON_ERROR_STOP=1 -U voltpilot -d voltpilot >/dev/null; }

# /metrics des Writers (actuator, `prometheus` auf `metrics` umgehaengt).
metrik_text() {
  docker run --rm --network "$SNETZ" "$BROKER_IMAGE" \
    wget -q -O - "http://writer:8092/metrics" 2>/dev/null || true
}

# Summe ueber ALLE Reihen einer Verwurf-Familie. Micrometer gibt einen Zaehler
# erst aus, wenn er einmal hochgezaehlt wurde - eine fehlende Reihe ist darum 0
# und keine fehlende Messung.
verwurf() { # <metrikname>
  metrik_text | awk -v n="$1" '
    index($0, n"{")==1 || $1==n { s += $NF } END { printf "%d", s+0 }'
}

hauptlauf() {
  local ref="$1"
  local E="$REPO/docs/contracts/v2/examples"

  # (1) Registry-Push -----------------------------------------------------
  echo "==> (1) Registry-Push: angenommen, Revision geechot — ohne und mit data_source_id"
  python3 "$REPO/tools/nw3-box-image/nutzlast.py" push \
    --vorlage "$E/edge-entity.valid.registry-push.json" \
    --revision "uems-registry:4711" --aus "$ARBEIT/push-ohne.json"
  zustellen "v2/entities" "$ARBEIT/push-ohne.json" -r
  if warte_auf "status" 'd.get("entities",{}).get("revision")=="uems-registry:4711"' 45; then
    melde "1a registry-push ohne quelle" gruen \
      "Push angenommen, Revision undurchsichtig geechot" "$(letzte status)"
  else
    melde "1a registry-push ohne quelle" rot \
      "Revision nicht geechot" "$(letzte status)"
  fi

  python3 "$REPO/tools/nw3-box-image/nutzlast.py" push \
    --vorlage "$E/edge-entity.valid.registry-push.json" \
    --revision "uems-registry:4712" --datenquellen --aus "$ARBEIT/push-mit.json"
  zustellen "v2/entities" "$ARBEIT/push-mit.json" -r
  if warte_auf "status" 'd.get("entities",{}).get("revision")=="uems-registry:4712"' 45; then
    local n
    n="$(letzte status | python3 -c 'import json,sys; print(json.load(sys.stdin).get("entities",{}).get("count",-1))')"
    melde "1b registry-push mit data_source_id" gruen \
      "Feld ueberlesen, Revision geechot, alle $n Entitaeten angewandt (keine verworfen)" "$(letzte status)"
  else
    melde "1b registry-push mit data_source_id" rot \
      "Push mit data_source_id nicht geechot — die alte Box ueberliest das Feld NICHT" \
      "$(docker logs --tail 15 "$KERN" 2>&1 | tr '\n' '|')"
  fi

  # (2) Planzyklus --------------------------------------------------------
  echo "==> (2) ein Planzyklus"
  python3 "$REPO/tools/nw3-box-image/nutzlast.py" plan \
    --vorlage "$E/mqtt-schedule-2.0.valid.minimal-battery.json" \
    --entitaet "5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f" --aus "$ARBEIT/plan.json"
  zustellen "v2/plan" "$ARBEIT/plan.json" -r
  if warte_auf "status" 'd.get("control") is not None or d.get("plan") is not None' 45; then
    melde "2 planzyklus" gruen "Plan zugestellt, angenommen und ausgefuehrt" "$(letzte status)"
  else
    melde "2 planzyklus" rot "keine Plan-Bestaetigung im Herzschlag" "$(letzte status)"
  fi

  # (3) Mess-Auswahl ------------------------------------------------------
  echo "==> (3) Mess-Auswahl im Vertrag 2.0 (Box liest STRIKT: DisallowUnknownFields)"
  zustellen "v2/measurement-config" "$E/mqtt-measurement-config.valid.json" -r
  if warte_auf "v2/measurement-config-status" 'd.get("revision")==7 and not d.get("rejected")' 60; then
    melde "3 mess-auswahl" gruen \
      "festgenagelte Cloud-Nutzlast angewandt, revision 7, rejected leer — kein unbekanntes Feld" \
      "$(letzte v2/measurement-config-status)"
  else
    melde "3 mess-auswahl" rot \
      "Box hat die Mess-Auswahl der neuen Cloud NICHT angewandt" \
      "$(letzte v2/measurement-config-status)"
  fi

  # (4) Samples 2.0 im Writer ---------------------------------------------
  echo "==> (4) Samples 2.0 im Writer"
  if [ "$STRECKE" != "1" ]; then
    # Ohne --strecke gibt es keinen Writer - der Punkt wird dann ausdruecklich
    # NICHT gefahren, statt aus „die Box hat gesendet" ein Urteil zu machen.
    melde "4 samples 2.0 im writer" nicht_gefahren \
      "ohne --strecke laeuft die Kette Datenannahme->Redpanda->Writer->TimescaleDB nicht" ""
  else
    strecke_hoch
    local v0 vs0 fenster
    v0="$(verwurf voltpilot_writer_verworfen_total)"
    vs0="$(verwurf voltpilot_writer_verworfene_samples_total)"
    # Die Auswahl, die die Box am Simulator DES TAGS wirklich lesen kann - Bytes
    # aus dem Erzeuger der Cloud (MeasurementContractsTest
    # #nw3AuswahlAmSimulatorIstDieFestgenagelteNutzlast), hier unveraendert zugestellt.
    zustellen "v2/measurement-config" "$E/mqtt-measurement-config.valid.nw3-simulator.json" -r
    if warte_auf "v2/measurement-config-status" \
        'd.get("revision")==8 and not d.get("rejected") and d.get("accepted")==["custom.sim.soc"]' 60; then
      local eq
      eq="$(letzte v2/measurement-config-status | python3 -c 'import json,sys; print(json.load(sys.stdin).get("edge_version",""))')"
      if [ "$eq" = "$STEMPEL" ]; then
        melde "4a mess-quittung nennt die auswahl angewandt" gruen \
          "revision 8 angewandt, accepted=[custom.sim.soc], rejected leer, edge_version=$eq (Stempel des Tags)" \
          "$(letzte v2/measurement-config-status)"
      else
        melde "4a mess-quittung nennt die auswahl angewandt" rot \
          "angewandt, aber edge_version=$eq statt $STEMPEL" "$(letzte v2/measurement-config-status)"
      fi
    else
      melde "4a mess-quittung nennt die auswahl angewandt" rot \
        "die Box hat die lesbare Auswahl nicht angewandt" "$(letzte v2/measurement-config-status)"
    fi
    fenster="${NW3_MESSFENSTER_S:-70}"
    echo "    Messfenster: $fenster s bei Kadenz 10 s"
    sleep "$fenster"
    # ⚠ Reihenfolge: ERST die Datenbank, DANN der Draht. So ist der Draht die
    # spaetere Seite - ein Umschlag aus dem Spalt dazwischen ist „noch unterwegs"
    # und nicht „verloren". Andersherum saehe jede Zeile aus dem Spalt wie eine
    # Zeile ohne Umschlag aus, und der Pruefstand meldete einen falschen Befund.
    docker exec "$SDB" psql -qtAX -U voltpilot -d voltpilot -c \
      "SELECT to_char(time AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS')||'Z'||' '||edge_sequence||' '||raw_numeric||' '||decoded_numeric||' '||quality||' '||catalog_version \
       FROM device_measurement_sample WHERE point_key='custom.sim.soc' ORDER BY time" \
      > "$ARBEIT/zeilen-punkt4.txt" 2>/dev/null || : > "$ARBEIT/zeilen-punkt4.txt"
    # Die Umschlaege, die die ECHTE Box gesendet hat - aus dem Mitschnitt am
    # Broker, also aus dem Draht, nicht aus einem Log.
    mitschnitt > "$ARBEIT/mitschnitt-punkt4.txt"
    local urteil
    urteil="$(python3 "$REPO/tools/nw3-box-image/strecke_pruefen.py" \
      --mitschnitt "$ARBEIT/mitschnitt-punkt4.txt" --zeilen "$ARBEIT/zeilen-punkt4.txt" \
      --basis "$BASIS" --punkt custom.sim.soc)"
    local gesendet geschrieben
    gesendet="$(printf '%s' "$urteil" | python3 -c 'import json,sys; print(json.load(sys.stdin)["gesendet"])')"
    geschrieben="$(printf '%s' "$urteil" | python3 -c 'import json,sys; print(json.load(sys.stdin)["geschrieben"])')"
    if printf '%s' "$urteil" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["ok"] else 1)'; then
      melde "4b samples der box landen als rohzeilen" gruen \
        "$gesendet Umschlaege der ausgelieferten Box (Vertrag 2.0, Topic-Identitaet = Umschlag-Identitaet), $geschrieben Rohzeilen in device_measurement_sample - bis zum Wasserstand dieselben Messzeiten" \
        "$urteil"
    else
      melde "4b samples der box landen als rohzeilen" rot \
        "$gesendet gesendet, $geschrieben geschrieben: $(printf '%s' "$urteil" | python3 -c 'import json,sys; print(json.load(sys.stdin)["grund"])')" \
        "$urteil"
    fi
    local v1 vs1
    v1="$(verwurf voltpilot_writer_verworfen_total)"
    vs1="$(verwurf voltpilot_writer_verworfene_samples_total)"
    if [ "$v1" = "$v0" ] && [ "$vs1" = "$vs0" ]; then
      melde "4c beide verwurf-familien bleiben 0" gruen \
        "voltpilot_writer_verworfen_total $v0 -> $v1, voltpilot_writer_verworfene_samples_total $vs0 -> $vs1" \
        "$(metrik_text | grep '^voltpilot_writer_verworfen' | tr '\n' '|')"
      else
      melde "4c beide verwurf-familien bleiben 0" rot \
        "der Writer hat verworfen: Umschlaege $v0 -> $v1, Samples $vs0 -> $vs1" \
        "$(metrik_text | grep '^voltpilot_writer_verworfen' | tr '\n' '|')"
    fi
  fi

  # (5) Handeingriff ------------------------------------------------------
  echo "==> (5) Handeingriff setzen und aufheben (H7)"
  python3 "$REPO/tools/nw3-box-image/nutzlast.py" push \
    --vorlage "$E/edge-entity.valid.registry-push.json" \
    --revision "uems-registry:4713" --pause-sekunden 3600 --aus "$ARBEIT/push-hand.json"
  zustellen "v2/entities" "$ARBEIT/push-hand.json" -r
  if warte_auf "status" 'd.get("entities",{}).get("revision")=="uems-registry:4713"' 45; then
    melde "5a handeingriff setzen" gruen "Pause mit Ende angenommen" "$(letzte status)"
  else
    melde "5a handeingriff setzen" rot "Pause nicht angenommen" "$(letzte status)"
  fi
  python3 "$REPO/tools/nw3-box-image/nutzlast.py" push \
    --vorlage "$E/edge-entity.valid.registry-push.json" \
    --revision "uems-registry:4714" --aus "$ARBEIT/push-hand-auf.json"
  zustellen "v2/entities" "$ARBEIT/push-hand-auf.json" -r
  if warte_auf "status" 'd.get("entities",{}).get("revision")=="uems-registry:4714"' 45; then
    melde "5b handeingriff aufheben" gruen "Aufhebung angenommen" "$(letzte status)"
  else
    melde "5b handeingriff aufheben" rot "Aufhebung nicht angenommen" "$(letzte status)"
  fi

  # (6) Ruhe mit rollierendem Ende, Box laenger getrennt als das Ende -----
  echo "==> (6) Ruhe bis zum Start + Trennung laenger als das rollierende Ende (Zeitraffer)"
  # Die neue Cloud sendet fuer eine Ruhe BEIDE Felder (RuheRegel.push):
  # automation_paused_until_revoked=true UND ein rollierendes Ende = jetzt + 4 h,
  # „das Ende existiert NUR fuer eine aeltere Box". Der Zeitraffer staucht die
  # vier Stunden auf Sekunden - derselbe Codepfad, gestauchte Uhr.
  python3 "$REPO/tools/nw3-box-image/nutzlast.py" push \
    --vorlage "$E/edge-entity.valid.registry-push.json" \
    --revision "uems-registry:4715" --ruhe-sekunden "${NW3_RUHE_S:-20}" \
    --aus "$ARBEIT/push-ruhe.json"
  zustellen "v2/entities" "$ARBEIT/push-ruhe.json" -r
  BAT="5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f"
  if warte_auf "status" 'd.get("entities",{}).get("revision")=="uems-registry:4715"' 45; then
    melde "6a ruhe zugestellt" gruen \
      "Ruhe angenommen: rollierendes Ende gelesen, automation_paused_until_revoked ueberlesen" \
      "$(letzte status)"
  else
    melde "6a ruhe zugestellt" rot "Ruhe nicht angenommen" "$(letzte status)"
  fi
  # Waehrend die Ruhe haelt, darf der Planer die Batterie NICHT halten.
  if warte_auf "status" \
      "d.get('entities',{}).get('arbitration',{}).get('$BAT',{}).get('source') != 'plan'" 20; then
    melde "6b ruhe haelt" gruen \
      "waehrend der Ruhe haelt der Planer die Batterie nicht (Schiedsspruch nicht 'plan')" \
      "$(letzte status)"
  else
    melde "6b ruhe haelt" rot \
      "die zugestellte Ruhe wirkt an der ausgelieferten Box gar nicht" "$(letzte status)"
  fi
  echo "    trenne die Box vom Netz (laenger als das rollierende Ende)"
  docker network disconnect "$NETZ" "$KERN" >/dev/null 2>&1 || true
  sleep "$(( ${NW3_RUHE_S:-20} + 10 ))"
  # ⚠ MIT --alias: `docker network connect` ohne Alias gibt dem Container NUR
  # seine Kurz-ID zurueck, nicht den Compose-Namen. Layer 1 faende danach
  # `core:1883` nicht mehr - ein Schaden des PRUEFSTANDS, kein Befund an der Box.
  docker network connect --alias core "$NETZ" "$KERN" >/dev/null 2>&1 || true
  echo "    Box wieder am Netz — was sagt sie jetzt?"
  sleep 30
  # X7/W12: das rollierende Ende ist waehrend der Trennung verstrichen und die
  # Cloud konnte es nicht erneuern. Setzt die Automatik von selbst wieder ein?
  if warte_auf "status" \
      "d.get('entities',{}).get('arbitration',{}).get('$BAT',{}).get('source') == 'plan'" 30; then
    melde "6c nach trennung laenger als das ende" befund \
      "die Ruhe ist an der ausgelieferten Box abgelaufen und die Automatik setzt von selbst wieder ein — das ist die schwaechere Zusage aus X7, jetzt gemessen" \
      "$(letzte status)"
  else
    melde "6c nach trennung laenger als das ende" gruen \
      "die Box ruht nach der Rueckkehr weiter" "$(letzte status)"
  fi

  # (7) „Update noetig fuer: …" -------------------------------------------
  echo "==> (7) Was die Cloud fuer DIESEN gemeldeten Stand auf UEMS-Flaechen sagt (X2)"
  python3 "$REPO/tools/nw3-box-image/faehigkeiten.py" \
    --stand "$STAND" \
    --tabelle "$REPO/docs/contracts/v2/edge-capabilities.json" \
    --aus "$ARBEIT/faehigkeiten.json"
  local text
  text="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rest"])' "$ARBEIT/faehigkeiten.json")"
  if [ "$text" = "Update nötig für: Rückmeldung je Datenquelle, Zuständigkeit ab Zeitpunkt" ]; then
    melde "7 update noetig" gruen "$text" "$(cat "$ARBEIT/faehigkeiten.json")"
  else
    melde "7 update noetig" rot "unerwarteter Satz: $text" "$(cat "$ARBEIT/faehigkeiten.json")"
  fi
}

# --- Lauf ------------------------------------------------------------------
echo "=== NW-3: ausgeliefertes Box-Image gegen die neue Cloud"
echo "    Repo-Stand (neue Cloud): $(git -C "$REPO" rev-parse HEAD)"
echo "    Paar-Liste:              $PAARE"

ANZ="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["paare"]))' "$PAARE")"
[ "$ANZ" -ge 1 ] || { echo "keine Paare in $PAARE" >&2; exit 2; }

for i in $(seq 0 $((ANZ-1))); do
  NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["paare"][int(sys.argv[2])]["name"])' "$PAARE" "$i")"
  CORE_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["paare"][int(sys.argv[2])]["core_ref"])' "$PAARE" "$i")"
  PAL_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["paare"][int(sys.argv[2])]["palette_ref"])' "$PAARE" "$i")"
  echo
  echo "=== Paar $NAME (core=$CORE_REF, palette=$PAL_REF)"
  bauen "$CORE_REF" "$PAL_REF"
  stack_hoch "$CORE_REF"
  hauptlauf "$CORE_REF"
  mitschnitt > "$ARBEIT/mitschnitt-$NAME.txt"
done

python3 "$REPO/tools/nw3-box-image/protokoll.py" \
  --befunde "$BEFUNDE" --aus "$PROTOKOLL" \
  --repo-stand "$(git -C "$REPO" rev-parse HEAD)" \
  --paar "$NAME" --core-ref "$CORE_REF" --palette-ref "$PAL_REF" \
  --tag-sha "$SHA" --stempel "$STEMPEL" \
  --kern-stempel "$KERN_STEMPEL" --palette-stempel "$PAL_STEMPEL" \
  --palette-marke "$PAL_MARKE" --palette-pruefung "$PAL_PRUEFUNG" \
  --gemeldeter-stand "$STAND" --strecke "$STRECKE"

echo
echo "=== Protokoll: $PROTOKOLL"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["zusammenfassung"])' "$PROTOKOLL"

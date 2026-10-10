#!/usr/bin/env bash
# Demo-Umgebung zum Durchklicken - das ganze Produkt lokal, nie gegen Produktion.
#
#   demo.sh start [--neu]
#       Baut auf der Prüfumgebung Ahrenberg auf (ahrenberg.sh aufbauen: Stapel,
#       Seed 1.4, Welt der Referenzdatei 1.10, Bühnen-Uhr 30.04.2029) und startet
#       dazu die Live-Strecke (EMQX, Redpanda, ingest, writer, simulierte Box der
#       Anlage „Demo“), Marktdaten, Wetter, Prognose, Optimierer, Simulation und
#       das gebaute Portal auf http://localhost:5173. Legt einmal die Demo-Zugänge
#       an (Einsicht bei Ahrenberg, zwei Demo-Kundenbereiche für das Vertragsende).
#       Idempotent; `--neu` baut Portal und Images neu.
#   demo.sh rundgang        EIN Login `rundgang` (Kundenadministrator bei Ahrenberg), der jede UEMS-Fläche
#                           mit Daten sieht: richtet „Messen & Auswerten“ an beiden Standorten ein und legt
#                           Ablesungen (MS-20) und Monatswerte (BZ-1) ab 10/2024 an (DemoRundgangAufbau);
#                           dazu MS-03, die automatisch von der Mess-Seite der Box Halle 1 liest.
#                           Teil von `start`; einzeln für eine laufende Demo, idempotent.
#   demo.sh mispel          MiSpeL: vier Kundenbereiche (Gewerbe, drei Haushalte) mit je einem Login, jede
#                           MiSpeL-Fläche mit Daten (DemoMispelAufbau). Teil von `start`, idempotent.
#   demo.sh wallbox [golf]  die Wallbox von Haus Albers meldet ihren Ladestand jetzt (frisch für fünf Minuten);
#                           `golf` steckt ein Auto ohne Rückspeise-Funktion an.
#   demo.sh stop            hält alle Container an, Daten bleiben.
#   demo.sh status          Zustand je Dienst, Datenfrische, Speicher; Exit ≠ 0, wenn etwas fehlt.
#   demo.sh zuruecksetzen   Container UND Volumes des Projekts weg, danach `start`.
#
# Eigenes Compose-Projekt `voltpilot-demo`. Die Dienste tragen die festen
# container_name des Stapels (voltpilot-*): ein Entwicklungs-Stapel oder die
# Prüfumgebung daneben geht nicht - das Skript bricht dann ab und fasst nichts an.
#
# Zugänge: die Logins des lokalen Realms (infra/local/keycloak/voltpilot-realm.json)
# und die hier angelegten Konten. Deren Passwörter erzeugt das Skript zufällig und
# schreibt sie nur nach $DEMO_ZUGANG (Vorgabe ~/.voltpilot-demo/zugang.txt, Rechte 600).
#
# Voraussetzungen: Docker, JDK 21 (JAVA_HOME), Node.js 22, curl, python3.
set -euo pipefail

HIER="$(cd "$(dirname "$0")" && pwd)"
WURZEL="$(cd "$HIER/../../.." && pwd)"
PROJEKT=voltpilot-demo
ZUSATZ="$HIER/docker-compose.demo.yml"
API="http://localhost:${API_PORT:-8090}"
KEYCLOAK="http://localhost:${KEYCLOAK_PORT:-8081}"
PORTAL="http://localhost:${PORTAL_PORT:-5173}"
DEMO_ZUGANG="${DEMO_ZUGANG:-$HOME/.voltpilot-demo/zugang.txt}"
PROFILE=(--profile edge --profile sim --profile feeds --profile optimize --profile demo)
# Was `start` zusätzlich zu ahrenberg.sh hochfährt (edge-nodered/edge-sim und flowc bleiben aus:
# die simulierte Box ist `edge-simulator`, die Aktivierung von Flows ist lokal abgeschaltet).
LIVE=(emqx redpanda redpanda-init ingest writer edge-simulator
  edge-sim-ahrenberg-halle1 edge-mess-ahrenberg-halle1 edge-sim-ahrenberg-halle2 edge-sim-ahrenberg-lindach
  market-data weather-collector forecast-collector optimizer simulation portal)
DEMO_TENANT=00000000-0000-0000-0000-000000000001
AHRENBERG_TENANT=20000000-0000-0000-0000-000000000001
ENDE_NAME="Demo-Kunde Vertragsende GmbH"
PROBE_NAME="Demo-Kunde zum Ausprobieren GmbH"

compose() {
  docker compose -p "$PROJEKT" --project-directory "$WURZEL" -f "$WURZEL/docker-compose.yml" \
    -f "$WURZEL/infra/local/pruefumgebung/docker-compose.pruefumgebung.yml" -f "$ZUSATZ" "${PROFILE[@]}" "$@"
}

ahrenberg() {
  PRUEFUMGEBUNG_PROJEKT="$PROJEKT" PRUEFUMGEBUNG_COMPOSE_ZUSATZ="$ZUSATZ" \
    "$WURZEL/infra/local/pruefumgebung/ahrenberg.sh" "$@"
}

psql_demo() {
  docker exec voltpilot-timescaledb psql -U "${POSTGRES_USER:-voltpilot}" -d "${POSTGRES_DB:-voltpilot}" -tAc "$1"
}

jdk21() {
  if ! "${JAVA_HOME:-/nonexistent}/bin/java" -version 2>&1 | grep -q 'version "21'; then
    for kandidat in /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21; do
      if [ -x "$kandidat/bin/java" ]; then
        export JAVA_HOME="$kandidat"
        return
      fi
    done
    echo "Demo: JDK 21 fehlt (JAVA_HOME)." >&2
    exit 1
  fi
}

fremde_container() {
  docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}' \
    | awk -v p="$PROJEKT" '$1 ~ /^voltpilot-/ && $2 != p {print $1}'
}

portal_bauen() {
  # VITE_API_BASE leer: das Portal ruft /api auf derselben Adresse, nginx reicht an die api weiter.
  (cd "$WURZEL/frontend/portal" && npm ci --no-audit --no-fund >/dev/null && VITE_API_BASE= npm run build >/dev/null)
  compose build portal
}

token() { # token <benutzer> <passwort>
  curl -fsS -d grant_type=password -d client_id=voltpilot-frontend -d username="$1" -d password="$2" \
    "$KEYCLOAK/realms/voltpilot/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

kc_admin_token() {
  curl -fsS -d grant_type=password -d client_id=admin-cli -d username="${KEYCLOAK_ADMIN:-admin}" \
    -d password="${KEYCLOAK_ADMIN_PASSWORD:-voltpilot_dev_pw}" "$KEYCLOAK/realms/master/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

kc_user_id() { # kc_user_id <admin-token> <benutzername> -> id oder leer
  curl -fsS -H "Authorization: Bearer $1" "$KEYCLOAK/admin/realms/voltpilot/users?exact=true&username=$2" \
    | python3 -c 'import json,sys; u=json.load(sys.stdin); print(u[0]["id"] if u else "")'
}

# Das einmalige Startpasswort der Produkt-Wege ersetzt die Demo durch ein festes, zufälliges Passwort
# ohne Pflichtwechsel - nur im lokalen Realm, nur für die hier angelegten Konten. Steht das Konto schon in
# $DEMO_ZUGANG (etwa nach `zuruecksetzen`), bekommt es dasselbe Passwort wieder: ausgegebene Zugänge bleiben gültig.
passwort_setzen() { # passwort_setzen <benutzername> <rolle-im-klartext> <kundenbereich>
  local admin id pw
  admin="$(kc_admin_token)"
  id="$(kc_user_id "$admin" "$1")"
  mkdir -p "$(dirname "$DEMO_ZUGANG")"
  touch "$DEMO_ZUGANG"
  chmod 600 "$DEMO_ZUGANG"
  pw="$(awk -F'\t' -v u="$1" '$1 == u {print $2; exit}' "$DEMO_ZUGANG")"
  if [ -z "$pw" ]; then
    pw="$(python3 -c 'import secrets; print("Demo-" + secrets.token_urlsafe(9))')"
    printf '%s\t%s\t%s\t%s\n' "$1" "$pw" "$2" "$3" >>"$DEMO_ZUGANG"
  fi
  curl -fsS -X PUT -H "Authorization: Bearer $admin" -H 'Content-Type: application/json' \
    -d "{\"type\":\"password\",\"value\":\"$pw\",\"temporary\":false}" \
    "$KEYCLOAK/admin/realms/voltpilot/users/$id/reset-password"
  curl -fsS -X PUT -H "Authorization: Bearer $admin" -H 'Content-Type: application/json' \
    -d '{"requiredActions":[]}' "$KEYCLOAK/admin/realms/voltpilot/users/$id"
}

einsicht_anlegen() {
  local admin
  admin="$(kc_admin_token)"
  if [ -n "$(kc_user_id "$admin" pruefer)" ]; then
    return
  fi
  ahrenberg einsicht pruefer@ahrenberg-demo.example 365 Paula Prüfer >/dev/null
  passwort_setzen pruefer "Einsicht (Fachperson, befristet)" "Kunststoffwerk Ahrenberg"
}

# Der Rundgang (Captain 27.09.2026): die Welt 1.10 legt „Messen & Auswerten“ nie an - ohne messenden Standort blendet
# das Portal alle UEMS-Bereiche aus (ebenenNav.ts, ebenenBereiche). Dazu Messwerte und Bezugsgrößen ab 10/2024.
api_gesund() { # wartet höchstens 15 Minuten, bis die api antwortet
  local i
  for i in $(seq 1 90); do
    if curl -fsS "$API/health" >/dev/null 2>&1; then
      return
    fi
    sleep 10
  done
  echo "Demo: die api antwortet nach 15 Minuten nicht." >&2
  exit 1
}

# Die api mit ein- oder ausgeschalteter Auffälligkeits- und Berichts-Naht neu starten (nur dieser Dienst), dann
# nginx frisch verbinden - es löst `api` beim Start auf.
api_naht() { # api_naht true|false
  VOLTPILOT_UEMS_VERBESSERUNG_ENABLED="$1" VOLTPILOT_UEMS_BERICHTE_ENABLED="$1" compose up -d --no-deps api
  api_gesund
  if docker inspect voltpilot-portal >/dev/null 2>&1; then
    docker restart voltpilot-portal >/dev/null
  fi
}

rundgang_anlegen() {
  local admin t body
  # Messen-Bau m2: die Mess-Seite der Box Halle 1, aus der MS-03 automatisch liest - vor dem Rundgang gestartet,
  # damit sie den Messwert lernt, sobald die api ihn zustellt; ohne einen anderen Dienst anzufassen (`--no-deps`;
  # in `start` läuft sie schon mit LIVE).
  compose up -d --build --no-deps edge-mess-ahrenberg-halle1
  jdk21
  # Demo-Füllung Verbessern und Nachweisen: der Rundgang rechnet die Bühne bis 03/2029 mit stummer Auffälligkeits-Naht
  # und vermerkt die Auffälligkeiten danach mit ihrem Tag; Nachweisen läuft erst danach. Die Demo-API läuft so lange
  # ebenfalls mit beiden Nähten stumm (Review #1454 M2) - ihr Takt (Kaskade alle fünf Minuten) rechnete die Ablesungen
  # des Rundgangs sonst nebenher, vermerkte jeden Monat mit der Bühnen-Uhr und stieße Berichte an, bevor Verbessern
  # und Nachweisen die Kaskade sehen; sie bleibt aber erreichbar (die Mess-Box Halle 1 lernt MS-03 von ihr).
  api_naht false
  trap 'api_naht true' EXIT
  (cd "$WURZEL/services/api" && ./mvnw -q test -Dtest=DemoRundgangAufbau -Dsurefire.failIfNoSpecifiedTests=false \
    -Drundgang.jdbc="jdbc:postgresql://localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-voltpilot}")
  trap - EXIT
  api_naht true
  admin="$(kc_admin_token)"
  if [ -n "$(kc_user_id "$admin" rundgang)" ]; then
    return
  fi
  t="$(token jonas jonas)"
  body='{"username":"rundgang","email":"rundgang@ahrenberg-demo.example","vorname":"Rundgang","nachname":"Vorführung",
    "rolle":"kundenadministrator","standorte":[],"gueltig_bis":null}'
  curl -fsS -o /dev/null -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d "$body" "$API/api/v1/benutzer"
  passwort_setzen rundgang "Kundenadministrator (Rundgang: alle UEMS-Flächen)" "Kunststoffwerk Ahrenberg"
}

admin_api() { # admin_api <methode> <pfad> [json]
  local t
  t="$(token admin admin)"
  if [ "$#" -ge 3 ]; then
    curl -fsS -X "$1" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d "$3" "$API$2"
  else
    curl -fsS -X "$1" -H "Authorization: Bearer $t" "$API$2"
  fi
}

tenant_id() { # tenant_id <name> -> id oder leer
  admin_api GET /api/v1/admin/tenants | python3 -c 'import json,sys
n=sys.argv[1]
print(next((t["id"] for t in json.load(sys.stdin) if t["name"] == n), ""))' "$1"
}

# Ein Demo-Kundenbereich mit Standort und Kundenadministrator - über die Betreiber-Routen des Portals.
kundenbereich_anlegen() { # kundenbereich_anlegen <name> <benutzername> <ort> <lat> <lon> [CI|B2C]
  local id body
  id="$(tenant_id "$1")"
  if [ -z "$id" ]; then
    body="$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "segment": sys.argv[2]}))' "$1" "${6:-CI}")"
    id="$(admin_api POST /api/v1/admin/tenants "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
    body="$(python3 -c 'import json,sys
print(json.dumps({"name": sys.argv[1], "biddingZone": "DE-LU", "latitude": float(sys.argv[2]),
                  "longitude": float(sys.argv[3])}))' "$3" "$4" "$5")"
    admin_api POST "/api/v1/admin/tenants/$id/sites" "$body" >/dev/null
  fi
  if [ -z "$(kc_user_id "$(kc_admin_token)" "$2")" ]; then
    body="$(python3 -c 'import json,sys
print(json.dumps({"username": sys.argv[1], "email": sys.argv[1] + "@demo.example", "firstName": "Demo",
                  "lastName": "Kundenadministrator"}))' "$2")"
    admin_api POST "/api/v1/admin/tenants/$id/users" "$body" >/dev/null
    passwort_setzen "$2" "Kundenadministrator" "$1"
  fi
  echo "$id"
}

vertragsende_anlegen() {
  local id zustand body
  id="$(kundenbereich_anlegen "$ENDE_NAME" vertragsende "Werk Nord" 53.55 9.99)"
  kundenbereich_anlegen "$PROBE_NAME" ausprobieren "Lager Süd" 48.14 11.58 >/dev/null
  zustand="$(psql_demo "SELECT CASE WHEN beendet_am IS NULL THEN 'aktiv' ELSE 'beendet' END FROM tenant WHERE id = '$id'")"
  if [ "$zustand" = "aktiv" ]; then
    body="$(python3 -c 'import json,sys
print(json.dumps({"auftrag": "Demo: Kündigung zum Vertragsende", "begruendung": "Demo-Umgebung: Vertragsende zeigen",
                  "confirmName": sys.argv[1], "fristTage": 90}))' "$ENDE_NAME")"
    admin_api POST "/api/v1/admin/tenants/$id/beenden" "$body" >/dev/null
  fi
}

# MiSpeL (Captain 05.10.2026): je Kundenart ein Login, der jede MiSpeL-Fläche mit Daten sieht. Kundenbereiche und
# Kundenadministratoren über die Betreiber-Routen, alles Weitere über DemoMispelAufbau (Testquelle, nur mit
# -Dmispel.jdbc): Förderwege, Zählerrollen, Werte des Messstellenbetreibers, Monats- und Jahreslauf, Check, Wallbox.
mispel_anlegen() {
  kundenbereich_anlegen "Demo MiSpeL Gewerbe GmbH" mispel-gewerbe "Kühlhaus Seebach" 48.05 11.21 >/dev/null
  kundenbereich_anlegen "Haus Kröger" haus-kroeger "Haus Kröger" 53.08 8.80 B2C >/dev/null
  kundenbereich_anlegen "Haus Sommer" haus-sommer "Haus Sommer" 50.94 6.96 B2C >/dev/null
  kundenbereich_anlegen "Haus Albers" haus-albers "Haus Albers" 52.37 9.73 B2C >/dev/null
  mispel_werkzeug
}

# demo.sh wallbox [golf]: die Wallbox von Haus Albers meldet ihren Ladestand jetzt (die Karte zeigt ihn nur, solange er
# jünger als fünf Minuten ist) und bekommt den Plan des Tages, falls er fehlt; `golf` steckt ein Auto ohne
# Rückspeise-Funktion an.
mispel_werkzeug() { # mispel_werkzeug [familienauto|golf]
  jdk21
  (cd "$WURZEL/services/api" && ./mvnw -q test -Dtest=DemoMispelAufbau -Dsurefire.failIfNoSpecifiedTests=false \
    -Dmispel.jdbc="jdbc:postgresql://localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-voltpilot}" \
    ${1:+-Dmispel.wallbox="$1"})
}

start() {
  local fremd
  fremd="$(fremde_container)"
  if [ -n "$fremd" ]; then
    echo "Demo: diese Container gehören zu einem anderen Stapel: $(echo $fremd) - erst dort abräumen." >&2
    exit 1
  fi
  jdk21
  if [ "${1:-}" = "--neu" ] || ! docker image inspect voltpilot-demo-portal >/dev/null 2>&1; then
    portal_bauen
  fi
  ahrenberg aufbauen
  compose up -d --build "${LIVE[@]}"
  # nginx löst `api` beim Start auf - nur nach einem neu gestarteten api-Container frisch verbinden.
  if [[ "$(docker inspect -f '{{.State.StartedAt}}' voltpilot-api)" > "$(docker inspect -f '{{.State.StartedAt}}' voltpilot-portal)" ]]; then
    docker restart voltpilot-portal >/dev/null
  fi
  einsicht_anlegen
  vertragsende_anlegen
  rundgang_anlegen
  mispel_anlegen
  echo
  echo "Demo läuft: $PORTAL  (Zugänge: $DEMO_ZUGANG und die Logins des lokalen Realms)"
  echo "Prognose und Fahrplan brauchen nach dem ersten Start bis zu 15 Minuten; Stand: $0 status"
}

stop() {
  compose stop
}

zeile() { printf '  %-22s %s\n' "$1" "$2"; }

status() {
  local rot=0 t alter n
  echo "Dienste (Projekt $PROJEKT):"
  for dienst in timescaledb keycloak api demo-seed "${LIVE[@]}"; do
    t="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}/{{.State.ExitCode}}' \
      "voltpilot-$dienst" 2>/dev/null || echo fehlt)"
    case "$dienst:$t" in
      demo-seed:exited//0 | redpanda-init:exited//0) zeile "$dienst" "fertig" ;;
      *:running/healthy/*) zeile "$dienst" "läuft, gesund" ;;
      *:running//*) zeile "$dienst" "läuft" ;;
      *) zeile "$dienst" "ROT: $t"; rot=1 ;;
    esac
  done
  echo "Adressen:"
  if curl -fsS "$API/health" >/dev/null 2>&1; then zeile api "$API ok"; else zeile api "ROT: $API"; rot=1; fi
  if curl -fsS "$PORTAL/healthz" >/dev/null 2>&1; then zeile portal "$PORTAL ok"; else zeile portal "ROT: $PORTAL"; rot=1; fi
  echo "Daten:"
  n="$(psql_demo "SELECT count(*) FROM feststellung_wirksamkeit WHERE tenant_id = '$AHRENBERG_TENANT'" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -gt 0 ]; then zeile "Welt Ahrenberg 1.10" "steht"; else zeile "Welt Ahrenberg 1.10" "ROT: fehlt"; rot=1; fi
  alter="$(psql_demo "SELECT coalesce(round(extract(epoch FROM now() - max(time)))::int, -1) FROM telemetry WHERE tenant_id = '$DEMO_TENANT'" 2>/dev/null || echo -1)"
  if [ "${alter:--1}" -ge 0 ] && [ "$alter" -le 120 ]; then zeile "Messwerte Demo-Box" "vor ${alter} s"; else zeile "Messwerte Demo-Box" "ROT: letzte vor ${alter} s"; rot=1; fi
  n="$(psql_demo "SELECT count(*) FROM day_ahead_prices WHERE ts >= date_trunc('day', now())" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -gt 0 ]; then zeile "Marktpreise ab heute" "$n Werte"; else zeile "Marktpreise ab heute" "noch keine (Marktdaten brauchen Internet)"; fi
  n="$(psql_demo "SELECT count(DISTINCT time) FROM schedule WHERE tenant_id = '$DEMO_TENANT' AND time >= now()" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -gt 0 ]; then zeile "Fahrplan Demo" "$n Viertelstunden voraus"; else zeile "Fahrplan Demo" "noch keiner (Optimierer-Takt 15 min)"; fi
  echo "Speicher:"
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(docker ps -q --filter "label=com.docker.compose.project=$PROJEKT") \
    | python3 -c 'import re,sys
eh={"B":1,"KiB":1024,"MiB":1024**2,"GiB":1024**3}
summe=0
for z in sys.stdin:
    name,rest=z.split(" ",1)
    m=re.match(r"([\d.]+)(\w+)",rest.strip())
    summe+=float(m.group(1))*eh[m.group(2)]
    print("  %-30s %s" % (name, rest.split("/")[0].strip()))
print("  %-30s %.2f GiB" % ("Summe", summe/1024**3))'
  return "$rot"
}

zuruecksetzen() {
  compose down -v --remove-orphans
  start --neu
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  status) status ;;
  rundgang) rundgang_anlegen ;;
  mispel) mispel_anlegen ;;
  wallbox) mispel_werkzeug "${2:-familienauto}" ;;
  zuruecksetzen) zuruecksetzen ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac

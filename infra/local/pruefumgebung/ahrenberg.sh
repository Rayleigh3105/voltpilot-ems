#!/usr/bin/env bash
# Prüfumgebung Ahrenberg (UEMS AP-20 IP-13, E5, PD1, PD2) - lokal.
#
#   ahrenberg.sh aufbauen
#       Stapel (timescaledb, keycloak, api) im eigenen Compose-Projekt, Seed 1.4
#       (Dienst demo-seed), darauf die Welt der Referenzdatei 1.10 über den
#       Welt-Aufbau der Abnahme (PruefumgebungAhrenbergAufbau). Idempotent.
#   ahrenberg.sh einsicht <email> <tage> [vorname] [nachname]
#       Jonas Wendlinger (Kundenadministrator von Ahrenberg) vergibt der
#       Fachperson ein Konto mit der Rolle „Einsicht“, befristet - über
#       POST /api/v1/benutzer, den Weg des Portals. Die Frist zählt auf der
#       Bühne (sie startet am 30.04.2029 und läuft in echter Zeit weiter):
#       letzter Tag = Bühnen-Heute + <tage>, also nach <tage> echten Tagen.
#       Gibt das einmalige Startpasswort aus (Pflichtwechsel beim ersten
#       Anmelden).
#   ahrenberg.sh abraeumen
#       Container UND Volumes des Projekts `voltpilot-pruefumgebung`.
#
# Voraussetzungen: Docker, JDK 21 (JAVA_HOME) für den Maven-Wrapper, curl,
# python3. Die Umgebung für die Fachperson erreichbar machen (Adresse,
# Portal, Zugangsweg) ist Hand des Betreibers - dieses Skript bindet nur an
# localhost. Nichts hier berührt Produktion.
set -euo pipefail

WURZEL="$(cd "$(dirname "$0")/../../.." && pwd)"
PROJEKT=voltpilot-pruefumgebung
API="http://localhost:${API_PORT:-8090}"
KEYCLOAK="http://localhost:${KEYCLOAK_PORT:-8081}"
JDBC="jdbc:postgresql://localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-voltpilot}"
compose() {
  docker compose -p "$PROJEKT" --project-directory "$WURZEL" -f "$WURZEL/docker-compose.yml" \
    -f "$WURZEL/infra/local/pruefumgebung/docker-compose.pruefumgebung.yml" "$@"
}

aufbauen() {
  # Die Dienste tragen feste container_name - ein laufender Entwicklungs-Stapel
  # hieße genauso. Nicht daneben starten, nichts davon anfassen.
  fremd="$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}' \
    | awk -v p="$PROJEKT" '$1 ~ /^voltpilot-(timescaledb|keycloak|api|demo-seed)$/ && $2 != p {print $1}')"
  if [ -n "$fremd" ]; then
    echo "Prüfumgebung: diese Container gehören zu einem anderen Stapel: $fremd - erst dort abräumen." >&2
    exit 1
  fi
  compose up -d --build timescaledb keycloak api
  compose up -d demo-seed
  code="$(docker wait voltpilot-demo-seed)"
  if [ "$code" != "0" ]; then
    compose logs demo-seed >&2
    exit 1
  fi
  i=0
  until curl -fsS "$API/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "Prüfumgebung: die api antwortet nach 15 Minuten nicht." >&2
      exit 1
    fi
    sleep 10
  done
  (cd "$WURZEL/services/api" && ./mvnw -q test -Dtest=PruefumgebungAhrenbergAufbau \
    -Dsurefire.failIfNoSpecifiedTests=false -Dpruefumgebung.jdbc="$JDBC")
  echo "Prüfumgebung steht: $API (Bühne ab 30.04.2029). Weiter: $0 einsicht <email> <tage>"
}

einsicht() {
  email="${1:?email fehlt}"
  tage="${2:?Zahl der Tage fehlt}"
  vorname="${3:-}"
  nachname="${4:-}"
  token="$(curl -fsS -d grant_type=password -d client_id=voltpilot-frontend -d username=jonas -d password=jonas \
    "$KEYCLOAK/realms/voltpilot/protocol/openid-connect/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
  # Bühnen-Heute aus dem Stichtag des Verzeichnisses (Europe/Berlin).
  bis="$(curl -fsS -H "Authorization: Bearer $token" "$API/api/v1/energiemanagement/verzeichnis" \
    | python3 -c 'import datetime,json,sys
heute=datetime.date.fromisoformat(json.load(sys.stdin)["stichtag"][:10])
print(heute + datetime.timedelta(days=int(sys.argv[1])))' "$tage")"
  body="$(python3 -c 'import json,sys
e,b,v,n=sys.argv[1:5]
print(json.dumps({"username": e.split("@")[0], "email": e, "vorname": v or None, "nachname": n or None,
                  "rolle": "einsicht", "standorte": [], "gueltig_bis": b}))' "$email" "$bis" "$vorname" "$nachname")"
  antwort="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$body" "$API/api/v1/benutzer")"
  status="${antwort##*$'\n'}"
  if [ "$status" != "201" ]; then
    echo "Prüfumgebung: POST /api/v1/benutzer antwortete $status: ${antwort%$'\n'*}" >&2
    exit 1
  fi
  printf '%s' "${antwort%$'\n'*}" | python3 -c 'import json,sys
a=json.load(sys.stdin)
print("Einsicht-Konto angelegt (Kundenbereich Ahrenberg, letzter Tag auf der Bühne " + sys.argv[1] + ", in " + sys.argv[2] + " echten Tagen):")
print("  Anmeldename: " + a["benutzer"]["email"])
print("  Startpasswort (nur jetzt sichtbar, Wechsel beim ersten Anmelden): " + a["startpasswort"])' "$bis" "$tage"
}

abraeumen() {
  compose down -v --remove-orphans
}

case "${1:-}" in
  aufbauen) aufbauen ;;
  einsicht) shift; einsicht "$@" ;;
  abraeumen) abraeumen ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac

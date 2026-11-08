#!/usr/bin/env bash
# Messlabor der Performance-Baseline (docs/performance/perf-baseline.md).
# Eigene Wegwerf-Container (vp-perf-*) auf einem eigenen Portbereich, nie der Demo- oder Entwicklungsstapel.
#
#   labor.sh start              DB (TimescaleDB + pg_stat_statements), Keycloak unter /auth, nginx mit der Prod-nginx.conf
#   labor.sh api <jar> [port]   api-Jar auf dem Host gegen das Labor (wartet auf readiness, druckt die Startzeit)
#   labor.sh portal             Portal-Build (VITE_API_BASE leer) und ausliefern über den Labor-nginx
#   labor.sh befuellen          vier Monate Bestand für demo2 ("Zuhause"), dann die Fahrplan-Jobs wie im Betrieb
#   labor.sh lebendig           Boxen von demo und demo2 alle 10 s melden lassen (Hintergrund)
#   labor.sh stop               eigene Prozesse per PID beenden, Container und Netz entfernen
#
# Portbereich: VP_PERF_PORTS (Standard 157) ergibt DB ${P}41, Keycloak ${P}42, api ${P}43, Portal ${P}44.
# Arbeitsverzeichnis (Logs, PIDs, Realm, nginx.conf, Bundle): VP_PERF_WERK (Standard $TMPDIR/vp-perf-labor).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
hier="$(cd "$(dirname "$0")" && pwd -P)"
P="${VP_PERF_PORTS:-157}"
DB_PORT="${P}41" KC_PORT="${P}42" API_PORT="${P}43" WEB_PORT="${P}44"
werk="${VP_PERF_WERK:-${TMPDIR:-/tmp}/vp-perf-labor}"
JAVA_HOME="${VP_JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home}"
mkdir -p "$werk"

psql_labor() { docker exec -i vp-perf-db psql -U voltpilot -d voltpilot -v ON_ERROR_STOP=1 "$@"; }

start() {
  docker network inspect vp-perf-net >/dev/null 2>&1 || docker network create vp-perf-net >/dev/null
  docker run -d --name vp-perf-db --network vp-perf-net -p "127.0.0.1:${DB_PORT}:5432" \
    -e POSTGRES_USER=voltpilot -e POSTGRES_PASSWORD=voltpilot_dev_pw -e POSTGRES_DB=voltpilot \
    timescale/timescaledb:2.17.2-pg16 \
    postgres -c shared_preload_libraries=timescaledb,pg_stat_statements -c max_connections=200 -c shared_buffers=1GB >/dev/null
  # Das Image startet einmal einen Init-Server und danach den echten: erst das zweite "ready" zählt.
  until [ "$(docker logs vp-perf-db 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do sleep 1; done
  psql_labor -qc "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"

  python3 - "$repo_root/infra/local/keycloak/voltpilot-realm.json" "$werk/voltpilot-realm.json" "$WEB_PORT" <<'PY'
import json, sys
quelle, ziel, port = sys.argv[1], sys.argv[2], sys.argv[3]
realm = json.load(open(quelle))
for c in realm['clients']:
    if c['clientId'] == 'voltpilot-frontend':
        c['redirectUris'].append(f'http://localhost:{port}/*')
        c['webOrigins'].append(f'http://localhost:{port}')
json.dump(realm, open(ziel, 'w'), indent=1)
PY
  docker run -d --name vp-perf-kc --network vp-perf-net -p "127.0.0.1:${KC_PORT}:8080" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    -e KC_HTTP_RELATIVE_PATH=/auth -e "KC_HOSTNAME=http://localhost:${WEB_PORT}/auth" -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true \
    -v "$werk/voltpilot-realm.json:/opt/keycloak/data/import/voltpilot-realm.json:ro" \
    quay.io/keycloak/keycloak:26.0.5 start-dev --import-realm >/dev/null

  # Die Prod-nginx.conf (gzip, Cache-Header, CSP), nur die Upstreams und das Schema auf das Labor gebogen.
  sed -e "s#proxy_pass http://api:8090;#proxy_pass http://host.docker.internal:${API_PORT};#" \
      -e 's#proxy_pass http://keycloak:8080;#proxy_pass http://vp-perf-kc:8080;#' \
      -e "s#proxy_set_header X-Forwarded-Port 443;#proxy_set_header X-Forwarded-Port ${WEB_PORT};#" \
      -e "s#^    ''      https;#    ''      http;#" \
      "$repo_root/frontend/portal/nginx.conf" > "$werk/nginx.conf"
  mkdir -p "$werk/html"
  docker run -d --name vp-perf-web --network vp-perf-net --add-host=host.docker.internal:host-gateway \
    -p "127.0.0.1:${WEB_PORT}:80" -v "$werk/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$werk/html:/usr/share/nginx/html:ro" nginx:1.27-alpine >/dev/null
  until curl -sf -o /dev/null "http://localhost:${KC_PORT}/auth/realms/voltpilot/.well-known/openid-configuration"; do sleep 2; done
  echo "Labor steht: DB ${DB_PORT}, Keycloak ${KC_PORT}, Portal http://localhost:${WEB_PORT} (api: labor.sh api <jar>)"
}

api() {
  local jar="$1" port="${2:-$API_PORT}"
  local log="$werk/api-${port}.log"
  local t0; t0="$(python3 -c 'import time; print(time.time())')"
  # Profil local (Dev-Seed), OIDC an; MQTT, Keycloak-Admin und Simulation zeigen auf tote Ports.
  env API_PORT="$port" POSTGRES_JDBC_URL="jdbc:postgresql://localhost:${DB_PORT}/voltpilot" \
    POSTGRES_USER=voltpilot POSTGRES_PASSWORD=voltpilot_dev_pw SPRING_PROFILES_ACTIVE=local \
    VOLTPILOT_SECURITY_OIDC_ENABLED=true \
    OIDC_ISSUER_URI="http://localhost:${WEB_PORT}/auth/realms/voltpilot" \
    OIDC_JWK_SET_URI="http://localhost:${KC_PORT}/auth/realms/voltpilot/protocol/openid-connect/certs" \
    VOLTPILOT_CORS_ALLOWED_ORIGINS="http://localhost:${WEB_PORT}" \
    MQTT_BROKER_URL=tcp://127.0.0.1:1 KEYCLOAK_ADMIN_BASE_URL=http://127.0.0.1:1/auth \
    VOLTPILOT_SIMULATION_BASE_URL=http://127.0.0.1:1 VOLTPILOT_UEMS_DATA_SOURCE_STATUS_MQTT_LISTENER_ENABLED=false \
    nohup "$JAVA_HOME/bin/java" -Xmx2g -jar "$jar" > "$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$werk/api-${port}.pid"
  while ps -p "$pid" >/dev/null; do
    if curl -s -m 2 "http://localhost:${port}/health/readiness" | grep -q '"UP"'; then
      python3 -c "import time; print(f'api ${port} (PID ${pid}) bereit nach {time.time() - ${t0}:.1f} s')"
      grep -o "Started ApiApplication in [0-9.]* seconds" "$log" || true
      grep -o "Successfully applied [0-9]* migrations.*" "$log" || true
      return 0
    fi
    sleep 1
  done
  echo "api beendet sich - $log"; tail -20 "$log"; return 1
}

portal() {
  (cd "$repo_root/frontend/portal" && VITE_API_BASE= VITE_KEYCLOAK_URL="http://localhost:${WEB_PORT}/auth" \
    npx vite build --outDir "$werk/dist" --emptyOutDir)
  # In das gemountete Verzeichnis kopieren: ein neu angelegtes Verzeichnis sähe der Container nicht.
  find "$werk/html" -mindepth 1 -delete
  cp -R "$werk/dist/." "$werk/html/"
  (cd "$werk" && python3 "$hier/bundle.py" "$werk/dist")
}

befuellen() {
  psql_labor < "$hier/befuellung-4-monate.sql" > "$werk/befuellung.log"
  # Wie im Betrieb: die Kompaktierung überholter Fahrplan-Läufe und die Tagestabelle der Sparzeile.
  for job in schedule_compaction_job schedule_savings_1d_job; do
    id="$(psql_labor -Atc "SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = '$job'")"
    psql_labor -qc "CALL run_job($id);"
  done
  psql_labor -qc "ANALYZE;"
  psql_labor -Atc "SELECT 'schedule demo2: ' || count(*) FROM schedule WHERE site_id = '10000000-0000-0000-0000-000000000002'"
}

lebendig() {
  nohup "$hier/box-meldet.sh" 10000000-0000-0000-0000-000000000001 10000000-0000-0000-0000-000000000002 \
    10000000-0000-0000-0000-000000000003 >/dev/null 2>&1 &
  echo $! >> "$werk/lebendig.pids"
  nohup "$hier/box-meldet.sh" 00000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-000000000002 \
    00000000-0000-0000-0000-000000000003 >/dev/null 2>&1 &
  echo $! >> "$werk/lebendig.pids"
  echo "Boxen von demo2 und demo melden alle 10 s (PIDs in $werk/lebendig.pids)"
}

stop() {
  for f in "$werk"/api-*.pid "$werk/lebendig.pids"; do
    [ -f "$f" ] || continue
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$f"
    rm -f "$f"
  done
  docker rm -f vp-perf-web vp-perf-kc vp-perf-db >/dev/null 2>&1 || true
  docker network rm vp-perf-net >/dev/null 2>&1 || true
  echo "Labor entfernt"
}

case "${1:-}" in
  start) start ;;
  api) shift; api "$@" ;;
  portal) portal ;;
  befuellen) befuellen ;;
  lebendig) lebendig ;;
  stop) stop ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac

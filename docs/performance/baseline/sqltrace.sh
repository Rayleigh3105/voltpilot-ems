#!/bin/bash
# SQL-Kosten EINES Endpunkts: Aufruf zum Aufwärmen, pg_stat_statements leeren, ein Aufruf, dann die Statements der
# App-Rolle seither (ms, Aufrufe, Zeilen, Buffer, Text). Usage: sqltrace.sh <user> <pfad> [label]
# Die @Scheduled-Jobs der api laufen mit; einzelne Fremd-Statements (etwa expire_ocpp_actions) gehören nicht zum Endpunkt.
export LC_ALL=C; P="${VP_PERF_PORTS:-157}"; USER=$1; PATHX=$2; LABEL=${3:-x}
TOK=$(curl -s -X POST "http://localhost:${P}42/auth/realms/voltpilot/protocol/openid-connect/token" -d "grant_type=password&client_id=voltpilot-frontend&username=$USER&password=$USER" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -o /dev/null -H "Authorization: Bearer $TOK" "http://localhost:${P}44$PATHX"   # warm-up
docker exec vp-perf-db psql -U voltpilot -d voltpilot -Atc "SELECT pg_stat_statements_reset();" >/dev/null
t=$(curl -s -o /dev/null -w "%{time_starttransfer}" -H "Authorization: Bearer $TOK" "http://localhost:${P}44$PATHX")
echo "## $LABEL $PATHX ttfb=${t}s"
docker exec vp-perf-db psql -U voltpilot -d voltpilot -Atc "SELECT round(total_exec_time::numeric,1) AS ms, calls, rows, shared_blks_hit+shared_blks_read AS blks, regexp_replace(left(query,160), E'[\\n\\r ]+', ' ', 'g') FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname='voltpilot_app') AND query NOT ILIKE 'set %' AND query NOT ILIKE 'select set_config%' AND query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 25;"

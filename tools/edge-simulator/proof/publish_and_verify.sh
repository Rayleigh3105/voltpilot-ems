#!/usr/bin/env bash
###############################################################################
# publish_and_verify.sh - reproducible proof that simulator telemetry lands in
# TimescaleDB via the live ingest pipe.
#
# It publishes N messages with the standalone simulator, then queries the
# TimescaleDB `telemetry` hypertable and shows the freshly-landed rows.
#
# PREREQUISITES: the live ingest path must be running, i.e. from the repo root:
#     cp .env.example .env    # once
#     docker compose --profile edge up -d --build \
#         timescaledb emqx redpanda redpanda-init ingest timescale-writer
#   (the `edge` profile carries ingest + timescale-writer; api provides the
#    schema/RLS role the writer needs, so include it if the DB is fresh:
#     docker compose up -d api )
#
# Then run this script from anywhere:
#     tools/edge-simulator/proof/publish_and_verify.sh
#
# Env overrides: HOST (default localhost), PORT (1883), COUNT (20),
#   DEVICE_ID/SITE_ID/TENANT_ID (default the demo seed), PG_SERVICE (timescaledb).
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SIM_DIR/../.." && pwd)"

HOST="${HOST:-localhost}"
PORT="${PORT:-1883}"
COUNT="${COUNT:-20}"
INTERVAL="${INTERVAL:-0.5}"
TENANT_ID="${TENANT_ID:-00000000-0000-0000-0000-000000000001}"
SITE_ID="${SITE_ID:-00000000-0000-0000-0000-000000000002}"
DEVICE_ID="${DEVICE_ID:-00000000-0000-0000-0000-000000000003}"
PG_SERVICE="${PG_SERVICE:-timescaledb}"
PG_USER="${PG_USER:-voltpilot}"
PG_DB="${PG_DB:-voltpilot}"

echo "==> 1/3  baseline row count for device ${DEVICE_ID}"
count_rows() {
  docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T "$PG_SERVICE" \
    psql -U "$PG_USER" -d "$PG_DB" -At -c \
    "SELECT count(*) FROM telemetry WHERE device_id = '${DEVICE_ID}';"
}
before="$(count_rows || echo 0)"
echo "    rows before: ${before}"

echo "==> 2/3  publishing ${COUNT} telemetry messages via the standalone simulator"
# time-scale 600 sweeps a chunk of a day so the values visibly vary; --count exits cleanly.
python3 "$SIM_DIR/voltpilot_edge_sim.py" \
  --host "$HOST" --port "$PORT" \
  --tenant-id "$TENANT_ID" --site-id "$SITE_ID" --device-id "$DEVICE_ID" \
  --count "$COUNT" --interval "$INTERVAL" --time-scale 600 --status-interval 5 --verbose

echo "==> waiting for the ingest pipe (EMQX -> ingest -> Redpanda -> writer -> TimescaleDB)"
sleep 5

echo "==> 3/3  verifying rows landed in TimescaleDB"
after="$(count_rows)"
echo "    rows after:  ${after}"

echo
echo "Latest 10 rows for this device (proof the payload mapped into columns):"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T "$PG_SERVICE" \
  psql -U "$PG_USER" -d "$PG_DB" -c \
  "SELECT time, device_id, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw
     FROM telemetry
    WHERE device_id = '${DEVICE_ID}'
    ORDER BY time DESC
    LIMIT 10;"

echo
if [ "${after}" -gt "${before}" ]; then
  echo "PROOF PASSED: ${after} >= ${before} + published; simulator telemetry reached TimescaleDB."
else
  echo "PROOF FAILED: row count did not grow (before=${before}, after=${after})." >&2
  echo "  Check that the 'edge' profile ingest + timescale-writer are healthy:" >&2
  echo "    docker compose ps ingest writer" >&2
  echo "    docker compose logs --tail=50 ingest writer" >&2
  exit 1
fi

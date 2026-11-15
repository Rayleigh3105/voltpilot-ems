#!/bin/bash
# Tauscht den api-Jar im Labor und wartet auf Bereitschaft: api-tauschen.sh <jar-name> [envfile]
set -u
cd "$(dirname "$0")"
N=$1; E=${2:-api.env}
docker rm -f vpls-api-1 >/dev/null 2>&1
for alt in $(docker ps -a --format '{{.Names}}' | grep '_vpls-api-1$'); do docker rm -f "$alt" >/dev/null 2>&1; done
WT=$(git rev-parse --show-toplevel) JAR=$PWD/jars/$N.jar ENVFILE=$E docker compose -f compose.yml --profile jvm up -d api >/dev/null 2>&1
sleep 20
for i in $(seq 1 120); do
  curl -s -m 5 http://127.0.0.1:25090/health/readiness 2>/dev/null | grep -q '"UP"' && { echo "api $N bereit nach $((20 + i*5)) s ($(date +%T))"; exit 0; }
  sleep 5
done
echo "api $N NICHT bereit"; exit 1

#!/bin/bash
# Kunden-Anfragen unter Hintergrundlast: admin-pool-last.sh <label> <sekunden> <parallel>
# Je Schleife ein anderer lt-Kunde, GET /api/v1/sites (jede Kunden-Anfrage prueft ueber die Admin-Rolle,
# ob der Kundenbereich beendet ist). Misst Antwortzeiten und die Hikari-Wartezeiten aller Pools.
set -u
cd "$(dirname "$0")"
L=$1; S=$2; P=$3; OUT=results/$L; mkdir -p "$OUT"
uptime > "$OUT/uptime-start.txt"
curl -s -m 20 localhost:25090/metrics | grep -E '^hikaricp_connections_(acquire_seconds|pending|max|active)' > "$OUT/hikari-start.txt"
: > "$OUT/pending.txt"
( while [ ! -f "$OUT/fertig" ]; do curl -s -m 5 localhost:25090/metrics | grep -E '^hikaricp_connections_(pending|active)\{' | tr '\n' ' ' >> "$OUT/pending.txt"; echo >> "$OUT/pending.txt"; sleep 2; done ) &
ENDE=$(( $(date +%s) + S ))
PIDS=""
for ((j=1; j<=P; j++)); do
  ( TOK=$(python3 -I mint.py lt-kunde-$((j*7))); while [ "$(date +%s)" -lt "$ENDE" ]; do
      curl -s -o /dev/null -w "%{http_code} %{time_total}\n" -m 60 -H "Authorization: Bearer $TOK" localhost:25090/api/v1/sites; done ) > "$OUT/zeiten-$j.txt" &
  PIDS="$PIDS $!"
done
wait $PIDS
touch "$OUT/fertig"; sleep 3
curl -s -m 20 localhost:25090/metrics | grep -E '^hikaricp_connections_(acquire_seconds|pending|max|active)' > "$OUT/hikari-end.txt"
uptime > "$OUT/uptime-end.txt"
cat "$OUT"/zeiten-*.txt | sort -k2 -n | awk '{a[NR]=$2; if($1!="200")f++} END {printf "Anfragen %d, Fehler %d, p50 %.3f s, p95 %.3f s, max %.3f s\n", NR, f, a[int(NR*0.5)], a[int(NR*0.95)], a[NR]}'

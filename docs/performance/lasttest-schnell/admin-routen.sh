#!/bin/bash
# Arbeit je Aufruf der drei Admin-Flottenrouten: admin-routen.sh <label> [aufrufe] [parallel]
# Je Route: pg_stat_statements zuruecksetzen, <aufrufe> Abrufe in Wellen zu <parallel> (wie offene Tabs),
# danach Anweisungen/Buffer der Rollen voltpilot_admin+voltpilot_app und Zeiten.
set -u
cd "$(dirname "$0")"
L=$1; N=${2:-5}; P=${3:-1}; OUT=results/$L; mkdir -p "$OUT"
TOK=$(python3 -I mint.py admin)
uptime > "$OUT/uptime.txt"
for R in fleet edge-updates devices; do
  ./q.sh -c "select pg_stat_statements_reset()" >/dev/null
  : > "$OUT/zeiten-$R.txt"
  for ((i=0; i<N; i+=P)); do
    for ((j=0; j<P; j++)); do
      curl -s -o /dev/null -w "%{http_code} %{time_total} %{size_download}\n" -m 120 -H "Authorization: Bearer $TOK" "localhost:25090/api/v1/admin/$R" >> "$OUT/zeiten-$R.txt" &
    done
    wait
  done
  ./q.sh -c "select userid::regrole, sum(calls), round(sum(total_exec_time)::numeric), sum(shared_blks_hit+shared_blks_read) from pg_stat_statements where dbid=(select oid from pg_database where datname='voltpilot') and userid::regrole::text in ('voltpilot_admin','voltpilot_app') group by 1 order by 1" > "$OUT/sql-$R.txt"
  ./q.sh -c "select calls, round(total_exec_time::numeric,1), regexp_replace(left(query,160), '\s+', ' ', 'g') from pg_stat_statements where dbid=(select oid from pg_database where datname='voltpilot') and userid::regrole::text in ('voltpilot_admin','voltpilot_app') order by calls desc limit 8" > "$OUT/top-$R.txt"
  echo "== $R"; cat "$OUT/sql-$R.txt"; awk '{n++; s+=$2; if($2>m)m=$2} END {printf "Abrufe %d, Mittel %.2f s, max %.2f s\n", n, s/n, m}' "$OUT/zeiten-$R.txt"; head -1 "$OUT/zeiten-$R.txt"
done

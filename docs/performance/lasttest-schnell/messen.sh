#!/bin/bash
# Messfenster: messen.sh <label> <sekunden>
# Setzt pg_stat_statements zurueck, wartet, schreibt Top-Anweisungen, Scheduler-Laufzeiten und uptime.
set -u
cd "$(dirname "$0")"
L=$1; S=$2; OUT=results/$L
mkdir -p "$OUT"
uptime > "$OUT/uptime-start.txt"
./q.sh -c "select pg_stat_statements_reset()" >/dev/null
curl -s -m 90 localhost:25090/metrics > "$OUT/metrics-start.txt"
date +%s > "$OUT/t_start"
sleep "$S"
date +%s > "$OUT/t_end"
curl -s -m 90 localhost:25090/metrics > "$OUT/metrics-end.txt"
./q.sh -c "select round(total_exec_time::numeric,1), calls, round(mean_exec_time::numeric,3), rows, shared_blks_hit+shared_blks_read, userid::regrole, regexp_replace(left(query,300), '\s+', ' ', 'g') from pg_stat_statements where dbid=(select oid from pg_database where datname='voltpilot') order by total_exec_time desc limit 80" > "$OUT/pg_top.txt"
./q.sh -c "select userid::regrole, sum(calls), round(sum(total_exec_time)::numeric), sum(shared_blks_hit+shared_blks_read) from pg_stat_statements where dbid=(select oid from pg_database where datname='voltpilot') group by 1 order by 1" > "$OUT/pg_total.txt"
uptime > "$OUT/uptime-end.txt"
echo "messen $L fertig"

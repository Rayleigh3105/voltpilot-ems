#!/usr/bin/env bash
# =============================================================================
# vp-db-backup-check.sh - der Alterscheck: faellt das Backup aus, faellt es AUF.
#
# Prueft gegen den laufenden TimescaleDB-Container (alles per docker exec):
#   1. juengstes abgeschlossenes Basis-Backup ist juenger als --max-base-age-hours
#      (Default 26 h: taeglicher Timer + Luft fuer RandomizedDelay/Laufzeit),
#   2. juengste WAL-Archivdatei ist juenger als --max-wal-age-minutes
#      (Default 60 min; archive_timeout=300 erzwingt auch bei wenig Verkehr
#      spaetestens alle 5 min ein Segment - 60 min ist also grosszuegig),
#   3. archive_mode=on und der Archiver ist nicht im Fehlerzustand
#      (letzter Fehlschlag neuer als letzter Erfolg = er scheitert GERADE;
#      genau so faellt ein vergessenes `install -d -o 70` binnen einer Stunde
#      auf, bevor pg_wal die Platte fuellt).
#
# Exit 0 = alles ok (eine OK-Zeile je Pruefung); Exit 1 = mindestens ein
# CRITICAL (Zeile sagt was). Gedacht fuer den stuendlichen systemd-Timer
# (tools/backup/systemd/) bzw. cron; ein fehlgeschlagener Lauf ist in
# `systemctl --failed` / journalctl sichtbar. docs/backup-restore.md.
# =============================================================================
set -euo pipefail

PROJECT="voltpilot"
DB_SERVICE="timescaledb"
DB_CONTAINER=""
MAX_BASE_AGE_HOURS=26
MAX_WAL_AGE_MINUTES=60

usage() {
  cat <<'EOF'
Usage: vp-db-backup-check.sh [options]
  --project NAME              Compose-Projekt (Default: voltpilot)
  --db-service NAME           Compose-Service der DB (Default: timescaledb)
  --container NAME            Container direkt (statt Compose-Aufloesung)
  --max-base-age-hours N      Alarm, wenn das juengste Basis-Backup aelter ist (Default: 26)
  --max-wal-age-minutes N     Alarm, wenn das juengste WAL-Archiv aelter ist (Default: 60)
EOF
}

FAIL=0
ok()   { printf 'OK        %s\n' "$*"; }
crit() { printf 'CRITICAL  %s\n' "$*"; FAIL=1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project)             PROJECT=$2; shift 2 ;;
    --db-service)          DB_SERVICE=$2; shift 2 ;;
    --container)           DB_CONTAINER=$2; shift 2 ;;
    --max-base-age-hours)  MAX_BASE_AGE_HOURS=$2; shift 2 ;;
    --max-wal-age-minutes) MAX_WAL_AGE_MINUTES=$2; shift 2 ;;
    -h|--help)             usage; exit 0 ;;
    *) usage >&2; printf 'unbekannte Option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { crit "docker nicht gefunden"; exit 1; }

if [ -z "$DB_CONTAINER" ]; then
  DB_CONTAINER=$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$DB_SERVICE" \
    --format '{{.Names}}' | head -1)
fi
if [ -z "$DB_CONTAINER" ] || ! docker exec "$DB_CONTAINER" true 2>/dev/null; then
  crit "TimescaleDB-Container laeuft nicht (Projekt=$PROJECT Service=$DB_SERVICE) - kein Backup UND keine Datenbank"
  exit 1
fi

PGUSER=$(docker exec "$DB_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo voltpilot)
PGDB=$(docker exec "$DB_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo voltpilot)
psqlq() { docker exec "$DB_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -Atc "$1"; }

# --- 1. Alter des juengsten Basis-Backups ------------------------------------
NEWEST=$(docker exec "$DB_CONTAINER" sh -c 'ls /backup/base 2>/dev/null' \
  | { grep -E '^[0-9]{8}T[0-9]{6}Z$' || true; } | sort | tail -1)
if [ -z "$NEWEST" ]; then
  crit "kein abgeschlossenes Basis-Backup unter /backup/base (lief vp-db-backup.sh je?)"
else
  ISO="${NEWEST:0:4}-${NEWEST:4:2}-${NEWEST:6:2} ${NEWEST:9:2}:${NEWEST:11:2}:${NEWEST:13:2}+00"
  AGE_S=$(psqlq "SELECT floor(extract(epoch FROM now() - '$ISO'::timestamptz))::bigint")
  AGE_H=$((AGE_S / 3600))
  if [ "$AGE_S" -gt $((MAX_BASE_AGE_HOURS * 3600)) ]; then
    crit "juengstes Basis-Backup $NEWEST ist ${AGE_H} h alt (Schwelle ${MAX_BASE_AGE_HOURS} h) - Timer pruefen: systemctl status vp-db-backup.timer"
  else
    ok "Basis-Backup $NEWEST (${AGE_H} h alt, Schwelle ${MAX_BASE_AGE_HOURS} h)"
  fi
fi

# --- 2. Alter der juengsten WAL-Archivdatei ----------------------------------
# Alter im Container gerechnet (eine Uhr fuer mtime UND now).
WAL_AGE_S=$(docker exec "$DB_CONTAINER" sh -c '
  newest=$(ls -t /backup/wal/*.gz 2>/dev/null | head -1)
  if [ -z "$newest" ]; then echo -1; else expr "$(date +%s)" - "$(stat -c %Y "$newest")"; fi' || echo -1)
if [ "$WAL_AGE_S" -lt 0 ]; then
  crit "keine WAL-Archivdatei unter /backup/wal (Overlay aktiv? Verzeichnis-Besitz uid 70?)"
elif [ "$WAL_AGE_S" -gt $((MAX_WAL_AGE_MINUTES * 60)) ]; then
  crit "juengste WAL-Archivdatei ist $((WAL_AGE_S / 60)) min alt (Schwelle ${MAX_WAL_AGE_MINUTES} min) - Archivierung steht"
else
  ok "WAL-Archiv aktuell (juengste Datei $((WAL_AGE_S / 60)) min alt, Schwelle ${MAX_WAL_AGE_MINUTES} min)"
fi

# --- 3. Archiver-Zustand -----------------------------------------------------
ARCHIVE_MODE=$(psqlq "SHOW archive_mode" 2>/dev/null || echo unbekannt)
if [ "$ARCHIVE_MODE" != "on" ]; then
  crit "archive_mode=$ARCHIVE_MODE - das DB-Backup-Overlay ist nicht aktiv (DB_BACKUP=enabled + Neustart des timescaledb-Dienstes)"
else
  ok "archive_mode=on"
fi
ARCH_STATE=$(psqlq "SELECT CASE
    WHEN last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)
      THEN 'failing since '||last_failed_time||' (failed_count='||failed_count||', segment '||COALESCE(last_failed_wal,'?')||')'
    ELSE 'ok (archived_count='||archived_count||', last='||COALESCE(last_archived_wal,'-')||')'
  END FROM pg_stat_archiver" 2>/dev/null || echo unbekannt)
case "$ARCH_STATE" in
  ok*)      ok "Archiver $ARCH_STATE" ;;
  failing*) crit "Archiver $ARCH_STATE - pg_wal waechst, bis das behoben ist (docker logs $DB_CONTAINER)" ;;
  *)        crit "Archiver-Zustand nicht lesbar" ;;
esac

exit "$FAIL"

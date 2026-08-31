#!/usr/bin/env bash
# =============================================================================
# vp-db-restore.sh - Wiederherstellung der TimescaleDB aus Basis-Backup + WAL.
#
# Braucht NUR docker, dieses Skript und die Backup-Dateien - bewusst keine
# weitere Repo-Datei, damit der Disaster-Fall minimal abhaengt (das Image
# bringt alle Postgres-Werkzeuge mit, su-exec inklusive). Das Runbook mit dem
# vollstaendigen Prod-Ablauf steht in docs/backup-restore.md.
#
# Es materialisiert ein FERTIGES Datenverzeichnis in ein leeres Docker-Volume
# (oder Host-Verzeichnis): Basis-Backup entpacken, restore_command auf das
# gzip-WAL-Archiv zeigen, Recovery in einem Wegwerf-Container bis zum Ende
# (bzw. bis --target-time) laufen lassen, Promotion abwarten, sauber stoppen.
# Danach haengt man das Volume an den normalen Compose-Dienst.
#
# PHYSISCHER Restore: byte-genau, kompressionstransparent (die komprimierten
# forecast-Chunks kommen als dieselben Bytes zurueck). timescaledb_pre_restore/
# timescaledb_post_restore sind Werkzeuge des LOGISCHEN pg_dump/pg_restore-Wegs
# und hier weder noetig noch korrekt - Hintergrund in docs/backup-restore.md.
#
# Das Backup-Verzeichnis wird ausschliesslich READ-ONLY eingehaengt: eine
# Wiederherstellung darf die Backups niemals beschaedigen koennen.
#
# Beispiele:
#   # juengstes Backup, in ein frisches Volume:
#   vp-db-restore.sh --backup /srv/backup/voltpilot-db --dest-volume voltpilot_timescale-data --yes
#   # Point-in-Time (Zeitstempel MIT Zeitzonen-Offset angeben):
#   vp-db-restore.sh --backup /srv/backup/voltpilot-db --from 20260831T024000Z \
#       --target-time '2026-08-31 07:12:00+00' --dest-volume restore-probe --yes
# =============================================================================
set -euo pipefail

BACKUP_MOUNT=""
FROM="latest"
DEST_VOLUME=""
DEST_DIR=""
IMAGE="timescale/timescaledb:2.17.2-pg16"
TARGET_TIME=""
TIMEOUT=3600
PGUSER="voltpilot"
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: vp-db-restore.sh --backup <PFAD|VOLUME> (--dest-volume NAME | --dest-dir PFAD) [options]
  --backup PFAD|VOLUME  Backup-Wurzel (enthaelt base/ und wal/); Host-Pfad
                        (absolut) oder Docker-Volume. Wird READ-ONLY gemountet.
  --from ID|latest      Basis-Backup (Verzeichnisname unter base/), Default latest
  --dest-volume NAME    Ziel: Docker-Volume (wird angelegt, MUSS leer sein)
  --dest-dir PFAD       Ziel: Host-Verzeichnis (absolut, MUSS leer sein)
  --image IMG           Postgres-Image (Default: timescale/timescaledb:2.17.2-pg16
                        - MUSS zur Major-Version des Backups passen)
  --target-time TS      Point-in-Time-Ziel, z. B. '2026-08-31 07:12:00+00'
                        (mit Offset angeben; muss NACH dem Ende des Basis-Backups
                        liegen). Ohne: Wiederherstellung bis zum Ende des Archivs.
  --pg-user NAME        Superuser-Rolle des Clusters (Default: voltpilot)
  --timeout SEC         Gesamtbudget fuer die Recovery (Default: 3600)
  --yes                 keine Rueckfrage
EOF
}

log() { printf '%s vp-db-restore: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { printf '%s vp-db-restore: FEHLER: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup)      BACKUP_MOUNT=$2; shift 2 ;;
    --from)        FROM=$2; shift 2 ;;
    --dest-volume) DEST_VOLUME=$2; shift 2 ;;
    --dest-dir)    DEST_DIR=$2; shift 2 ;;
    --image)       IMAGE=$2; shift 2 ;;
    --target-time) TARGET_TIME=$2; shift 2 ;;
    --pg-user)     PGUSER=$2; shift 2 ;;
    --timeout)     TIMEOUT=$2; shift 2 ;;
    --yes)         ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) usage >&2; die "unbekannte Option: $1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker nicht gefunden"
[ -n "$BACKUP_MOUNT" ] || { usage >&2; die "--backup fehlt"; }
if [ -n "$DEST_VOLUME" ] && [ -n "$DEST_DIR" ]; then die "--dest-volume und --dest-dir schliessen sich aus"; fi
if [ -z "$DEST_VOLUME" ] && [ -z "$DEST_DIR" ]; then usage >&2; die "Ziel fehlt (--dest-volume oder --dest-dir)"; fi
case "$BACKUP_MOUNT" in
  /*) [ -d "$BACKUP_MOUNT" ] || die "Backup-Verzeichnis $BACKUP_MOUNT existiert nicht" ;;
  *)  docker volume inspect "$BACKUP_MOUNT" >/dev/null 2>&1 || die "Docker-Volume $BACKUP_MOUNT existiert nicht" ;;
esac

brun() { docker run --rm -v "$BACKUP_MOUNT:/backup:ro" --entrypoint sh "$IMAGE" -c "$1"; }

# --- Basis-Backup aufloesen --------------------------------------------------
if [ "$FROM" = "latest" ]; then
  FROM=$(brun 'ls /backup/base 2>/dev/null' | { grep -E '^[0-9]{8}T[0-9]{6}Z$' || true; } | sort | tail -1)
  [ -n "$FROM" ] || die "kein abgeschlossenes Basis-Backup unter base/ gefunden"
fi
brun "test -s '/backup/base/$FROM/base.tar.gz'" || die "base/$FROM/base.tar.gz fehlt oder ist leer"
log "Basis-Backup: $FROM"
[ -n "$TARGET_TIME" ] && log "Point-in-Time-Ziel: $TARGET_TIME"

# --- Ziel vorbereiten (MUSS leer sein - niemals still ueberschreiben) --------
if [ -n "$DEST_DIR" ]; then
  case "$DEST_DIR" in /*) ;; *) die "--dest-dir muss absolut sein" ;; esac
  mkdir -p "$DEST_DIR"
  DEST_MOUNT=$DEST_DIR
else
  docker volume inspect "$DEST_VOLUME" >/dev/null 2>&1 || docker volume create "$DEST_VOLUME" >/dev/null
  DEST_MOUNT=$DEST_VOLUME
fi
docker run --rm -v "$DEST_MOUNT:/dest" --entrypoint sh "$IMAGE" \
  -c '[ -z "$(ls -A /dest)" ]' \
  || die "Ziel $DEST_MOUNT ist nicht leer - Wiederherstellung nur in ein leeres Ziel (docs/backup-restore.md)"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Wiederherstellen von base/%s nach %s%s? [ja/N] ' "$FROM" "$DEST_MOUNT" \
    "${TARGET_TIME:+ (bis $TARGET_TIME)}"
  read -r answer
  [ "$answer" = "ja" ] || die "abgebrochen"
fi

# --- Recovery im Wegwerf-Container -------------------------------------------
# Alles Innere ist busybox-sh; Parameter reisen als Umgebungsvariablen. Der
# Server startet ohne TCP (listen_addresses='') und ohne Archivierung - die
# schaltet erst der normale Compose-Dienst (Overlay) wieder ein.
IN_CONTAINER=$(cat <<'EOSH'
set -eu
PGDATA=/var/lib/postgresql/data
B="/backup/base/$VP_FROM"
[ -z "$(ls -A "$PGDATA")" ] || { echo "Ziel nicht leer" >&2; exit 1; }
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"
echo "vp-db-restore: entpacke $B/base.tar.gz ..."
su-exec postgres tar -xzf "$B/base.tar.gz" -C "$PGDATA"
{
  echo "restore_command = 'sh -c \"test -f /backup/wal/%f.gz && gunzip -c /backup/wal/%f.gz > %p\"'"
  if [ -n "${VP_TARGET_TIME:-}" ]; then
    echo "recovery_target_time = '$VP_TARGET_TIME'"
    echo "recovery_target_action = 'promote'"
  fi
} >> "$PGDATA/postgresql.auto.conf"
chown postgres:postgres "$PGDATA/postgresql.auto.conf"
su-exec postgres touch "$PGDATA/recovery.signal"
echo "vp-db-restore: starte Recovery (WAL-Replay aus /backup/wal) ..."
su-exec postgres pg_ctl -D "$PGDATA" -w -t "$VP_TIMEOUT" -l /tmp/vp-restore.log start \
  -o "-c listen_addresses='' -c archive_mode=off" \
  || { echo "vp-db-restore: Serverstart fehlgeschlagen:" >&2; tail -100 /tmp/vp-restore.log >&2; exit 1; }
deadline=$(( $(date +%s) + VP_TIMEOUT ))
i=0
while :; do
  if ! su-exec postgres pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    echo "vp-db-restore: Server waehrend der Recovery beendet - Log:" >&2
    tail -100 /tmp/vp-restore.log >&2
    exit 1
  fi
  r=$(su-exec postgres psql -U "$VP_PGUSER" -d postgres -Atc 'SELECT pg_is_in_recovery()' 2>/dev/null || echo x)
  [ "$r" = f ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "vp-db-restore: Zeitbudget ueberschritten - Log:" >&2
    tail -50 /tmp/vp-restore.log >&2
    exit 1
  fi
  i=$((i + 1))
  if [ $((i % 15)) -eq 0 ]; then
    lsn=$(su-exec postgres psql -U "$VP_PGUSER" -d postgres -Atc 'SELECT pg_last_wal_replay_lsn()' 2>/dev/null || echo '?')
    echo "vp-db-restore: Replay laeuft, LSN $lsn"
  fi
  sleep 2
done
echo "vp-db-restore: Recovery abgeschlossen, Cluster ist befoerdert."
su-exec postgres psql -U "$VP_PGUSER" -d postgres -Atc \
  "SELECT 'Zeitleiste/Segment: '||pg_walfile_name(pg_current_wal_lsn())||'  LSN: '||pg_current_wal_lsn()"
su-exec postgres psql -U "$VP_PGUSER" -d postgres -Atc \
  "SELECT 'timescaledb: '||COALESCE((SELECT extversion FROM pg_extension WHERE extname='timescaledb'), 'FEHLT')"
# Hygiene: Recovery-Parameter nicht im Datenverzeichnis zuruecklassen.
su-exec postgres psql -U "$VP_PGUSER" -d postgres -q \
  -c "ALTER SYSTEM RESET restore_command" \
  -c "ALTER SYSTEM RESET recovery_target_time" \
  -c "ALTER SYSTEM RESET recovery_target_action" 2>/dev/null || true
# Die Beförderung lief hier mit archive_mode=off, also hat die neue
# Zeitleisten-History-Datei KEINEN .ready-Marker bekommen. Der Marker wird
# nachgetragen, damit der NAECHSTE Start mit aktiver Archivierung (der normale
# Compose-Dienst mit dem Backup-Overlay) sie ins WAL-Archiv legt - ohne sie
# faende eine spaetere Wiederherstellung ueber den Zeitleisten-Wechsel hinweg
# die neue Zeitleiste nicht.
for h in "$PGDATA"/pg_wal/*.history; do
  [ -f "$h" ] || continue
  su-exec postgres sh -c ": > '$PGDATA/pg_wal/archive_status/$(basename "$h").ready'"
done
su-exec postgres psql -U "$VP_PGUSER" -d postgres -q -c CHECKPOINT
su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop
echo "vp-db-restore: Datenverzeichnis ist fertig."
EOSH
)

RUN_NAME="vpdbrestore-$$"
log "starte Wiederherstellungs-Container $RUN_NAME (Image $IMAGE)"
docker run --rm --name "$RUN_NAME" \
  -v "$DEST_MOUNT:/var/lib/postgresql/data" \
  -v "$BACKUP_MOUNT:/backup:ro" \
  -e VP_FROM="$FROM" \
  -e VP_TARGET_TIME="$TARGET_TIME" \
  -e VP_TIMEOUT="$TIMEOUT" \
  -e VP_PGUSER="$PGUSER" \
  --entrypoint sh "$IMAGE" -c "$IN_CONTAINER" \
  || die "Wiederherstellung fehlgeschlagen (Ziel $DEST_MOUNT ggf. aufraeumen, bevor es erneut versucht wird)"

log "FERTIG. Naechste Schritte (Prod-Runbook: docs/backup-restore.md):"
log "  1. Volume/Verzeichnis an den Compose-Dienst timescaledb haengen (up -d)"
log "  2. SOFORT ein frisches Basis-Backup ziehen (neue Zeitleiste verankern):"
log "     tools/backup/vp-db-backup.sh"
exit 0

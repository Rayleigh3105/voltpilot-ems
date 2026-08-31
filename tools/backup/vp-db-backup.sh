#!/usr/bin/env bash
# =============================================================================
# vp-db-backup.sh - taegliches physisches Backup der VoltPilot-Datenebene.
#
# Laeuft auf der VM (systemd-Timer/cron, siehe tools/backup/systemd/ und
# docs/backup-restore.md) gegen die LAUFENDEN Container des Compose-Projekts
# `voltpilot`. Alles geht durch `docker exec` - das Skript braucht selbst
# weder Postgres-Werkzeuge noch Zugriff auf das Backup-Verzeichnis, und die
# Werkzeug-Version ist per Konstruktion die des Server-Images.
#
# Was ein Lauf tut:
#   1. pg_basebackup der TimescaleDB ueber den Unix-Socket im Container
#      (tar + gzip + backup_manifest) nach /backup/base/<UTC-Stempel>/.
#      PHYSISCH und damit kompressionstransparent: die komprimierten
#      forecast-Chunks reisen als Bytes mit; timescaledb_pre_restore/
#      post_restore (Werkzeuge des LOGISCHEN Dumps) werden nie gebraucht.
#      --wal-method=fetch legt das waehrend des Backups entstandene WAL mit
#      ins Archivpaket - jedes Basis-Backup ist damit AUCH OHNE WAL-Archiv
#      fuer sich allein wiederherstellbar (auf den Stand seines Endes).
#   2. pg_dump der keycloak-db (klein, ohne Timescale) nach /backup/keycloak/
#      - der Verlust aller Logins waere ein eigener Totalschaden; die Kopie
#      kostet Sekunden. Der Dump reist per Pipe Container -> Container, damit
#      auch hierfuer kein Host-Pfad noetig ist.
#   3. Rotation: 7 taegliche + 4 woechentliche Basis-Backups (Begruendung in
#      docs/backup-restore.md), danach pg_archivecleanup auf das WAL-Archiv
#      bis zum Start-Segment des aeltesten BEHALTENEN Basis-Backups.
#
# Die kontinuierliche Haelfte (WAL-Archivierung nach /backup/wal) macht nicht
# dieses Skript, sondern der Server selbst - infra/prod/backup/enabled.yml +
# archive-wal.sh. Ohne sie verweigert dieses Skript den Lauf (ein Backup-System,
# das still ohne PITR-Faehigkeit weiterlaeuft, ist die Fehlerklasse, die dieses
# Repo ueberall sonst auch ablehnt); --allow-no-archive ist der ausdrueckliche
# Ausweg fuer ein einmaliges Ad-hoc-Backup vor dem Aktivieren des Overlays.
#
# Beweis: tools/backup/test-backup-restore.sh faehrt den echten Zyklus
# (seed -> backup -> zerstoeren -> restore -> identisch) in Wegwerf-Containern.
# =============================================================================
set -euo pipefail

PROJECT="voltpilot"
DB_SERVICE="timescaledb"
KC_SERVICE="keycloak-db"
DB_CONTAINER=""
KC_CONTAINER=""
KEEP_DAILY=7
KEEP_WEEKLY=4
WEEKLY_DOW=7          # ISO: 1=Montag .. 7=Sonntag; das Sonntags-Backup wird zum Wochen-Backup
SKIP_KEYCLOAK=0
NO_PRUNE=0
ALLOW_NO_ARCHIVE=0

usage() {
  cat <<'EOF'
Usage: vp-db-backup.sh [options]
  --project NAME        Compose-Projekt (Default: voltpilot)
  --db-service NAME     Compose-Service der TimescaleDB (Default: timescaledb)
  --kc-service NAME     Compose-Service der Keycloak-DB (Default: keycloak-db)
  --container NAME      TimescaleDB-Container direkt (statt Compose-Aufloesung)
  --kc-container NAME   Keycloak-DB-Container direkt
  --keep-daily N        behaltene taegliche Backups (Default: 7)
  --keep-weekly N       behaltene woechentliche Backups (Default: 4)
  --weekly-dow N        ISO-Wochentag des Wochen-Backups, 1=Mo..7=So (Default: 7)
  --skip-keycloak       keinen keycloak-db-Dump ziehen
  --no-prune            keine Rotation/kein WAL-Aufraeumen
  --allow-no-archive    Lauf trotz archive_mode=off erlauben (Ad-hoc-Backup)
  --self-test           Offline-Selbsttest der puren Logik (kein Docker) und Ende
EOF
}

log()  { printf '%s vp-db-backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { printf '%s vp-db-backup: FEHLER: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

# --- pure Logik (offline testbar via --self-test) ----------------------------

# vp_dow YYYYMMDD -> ISO-Wochentag 1..7 (Sakamoto; kein GNU/BSD-date noetig,
# damit Rotation auf macOS-Dev, Linux-VM und im Container identisch rechnet).
vp_dow() {
  local ds=$1 y m d t dow
  y=$((10#${ds:0:4})); m=$((10#${ds:4:2})); d=$((10#${ds:6:2}))
  set -- 0 3 2 5 0 3 5 1 4 6 2 4
  shift $((m - 1)); t=$1
  if [ "$m" -lt 3 ]; then y=$((y - 1)); fi
  dow=$(( (y + y/4 - y/100 + y/400 + t + d) % 7 ))   # 0=Sonntag
  if [ "$dow" -eq 0 ]; then dow=7; fi
  echo "$dow"
}

# vp_select_prune KEEP_DAILY KEEP_WEEKLY WEEKLY_DOW
#   stdin:  Backup-IDs (YYYYMMDDTHHMMSSZ), aufsteigend sortiert, eine je Zeile
#   stdout: die zu LOESCHENDEN IDs, aufsteigend.
# Behalten wird die Vereinigung aus: den KEEP_DAILY neuesten Backups und den
# KEEP_WEEKLY neuesten Backups, deren Datum auf WEEKLY_DOW faellt.
vp_select_prune() {
  local kd=$1 kw=$2 wdow=$3
  local ids=() id keep=$'\n' i kept_d=0 kept_w=0
  while IFS= read -r id; do [ -n "$id" ] && ids+=("$id"); done
  local n=${#ids[@]}
  for (( i=n-1; i>=0; i-- )); do
    id=${ids[i]}
    if [ "$kept_d" -lt "$kd" ]; then keep="${keep}${id}"$'\n'; kept_d=$((kept_d+1)); continue; fi
    if [ "$kw" -gt 0 ] && [ "$kept_w" -lt "$kw" ] && [ "$(vp_dow "${id:0:8}")" = "$wdow" ]; then
      keep="${keep}${id}"$'\n'; kept_w=$((kept_w+1))
    fi
  done
  # kept_w zaehlt nur JENSEITS der Tages-Fenster liegende Wochen-Backups mit -
  # ein Sonntag innerhalb der letzten 7 Tage ist schon als taeglich behalten.
  # Das ist gewollt: behalten wird die VEREINIGUNG, geloescht der Rest.
  for (( i=0; i<n; i++ )); do
    id=${ids[i]}
    case "$keep" in *$'\n'"$id"$'\n'*) ;; *) printf '%s\n' "$id" ;; esac
  done
}

self_test() {
  local failures=0
  chk() { # chk BESCHREIBUNG ERWARTET IST
    if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"
    else printf '  FAIL  %s (erwartet [%s], bekommen [%s])\n' "$1" "$2" "$3"; failures=1; fi
  }
  chk "dow 2026-08-31 = Montag"     1 "$(vp_dow 20260831)"
  chk "dow 2026-08-30 = Sonntag"    7 "$(vp_dow 20260830)"
  chk "dow 2000-01-01 = Samstag"    6 "$(vp_dow 20000101)"
  chk "dow 2024-02-29 = Donnerstag" 4 "$(vp_dow 20240229)"
  chk "dow 2026-12-31 = Donnerstag" 4 "$(vp_dow 20261231)"

  local in out want
  # 10 Tage bis Montag 2026-08-31; Sonntage: 23. + 30.
  in=$(printf '%s\n' 20260822T020000Z 20260823T020000Z 20260824T020000Z \
    20260825T020000Z 20260826T020000Z 20260827T020000Z 20260828T020000Z \
    20260829T020000Z 20260830T020000Z 20260831T020000Z)
  out=$(vp_select_prune 7 4 7 <<<"$in")
  want=$(printf '%s\n' 20260822T020000Z 20260824T020000Z)
  chk "prune 7d/4w: Sa 22. + Mo 24. fallen, So 23. bleibt als Wochen-Backup" "$want" "$out"

  out=$(vp_select_prune 1 0 7 <<<"$in")
  want=$(printf '%s\n' 20260822T020000Z 20260823T020000Z 20260824T020000Z \
    20260825T020000Z 20260826T020000Z 20260827T020000Z 20260828T020000Z \
    20260829T020000Z 20260830T020000Z)
  chk "prune 1d/0w: nur das neueste bleibt" "$want" "$out"

  out=$(vp_select_prune 7 4 7 </dev/null)
  chk "prune leere Eingabe: nichts zu loeschen" "" "$out"

  # Zwei Backups am selben Tag: das aeltere faellt aus dem Tages-Fenster zuerst.
  in=$(printf '%s\n' 20260831T020000Z 20260831T140000Z)
  out=$(vp_select_prune 1 0 7 <<<"$in")
  chk "prune gleicher Tag: aelterer Stempel faellt" 20260831T020000Z "$out"

  if [ "$failures" -ne 0 ]; then echo "SELF-TEST FAILED"; exit 1; fi
  echo "self-test ok"
  exit 0
}

# --- Argumente ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --project)          PROJECT=$2; shift 2 ;;
    --db-service)       DB_SERVICE=$2; shift 2 ;;
    --kc-service)       KC_SERVICE=$2; shift 2 ;;
    --container)        DB_CONTAINER=$2; shift 2 ;;
    --kc-container)     KC_CONTAINER=$2; shift 2 ;;
    --keep-daily)       KEEP_DAILY=$2; shift 2 ;;
    --keep-weekly)      KEEP_WEEKLY=$2; shift 2 ;;
    --weekly-dow)       WEEKLY_DOW=$2; shift 2 ;;
    --skip-keycloak)    SKIP_KEYCLOAK=1; shift ;;
    --no-prune)         NO_PRUNE=1; shift ;;
    --allow-no-archive) ALLOW_NO_ARCHIVE=1; shift ;;
    --self-test)        self_test ;;
    -h|--help)          usage; exit 0 ;;
    *) usage >&2; die "unbekannte Option: $1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker nicht gefunden"

resolve_container() { # resolve_container PROJECT SERVICE
  docker ps \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" \
    --format '{{.Names}}' | head -1
}

if [ -z "$DB_CONTAINER" ]; then
  DB_CONTAINER=$(resolve_container "$PROJECT" "$DB_SERVICE")
  [ -n "$DB_CONTAINER" ] || die "kein laufender Container fuer Projekt=$PROJECT Service=$DB_SERVICE (laeuft der Stack?)"
fi

PGUSER=$(docker exec "$DB_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo voltpilot)
PGDB=$(docker exec "$DB_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo voltpilot)

psqlq() { docker exec "$DB_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -Atc "$1"; }

# --- Preflight ---------------------------------------------------------------
docker exec "$DB_CONTAINER" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null \
  || die "TimescaleDB in $DB_CONTAINER antwortet nicht (pg_isready)"

ARCHIVE_MODE=$(psqlq "SHOW archive_mode")
if [ "$ARCHIVE_MODE" != "on" ]; then
  if [ "$ALLOW_NO_ARCHIVE" -eq 1 ]; then
    log "WARNUNG: archive_mode=$ARCHIVE_MODE - Backup ist nur auf seinen eigenen Endstand wiederherstellbar (kein PITR)"
  else
    die "archive_mode=$ARCHIVE_MODE - das DB-Backup-Overlay ist nicht aktiv (DB_BACKUP=enabled, docs/backup-restore.md). Ad-hoc: --allow-no-archive"
  fi
fi

# Zielverzeichnisse sicherstellen (als root im Container - funktioniert auch,
# wenn der Host-Mount root:root gehoert; ab dann besitzt postgres alles).
docker exec -u root "$DB_CONTAINER" install -d -o postgres -g postgres \
  /backup/base /backup/wal /backup/keycloak

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PART="/backup/base/$STAMP.part"
FINAL="/backup/base/$STAMP"

# Bis zum erfolgreichen mv raeumt jeder Abbruch das .part-Verzeichnis weg
# (EXIT-Trap, weil die()/set -e ueber exit enden, nicht ueber ERR).
# shellcheck disable=SC2329  # indirekt ueber trap aufgerufen
cleanup_part() { docker exec -u postgres "$DB_CONTAINER" rm -rf "$PART" 2>/dev/null || true; }
trap cleanup_part EXIT

# --- 1. Basis-Backup ---------------------------------------------------------
log "pg_basebackup -> $FINAL (Container $DB_CONTAINER, Benutzer $PGUSER)"
docker exec -u postgres "$DB_CONTAINER" pg_basebackup \
  -U "$PGUSER" --no-password \
  -D "$PART" \
  --format=tar --compress=client-gzip:6 \
  --checkpoint=fast --wal-method=fetch \
  --label="vp-$STAMP" \
  || die "pg_basebackup fehlgeschlagen"

docker exec "$DB_CONTAINER" sh -c "test -s '$PART/base.tar.gz' && test -s '$PART/backup_manifest'" \
  || die "Backup unvollstaendig: base.tar.gz/backup_manifest fehlen in $PART"
docker exec "$DB_CONTAINER" grep -q '"WAL-Ranges"' "$PART/backup_manifest" \
  || die "backup_manifest ohne WAL-Ranges - unerwartetes Format"

docker exec -u postgres "$DB_CONTAINER" mv "$PART" "$FINAL"
trap - EXIT
log "Basis-Backup fertig: $FINAL"

# --- 2. keycloak-db-Dump -----------------------------------------------------
if [ "$SKIP_KEYCLOAK" -eq 0 ]; then
  if [ -z "$KC_CONTAINER" ]; then
    KC_CONTAINER=$(resolve_container "$PROJECT" "$KC_SERVICE")
  fi
  [ -n "$KC_CONTAINER" ] || die "keycloak-db-Container nicht gefunden (Projekt=$PROJECT Service=$KC_SERVICE); ohne Auth-Backup ist der Lauf unvollstaendig - bewusst ueberspringen mit --skip-keycloak"
  KCU=$(docker exec "$KC_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo keycloak)
  KCDB=$(docker exec "$KC_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo keycloak)
  KC_PART="/backup/keycloak/$STAMP.dump.part"
  KC_FINAL="/backup/keycloak/$STAMP.dump"
  log "pg_dump keycloak-db ($KC_CONTAINER) -> $KC_FINAL"
  docker exec "$KC_CONTAINER" pg_dump -U "$KCU" -Fc "$KCDB" \
    | docker exec -i -u postgres "$DB_CONTAINER" sh -c "cat > '$KC_PART'" \
    || die "keycloak-db-Dump fehlgeschlagen"
  docker exec "$DB_CONTAINER" test -s "$KC_PART" || die "keycloak-db-Dump ist leer"
  docker exec -u postgres "$DB_CONTAINER" mv "$KC_PART" "$KC_FINAL"
fi

# --- 3. Rotation + WAL-Aufraeumen -------------------------------------------
if [ "$NO_PRUNE" -eq 0 ]; then
  IDS=$(docker exec "$DB_CONTAINER" sh -c 'ls /backup/base 2>/dev/null' \
    | { grep -E '^[0-9]{8}T[0-9]{6}Z$' || true; } | sort)
  DELETE=$(vp_select_prune "$KEEP_DAILY" "$KEEP_WEEKLY" "$WEEKLY_DOW" <<<"$IDS")
  for id in $DELETE; do
    log "Rotation: entferne Basis-Backup $id"
    docker exec -u postgres "$DB_CONTAINER" rm -rf "/backup/base/$id"
  done

  KIDS=$(docker exec "$DB_CONTAINER" sh -c 'ls /backup/keycloak 2>/dev/null' \
    | { grep -E '^[0-9]{8}T[0-9]{6}Z\.dump$' || true; } | sed 's/\.dump$//' | sort)
  KDELETE=$(vp_select_prune "$KEEP_DAILY" "$KEEP_WEEKLY" "$WEEKLY_DOW" <<<"$KIDS")
  for id in $KDELETE; do
    log "Rotation: entferne keycloak-Dump $id"
    docker exec -u postgres "$DB_CONTAINER" rm -f "/backup/keycloak/$id.dump"
  done

  # Liegengebliebene .part-Reste (abgebrochene Laeufe) nach >1 Tag entsorgen.
  docker exec -u postgres "$DB_CONTAINER" sh -c \
    'find /backup/base -maxdepth 1 -name "*.part" -mtime +1 -exec rm -rf {} + 2>/dev/null;
     find /backup/keycloak -maxdepth 1 -name "*.part" -mtime +1 -exec rm -f {} + 2>/dev/null; true'

  # WAL nur bis zum Start des aeltesten BEHALTENEN Basis-Backups behalten.
  OLDEST=$(comm -23 <(printf '%s\n' "$IDS") <(printf '%s\n' "$DELETE") | head -1)
  if [ -n "$OLDEST" ]; then
    START_LSN=$(docker exec "$DB_CONTAINER" sh -c \
      "grep -o '\"Start-LSN\": \"[^\"]*\"' '/backup/base/$OLDEST/backup_manifest' | head -1 | cut -d'\"' -f4")
    if [ -n "$START_LSN" ]; then
      SEGMENT=$(psqlq "SELECT pg_walfile_name('$START_LSN'::pg_lsn)")
      log "WAL-Aufraeumen: behalte ab Segment $SEGMENT (Start von $OLDEST)"
      docker exec -u postgres "$DB_CONTAINER" pg_archivecleanup -x .gz /backup/wal "$SEGMENT" \
        || log "WARNUNG: pg_archivecleanup fehlgeschlagen (Archiv waechst weiter, naechster Lauf versucht es erneut)"
      # pg_archivecleanup entfernt nur echte Segment-Namen; die winzigen
      # Backup-History-Marker (<segment>.<offset>.backup.gz) jedes
      # pg_basebackup-Laufs raeumen wir bis zur selben Grenze selbst weg.
      docker exec -u postgres -e VP_BOUNDARY="$SEGMENT" "$DB_CONTAINER" sh -c '
        for f in /backup/wal/*.backup.gz; do
          [ -f "$f" ] || continue
          seg=$(basename "$f"); seg=${seg%%.*}
          [ "${#seg}" -eq 24 ] || continue
          first=$(printf "%s\n%s\n" "$seg" "$VP_BOUNDARY" | sort | head -1)
          if [ "$first" = "$seg" ] && [ "$seg" != "$VP_BOUNDARY" ]; then rm -f "$f"; fi
        done' \
        || log "WARNUNG: Aufraeumen der .backup-Marker fehlgeschlagen"
    else
      log "WARNUNG: Start-LSN aus $OLDEST/backup_manifest nicht lesbar - WAL-Aufraeumen uebersprungen"
    fi
  fi
fi

# --- Zusammenfassung ---------------------------------------------------------
SIZES=$(docker exec "$DB_CONTAINER" sh -c 'du -sh /backup/base /backup/wal /backup/keycloak 2>/dev/null' || true)
ARCHIVER=$(psqlq "SELECT 'archived='||archived_count||' failed='||failed_count||' last='||COALESCE(last_archived_wal,'-') FROM pg_stat_archiver" 2>/dev/null || true)
log "fertig. Belegung:"
printf '%s\n' "$SIZES" | sed 's/^/    /'
[ -n "$ARCHIVER" ] && log "WAL-Archiver: $ARCHIVER"
exit 0

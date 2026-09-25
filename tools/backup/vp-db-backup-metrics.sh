#!/usr/bin/env bash
# =============================================================================
# vp-db-backup-metrics.sh - das Alter der Sicherung als Metrik (AP-20 IP-19).
#
# Schreibt fuer den Textfile-Collector des node-exporters auf der
# Datenebenen-VM die Datei voltpilot_sicherung.prom mit drei Zeitpunkten
# (Unix-Sekunden, UTC):
#
#   voltpilot_sicherung_basis_timestamp_seconds   juengstes abgeschlossenes
#       Basis-Backup: Stempel des Verzeichnisses base/<JJJJMMTTThhmmssZ>,
#       dieselbe Regel wie vp-db-backup-check.sh (".part" zaehlt nicht)
#   voltpilot_sicherung_wal_timestamp_seconds     juengste WAL-Archivdatei
#       (mtime der juengsten wal/*.gz, wie vp-db-backup-check.sh)
#   voltpilot_sicherung_export_timestamp_seconds  wann dieser Export lief
#
# ZEITPUNKTE STATT ALTER, absichtlich: das Alter rechnet die Regel beim
# Auswerten (time() - x). Steht dieser Export, waechst das Alter trotzdem
# weiter und der Alarm kommt. Ein exportiertes Alter bliebe auf dem letzten
# Wert stehen und zeigte einen stehenden Export als frische Sicherung.
#
# UNBEKANNT IST KEINE NULL: gibt es kein Basis-Backup oder keine WAL-Datei,
# fehlt die jeweilige Zeile ganz (ein Kommentar in der Datei sagt, warum).
# Die Regel VoltPilotSicherungZuAlt meldet das als zustand="keine".
#
# Liest nur das Backup-Verzeichnis auf dem Host (DB_BACKUP_DIR) und braucht
# weder Docker noch Postgres: das Alter der Sicherung bleibt messbar, wenn die
# Datenbank steht. Schreibt atomar (Temp-Datei + mv im selben Verzeichnis),
# damit der node-exporter nie eine halbe Datei liest; Rechte 0644, weil der
# node-exporter im Container nicht als root liest.
#
# Exit 0 = Datei geschrieben, auch wenn die Sicherung zu alt ist (urteilen
# tut die Regel, nicht der Export). Exit 2 = Aufruffehler oder Zielverzeichnis
# nicht schreibbar.
# Gegenstuecke: tools/backup/systemd/vp-db-backup-metrics.{service,timer},
# docs/bewertung/vorschlaege/gitops/ (Regel + promtool-Test),
# docs/backup-restore.md "Sicherungsalter als Metrik".
# =============================================================================
set -euo pipefail

BACKUP_DIR="/srv/backup/voltpilot-db"
TEXTFILE_DIR="/var/lib/node_exporter/textfile_collector"
JETZT=""
DATEI="voltpilot_sicherung.prom"

usage() {
  cat <<'EOF'
Usage: vp-db-backup-metrics.sh [options]
  --backup-dir DIR    Host-Verzeichnis der Sicherung = DB_BACKUP_DIR
                      (Default: /srv/backup/voltpilot-db)
  --textfile-dir DIR  Textfile-Verzeichnis des node-exporters
                      (Default: /var/lib/node_exporter/textfile_collector)
  --jetzt SEKUNDEN    Zeitpunkt des Exports festlegen, nur fuer Tests
                      (Default: die Uhr der VM)
EOF
}

die() { printf 'vp-db-backup-metrics: %s\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir)   [ $# -ge 2 ] || die "--backup-dir braucht einen Wert"; BACKUP_DIR=$2; shift 2 ;;
    --textfile-dir) [ $# -ge 2 ] || die "--textfile-dir braucht einen Wert"; TEXTFILE_DIR=$2; shift 2 ;;
    --jetzt)        [ $# -ge 2 ] || die "--jetzt braucht einen Wert"; JETZT=$2; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) usage >&2; die "unbekannte Option: $1" ;;
  esac
done

if [ -z "$JETZT" ]; then
  JETZT=$(date -u +%s)
fi
case "$JETZT" in ''|*[!0-9]*) die "--jetzt erwartet Unix-Sekunden, nicht '$JETZT'" ;; esac
[ -d "$TEXTFILE_DIR" ] && [ -w "$TEXTFILE_DIR" ] \
  || die "Textfile-Verzeichnis $TEXTFILE_DIR fehlt oder ist nicht schreibbar (install -d -m 0755 $TEXTFILE_DIR)"

# JJJJMMTTThhmmssZ -> Unix-Sekunden, in reiner Shell-Arithmetik (days_from_civil
# nach H. Hinnant), damit GNU-date (VM) und BSD-date (Pruefrechner) nicht
# auseinanderlaufen. Der Stempel ist UTC, so schreibt ihn vp-db-backup.sh.
epoche() {
  local s=$1 y m d mp era yoe doy doe
  y=$((10#${s:0:4})); m=$((10#${s:4:2})); d=$((10#${s:6:2}))
  if [ "$m" -le 2 ]; then y=$((y - 1)); fi
  era=$((y / 400)); yoe=$((y - era * 400))
  mp=$(((m + 9) % 12))
  doy=$(((153 * mp + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $(((era * 146097 + doe - 719468) * 86400 \
    + 10#${s:9:2} * 3600 + 10#${s:11:2} * 60 + 10#${s:13:2}))
}

# mtime einer Datei in Unix-Sekunden: GNU stat (VM), sonst BSD stat.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# --- Basis-Backup -------------------------------------------------------------
BASIS=$({ ls "$BACKUP_DIR/base" 2>/dev/null || true; } \
  | { grep -E '^[0-9]{8}T[0-9]{6}Z$' || true; } | sort | tail -1)
# --- WAL-Archiv -----------------------------------------------------------------
WAL=$({ ls -t "$BACKUP_DIR/wal" 2>/dev/null || true; } \
  | { grep '\.gz$' || true; } | head -1)

ZIEL="$TEXTFILE_DIR/$DATEI"
# Kein .prom-Suffix: der Collector liest nur *.prom, die halbe Datei nie.
TMPF=$(mktemp "$TEXTFILE_DIR/.voltpilot_sicherung.XXXXXX") || die "kann in $TEXTFILE_DIR nicht schreiben"
trap 'rm -f "$TMPF"' EXIT

{
  echo "# Geschrieben von tools/backup/vp-db-backup-metrics.sh aus $BACKUP_DIR (AP-20 IP-19)."
  echo "# HELP voltpilot_sicherung_basis_timestamp_seconds Juengstes abgeschlossenes Basis-Backup (Stempel des Verzeichnisses), Unix-Sekunden UTC."
  echo "# TYPE voltpilot_sicherung_basis_timestamp_seconds gauge"
  if [ -n "$BASIS" ]; then
    BASIS_S=$(epoche "$BASIS")
    echo "voltpilot_sicherung_basis_timestamp_seconds $BASIS_S"
  else
    echo "# keine: kein abgeschlossenes Basis-Backup unter $BACKUP_DIR/base"
  fi
  echo "# HELP voltpilot_sicherung_wal_timestamp_seconds Juengste WAL-Archivdatei (mtime), Unix-Sekunden UTC."
  echo "# TYPE voltpilot_sicherung_wal_timestamp_seconds gauge"
  if [ -n "$WAL" ]; then
    WAL_S=$(mtime "$BACKUP_DIR/wal/$WAL")
    echo "voltpilot_sicherung_wal_timestamp_seconds $WAL_S"
  else
    echo "# keine: keine WAL-Archivdatei unter $BACKUP_DIR/wal"
  fi
  echo "# HELP voltpilot_sicherung_export_timestamp_seconds Letzter Lauf dieses Exports, Unix-Sekunden UTC."
  echo "# TYPE voltpilot_sicherung_export_timestamp_seconds gauge"
  echo "voltpilot_sicherung_export_timestamp_seconds $JETZT"
} >"$TMPF"
chmod 0644 "$TMPF"
mv -f "$TMPF" "$ZIEL"
trap - EXIT

# Eine Zeile fuers Journal: was der Export gesehen hat.
if [ -n "$BASIS" ]; then
  BASIS_TEXT="Basis-Backup $BASIS ($(((JETZT - BASIS_S) / 3600)) h alt)"
else
  BASIS_TEXT="kein Basis-Backup"
fi
if [ -n "$WAL" ]; then
  WAL_TEXT="WAL $WAL ($(((JETZT - WAL_S) / 60)) min alt)"
else
  WAL_TEXT="keine WAL-Archivdatei"
fi
printf '%s geschrieben: %s, %s\n' "$ZIEL" "$BASIS_TEXT" "$WAL_TEXT"

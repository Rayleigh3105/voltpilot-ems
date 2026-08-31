#!/bin/sh
# =============================================================================
# archive-wal.sh - das archive_command der TimescaleDB (DB-Backup-Overlay).
#
# Laeuft IM Container als Benutzer postgres, aufgerufen vom Postgres-Server:
#   /usr/local/bin/vp-archive-wal.sh %p %f
# ($1 = Pfad des fertigen WAL-Segments relativ zu PGDATA, $2 = Dateiname).
#
# Es legt jedes Segment gzip-komprimiert nach /backup/wal (auf dem Host:
# ${DB_BACKUP_DIR}/wal). Drei Regeln, alle aus dem archive_command-Vertrag von
# Postgres (der Server wiederholt bei Exit != 0 endlos, und ein Segment darf
# NIE still durch anderen Inhalt ersetzt werden):
#   1. Existiert das Ziel schon mit IDENTISCHEM Inhalt -> Exit 0 (Postgres
#      wiederholt nach einem Crash legitim dasselbe Segment).
#   2. Existiert es mit ANDEREM Inhalt -> lauter Fehler, Exit 1. Das passiert
#      nur, wenn zwei Cluster in dasselbe Archiv schreiben - ein Zustand, den
#      man sehen muss, nie einer, den man wegoptimiert.
#   3. Geschrieben wird ueber tmp+rename im SELBEN Verzeichnis, damit nie ein
#      halbes Segment unter seinem endgueltigen Namen liegt.
#
# Timeline-History-Dateien (%f = *.history, nach einem Restore) reisen ueber
# denselben Pfad - auch sie werden gzip-komprimiert abgelegt; das
# restore_command in tools/backup/vp-db-restore.sh erwartet genau das.
#
# busybox-sh-kompatibel (Alpine-Image); keine Bashismen.
# =============================================================================
set -eu

src="$1"
name="$2"
dir="${VP_WAL_ARCHIVE_DIR:-/backup/wal}"
dest="$dir/$name.gz"
tmp="$dir/.$name.part"

# Verzeichnis defensiv anlegen (greift nur, wenn /backup selbst schreibbar ist;
# die Erst-Einrichtung per `install -d -o 70 -g 70` steht in enabled.yml).
[ -d "$dir" ] || mkdir -p "$dir"

if [ -f "$dest" ]; then
  if gunzip -c "$dest" | cmp -s - "$src"; then
    exit 0
  fi
  echo "vp-archive-wal: REFUSE to overwrite $dest with different content" >&2
  exit 1
fi

gzip -c "$src" >"$tmp"
mv "$tmp" "$dest"
# Dauerhaftigkeit: erst wenn das Segment die Platte erreicht hat, darf Postgres
# es lokal recyceln. busybox-sync nimmt (je nach Version) Dateiargumente; der
# Fallback ist ein globales sync - ein Aufruf je 16-MB-Segment ist tragbar.
sync "$dest" 2>/dev/null || sync
exit 0

#!/usr/bin/env bash
# =============================================================================
# test-backup-restore.sh - der Beweis, dass Backup UND Restore funktionieren.
#
# Ein Backup ohne getesteten Restore gilt als nicht geliefert. Dieses Skript
# faehrt deshalb den ECHTEN Zyklus mit den ECHTEN Skripten gegen das ECHTE
# Prod-Image (timescale/timescaledb:2.17.2-pg16), in Wegwerf-Containern mit
# eindeutigen Namen - der laufende Dev-/Live-Stack wird nie beruehrt:
#
#   Phase 0 (ohne Docker, laeuft immer):
#     - vp-db-backup.sh --self-test (Wochentags-/Rotations-Arithmetik)
#     - archive-wal.sh-Vertrag: idempotent bei identischem Segment, LAUTER
#       Fehler bei abweichendem Inhalt, keine .part-Reste
#     - Lockstep-Waechter: enabled.yml traegt exakt das archive_command, das
#       dieser Test faehrt (Drift Overlay <-> Test faellt hier um)
#     - Textfile-Export des Sicherungsalters (test-backup-metrics.sh)
#     - shellcheck (falls installiert)
#
#   Phase B (mit Docker):
#     seed (Hypertable + komprimierte Chunks wie forecast + Kompressions-Job)
#       -> vp-db-backup.sh (Basis-Backup + keycloak-Dump)
#       -> weitere Schreibvorgaenge (leben NUR im WAL-Archiv) + PITR-Anker
#       -> Container UND Datenvolume ZERSTOEREN (Totalverlust)
#       -> vp-db-restore.sh in ein frisches Volume (bis Archiv-Ende)
#       -> Daten IDENTISCH (Pruefsummen), komprimierte Chunks identisch UND
#          weiter komprimiert, Timescale-Job da, neue Zeitleiste, Schreiben ok,
#          Archivierung laeuft auf der neuen Zeitleiste weiter
#       -> ZWEITER Restore desselben Backups mit --target-time (PITR):
#          Stand VOR den letzten Schreibvorgaengen, Phase 3 fehlt
#       -> Rotation: --keep-daily 1 loescht das alte Basis-Backup + WAL davor
#       -> Alterscheck: gruen im Normalfall, rot bei Schwelle 0
#
# Zur timescaledb_pre_restore/post_restore-Semantik: die gehoert zum LOGISCHEN
# pg_dump/pg_restore-Weg. Der hiesige Weg ist PHYSISCH und deshalb
# kompressionstransparent - genau das beweisen die Pruefsummen ueber die
# komprimierten Chunks nach dem Restore, ohne dass eine der beiden Funktionen
# je laeuft (Hintergrund: docs/backup-restore.md, Abschnitt "Warum physisch").
#
# Laufzeit ~3-5 min. Ohne Docker werden die Docker-Phasen mit Notiz
# uebersprungen (Phase 0 laeuft immer).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."

PASS=0
FAILED=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
note() { printf '  ....  %s\n' "$*"; }

IMG="timescale/timescaledb:2.17.2-pg16"
KC_IMG="postgres:16-alpine"
ARCHIVE_CMD='archive_command=/usr/local/bin/vp-archive-wal.sh %p %f'
P="vpbk$$"
TMP=$(mktemp -d)

cleanup() {
  docker rm -f "$P-db" "$P-kc" "$P-verify" "$P-pitr" >/dev/null 2>&1 || true
  docker volume rm -f "$P-backup" "$P-data" "$P-rest1" "$P-rest2" >/dev/null 2>&1 || true
  docker network rm "$P-net" >/dev/null 2>&1 || true
  docker rmi "$P-img" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== Phase 0: Offline-Pruefungen (ohne Docker) =="

if bash tools/backup/vp-db-backup.sh --self-test >"$TMP/selftest.out" 2>&1; then
  pass "vp-db-backup.sh --self-test (Rotations-/Wochentags-Arithmetik)"
else
  fail "vp-db-backup.sh --self-test:"; sed 's/^/        /' "$TMP/selftest.out"
fi

# archive-wal.sh-Vertrag, direkt mit /bin/sh auf dem Host.
WALT="$TMP/walt"; mkdir -p "$WALT/wal"
printf 'segment-eins-inhalt' > "$WALT/seg"
if VP_WAL_ARCHIVE_DIR="$WALT/wal" sh infra/prod/backup/archive-wal.sh "$WALT/seg" TESTSEG000000000001 \
   && gunzip -c "$WALT/wal/TESTSEG000000000001.gz" | cmp -s - "$WALT/seg"; then
  pass "archive-wal.sh: Segment landet gzip-identisch im Archiv"
else
  fail "archive-wal.sh: Erst-Archivierung"
fi
if VP_WAL_ARCHIVE_DIR="$WALT/wal" sh infra/prod/backup/archive-wal.sh "$WALT/seg" TESTSEG000000000001; then
  pass "archive-wal.sh: identisches Segment erneut = Exit 0 (Crash-Retry-Vertrag)"
else
  fail "archive-wal.sh: identischer Retry muss Exit 0 sein"
fi
printf 'ANDERER-inhalt' > "$WALT/seg"
if VP_WAL_ARCHIVE_DIR="$WALT/wal" sh infra/prod/backup/archive-wal.sh "$WALT/seg" TESTSEG000000000001 2>/dev/null; then
  fail "archive-wal.sh: abweichender Inhalt haette Exit != 0 sein muessen"
else
  pass "archive-wal.sh: abweichender Inhalt wird LAUT verweigert"
fi
if ls "$WALT/wal"/.*.part >/dev/null 2>&1; then
  fail "archive-wal.sh: .part-Reste liegen im Archiv"
else
  pass "archive-wal.sh: keine .part-Reste"
fi

# Lockstep: das Overlay und dieser Test muessen dasselbe archive_command fahren.
if grep -qF "$ARCHIVE_CMD" infra/prod/backup/enabled.yml; then
  pass "Lockstep: enabled.yml traegt exakt das archive_command dieses Tests"
else
  fail "Lockstep: enabled.yml archive_command weicht vom Test ab - beide zusammen aendern"
fi
if grep -q 'archive_mode=on' infra/prod/backup/enabled.yml \
   && grep -q './archive-wal.sh:/usr/local/bin/vp-archive-wal.sh:ro' infra/prod/backup/enabled.yml; then
  pass "Lockstep: enabled.yml traegt archive_mode=on + den ro-Mount des Skripts"
else
  fail "Lockstep: enabled.yml ohne archive_mode/Skript-Mount"
fi

# Textfile-Export des Sicherungsalters (AP-20 IP-19): eigener Offline-Test.
if bash tools/backup/test-backup-metrics.sh >"$TMP/metrics.out" 2>&1; then
  pass "vp-db-backup-metrics.sh: Textfile-Export ($(grep -c '  PASS' "$TMP/metrics.out") Faelle, test-backup-metrics.sh)"
else
  fail "test-backup-metrics.sh:"; sed 's/^/        /' "$TMP/metrics.out"
fi

if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck tools/backup/vp-db-backup.sh tools/backup/vp-db-restore.sh \
       tools/backup/vp-db-backup-check.sh tools/backup/test-backup-restore.sh \
       tools/backup/vp-db-backup-metrics.sh tools/backup/test-backup-metrics.sh \
       infra/prod/backup/archive-wal.sh >"$TMP/shellcheck.out" 2>&1; then
    pass "shellcheck sauber (7 Skripte)"
  else
    fail "shellcheck:"; sed 's/^/        /' "$TMP/shellcheck.out"
  fi
else
  note "shellcheck nicht installiert - uebersprungen"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  note "Docker nicht verfuegbar - Restore-Zyklus uebersprungen (Phase 0: $PASS PASS, $FAILED FAIL)"
  if [ "$FAILED" -ne 0 ]; then echo "TEST FAILED"; exit 1; fi
  echo "TEST OK (nur Phase 0)"; exit 0
fi

echo "== Phase B: der echte Zyklus (Wegwerf-Container, Prefix $P) =="

# Testimage: das Prod-Image + archive-wal.sh an derselben Stelle, an der das
# Overlay es mountet. BUILD-Kontext statt Bind-Mount - Workspace-Binds
# funktionieren auf dem CI-Runner nicht (dokumentierte Falle in AGENTS.md).
mkdir -p "$TMP/ctx"
cp infra/prod/backup/archive-wal.sh "$TMP/ctx/"
cat > "$TMP/ctx/Dockerfile" <<EOF
FROM $IMG
COPY archive-wal.sh /usr/local/bin/vp-archive-wal.sh
RUN chmod 755 /usr/local/bin/vp-archive-wal.sh
EOF
docker build -q -t "$P-img" "$TMP/ctx" >/dev/null
docker network create "$P-net" >/dev/null
docker volume create "$P-backup" >/dev/null
docker volume create "$P-data" >/dev/null

# Primaer-DB: dieselben Serverflags wie infra/prod/backup/enabled.yml, nur mit
# kuerzerem archive_timeout, damit der Test nicht 5 min auf ein Segment wartet.
docker run -d --name "$P-db" --network "$P-net" \
  -e POSTGRES_PASSWORD=vpbk -e POSTGRES_USER=voltpilot -e POSTGRES_DB=voltpilot \
  -v "$P-data:/var/lib/postgresql/data" -v "$P-backup:/backup" \
  "$P-img" postgres -c archive_mode=on -c "$ARCHIVE_CMD" -c archive_timeout=60 >/dev/null

wait_ready() { # wait_ready CONTAINER
  local _i
  for _i in $(seq 1 60); do
    docker exec "$1" pg_isready -U voltpilot -d voltpilot >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
if ! wait_ready "$P-db"; then
  fail "Primaer-DB wird nicht bereit"; docker logs "$P-db" 2>&1 | tail -20
  echo "TEST FAILED"; exit 1
fi
docker exec -u root "$P-db" install -d -o postgres -g postgres /backup/base /backup/wal /backup/keycloak

pq() { docker exec "$P-db" psql -U voltpilot -d voltpilot -Atc "$1"; }

# keycloak-db-Doppel (der pg_dump-Pfad des Backup-Skripts).
docker run -d --name "$P-kc" --network "$P-net" \
  -e POSTGRES_PASSWORD=kc -e POSTGRES_USER=keycloak -e POSTGRES_DB=keycloak \
  "$KC_IMG" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$P-kc" pg_isready -U keycloak -d keycloak >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$P-kc" psql -U keycloak -d keycloak -Atc \
  "CREATE TABLE realm_probe(id int primary key, name text); INSERT INTO realm_probe VALUES (1,'voltpilot');" >/dev/null

# --- Seed: Hypertable mit komprimierten Chunks (die forecast-Situation) ------
docker exec -i "$P-db" psql -U voltpilot -d voltpilot -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE master(id int PRIMARY KEY, name text NOT NULL);
INSERT INTO master SELECT g, 'kunde-'||g FROM generate_series(1,50) g;
CREATE TABLE meas(time timestamptz NOT NULL, site int NOT NULL, val double precision NOT NULL);
SELECT create_hypertable('meas','time', chunk_time_interval => interval '1 day');
INSERT INTO meas
  SELECT t, s, extract(epoch FROM t)/1000 + s
  FROM generate_series(now() - interval '9 days', now(), interval '15 minutes') t,
       generate_series(1,3) s;
ALTER TABLE meas SET (timescaledb.compress,
                      timescaledb.compress_segmentby = 'site',
                      timescaledb.compress_orderby   = 'time DESC');
SELECT add_compression_policy('meas', interval '30 days');
SELECT compress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass)
  FROM timescaledb_information.chunks
  WHERE hypertable_name = 'meas' AND NOT is_compressed
    AND range_end < now() - interval '6 days';
SQL

COMP1=$(pq "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='meas' AND is_compressed")
if [ "$COMP1" -ge 3 ]; then
  pass "Seed: $COMP1 komprimierte Chunks (die forecast-Situation ist im Spiel)"
else
  fail "Seed: erwartete >=3 komprimierte Chunks, habe $COMP1"
fi

# --- Backup 1 (das echte Skript) ---------------------------------------------
if bash tools/backup/vp-db-backup.sh --container "$P-db" --kc-container "$P-kc" >"$TMP/backup1.out" 2>&1; then
  pass "vp-db-backup.sh: Lauf 1 (Basis-Backup + keycloak-Dump)"
else
  fail "vp-db-backup.sh Lauf 1:"; sed 's/^/        /' "$TMP/backup1.out"
fi
B1=$(docker exec "$P-db" sh -c 'ls /backup/base' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -1)
if [ -n "$B1" ] && docker exec "$P-db" sh -c "test -s /backup/base/$B1/base.tar.gz && test -s /backup/base/$B1/backup_manifest"; then
  pass "Basis-Backup $B1 mit base.tar.gz + backup_manifest"
else
  fail "Basis-Backup unvollstaendig"
fi
if docker exec "$P-db" sh -c "head -c 5 /backup/keycloak/$B1.dump" | grep -q 'PGDMP'; then
  pass "keycloak-Dump $B1.dump vorhanden (PGDMP-Magic)"
else
  fail "keycloak-Dump fehlt oder kein pg_dump-Custom-Format"
fi

# --- Nach dem Backup: Schreibvorgaenge, die NUR im WAL-Archiv leben ----------
pq "INSERT INTO master SELECT g, 'phase2-'||g FROM generate_series(51,60) g" >/dev/null
sleep 2
TS_MID=$(pq "SELECT now()")
sleep 2
pq "INSERT INTO master SELECT g, 'phase3-'||g FROM generate_series(61,70) g" >/dev/null
# Auch Kompressions-DDL muss ueber das WAL-Replay kommen:
pq "SELECT count(compress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass))
    FROM timescaledb_information.chunks
    WHERE hypertable_name='meas' AND NOT is_compressed
      AND range_end < now() - interval '5 days'" >/dev/null

SUM_MASTER=$(pq "SELECT md5(string_agg(id||':'||name, ',' ORDER BY id)) FROM master")
SUM_MEAS=$(pq "SELECT md5(string_agg(time::text||'|'||site||'|'||val, ',' ORDER BY time, site)) FROM meas")
COMP_F=$(pq "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='meas' AND is_compressed")
ROWS_MEAS=$(pq "SELECT count(*) FROM meas")
if [ "$COMP_F" -gt "$COMP1" ]; then
  pass "nach Backup 1 ein weiterer Chunk komprimiert ($COMP1 -> $COMP_F; reist nur im WAL)"
else
  fail "Nachbackup-Kompression lief nicht ($COMP1 -> $COMP_F)"
fi

# WAL bis einschliesslich dieser Aenderungen ins Archiv zwingen und warten.
SW=$(pq "SELECT pg_walfile_name(pg_switch_wal())")
ARCHIVED=0
for _ in $(seq 1 90); do
  if docker exec "$P-db" test -f "/backup/wal/$SW.gz" 2>/dev/null; then ARCHIVED=1; break; fi
  sleep 1
done
if [ "$ARCHIVED" -eq 1 ]; then
  pass "WAL-Segment $SW im Archiv (alle Phase-2/3-Aenderungen sind archiviert)"
else
  fail "WAL-Segment $SW erreichte das Archiv nicht"
fi
EARLIEST_WAL=$(docker exec "$P-db" sh -c 'ls /backup/wal' | grep -E '^[0-9A-F]{24}\.gz$' | sort | head -1)
B1_MARKER=$(docker exec "$P-db" sh -c 'ls /backup/wal' | grep -E '\.backup\.gz$' | sort | head -1)
WAL_COUNT_BEFORE=$(docker exec "$P-db" sh -c 'ls /backup/wal | wc -l' | tr -d ' ')

# --- TOTALVERLUST: Container weg, Datenvolume weg ----------------------------
docker rm -f "$P-db" >/dev/null
docker volume rm "$P-data" >/dev/null
pass "Primaer-DB zerstoert (Container + Datenvolume geloescht)"

# --- Restore 1: bis zum Ende des Archivs -------------------------------------
if bash tools/backup/vp-db-restore.sh --backup "$P-backup" --dest-volume "$P-rest1" --yes >"$TMP/restore1.out" 2>&1; then
  pass "vp-db-restore.sh: Restore bis Archiv-Ende"
else
  fail "vp-db-restore.sh Restore 1:"; sed 's/^/        /' "$TMP/restore1.out"
fi

# Wiederhergestellten Cluster mit AKTIVER Archivierung starten - exakt die
# Prod-Lage nach einem Restore (neue Zeitleiste archiviert ins selbe Archiv).
docker run -d --name "$P-verify" --network "$P-net" \
  -e POSTGRES_PASSWORD=vpbk -e POSTGRES_USER=voltpilot -e POSTGRES_DB=voltpilot \
  -v "$P-rest1:/var/lib/postgresql/data" -v "$P-backup:/backup" \
  "$P-img" postgres -c archive_mode=on -c "$ARCHIVE_CMD" -c archive_timeout=60 >/dev/null
if ! wait_ready "$P-verify"; then
  fail "wiederhergestellte DB wird nicht bereit"; docker logs "$P-verify" 2>&1 | tail -30
fi
pq2() { docker exec "$P-verify" psql -U voltpilot -d voltpilot -Atc "$1"; }

R_SUM_MASTER=$(pq2 "SELECT md5(string_agg(id||':'||name, ',' ORDER BY id)) FROM master")
R_SUM_MEAS=$(pq2 "SELECT md5(string_agg(time::text||'|'||site||'|'||val, ',' ORDER BY time, site)) FROM meas")
R_COMP=$(pq2 "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='meas' AND is_compressed")
R_ROWS=$(pq2 "SELECT count(*) FROM meas")
if [ "$R_SUM_MASTER" = "$SUM_MASTER" ]; then
  pass "master identisch (inkl. Phase 2+3, die nur im WAL lebten)"
else
  fail "master weicht ab (erwartet $SUM_MASTER, ist $R_SUM_MASTER)"
fi
if [ "$R_SUM_MEAS" = "$SUM_MEAS" ] && [ "$R_ROWS" = "$ROWS_MEAS" ]; then
  pass "Hypertable identisch ($R_ROWS Zeilen, Pruefsumme gleich - komprimierte Chunks lesen sich byte-treu)"
else
  fail "Hypertable weicht ab"
fi
if [ "$R_COMP" = "$COMP_F" ]; then
  pass "Chunks weiterhin komprimiert ($R_COMP) - physischer Restore ist kompressionstransparent"
else
  fail "Kompressionszustand weicht ab (erwartet $COMP_F, ist $R_COMP)"
fi
JOBS=$(pq2 "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_compression'")
if [ "$JOBS" -ge 1 ]; then
  pass "Timescale-Hintergrundjob (Kompressions-Policy) hat den Restore ueberlebt"
else
  fail "Kompressions-Policy-Job fehlt nach Restore"
fi
TL=$(pq2 "SELECT substring(pg_walfile_name(pg_current_wal_lsn()), 1, 8)")
if [ "$TL" != "00000001" ]; then
  pass "Cluster auf neuer Zeitleiste ($TL)"
else
  fail "Zeitleiste unveraendert 00000001 - Recovery lief nicht"
fi
if pq2 "INSERT INTO meas VALUES (now(), 99, 4.2)" >/dev/null; then
  pass "wiederhergestellter Cluster nimmt Schreibvorgaenge an"
else
  fail "Schreibtest fehlgeschlagen"
fi
SW2=$(pq2 "SELECT pg_walfile_name(pg_switch_wal())")
CONT=0
for _ in $(seq 1 90); do
  if docker exec "$P-verify" test -f "/backup/wal/$SW2.gz" 2>/dev/null; then CONT=1; break; fi
  sleep 1
done
if [ "$CONT" -eq 1 ]; then
  pass "Archivierung laeuft auf der neuen Zeitleiste weiter ($SW2 archiviert)"
else
  fail "neue Zeitleiste archiviert nicht (Prod-Kontinuitaet gebrochen)"
fi
# Die History-Datei entstand bei der Befoerderung im Restore-Container
# (Archivierung aus); der .ready-Marker aus vp-db-restore.sh muss sie beim
# Start MIT Archivierung nachreichen - kurz warten.
HIST=0
for _ in $(seq 1 30); do
  if docker exec "$P-verify" sh -c 'ls /backup/wal | grep -q "\.history\.gz$"'; then HIST=1; break; fi
  sleep 1
done
if [ "$HIST" -eq 1 ]; then
  pass "Zeitleisten-History-Datei ist archiviert (der .ready-Marker aus dem Restore wirkt)"
else
  fail "keine .history.gz im Archiv - kuenftige Restores faenden die neue Zeitleiste nicht"
fi

# Restore in ein NICHT-leeres Ziel muss verweigert werden.
if bash tools/backup/vp-db-restore.sh --backup "$P-backup" --dest-volume "$P-rest1" --yes >"$TMP/restore-nonempty.out" 2>&1; then
  fail "Restore in nicht-leeres Ziel haette verweigert werden muessen"
else
  pass "Restore in nicht-leeres Ziel wird verweigert"
fi

# --- Restore 2: Point-in-Time auf den Anker zwischen Phase 2 und 3 -----------
if bash tools/backup/vp-db-restore.sh --backup "$P-backup" --from "$B1" \
     --target-time "$TS_MID" --dest-volume "$P-rest2" --yes >"$TMP/restore2.out" 2>&1; then
  pass "vp-db-restore.sh: PITR-Restore auf $TS_MID"
else
  fail "vp-db-restore.sh PITR:"; sed 's/^/        /' "$TMP/restore2.out"
fi
docker run -d --name "$P-pitr" \
  -e POSTGRES_PASSWORD=vpbk -e POSTGRES_USER=voltpilot -e POSTGRES_DB=voltpilot \
  -v "$P-rest2:/var/lib/postgresql/data" \
  "$IMG" >/dev/null
if ! wait_ready "$P-pitr"; then fail "PITR-Cluster wird nicht bereit"; fi
pq3() { docker exec "$P-pitr" psql -U voltpilot -d voltpilot -Atc "$1"; }
P2=$(pq3 "SELECT count(*) FROM master WHERE id BETWEEN 51 AND 60")
P3=$(pq3 "SELECT count(*) FROM master WHERE id >= 61")
if [ "$P2" = "10" ] && [ "$P3" = "0" ]; then
  pass "PITR: Phase 2 vorhanden (10 Zeilen), Phase 3 fehlt - der Zeitpunkt stimmt"
else
  fail "PITR: erwartet Phase2=10/Phase3=0, ist $P2/$P3"
fi
docker rm -f "$P-pitr" >/dev/null

# --- Rotation + WAL-Aufraeumen (Backup 2 auf dem wiederhergestellten Cluster) -
sleep 1
if bash tools/backup/vp-db-backup.sh --container "$P-verify" --skip-keycloak \
     --keep-daily 1 --keep-weekly 0 >"$TMP/backup2.out" 2>&1; then
  pass "vp-db-backup.sh: Lauf 2 (Rotation keep-daily=1)"
else
  fail "vp-db-backup.sh Lauf 2:"; sed 's/^/        /' "$TMP/backup2.out"
fi
if docker exec "$P-verify" test -d "/backup/base/$B1" 2>/dev/null; then
  fail "Rotation: $B1 haette geloescht werden muessen"
else
  pass "Rotation: altes Basis-Backup $B1 ist geloescht"
fi
B2=$(docker exec "$P-verify" sh -c 'ls /backup/base' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -1)
if [ -n "$B2" ] && [ "$B2" != "$B1" ]; then
  pass "Rotation: neues Basis-Backup $B2 ist da"
else
  fail "Rotation: kein neues Basis-Backup gefunden"
fi
WAL_COUNT_AFTER=$(docker exec "$P-verify" sh -c 'ls /backup/wal | wc -l' | tr -d ' ')
if docker exec "$P-verify" test -f "/backup/wal/$EARLIEST_WAL" 2>/dev/null; then
  fail "WAL-Aufraeumen: aeltestes Segment $EARLIEST_WAL liegt noch im Archiv"
else
  pass "WAL-Aufraeumen: aeltestes Segment $EARLIEST_WAL ist weg ($WAL_COUNT_BEFORE -> $WAL_COUNT_AFTER Dateien)"
fi
if [ -n "$B1_MARKER" ] && docker exec "$P-verify" test -f "/backup/wal/$B1_MARKER" 2>/dev/null; then
  fail "WAL-Aufraeumen: alter Backup-Marker $B1_MARKER liegt noch im Archiv"
else
  pass "WAL-Aufraeumen: alter Backup-Marker $B1_MARKER ist weg"
fi

# --- Alterscheck -------------------------------------------------------------
if bash tools/backup/vp-db-backup-check.sh --container "$P-verify" >"$TMP/check-ok.out" 2>&1; then
  pass "vp-db-backup-check.sh: frisches Backup + frisches WAL = Exit 0"
else
  fail "vp-db-backup-check.sh haette gruen sein muessen:"; sed 's/^/        /' "$TMP/check-ok.out"
fi
if bash tools/backup/vp-db-backup-check.sh --container "$P-verify" --max-base-age-hours 0 >"$TMP/check-base.out" 2>&1; then
  fail "Alterscheck: Schwelle 0 h haette rot sein muessen"
else
  pass "Alterscheck: zu altes Basis-Backup wird rot (Schwelle 0 h)"
fi
if bash tools/backup/vp-db-backup-check.sh --container "$P-verify" --max-wal-age-minutes 0 >"$TMP/check-wal.out" 2>&1; then
  fail "Alterscheck: WAL-Schwelle 0 min haette rot sein muessen"
else
  pass "Alterscheck: zu altes WAL-Archiv wird rot (Schwelle 0 min)"
fi

echo
echo "Ergebnis: $PASS PASS, $FAILED FAIL"
if [ "$FAILED" -ne 0 ]; then echo "TEST FAILED"; exit 1; fi
echo "TEST OK"

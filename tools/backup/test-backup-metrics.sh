#!/usr/bin/env bash
# =============================================================================
# test-backup-metrics.sh - der Textfile-Export des Sicherungsalters, offline.
#
# Faehrt tools/backup/vp-db-backup-metrics.sh gegen Wegwerf-Verzeichnisse im
# Layout, das vp-db-backup.sh und archive-wal.sh auf der VM anlegen
# (base/<JJJJMMTTThhmmssZ>, base/<Stempel>.part, wal/*.gz, wal/.*.part).
# Kein Docker, kein Postgres. Laeuft auch als Teil von Phase 0 in
# test-backup-restore.sh. Die Regel dazu beweist
# docs/bewertung/vorschlaege/gitops/pruefe.sh (promtool).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."

PASS=0
FAILED=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
note() { printf '  ....  %s\n' "$*"; }
# pruefe "Text" <Bedingung...>: PASS, wenn die Bedingung Exit 0 hat, sonst FAIL.
pruefe() { local text=$1; shift; if "$@"; then pass "$text"; else fail "$text"; fi; }
# nur_die_datei <verzeichnis>: liegt dort genau voltpilot_sicherung.prom und sonst nichts?
nur_die_datei() {
  [ "$(find "$1" -mindepth 1 | wc -l | tr -d ' ')" = 1 ] && [ -f "$1/voltpilot_sicherung.prom" ]
}
leer() { [ -z "$(find "$1" -mindepth 1)" ]; }

EXPORT=tools/backup/vp-db-backup-metrics.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
JETZT=1790352000   # 2026-09-25 16:00:00 UTC

wert() { # Metrikname Datei -> Wert oder leer
  { grep -E "^$1 " "$2" || true; } | awk '{print $2}'
}

echo "== Textfile-Export des Sicherungsalters =="

# --- 1. Normalfall: juengstes Basis-Backup, juengste WAL-Datei ----------------
B="$TMP/normal/backup"; T="$TMP/normal/textfile"
mkdir -p "$B/base/20260924T024012Z" "$B/base/20260925T024133Z" "$B/base/20260925T150000Z.part" \
  "$B/wal" "$B/keycloak" "$T"
printf 'a' > "$B/wal/000000010000000000000041.gz"
printf 'b' > "$B/wal/000000010000000000000042.gz"
printf 'c' > "$B/wal/.000000010000000000000043.gz.part"
printf 'd' > "$B/wal/000000010000000000000040.00000028.backup.gz"
TZ=UTC touch -t 202609251350.00 "$B/wal/000000010000000000000041.gz"
TZ=UTC touch -t 202609251400.00 "$B/wal/000000010000000000000042.gz"
TZ=UTC touch -t 202609251355.00 "$B/wal/000000010000000000000040.00000028.backup.gz"
TZ=UTC touch -t 202609251559.00 "$B/wal/.000000010000000000000043.gz.part"
printf 'alt' > "$T/voltpilot_sicherung.prom"
if AUS=$(bash "$EXPORT" --backup-dir "$B" --textfile-dir "$T" --jetzt "$JETZT" 2>&1); then
  pass "Exit 0 im Normalfall"
else
  fail "Exit != 0 im Normalfall: $AUS"
fi
P="$T/voltpilot_sicherung.prom"
pruefe "Basis: juengster abgeschlossener Stempel 20260925T024133Z = 1790304093, .part zaehlt nicht" \
  [ "$(wert voltpilot_sicherung_basis_timestamp_seconds "$P")" = 1790304093 ]
pruefe "WAL: juengste *.gz nach mtime (14:00 UTC = 1790344800), .part zaehlt nicht" \
  [ "$(wert voltpilot_sicherung_wal_timestamp_seconds "$P")" = 1790344800 ]
pruefe "Export-Zeitpunkt = --jetzt" [ "$(wert voltpilot_sicherung_export_timestamp_seconds "$P")" = "$JETZT" ]
case "$AUS" in
  *"Basis-Backup 20260925T024133Z (13 h alt), WAL 000000010000000000000042.gz (120 min alt)"*)
    pass "Journal-Zeile nennt Stempel und Alter" ;;
  *) fail "Journal-Zeile: $AUS" ;;
esac
RECHTE=$(stat -c %a "$P" 2>/dev/null || stat -f %Lp "$P")
pruefe "Datei 0644 (der node-exporter liest nicht als root), ist: $RECHTE" [ "$RECHTE" = 644 ]
pruefe "atomar: nur voltpilot_sicherung.prom, keine Temp-Reste, alte Datei ersetzt" nur_die_datei "$T"
if command -v promtool >/dev/null 2>&1; then
  if promtool check metrics < "$P" >"$TMP/lint.out" 2>&1; then
    pass "promtool check metrics: Textformat sauber"
  else
    fail "promtool check metrics:"; sed 's/^/        /' "$TMP/lint.out"
  fi
else
  note "promtool nicht installiert - Textformat-Pruefung uebersprungen"
fi

# --- 2. Keine Sicherung: die Zeilen fehlen, eine Null gibt es nicht ------------
B="$TMP/leer/backup"; T="$TMP/leer/textfile"
mkdir -p "$B/base" "$B/wal" "$T"
if bash "$EXPORT" --backup-dir "$B" --textfile-dir "$T" --jetzt "$JETZT" >/dev/null 2>&1; then
  pass "Exit 0 ohne Sicherung (urteilen tut die Regel)"
else
  fail "Exit != 0 ohne Sicherung"
fi
P="$T/voltpilot_sicherung.prom"
if ! grep -qE '^voltpilot_sicherung_(basis|wal)_timestamp_seconds ' "$P" \
   && grep -q '^# keine: kein abgeschlossenes Basis-Backup' "$P" \
   && grep -q '^# keine: keine WAL-Archivdatei' "$P" \
   && [ "$(wert voltpilot_sicherung_export_timestamp_seconds "$P")" = "$JETZT" ]; then
  pass "ohne Sicherung: Basis- und WAL-Zeile fehlen (kein 0), Export-Zeile steht"
else
  fail "ohne Sicherung: unerwarteter Inhalt"; sed 's/^/        /' "$P"
fi
# Nur ein .part-Verzeichnis ist auch keine Sicherung.
mkdir -p "$B/base/20260925T024133Z.part"
bash "$EXPORT" --backup-dir "$B" --textfile-dir "$T" --jetzt "$JETZT" >/dev/null 2>&1
pruefe "ein abgebrochenes .part-Verzeichnis ist kein Basis-Backup" \
  grep -q '^# keine: kein abgeschlossenes Basis-Backup' "$P"
# Verzeichnis gar nicht da (Tippfehler in --backup-dir): ebenfalls keine Sicherung.
bash "$EXPORT" --backup-dir "$TMP/gibt-es-nicht" --textfile-dir "$T" --jetzt "$JETZT" >/dev/null 2>&1
pruefe "fehlendes Backup-Verzeichnis = keine Sicherung, nicht 'frisch'" \
  grep -q '^# keine: kein abgeschlossenes Basis-Backup' "$P"

# --- 3. Stempel-Arithmetik ohne date: gegen bekannte Unix-Zeiten ---------------
while read -r STEMPEL SOLL; do
  B="$TMP/stempel-$STEMPEL/backup"; T="$TMP/stempel-$STEMPEL/textfile"
  mkdir -p "$B/base/$STEMPEL" "$T"
  bash "$EXPORT" --backup-dir "$B" --textfile-dir "$T" --jetzt "$JETZT" >/dev/null 2>&1
  IST=$(wert voltpilot_sicherung_basis_timestamp_seconds "$T/voltpilot_sicherung.prom")
  pruefe "Stempel $STEMPEL = $SOLL (ist: $IST)" [ "$IST" = "$SOLL" ]
done <<'EOF'
19700101T000000Z 0
20000101T000000Z 946684800
20261231T235959Z 1798761599
20280229T120000Z 1835438400
21000301T000000Z 4107542400
EOF

# --- 4. Aufruffehler: Exit 2, keine Datei ---------------------------------------
T="$TMP/fehler/textfile"; mkdir -p "$T"
RC=0; bash "$EXPORT" --backup-dir "$TMP" --textfile-dir "$TMP/fehler/gibt-es-nicht" >/dev/null 2>&1 || RC=$?
pruefe "fehlendes Textfile-Verzeichnis: Exit 2 (ist: $RC)" [ "$RC" = 2 ]
RC=0; bash "$EXPORT" --textfile-dir "$T" --jetzt gestern >/dev/null 2>&1 || RC=$?
pruefe "--jetzt ohne Zahl: Exit 2 (ist: $RC)" [ "$RC" = 2 ]
pruefe "nach Aufruffehler keine Datei" leer "$T"

# --- 5. shellcheck ---------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$EXPORT" tools/backup/test-backup-metrics.sh >"$TMP/sc.out" 2>&1; then
    pass "shellcheck sauber (Export + dieser Test)"
  else
    fail "shellcheck:"; sed 's/^/        /' "$TMP/sc.out"
  fi
else
  note "shellcheck nicht installiert - uebersprungen"
fi

echo "== $PASS PASS, $FAILED FAIL =="
[ "$FAILED" -eq 0 ] || { echo "TEST FAILED"; exit 1; }
echo "TEST OK"

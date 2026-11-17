#!/bin/sh
# Probe der Groessen-Leitplanke (scripts/groessen-gate.sh), ohne Docker und
# ohne Go-Build: synthetische Dateien mit den Groessen echter Releases
# (release.json, linux/mipsle) und den Grenzlagen. Budget ist ASP im
# Tauschweg (36 744 kB am 17.11.2026).
#
#   edge-light/test/groessen-gate-probe.sh
# shellcheck disable=SC2015 # ok/falsch-Zeilen wie in den Nachbar-Proben
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
GATE="$HIER/../scripts/groessen-gate.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT INT TERM
OK=0
FEHLER=0
ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; cat "$T/aus" 2>/dev/null | sed 's/^/    | /'; }

# datei <pfad> <bytes>
datei() { head -c "$2" /dev/zero >"$1"; }

# lauf <prog_bytes> <gz_bytes> -> rc in $RC, Ausgabe in $T/aus
lauf() {
  datei "$T/prog" "$1"
  datei "$T/prog.gz" "$2"
  RC=0
  bash "$GATE" "$T/prog" "$T/prog.gz" >"$T/aus" 2>&1 || RC=$?
}

echo "== 1. Stand 26.10.2026 (15 270 103 B): angenommen, ohne Warnung"
lauf 15270103 4851221
[ "$RC" = 0 ] && ok "Gate nimmt an (rc 0)" || falsch "Gate nimmt an (rc $RC)"
grep -q "Update-Bedarf 26912 kB (Budget 36744 kB, Abstand 9832 kB)" "$T/aus" && ok "Bedarf mit Loader Stand 2 (26 912 kB)" || falsch "Bedarf mit Loader Stand 2"
grep -q "mit Loader Stand 1 34912 kB (Abstand 1832 kB)" "$T/aus" && ok "Bedarf mit Loader Stand 1 (34 912 kB)" || falsch "Bedarf mit Loader Stand 1"
! grep -q "WARNUNG" "$T/aus" && ok "keine Warnung" || falsch "keine Warnung"

echo "== 2. 11.12 (16 515 287 B): tauschte an ASP mit Stand 1 - ohne Warnung"
lauf 16515287 5283464
[ "$RC" = 0 ] && ok "Gate nimmt an (rc 0)" || falsch "Gate nimmt an (rc $RC)"
grep -q "mit Loader Stand 1 36128 kB (Abstand 616 kB)" "$T/aus" && ok "Stand 1: 36 128 kB <= 36 744 kB" || falsch "Stand 1: 36 128 kB"
! grep -q "WARNUNG" "$T/aus" && ok "keine Warnung" || falsch "keine Warnung"

echo "== 3. 11.13 (17 236 183 B): Stand 1 tauscht an ASP nicht mehr sicher - Warnung"
lauf 17236183 5520820
[ "$RC" = 0 ] && ok "Gate nimmt an (rc 0)" || falsch "Gate nimmt an (rc $RC)"
grep -q "WARNUNG: Boxen mit Loader Stand 1 tauschen diese Fassung" "$T/aus" && ok "warnt fuer Loader Stand 1" || falsch "warnt fuer Loader Stand 1"
grep -q "Bedarf 36832 kB > Budget 36744 kB" "$T/aus" && ok "nennt 36 832 kB > 36 744 kB" || falsch "nennt 36 832 kB > 36 744 kB"

echo "== 4. 11.15 (17 432 791 B): die Zahlen aus dem Log von ASP"
lauf 17432791 5560506
[ "$RC" = 0 ] && ok "Gate nimmt an (rc 0, Stand 2 tauscht)" || falsch "Gate nimmt an (rc $RC)"
grep -q "Update-Bedarf 29024 kB (Budget 36744 kB, Abstand 7720 kB)" "$T/aus" && ok "Stand 2: 29 024 kB, Abstand 7 720 kB" || falsch "Stand 2: 29 024 kB"
grep -q "Bedarf 37024 kB > Budget 36744 kB" "$T/aus" && ok "Stand 1: 37 024 kB > 36 744 kB (wie im Log)" || falsch "Stand 1: 37 024 kB > 36 744 kB"
! grep -q "nur noch" "$T/aus" && ok "keine Vorwarnung fuer Stand 2" || falsch "keine Vorwarnung fuer Stand 2"

echo "== 5. Vorwarnung: weniger als 1 MiB Abstand fuer Loader Stand 2"
# 24 500 000 B -> 23925 + 12000 = 35925 kB, Abstand 819 kB < 1024 kB.
lauf 24500000 6000000
[ "$RC" = 0 ] && ok "Gate nimmt noch an (rc 0)" || falsch "Gate nimmt noch an (rc $RC)"
grep -q "WARNUNG: nur noch 819 kB Abstand zum RAM-Budget" "$T/aus" && ok "Vorwarnung mit Abstand" || falsch "Vorwarnung mit Abstand"

echo "== 6. zu gross auch fuer Loader Stand 2: verweigert"
# 25 400 000 B -> 24804 + 12000 = 36804 kB > 36 744 kB.
lauf 25400000 6500000
[ "$RC" = 1 ] && ok "Gate verweigert (rc 1)" || falsch "Gate verweigert (rc $RC)"
grep -q "FEHLER: das Programm ist zu gross fuer ein Update auf der Mango: Bedarf 36804 kB > Budget 36744 kB" "$T/aus" && ok "nennt den Grund" || falsch "nennt den Grund"

echo "== 7. gepackte Lieferung zu gross fuer den Flash: verweigert"
lauf 16842945 7600000
[ "$RC" = 1 ] && ok "Gate verweigert (rc 1)" || falsch "Gate verweigert (rc $RC)"
grep -q "passt nicht mehr sicher in den" "$T/aus" && ok "nennt den Flash als Grund" || falsch "nennt den Flash als Grund"

echo
echo "$OK ok, $FEHLER Fehler"
[ "$FEHLER" -eq 0 ]

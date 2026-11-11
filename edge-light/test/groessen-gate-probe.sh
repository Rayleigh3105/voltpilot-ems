#!/bin/sh
# Probe der Groessen-Leitplanke (scripts/groessen-gate.sh), ohne Docker und
# ohne Go-Build: synthetische Dateien in den vier Lagen heutige Groesse,
# Vorwarnung, zu gross fuer den RAM, zu gross fuer den Flash.
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

echo "== 1. heutige Groesse (16,8 MB / 5,4 MB): angenommen, ohne Warnung"
lauf 16842945 5424041
[ "$RC" = 0 ] && ok "Gate nimmt an (rc 0)" || falsch "Gate nimmt an (rc $RC)"
grep -q "Update-Bedarf 36448 kB" "$T/aus" && ok "nennt den Update-Bedarf (36 448 kB)" || falsch "nennt den Update-Bedarf"
! grep -q "WARNUNG" "$T/aus" && ok "keine Vorwarnung" || falsch "keine Vorwarnung"

echo "== 2. Vorwarnung: weniger als 1 MiB Abstand zum RAM-Budget"
# 18 900 000 B -> Bedarf 18457 + 20000 = 38457 kB, Abstand 543 kB < 1024 kB.
lauf 18900000 6000000
[ "$RC" = 0 ] && ok "Gate nimmt noch an (rc 0)" || falsch "Gate nimmt noch an (rc $RC)"
grep -q "WARNUNG: nur noch 543 kB Abstand zum RAM-Budget" "$T/aus" && ok "Vorwarnung mit Abstand" || falsch "Vorwarnung mit Abstand"

echo "== 3. zu gross fuer den RAM der schwaechsten Mango: verweigert"
# 20 500 000 B -> Bedarf 20019 + 20000 = 40019 kB > 39 000 kB.
lauf 20500000 6500000
[ "$RC" = 1 ] && ok "Gate verweigert (rc 1)" || falsch "Gate verweigert (rc $RC)"
grep -q "FEHLER: das Programm ist zu gross fuer ein Update auf der Mango" "$T/aus" && ok "nennt den Grund" || falsch "nennt den Grund"

echo "== 4. gepackte Lieferung zu gross fuer den Flash: verweigert"
lauf 16842945 7600000
[ "$RC" = 1 ] && ok "Gate verweigert (rc 1)" || falsch "Gate verweigert (rc $RC)"
grep -q "passt nicht mehr sicher in den" "$T/aus" && ok "nennt den Flash als Grund" || falsch "nennt den Flash als Grund"

echo
echo "$OK ok, $FEHLER Fehler"
[ "$FEHLER" -eq 0 ]

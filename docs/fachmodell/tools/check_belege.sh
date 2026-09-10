#!/usr/bin/env bash
# Prüft, dass jeder Beleg `datei:zeile` in `glossar.md` und `auswirkungen.md` auf eine
# EXISTIERENDE Datei zeigt.
#
# Eine fehlende Datei ist ein FEHLER (Exit 1) — ein Beleg, der auf nichts zeigt, ist eine
# Behauptung ohne Deckung. Eine abweichende ZEILE ist nur eine Warnung: die Zeile eines Belegs
# wandert bei jedem Umbau darüber, die Aussage bleibt trotzdem wahr. Gewarnt wird, wenn die
# Datei kürzer ist als die belegte Zeile — dann ist der Beleg sicher veraltet.
#
#   bash docs/fachmodell/tools/check_belege.sh
#
# `DATA/…` wird übersprungen: das ist die Konzept-Ablage des Programms, nicht dieses Repo.
set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 1
MIG="services/api/src/main/resources/db/migration"
PORTAL="frontend/portal/src"
QUELLEN="docs/fachmodell/glossar.md docs/fachmodell/auswirkungen.md"

for q in $QUELLEN; do
  [ -f "$q" ] || { echo "FEHLER: $q fehlt — erst den Generator laufen lassen"; exit 1; }
done

fehler=0
warnungen=0
geprueft=0

# Belege sehen so aus: MIG/V1__core_schema.sql:36-44 · PORTAL/nav.ts:881 · docs/architecture.md:90-94
belege=$(grep -hoE '(MIG|PORTAL|DATA)?/?[A-Za-z0-9_./-]+\.(sql|ts|tsx|java|json|md|py):[0-9]+' \
  $QUELLEN | sort -u)

while IFS= read -r beleg; do
  [ -n "$beleg" ] || continue
  datei="${beleg%:*}"
  zeile="${beleg##*:}"
  case "$datei" in
    DATA/*) continue ;;
    MIG/*) pfad="$MIG/${datei#MIG/}" ;;
    PORTAL/*) pfad="$PORTAL/${datei#PORTAL/}" ;;
    *) pfad="$datei" ;;
  esac
  geprueft=$((geprueft + 1))
  if [ ! -f "$pfad" ]; then
    echo "FEHLER  $beleg → $pfad existiert nicht"
    fehler=$((fehler + 1))
    continue
  fi
  laenge=$(wc -l < "$pfad" | tr -d ' ')
  if [ "$zeile" -gt "$laenge" ]; then
    echo "WARNUNG $beleg → $pfad hat nur $laenge Zeilen"
    warnungen=$((warnungen + 1))
  fi
done <<< "$belege"

echo "$geprueft Belege geprüft · $fehler fehlende Dateien · $warnungen veraltete Zeilen"
[ "$fehler" -eq 0 ] || exit 1

#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
MAIN_COMMIT=4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3
OUTPUT=${TMPDIR:-/tmp}/vp-buehne-bilder
REVIEW=${TMPDIR:-/tmp}/vp-buehne-bestandskunde.html
FEHLERLOG=${TMPDIR:-/tmp}/vp-buehne-vorher-nachher-fehler.log
JAVA_HOME_DEFAULT=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) OUTPUT=$2; shift 2 ;;
    --review) REVIEW=$2; shift 2 ;;
    --help)
      echo "Aufruf: bash tools/buehne-vorher-nachher/run.sh [--output ORDNER] [--review DATEI]"
      exit 0
      ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

case "$OUTPUT" in /*) ;; *) OUTPUT="$ROOT/$OUTPUT" ;; esac
case "$REVIEW" in /*) ;; *) REVIEW="$ROOT/$REVIEW" ;; esac

for programm in cmp docker git java npm python3 lsof memory_pressure; do
  command -v "$programm" >/dev/null || { echo "Fehlt: $programm" >&2; exit 2; }
done
export JAVA_HOME=${JAVA_HOME:-$JAVA_HOME_DEFAULT}
"$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "21' || { echo "Java 21 ist erforderlich." >&2; exit 2; }

ARBEIT=$(mktemp -d "${TMPDIR:-/tmp}/vp-buehne-vorher-nachher.XXXXXX")
MAIN_WORKTREE="$ARBEIT/main"
cleanup() {
  if [ -e "$MAIN_WORKTREE/.git" ]; then
    git -C "$ROOT" worktree remove --force "$MAIN_WORKTREE" >/dev/null 2>&1 || true
  fi
  case "$ARBEIT" in
    "${TMPDIR:-/tmp}"/vp-buehne-vorher-nachher.*) rm -rf "$ARBEIT" ;;
  esac
}
trap cleanup EXIT INT TERM
mkdir -p "$OUTPUT" "$(dirname "$REVIEW")" "$ARBEIT/logs"

warte_containerfenster() {
  while :; do
    frei=$(memory_pressure | tail -1 | sed -E 's/.* ([0-9]+)%/\1/')
    # Fremde Bahnen dürfen eigene, langlebige Container besitzen. Dieser Lauf startet seriell nur
    # eine Wegwerf-Datenbank plus Testcontainers-Aufräumer und prüft deshalb hier ausschließlich
    # das gemeinsame Speicherfenster; fremde Docker-Ressourcen fasst er weder an noch zählt er als eigene.
    if [ "$frei" -ge 35 ]; then return; fi
    echo "Warte auf Testcontainers-Speicherfenster: $frei % frei (mindestens 35 % erforderlich)."
    sleep 20
  done
}

warte_port() {
  while lsof -nP -iTCP:4174 -sTCP:LISTEN >/dev/null 2>&1; do
    echo "Port 4174 ist belegt; die Bühne wartet."
    sleep 10
  done
}

echo "Lege den belegten main-Stand $MAIN_COMMIT als detached Wegwerf-Worktree an."
git -C "$ROOT" worktree add --detach "$MAIN_WORKTREE" "$MAIN_COMMIT" >/dev/null
mkdir -p "$MAIN_WORKTREE/services/api/src/test/java/com/voltpilot/api/uems"
mkdir -p "$MAIN_WORKTREE/services/api/src/test/resources/uems/nw2"
mkdir -p "$MAIN_WORKTREE/services/api/src/test/resources/migration"
mkdir -p "$MAIN_WORKTREE/frontend/portal/e2e"
cp "$ROOT/services/api/src/test/java/com/voltpilot/api/uems/UemsBestandSteuerungAusEinemStueckTest.java" \
  "$MAIN_WORKTREE/services/api/src/test/java/com/voltpilot/api/uems/"
cp "$ROOT/services/api/src/test/resources/uems/nw2/"* "$MAIN_WORKTREE/services/api/src/test/resources/uems/nw2/"
cp "$ROOT/services/api/src/test/resources/migration/main-migrations.txt" \
  "$MAIN_WORKTREE/services/api/src/test/resources/migration/"
cp "$ROOT/frontend/portal/e2e/buehne-vorher-nachher.html" \
  "$ROOT/frontend/portal/e2e/buehne-vorher-nachher.tsx" \
  "$ROOT/frontend/portal/e2e/buehne-vorher-nachher.spec.ts" \
  "$MAIN_WORKTREE/frontend/portal/e2e/"

warte_containerfenster
echo "Zeichne main-API-Antworten auf einer Wegwerf-Datenbank auf."
if ! (cd "$MAIN_WORKTREE/services/api" && ./mvnw clean test \
  -Dtest=UemsBestandSteuerungAusEinemStueckTest \
  -Dbuehne.container-prefix="vp-buehne-ip20-main-$$" \
  -Dnw2.capture="$ARBEIT/main-reference.json" \
  -Dbuehne.antworten="$ARBEIT/main-antworten.json") >"$ARBEIT/logs/main-api.log" 2>&1; then
  cp "$ARBEIT/logs/main-api.log" "$FEHLERLOG"
  tail -25 "$ARBEIT/logs/main-api.log"
  echo "Vollständiger Fehlerlog: $FEHLERLOG"
  exit 1
fi
tail -25 "$ARBEIT/logs/main-api.log"

warte_containerfenster
echo "Migriere dieselbe Saat mit UEMS und zeichne Antworten nach den Bestandsläufern auf."
if ! (cd "$ROOT/services/api" && ./mvnw clean test \
  -Dtest=UemsBestandSteuerungAusEinemStueckTest \
  -Dbuehne.container-prefix="vp-buehne-ip20-uems-$$" \
  -Dnw2.observed="$ARBEIT/uems-observed.json" \
  -Dbuehne.antworten="$ARBEIT/uems-antworten.json") >"$ARBEIT/logs/uems-api.log" 2>&1; then
  cp "$ARBEIT/logs/uems-api.log" "$FEHLERLOG"
  tail -25 "$ARBEIT/logs/uems-api.log"
  echo "Vollständiger Fehlerlog: $FEHLERLOG"
  exit 1
fi
tail -25 "$ARBEIT/logs/uems-api.log"

if [ ! -d "$ROOT/frontend/portal/node_modules" ]; then
  (cd "$ROOT/frontend/portal" && npm ci)
fi
ln -s "$ROOT/frontend/portal/node_modules" "$MAIN_WORKTREE/frontend/portal/node_modules"

warte_port
echo "Rendere das echte main-Portal mit den aufgezeichneten main-Antworten."
(cd "$MAIN_WORKTREE/frontend/portal" && \
  BUEHNE_PHASE=vorher BUEHNE_ANTWORTEN="$ARBEIT/main-antworten.json" BUEHNE_BILDER="$OUTPUT" \
  npx playwright test e2e/buehne-vorher-nachher.spec.ts --project=desktop-chromium --workers=1) \
  >"$ARBEIT/logs/main-portal.log" 2>&1 || { cp "$ARBEIT/logs/main-portal.log" "$FEHLERLOG"; tail -25 "$ARBEIT/logs/main-portal.log"; echo "Vollständiger Fehlerlog: $FEHLERLOG"; exit 1; }
tail -25 "$ARBEIT/logs/main-portal.log"

warte_port
echo "Rendere das echte UEMS-Portal mit den Antworten nach Migrationen und Läufern."
(cd "$ROOT/frontend/portal" && \
  BUEHNE_PHASE=nachher BUEHNE_ANTWORTEN="$ARBEIT/uems-antworten.json" BUEHNE_BILDER="$OUTPUT" \
  npx playwright test e2e/buehne-vorher-nachher.spec.ts --project=desktop-chromium --workers=1) \
  >"$ARBEIT/logs/uems-portal.log" 2>&1 || { cp "$ARBEIT/logs/uems-portal.log" "$FEHLERLOG"; tail -25 "$ARBEIT/logs/uems-portal.log"; echo "Vollständiger Fehlerlog: $FEHLERLOG"; exit 1; }
tail -25 "$ARBEIT/logs/uems-portal.log"

for breite in 375 1440; do
  if ! cmp -s "$OUTPUT/u1-vorher-$breite.png" "$OUTPUT/u1-nachher-$breite.png"; then
    echo "U1 ist bei $breite px nicht bytegleich; Bilder bleiben zur Befundaufnahme erhalten." >&2
    exit 1
  fi
done

python3 "$ROOT/tools/buehne-vorher-nachher/review.py" --images "$OUTPUT" --output "$REVIEW"
echo "Bilder: $OUTPUT"
echo "Ansicht: $REVIEW"
echo "Temporäre Datenbanken, Portal-Kopie und Logs wurden ausschließlich im eigenen Wegwerfbereich gehalten."

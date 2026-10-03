#!/usr/bin/env bash
# Die Pruefungen von Edge Light, ohne Hardware:
#
#   1. die gemeinsamen Vektoren sind aus den aktuellen JS-Modulen erzeugt
#      (Node-RED bleibt die Quelle der Wahrheit),
#   2. die Go-Zwillinge (solarmanv5, deyedecode) stimmen mit ihnen ueberein,
#   3. die Go-Schicht 1 (layer1) inklusive des Integrationstests
#      "unveraenderter Kern + Go-Schicht 1",
#   4. das Programm laesst sich fuer MIPS bauen (der Mango).
#
#   edge-light/scripts/test.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/lib.sh"

NODERED="$REPO_ROOT/edge-app/nodered"

echo "--- 1. gemeinsame Vektoren (JS)"
if command -v node >/dev/null 2>&1; then
  node --test "$NODERED/deye/deye-decode-vectors.test.js" "$NODERED/deye/solarman-v5-vectors.test.js"
else
  echo "    uebersprungen: node fehlt (die Go-Seite prueft die committeten Vektoren trotzdem)"
fi

echo "--- 2.+3. Go-Zwillinge und Schicht 1 (mit Race-Detector)"
go_run -- vet ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/layer1/... ./internal/edgemain/... ./cmd/vp-edge-light/ ./cmd/vp-solarman-sim/
go_run CGO_ENABLED=1 -- test -count=1 -race ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/layer1/...

echo "--- 4. MIPS-Build (Mango)"
go_run GOOS=linux GOARCH=mipsle GOMIPS=softfloat CGO_ENABLED=0 -- build -o /dev/null ./cmd/vp-edge-light

echo "--- alles gruen"

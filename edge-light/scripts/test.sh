#!/usr/bin/env bash
# Die Pruefungen von Edge Light, ohne Hardware:
#
#   1. die gemeinsamen Vektoren sind aus den aktuellen JS-Modulen erzeugt
#      (Node-RED bleibt die Quelle der Wahrheit),
#   2. die Go-Zwillinge (solarmanv5, deyedecode, goeapi, verbraucherregel,
#      huaweidecode, kacoserial) stimmen mit ihnen ueberein; der gemeinsame
#      Modbus-TCP-Client (modbustcp),
#   3. die Go-Schicht 1 (layer1) inklusive des Integrationstests
#      "unveraenderter Kern + Go-Schicht 1" und die Geraetesuche
#      (geraetesuche, gegen simulierte Geraete),
#   4. das Programm laesst sich fuer MIPS bauen (der Mango).
#
#   edge-light/scripts/test.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/lib.sh"

NODERED="$REPO_ROOT/edge-app/nodered"

echo "--- 1. gemeinsame Vektoren (JS)"
if command -v node >/dev/null 2>&1; then
  node --test "$NODERED/deye/deye-decode-vectors.test.js" "$NODERED/deye/solarman-v5-vectors.test.js" \
    "$NODERED/goe/goe-api-vectors.test.js" "$NODERED/huawei/huawei-decode-vectors.test.js" \
    "$NODERED/kaco/kaco-serial-vectors.test.js"
  # Verbraucherregel (vp-consumer-policy): die Vektoren kommen aus der JS-Referenz.
  node "$NODERED/vp-palette/test/verbraucherregel-vectors.gen.js" --check
else
  echo "    uebersprungen: node fehlt (die Go-Seite prueft die committeten Vektoren trotzdem)"
fi

echo "--- 2.+3. Go-Zwillinge und Schicht 1 (mit Race-Detector)"
go_run -- vet ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/goeapi/... ./internal/huaweidecode/... ./internal/kacoserial/... ./internal/modbustcp/... ./internal/verbraucherregel/... ./internal/flowdeploy/... ./internal/layer1/... ./internal/edgemain/... ./internal/geraetesuche/... ./internal/otalight/... ./cmd/vp-edge-light/ ./cmd/vp-solarman-sim/ ./cmd/vp-geraete-sim/
go_run CGO_ENABLED=1 -- test -count=1 -race ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/goeapi/... ./internal/huaweidecode/... ./internal/kacoserial/... ./internal/modbustcp/... ./internal/verbraucherregel/... ./internal/flowdeploy/... ./internal/layer1/... ./internal/geraetesuche/... ./internal/otalight/...
# Das Update im Programm (Konzept vp-edge-light-update, K3): laden, pruefen, Probe.
go_run CGO_ENABLED=1 -- test -count=1 -race -run 'EdgeLight' ./internal/agent/

echo "--- 4. MIPS-Build (Mango)"
go_run GOOS=linux GOARCH=mipsle GOMIPS=softfloat CGO_ENABLED=0 -- build -o /dev/null ./cmd/vp-edge-light

echo "--- alles gruen"

#!/usr/bin/env bash
# Die Pruefungen von Edge Light, ohne Hardware:
#
#   1. die gemeinsamen Vektoren sind aus den aktuellen JS-Modulen erzeugt
#      (Node-RED bleibt die Quelle der Wahrheit),
#   2. die Go-Zwillinge (solarmanv5, deyedecode, goeapi, verbraucherregel,
#      huaweidecode, kacoserial, modbusprofil) stimmen mit ihnen ueberein; der
#      gemeinsame Modbus-TCP-Client (modbustcp),
#   3. die Go-Schicht 1 (layer1) inklusive des Integrationstests
#      "unveraenderter Kern + Go-Schicht 1" und die Geraetesuche
#      (geraetesuche, gegen simulierte Geraete); der Kern der Steuerlogik
#      (logik) und ihr Mitlauf (logiklauf), das eigene Modbus-Geraet mit
#      Schreibwerten (modbusgeraet),
#   4. die SPS-Bibliothek (sps/codesys) stimmt mit den Vertragsvektoren des
#      Erzeuger-Bilds ueberein,
#   5. das Programm laesst sich fuer MIPS bauen (der Mango),
#   6. es laesst sich fuer ARMv7 bauen (der WAGO PFC200), und der Loader des
#      PFC200 spricht wortgleich das Update-Protokoll des Mango-Loaders
#      (pfc-abgleich.sh); die Modellangabe der Box (geraet).
#
#   edge-light/scripts/test.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/lib.sh"

NODERED="$REPO_ROOT/edge-app/nodered"

echo "--- 1. gemeinsame Vektoren (JS)"
if command -v node >/dev/null 2>&1; then
  node --test "$NODERED/deye/deye-decode-vectors.test.js" "$NODERED/deye/solarman-v5-vectors.test.js" \
    "$NODERED/goe/goe-api-vectors.test.js" "$NODERED/huawei/huawei-decode-vectors.test.js" \
    "$NODERED/kaco/kaco-serial-vectors.test.js" "$NODERED/sunspec/sunspec-live-vectors.test.js" \
    "$NODERED/measurements/erzeuger-laufzeit-vectors.test.js" "$NODERED/modbus-tcp-vectors.test.js"
  # Verbraucherregel (vp-consumer-policy): die Vektoren kommen aus der JS-Referenz.
  node "$NODERED/vp-palette/test/verbraucherregel-vectors.gen.js" --check
else
  echo "    uebersprungen: node fehlt (die Go-Seite prueft die committeten Vektoren trotzdem)"
fi

echo "--- 2.+3. Go-Zwillinge und Schicht 1 (mit Race-Detector)"
go_run -- vet ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/goeapi/... ./internal/huaweidecode/... ./internal/kacoserial/... ./internal/sunspeclive/... ./internal/erzeugerbild/... ./internal/shellyem/... ./internal/componentapply/... ./internal/modbustcp/... ./internal/modbusprofil/... ./internal/verbraucherregel/... ./internal/flowdeploy/... ./internal/layer1/... ./internal/edgemain/... ./internal/geraetesuche/... ./internal/otalight/... ./internal/loaderstand/... ./internal/geraet/... ./internal/logik/... ./internal/logiklauf/... ./internal/modbusgeraet/... ./cmd/vp-edge-light/ ./cmd/vp-solarman-sim/ ./cmd/vp-geraete-sim/ ./cmd/vp-lese-probe/
go_run CGO_ENABLED=1 -- test -count=1 -race ./internal/solarmanv5/... ./internal/deyedecode/... ./internal/goeapi/... ./internal/huaweidecode/... ./internal/kacoserial/... ./internal/sunspeclive/... ./internal/erzeugerbild/... ./internal/shellyem/... ./internal/componentapply/... ./internal/modbustcp/... ./internal/modbusprofil/... ./internal/verbraucherregel/... ./internal/flowdeploy/... ./internal/layer1/... ./internal/geraetesuche/... ./internal/otalight/... ./internal/loaderstand/... ./internal/geraet/... ./internal/logik/... ./internal/logiklauf/... ./internal/modbusgeraet/...
# Das Update im Programm (Konzept vp-edge-light-update, K3): laden, pruefen,
# Probe - und die Lader-Pflege des bestaetigten Programms (Loader-Selbstupdate).
go_run CGO_ENABLED=1 -- test -count=1 -race -run 'EdgeLight' ./internal/agent/
# Steuerlogik (Stufe 2): der Kern laeuft auf beiden Box-Arten mit, ohne zu schalten.
# Klima, Heizung, Kaelte (K2/K3): das eigene Modbus-Geraet mit Schreibwerten liest
# und schreibt der Core selbst, gegen ein gestelltes Geraet.
go_run CGO_ENABLED=1 -- test -count=1 -race -run 'Steuerlogik|LogikQuelle|LogikBefehle|ModbusGeraet|KlimaLogik|KuehlraumLogik' ./internal/agent/

echo "--- 4. SPS-Bibliothek (CODESYS) gegen die Vertragsvektoren des Erzeuger-Bilds"
if command -v python3 >/dev/null 2>&1; then
  python3 "$REPO_ROOT/sps/codesys/pruefer/pruefe.py"
else
  echo "    uebersprungen: python3 fehlt"
fi
echo "--- 5. MIPS-Build (Mango)"
go_run GOOS=linux GOARCH=mipsle GOMIPS=softfloat CGO_ENABLED=0 -- build -o /dev/null ./cmd/vp-edge-light

echo "--- 6. ARMv7-Build und Loader-Abgleich (WAGO PFC200)"
go_run GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 -- build -o /dev/null ./cmd/vp-edge-light
"$LIGHT_DIR/scripts/pfc-abgleich.sh"

echo "--- alles gruen"

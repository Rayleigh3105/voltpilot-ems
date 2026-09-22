#!/bin/sh
# AP-15 IP-29: sechs Säulen AHR-LP-02…07 (ladepark-je-box-vectors.json R3) an
# der Box Verwaltung; je Säule ein Anschluss und ein Wagen, der 22 kW will und
# unter 4,1 kW (6 A dreiphasig) nicht lädt. Statusseite der Säule n: :91nn.
set -eu
CSMS="${LP_CSMS:-ws://core:8887/ocpp}"
# vp-ocpp-sim gibt nach 20 s ohne Verbindung auf; die Box lässt eine Säule
# aber erst zu, wenn das Ladepark-Dokument sie freigegeben hat - also neu wählen.
for n in 02 03 04 05 06 07; do
  (while :; do
    vp-ocpp-sim --csms "$CSMS" --id "AHR-LP-$n" --connectors 1 --status "0.0.0.0:91$n" 2>&1 \
      | grep -v "could not reach" || true
    sleep 2
  done) &
done
# Einstecken, sobald die Säule verbunden ist (ihre Statusseite antwortet erst dann).
for n in 02 03 04 05 06 07; do
  i=0
  until wget -q -O /dev/null "http://127.0.0.1:91$n/status" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 300 ] || { echo "AHR-LP-$n nicht verbunden" >&2; exit 1; }
    sleep 1
  done
  wget -q -O /dev/null --post-data '' "http://127.0.0.1:91$n/plug?connector=1&demand=${LP_WAGEN_KW:-22}&min=4.1" \
    && echo "AHR-LP-$n: Wagen eingesteckt"
done
wait

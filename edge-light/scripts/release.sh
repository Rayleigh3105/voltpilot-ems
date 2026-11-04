#!/usr/bin/env bash
# Eine Edge-Light-Fassung bauen (Release-Linie edge-light-JJJJ.MM.N, Entscheid
# E7): die Programme fuer die Mango (mipsle) und den Raspberry Pi (arm64), den
# Skriptstand, die Pruefsummen und den Ausschnitt fuer die Freigabe der
# Werkstatt. Der Lauf .forgejo/workflows/edge-light-release.yaml haengt das an
# das Forgejo-Release; der Werkstatt-Dienst spielt es auf
# (services/werkstatt-dienst, Release-Anhaenge).
#
#   edge-light/scripts/release.sh edge-light-2026.11.0 <ausgabe>
#
# In <ausgabe>:
#   vp-edge-light-linux-mipsle, vp-edge-light-linux-arm64   die Programme
#   vp-edge-light-linux-<arch>.gz                           je Programm die gepackte Lieferung (gzip -9 -n)
#   edge-light-openwrt.tar.gz                               edge-light/openwrt/ als openwrt/…
#   sha256sums                                              alle fuenf, Format sha256sum
#   freigabe-edge-light.json                                der Block edge_light der Freigabe (Mango)
#
# Die gepackte Lieferung ist das, was eine Box beim Update laedt (Konzept
# vp-edge-light-update, Schritt 3): ~5 MB statt 16 MB in den Arbeitsspeicher.
# `gzip -n` laesst Name und Zeit weg - dieselben Programme ergeben byteweise
# dieselbe Lieferung. Das Manifest (`vp-ota manifest --binary`) und die
# Signatur entstehen im Release-Lauf, nicht hier. Die Fassung steht als Version
# im Programm (/health "version") - genau sie prueft der Werkstatt-Dienst gegen
# die Freigabe.
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/lib.sh"

TAG="${1:-}"
AUS="${2:-}"
[[ "$TAG" =~ ^edge-light-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$ ]] || {
  echo "FEHLER: Fassung '$TAG' folgt nicht dem Schema edge-light-JJJJ.MM.N" >&2
  exit 2
}
[ -n "$AUS" ] || { echo "FEHLER: Ausgabeverzeichnis fehlt" >&2; exit 2; }
have_local_go || { echo "FEHLER: release.sh braucht Go >= 1.24 auf dem Rechner" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "FEHLER: python3 fehlt" >&2; exit 2; }
mkdir -p "$AUS"
AUS="$(cd "$AUS" && pwd -P)"
BAU="$AUS/.bau"
rm -rf "$BAU"

VP_LIGHT_VERSION="$TAG" VP_LIGHT_DIST="$BAU" "$LIGHT_DIR/scripts/build.sh" mipsle arm64
for arch in mipsle arm64; do
  mv -f "$BAU/vp-edge-light-linux-$arch" "$AUS/"
  # Die Fassung muss im Programm stehen (ldflags); sonst meldet /health etwas anderes.
  grep -aqF "$TAG" "$AUS/vp-edge-light-linux-$arch" || {
    echo "FEHLER: $TAG steht nicht im Programm vp-edge-light-linux-$arch" >&2
    exit 1
  }
done
rm -rf "$BAU"
for arch in mipsle arm64; do
  gzip -9 -n -c "$AUS/vp-edge-light-linux-$arch" >"$AUS/vp-edge-light-linux-$arch.gz"
done
python3 "$LIGHT_DIR/scripts/skripte-paket.py" "$AUS/edge-light-openwrt.tar.gz"

summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }
(cd "$AUS" && for f in vp-edge-light-linux-mipsle vp-edge-light-linux-arm64 \
  vp-edge-light-linux-mipsle.gz vp-edge-light-linux-arm64.gz edge-light-openwrt.tar.gz; do
  printf '%s  %s\n' "$(summe "$f")" "$f"
done) >"$AUS/sha256sums"

QUELLE="${VP_LIGHT_RELEASE_QUELLE:-https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/$TAG/}"
printf '{\n  "fassung": "%s",\n  "quelle": "%s",\n  "programm_sha256": "%s",\n  "skripte_sha256": "%s"\n}\n' \
  "$TAG" "$QUELLE" "$(summe "$AUS/vp-edge-light-linux-mipsle")" "$(summe "$AUS/edge-light-openwrt.tar.gz")" \
  >"$AUS/freigabe-edge-light.json"

echo "--- $TAG fertig in $AUS"
cat "$AUS/sha256sums"
echo "--- Block edge_light fuer die Freigabe der Werkstatt (Mango):"
cat "$AUS/freigabe-edge-light.json"

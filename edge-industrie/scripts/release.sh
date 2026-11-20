#!/usr/bin/env bash
# Eine Edge-Industrie-Fassung bauen (Release-Linie edge-industrie-JJJJ.MM.N):
# das Programm fuer den WAGO PFC200 (linux/arm, ARMv7), seine gepackte
# Lieferung, dazu was die Werkstatt beim Einrichten eines Geraets auflegt
# (Skriptstand, Tunnel-Programm), und die Pruefsummen. Der Lauf
# .forgejo/workflows/edge-industrie-release.yaml haengt das an das
# Forgejo-Release.
#
#   edge-industrie/scripts/release.sh edge-industrie-2026.11.0 <ausgabe>
#
# In <ausgabe>:
#   vp-edge-industrie-linux-arm      das Programm
#   vp-edge-industrie-linux-arm.gz   die gepackte Lieferung (gzip -9 -n)
#   edge-industrie-skripte.tar.gz    der Skriptstand: install.sh, wartung.sh,
#                                    files/ (scripts/skripte-paket.py)
#   vp-wartung-linux-arm             das Tunnel-Programm (edge-industrie/wartung)
#   sha256sums                       alle vier, Format sha256sum
#
# Ein Update aus dem Portal tauscht nur das Programm. Skriptstand und
# Tunnel-Programm legt der Werkstatt-Dienst beim Einrichten auf das Geraet; ihre
# Pruefsummen kommen signiert ins Manifest (`vp-ota manifest --skripte
# --wartung`), als eigene Felder und nie als Bestandteil des Updates. Das
# Manifest (Backend industrie) und die Signatur entstehen im Release-Lauf.
# Die Fassung steht als Version in beiden Programmen (/health "version",
# vp-wartung fassung).
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../../edge-light/scripts/lib.sh"

TAG="${1:-}"
AUS="${2:-}"
[[ "$TAG" =~ ^edge-industrie-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$ ]] || {
  echo "FEHLER: Fassung '$TAG' folgt nicht dem Schema edge-industrie-JJJJ.MM.N" >&2
  exit 2
}
[ -n "$AUS" ] || { echo "FEHLER: Ausgabeverzeichnis fehlt" >&2; exit 2; }
have_local_go || { echo "FEHLER: release.sh braucht Go >= 1.24 auf dem Rechner" >&2; exit 2; }
mkdir -p "$AUS"
AUS="$(cd "$AUS" && pwd -P)"
BAU="$AUS/.bau"
rm -rf "$BAU"

N=vp-edge-industrie-linux-arm
W=vp-wartung-linux-arm
S=edge-industrie-skripte.tar.gz
VP_INDUSTRIE_VERSION="$TAG" VP_INDUSTRIE_DIST="$BAU" "$REPO_ROOT/edge-industrie/scripts/build.sh"
VP_INDUSTRIE_VERSION="$TAG" VP_INDUSTRIE_DIST="$BAU" "$REPO_ROOT/edge-industrie/scripts/build-wartung.sh" arm
mv -f "$BAU/$N" "$BAU/$W" "$AUS/"
# Die Fassung muss in beiden Programmen stehen (ldflags); sonst meldet /health
# oder "vp-wartung fassung" etwas anderes.
for p in "$N" "$W"; do
  grep -aqF "$TAG" "$AUS/$p" || {
    echo "FEHLER: $TAG steht nicht im Programm $p" >&2
    exit 1
  }
done
rm -rf "$BAU"
gzip -9 -n -c "$AUS/$N" >"$AUS/$N.gz"
python3 "$REPO_ROOT/edge-industrie/scripts/skripte-paket.py" "$AUS/$S"

summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }
(cd "$AUS" && for f in "$N" "$N.gz" "$S" "$W"; do
  printf '%s  %s\n' "$(summe "$f")" "$f"
done) >"$AUS/sha256sums"

echo "--- $TAG fertig in $AUS"
cat "$AUS/sha256sums"

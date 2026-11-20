#!/usr/bin/env bash
# Eine Edge-Industrie-Fassung bauen (Release-Linie edge-industrie-JJJJ.MM.N):
# das Programm fuer den WAGO PFC200 (linux/arm, ARMv7), seine gepackte
# Lieferung und die Pruefsummen. Der Lauf
# .forgejo/workflows/edge-industrie-release.yaml haengt das an das
# Forgejo-Release.
#
#   edge-industrie/scripts/release.sh edge-industrie-2026.11.0 <ausgabe>
#
# In <ausgabe>:
#   vp-edge-industrie-linux-arm      das Programm
#   vp-edge-industrie-linux-arm.gz   die gepackte Lieferung (gzip -9 -n)
#   sha256sums                       beide, Format sha256sum
#
# Loader, Dienst-Skript und Einstellungen (edge-industrie/install.sh, files/)
# gehen nicht in die Fassung: sie kommen von Hand aus dem Projekt auf das
# Geraet; ein Update tauscht nur das Programm. Das Manifest (`vp-ota manifest
# --binary`, Backend industrie) und die Signatur entstehen im Release-Lauf.
# Die Fassung steht als Version im Programm (/health "version").
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
VP_INDUSTRIE_VERSION="$TAG" VP_INDUSTRIE_DIST="$BAU" "$REPO_ROOT/edge-industrie/scripts/build.sh"
mv -f "$BAU/$N" "$AUS/"
# Die Fassung muss im Programm stehen (ldflags); sonst meldet /health etwas anderes.
grep -aqF "$TAG" "$AUS/$N" || {
  echo "FEHLER: $TAG steht nicht im Programm $N" >&2
  exit 1
}
rm -rf "$BAU"
gzip -9 -n -c "$AUS/$N" >"$AUS/$N.gz"

summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }
(cd "$AUS" && for f in "$N" "$N.gz"; do
  printf '%s  %s\n' "$(summe "$f")" "$f"
done) >"$AUS/sha256sums"

echo "--- $TAG fertig in $AUS"
cat "$AUS/sha256sums"

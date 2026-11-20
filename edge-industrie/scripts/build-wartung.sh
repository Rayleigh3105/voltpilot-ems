#!/usr/bin/env bash
# Baut vp-wartung, das Tunnel-Programm fuer Geraete ohne OpenWrt
# (edge-industrie/wartung; auf dem WAGO PFC200 richtet es edge-industrie/wartung.sh
# ein). Die Mango braucht es nicht: dort tut service-tunnel.sh dasselbe mit
# WireGuard im Kern und Dropbear.
#
#   linux/arm (GOARM=7)   WAGO PFC200 G2 (Cortex-A8, ARMv7)
#   linux/arm64, amd64    nur fuer Proben und Entwicklung
#
# Ergebnis in edge-industrie/dist/ (oder VP_INDUSTRIE_DIST): je Bauart das Programm
# (statisch, ohne Symbole) plus eine .sha256-Datei im Format von sha256sum.
# Das Programm ist NICHT Teil der Updates aus dem Portal: es kommt durch
# wartung.sh auf das Geraet.
#
#   edge-industrie/scripts/build-wartung.sh           # arm
#   edge-industrie/scripts/build-wartung.sh arm64     # eine andere Bauart
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../../edge-light/scripts/lib.sh"

VERSION="${VP_INDUSTRIE_VERSION:-$(light_version)}"
DIST="${VP_INDUSTRIE_DIST:-$REPO_ROOT/edge-industrie/dist}"
mkdir -p "$DIST"

ARCHS=("$@")
[ "${#ARCHS[@]}" -eq 0 ] && ARCHS=(arm)

for arch in "${ARCHS[@]}"; do
  envs=(GOOS=linux CGO_ENABLED=0 "GOARCH=$arch")
  case "$arch" in
    arm) envs+=(GOARM=7) ;;
    arm64 | amd64) ;;
    *)
      echo "FEHLER: unbekannte Architektur $arch (arm|arm64|amd64)" >&2
      exit 2
      ;;
  esac
  out="$DIST/vp-wartung-linux-$arch"
  echo "--- baue $out ($VERSION)"
  VP_GO_DIR="$WARTUNG_DIR" go_run "${envs[@]}" -- build -trimpath -ldflags "-s -w -X main.Fassung=$VERSION" -o "$(core_rel "$out")" ./cmd/vp-wartung
  (cd "$DIST" && sha256sum "$(basename "$out")" >"$(basename "$out").sha256")
  awk -v b="$(wc -c <"$out")" 'BEGIN {printf "    %.1f MB\n", b / 1048576}'
done
echo "--- fertig: $DIST"

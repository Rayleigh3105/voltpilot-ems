#!/usr/bin/env bash
# Baut Edge Industrie fuer den WAGO PFC200 G2 (Cortex-A8, ARMv7, GOARM=7):
# dasselbe Programm wie Edge Light (Kern edge-app/core), nur unter dem Namen
# vp-edge-industrie.
#
# Ergebnis in edge-industrie/dist/ (oder VP_INDUSTRIE_DIST): das Programm
# (statisch, ohne Symbole) plus eine .sha256-Datei im Format von sha256sum.
# Der Loader auf dem Geraet prueft genau diese Pruefsumme, bevor er startet.
#
#   edge-industrie/scripts/build.sh
#   VP_INDUSTRIE_VERSION=edge-light-2026.11.1 edge-industrie/scripts/build.sh
#
# Bis Edge Industrie eigene Fassungen hat, traegt das Programm den Stempel der
# Edge-Light-Linie (edge-light-JJJJ.MM.N).
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../../edge-light/scripts/lib.sh"

# Ein Release-Programm ist nie der Pruefstand-Build (Build-Tag `pruefstand`
# oeffnet die Steuerung ohne Freigabe, layer1/pruefstand.go).
case " ${GOFLAGS:-} " in
  *pruefstand*)
    echo "FEHLER: GOFLAGS nennt den Pruefstand-Tag - build.sh baut nur Release-Programme" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 0 ]; then
  echo "FEHLER: build.sh baut nur linux/arm (WAGO PFC200) und nimmt keine Argumente" >&2
  exit 2
fi

VERSION="${VP_INDUSTRIE_VERSION:-$(light_version)}"
DIST="${VP_INDUSTRIE_DIST:-$REPO_ROOT/edge-industrie/dist}"
mkdir -p "$DIST"

LDFLAGS="-s -w -X git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent.Version=$VERSION"

out="$DIST/vp-edge-industrie-linux-arm"
echo "--- baue $out ($VERSION)"
go_run GOOS=linux CGO_ENABLED=0 GOARCH=arm GOARM=7 -- build -trimpath -ldflags "$LDFLAGS" -o "$(core_rel "$out")" ./cmd/vp-edge-light
(cd "$DIST" && sha256sum "$(basename "$out")" >"$(basename "$out").sha256")
awk -v b="$(wc -c <"$out")" 'BEGIN {printf "    %.1f MB\n", b / 1048576}'

printf '%s\n' "$VERSION" >"$DIST/VERSION"
echo "--- fertig: $DIST"

#!/usr/bin/env bash
# Baut Edge Light fuer die Zielarchitekturen:
#
#   linux/mipsle (GOMIPS=softfloat)  GL.iNet Mango GL-MT300N-V2 (MT7628, ohne FPU)
#   linux/arm64                      Raspberry Pi 3/4/5, NanoPi, ...
#   linux/amd64                      x86-Thin-Clients, Entwicklung
#
# Ergebnis in edge-light/dist/: je Architektur das Programm (statisch, ohne
# Symbole) plus eine .sha256-Datei im Format von sha256sum. Der Loader auf dem
# Geraet prueft genau diese Pruefsumme, bevor er startet.
#
#   edge-light/scripts/build.sh                 # alle Architekturen
#   edge-light/scripts/build.sh mipsle          # nur eine
#   VP_LIGHT_VERSION=edge-light-2026.10.1 edge-light/scripts/build.sh
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/lib.sh"

VERSION="${VP_LIGHT_VERSION:-$(light_version)}"
DIST="$LIGHT_DIR/dist"
mkdir -p "$DIST"

ARCHS=("$@")
[ "${#ARCHS[@]}" -eq 0 ] && ARCHS=(mipsle arm64 amd64)

LDFLAGS="-s -w -X git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent.Version=$VERSION"

for arch in "${ARCHS[@]}"; do
  envs=(GOOS=linux CGO_ENABLED=0 "GOARCH=$arch")
  case "$arch" in
    mipsle | mips) envs+=(GOMIPS=softfloat) ;;
    arm64 | amd64) ;;
    *)
      echo "FEHLER: unbekannte Architektur $arch (mipsle|arm64|amd64)" >&2
      exit 2
      ;;
  esac
  out="$DIST/vp-edge-light-linux-$arch"
  echo "--- baue $out ($VERSION)"
  go_run "${envs[@]}" -- build -trimpath -ldflags "$LDFLAGS" -o "$(core_rel "$out")" ./cmd/vp-edge-light
  (cd "$DIST" && sha256sum "$(basename "$out")" >"$(basename "$out").sha256")
  awk -v b="$(wc -c <"$out")" 'BEGIN {printf "    %.1f MB\n", b / 1048576}'
done

printf '%s\n' "$VERSION" >"$DIST/VERSION"
echo "--- fertig: $DIST"

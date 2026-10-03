#!/usr/bin/env bash
# Gemeinsame Helfer der Edge-Light-Skripte. Nur per `source` einbinden.
#
# go_run fuehrt ein Go-Kommando im Modul edge-app/core aus - mit lokalem Go,
# wenn es da ist (Go >= 1.24, wie edge-app/core/go.mod), sonst im offiziellen
# golang-Container. Der Container laeuft mit der eigenen uid, damit nie
# root-eigene Dateien im Repo entstehen, und teilt sich einen Cache-Volume.

set -euo pipefail

LIGHT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO_ROOT="$(cd "$LIGHT_DIR/.." && pwd -P)"
CORE_DIR="$REPO_ROOT/edge-app/core"
GO_IMAGE="${VP_LIGHT_GO_IMAGE:-golang:1.24}"
GO_CACHE_VOLUME="${VP_LIGHT_GO_CACHE:-vp-light-gocache}"

have_local_go() {
  command -v go >/dev/null 2>&1 || return 1
  # go1.24.x oder neuer
  local v
  v="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
  [ -n "$v" ] || return 1
  local major minor
  major="${v%%.*}"
  minor="$(echo "$v" | cut -d. -f2)"
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 24 ]; }
}

# go_run <env-zuweisungen...> -- <go-argumente...>
go_run() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  if have_local_go; then
    (cd "$CORE_DIR" && env "${envs[@]}" go "$@")
    return
  fi
  command -v docker >/dev/null 2>&1 || {
    echo "FEHLER: weder Go >= 1.24 noch Docker gefunden" >&2
    return 1
  }
  docker volume inspect "$GO_CACHE_VOLUME" >/dev/null 2>&1 || {
    docker volume create "$GO_CACHE_VOLUME" >/dev/null
    docker run --rm -v "$GO_CACHE_VOLUME":/cache "$GO_IMAGE" chmod -R 0777 /cache
  }
  local denv=()
  for e in "${envs[@]}"; do denv+=(-e "$e"); done
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT":/src -v "$GO_CACHE_VOLUME":/cache \
    -w /src/edge-app/core \
    -e HOME=/tmp -e GOCACHE=/cache/build -e GOMODCACHE=/cache/mod \
    "${denv[@]}" "$GO_IMAGE" go "$@"
}

# core_path übersetzt einen Pfad unter dem Repo in den im Container gueltigen.
core_rel() {
  local abs
  abs="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
  if have_local_go; then
    echo "$abs"
  else
    echo "/src${abs#"$REPO_ROOT"}"
  fi
}

light_version() {
  git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo dev
}

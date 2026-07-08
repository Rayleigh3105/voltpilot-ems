#!/usr/bin/env bash
# Self-check for the standalone installer edge-app/install.sh.
#
# install.sh is the ONLY file a device needs: it GENERATES its own
# docker-compose.yml. This check proves that generated compose is the correct
# real-mode, images-only subset and stays in lockstep with the repo compose:
#
#   1. `install.sh --print-compose` emits a compose that
#        - carries the generated marker, name voltpilot-edge, both registry
#          images (core + nodered), both named volumes, pull_policy: always;
#        - contains NO build:/context: (a device never builds) and NO
#          sim/edge-sim/profiles (real mode only).
#   2. If `docker compose` (v2) is available: the emitted compose passes
#        `docker compose -f - config` (valid), and its resolved real-mode
#        service definition is byte-identical to the repo compose's default
#        (no-sim) config - so a pulled stack behaves like a repo `up -d`.
#   3. shellcheck is clean (if installed).
#
# Docker-free by default (steps 1 + 3 always run); the equivalence proof
# (step 2) is skipped with a notice when docker/compose is absent.
set -euo pipefail

cd "$(dirname "$0")/.."          # -> edge-app/
INSTALL="./install.sh"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
note() { printf '  ....  %s\n' "$*"; }

echo "== install.sh self-check =="

[ -f "$INSTALL" ] || fail "install.sh not found in $(pwd)"

# --- 1. Emit + structural assertions (no docker needed). ------------------
COMPOSE="$(bash "$INSTALL" --print-compose)"
[ -n "$COMPOSE" ] || fail "--print-compose produced no output"

grep_has()  { printf '%s\n' "$COMPOSE" | grep -q -- "$1" || fail "generated compose is missing: $1"; }
grep_none() { printf '%s\n' "$COMPOSE" | grep -qi -- "$1" && fail "generated compose must NOT contain: $1"; return 0; }

grep_has '@voltpilot-edge-install'
grep_has 'name: voltpilot-edge'
grep_has 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest'
grep_has 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:latest'
grep_has 'pull_policy: always'
grep_has 'vp-edge-data'
grep_has 'vp-nodered-data'
# Real-mode, images-only: never a build context, never the simulator.
grep_none 'build:'
grep_none 'context:'
grep_none 'edge-sim'
grep_none 'profiles:'
# "sim" as a standalone token (the profile / service) must be absent; the
# substring in "Simulator" comments does not appear (there are none).
if printf '%s\n' "$COMPOSE" | grep -qiE '(^|[^a-z])sim([^a-z]|$)'; then
  fail "generated compose references the simulator"
fi
pass "structural: marker, images, volumes, pull_policy; no build/context/sim/profiles"

# --- 2. docker compose validity + equivalence to the repo real-mode config.
if docker compose version >/dev/null 2>&1; then
  if ! printf '%s\n' "$COMPOSE" | docker compose -f - config >/dev/null 2>&1; then
    fail "'docker compose -f - config' rejected the generated compose"
  fi
  pass "docker compose config accepts the generated compose"

  # Resolve both with a clean env + an empty project dir so ONLY defaults are
  # substituted (no ambient VP_* / stray .env), then compare - the repo's
  # build: lines are the only legitimate difference and are stripped.
  emptyd="$(mktemp -d)"
  repo="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" -f docker-compose.yml config 2>/dev/null \
            | grep -vE '^[[:space:]]*(build:|context:|dockerfile:)')"
  gen="$(printf '%s\n' "$COMPOSE" | env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" -f - config 2>/dev/null)"
  rmdir "$emptyd" 2>/dev/null || true
  if [ "$repo" = "$gen" ]; then
    pass "generated compose == repo real-mode 'docker compose config' (minus build:)"
  else
    printf '%s\n' "--- diff (repo <  | generated >) ---" >&2
    diff <(printf '%s\n' "$repo") <(printf '%s\n' "$gen") >&2 || true
    fail "generated compose drifted from the repo real-mode compose"
  fi
else
  note "docker compose (v2) unavailable - skipping config validity + equivalence check"
fi

# --- 3. shellcheck (if present). ------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$INSTALL"; then pass "shellcheck clean"; else fail "shellcheck reported issues"; fi
else
  note "shellcheck unavailable - skipping lint"
fi

echo "== self-check OK =="

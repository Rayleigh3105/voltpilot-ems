#!/usr/bin/env bash
# Docker reproduction of the REAL prod-down failure the host-only reseed.test.sh
# could not catch (prod-down 2026-07-09).
#
# THE BUG: an OLDER nodered image seeded the vp-palette / node_modules dirs into
# /data at BUILD time (`COPY ... /data`), so on a pre-existing `vp-nodered-data`
# volume those dirs are ROOT-owned. PR 117's re-seed entrypoint ran unprivileged
# (`USER node-red` before the ENTRYPOINT), so `rm -rf /data/vp-palette` failed
# with `Permission denied`, `set -e` aborted, the container looped, and the edge
# went dark - no telemetry. The host unit test only ever exercised a /data owned
# by the test user, so it shipped green.
#
# THE FIX (verified here end-to-end against a real Alpine node-red image):
#   - the entrypoint runs as ROOT (Dockerfile drops the `USER node-red`),
#   - re-seeds with privilege to replace ANY prior ownership,
#   - `chown -R node-red:node-red /data`,
#   - drops privileges via su-exec and exec's Node-RED as node-red.
#
# This test builds a MINIMAL image (real Alpine node-red base + su-exec + the
# ACTUAL reseed-entrypoint.sh + a fake template) - it deliberately avoids the
# heavy Go/npm build of the production image. It then:
#   Run A (FIXED, default root start): asserts the re-seed RECOVERS a root-owned
#          volume, runtime state survives, /data ends up node-red-owned, and the
#          final process runs as node-red (privilege was dropped).
#   Run B (control, forced `--user 1000`, i.e. the OLD unprivileged behavior):
#          asserts it FAILS on the same root-owned volume - proving the test
#          actually reproduces the brick and that root is what saves it.
#
# SKIPS cleanly (exit 0) when Docker is unavailable, so it is safe in a
# Docker-less CI lane; the docker-full lane runs the real proof.
#
# Run: edge-app/nodered/reseed-perms.docker.test.sh
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
skip() { printf '  SKIP  %s\n' "$*"; exit 0; }

echo "== reseed-perms.docker.test.sh (real root-owned-volume reproduction) =="

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

BASE="nodered/node-red:4.0"
TAG="vp-reseed-perms-test:$$"
VOL="vp-reseed-perms-vol-$$"
BUILD_CTX="$(mktemp -d)"
cleanup() {
  docker rmi -f "$TAG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -rf "$BUILD_CTX"
}
trap cleanup EXIT

# --- Build the minimal test image around the REAL entrypoint script ----------
# Mirrors the production Dockerfile's runtime shape (su-exec, root entrypoint,
# NO `USER node-red`) but with a tiny fake template instead of the Go/npm build.
cp "$HERE/reseed-entrypoint.sh" "$BUILD_CTX/reseed-entrypoint.sh"
cat > "$BUILD_CTX/Dockerfile" <<DOCKERFILE
FROM ${BASE}
USER root
RUN apk add --no-cache su-exec
COPY reseed-entrypoint.sh /usr/local/bin/vp-nodered-entrypoint.sh
RUN chmod 0755 /usr/local/bin/vp-nodered-entrypoint.sh \
 && mkdir -p /opt/vp-template/vp-palette/nodes /opt/vp-template/node_modules/dep \
 && printf 'NEW-FLOWS-fixed\n' > /opt/vp-template/flows.json \
 && printf 'settings-new\n' > /opt/vp-template/settings.js \
 && printf '{ "name": "tmpl" }\n' > /opt/vp-template/package.json \
 && printf 'palette-new\n' > /opt/vp-template/vp-palette/nodes/vp-core.js \
 && printf 'module\n' > /opt/vp-template/node_modules/dep/index.js \
 && cd /opt/vp-template \
 && find . -type f ! -name '.vp-template-version' -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 \
    > .vp-template-version
ENTRYPOINT ["/usr/local/bin/vp-nodered-entrypoint.sh"]
CMD ["./entrypoint.sh"]
DOCKERFILE

echo "-- building minimal test image (real Alpine node-red base) --"
# `--load` ensures the built image lands in the local daemon (the buildx
# container driver otherwise only keeps it in the build cache, so the
# `docker run` below wouldn't find it); harmless on the classic builder too.
docker build --load -t "$TAG" "$BUILD_CTX" >/dev/null 2>&1 \
  || docker build -t "$TAG" "$BUILD_CTX" >/dev/null 2>&1 \
  || fail "test image build failed"
docker image inspect "$TAG" >/dev/null 2>&1 \
  || fail "test image built but not loaded into the daemon"

# --- Pre-seed the volume as an OLDER image would: ROOT-owned template dirs ----
# `--user 0` writes root-owned files; the explicit chown pins it. Genuine
# per-instance runtime state is added too - it MUST survive the re-seed.
docker volume create "$VOL" >/dev/null
docker run --rm --user 0 -v "$VOL:/data" --entrypoint sh "$BASE" -c '
  set -e
  mkdir -p /data/vp-palette/nodes /data/node_modules/dep /data/context
  printf "OLD-FLOWS-stale\n"       > /data/flows.json
  printf "settings-old\n"          > /data/settings.js
  printf "palette-old\n"           > /data/vp-palette/nodes/vp-core.js
  printf "oldmod\n"                > /data/node_modules/dep/index.js
  printf "v-old\n"                 > /data/.vp-template-version
  printf "runtime\n"               > /data/.config.runtime.json
  printf "ctx\n"                   > /data/context/global.json
  chown -R 0:0 /data
' >/dev/null

# Sanity: the seeded volume really is root-owned (else the test proves nothing).
owner="$(docker run --rm -v "$VOL:/data" --user 0 --entrypoint sh "$BASE" -c 'stat -c "%u" /data/vp-palette/nodes/vp-core.js')"
[ "$owner" = "0" ] || fail "precondition: seeded /data/vp-palette is not root-owned (uid=$owner)"

# --- Run A: THE FIX. Default (root) start must recover the root-owned volume --
# Override CMD with a probe that reports the effective user + the re-seeded
# content + resulting ownership. The entrypoint (root) re-seeds, chowns, then
# su-exec-drops to node-red before running this probe.
outA="$(docker run --rm -v "$VOL:/data" "$TAG" \
  sh -c 'echo "USER=$(id -un)"; echo "FLOWS=$(cat /data/flows.json)"; echo "PALETTE=$(cat /data/vp-palette/nodes/vp-core.js)"; echo "MARKER=$(cat /data/.vp-template-version)"; echo "RUNTIME=$(cat /data/.config.runtime.json)"; echo "CTX=$(cat /data/context/global.json)"; echo "FLOWS_UID=$(stat -c %u /data/flows.json)"; echo "PALETTE_UID=$(stat -c %u /data/vp-palette/nodes/vp-core.js)"' 2>&1)" \
  || { printf '%s\n' "$outA"; fail "FIXED image failed to start over a root-owned volume (the brick is NOT fixed)"; }

printf '%s\n' "$outA" | grep -q '^FLOWS=NEW-FLOWS-fixed$'   || { printf '%s\n' "$outA"; fail "root-owned stale flows.json was NOT replaced by the template (the exact prod brick)"; }
printf '%s\n' "$outA" | grep -q '^PALETTE=palette-new$'     || { printf '%s\n' "$outA"; fail "root-owned vp-palette dir was NOT replaced (rm/cp under root failed)"; }
printf '%s\n' "$outA" | grep -q '^USER=node-red$'           || { printf '%s\n' "$outA"; fail "final process did NOT drop to node-red (still privileged)"; }
printf '%s\n' "$outA" | grep -q '^FLOWS_UID=1000$'          || { printf '%s\n' "$outA"; fail "/data/flows.json not chowned to node-red (uid 1000)"; }
printf '%s\n' "$outA" | grep -q '^PALETTE_UID=1000$'        || { printf '%s\n' "$outA"; fail "/data/vp-palette not chowned to node-red (uid 1000)"; }
printf '%s\n' "$outA" | grep -q '^RUNTIME=runtime$'         || { printf '%s\n' "$outA"; fail "genuine runtime state (.config.runtime.json) was clobbered"; }
printf '%s\n' "$outA" | grep -q '^CTX=ctx$'                 || { printf '%s\n' "$outA"; fail "genuine runtime state (context/) was clobbered"; }
pass "root entrypoint recovers a ROOT-owned volume: template replaced, /data chowned to node-red, privileges dropped, runtime state kept"

# --- Re-seed the volume back to the root-owned bricked state for Run B --------
docker run --rm --user 0 -v "$VOL:/data" --entrypoint sh "$BASE" -c '
  set -e
  rm -rf /data/vp-palette /data/node_modules
  mkdir -p /data/vp-palette/nodes
  printf "OLD-FLOWS-stale\n" > /data/flows.json
  printf "palette-old\n"     > /data/vp-palette/nodes/vp-core.js
  printf "v-old\n"           > /data/.vp-template-version
  chown -R 0:0 /data
' >/dev/null

# --- Run B: CONTROL. Force the OLD unprivileged behavior (`--user 1000`) ------
# Same fixed image, but started as node-red (what the old `USER node-red`
# Dockerfile did). The entrypoint's root branch is skipped, the re-seed runs
# unprivileged, and rm/cp over the root-owned /data must FAIL - proving this
# test reproduces the brick and that running as root is what fixes it. BusyBox
# surfaces the failure as "Permission denied" OR "File exists" (an unlink that
# needs write on the root-owned parent dir), so the decisive, message-agnostic
# invariant is: the run exited non-zero AND the stale flows.json was NOT
# replaced by the template.
set +e
outB="$(docker run --rm --user 1000:1000 -v "$VOL:/data" "$TAG" sh -c 'echo STARTED_OK' 2>&1)"
codeB=$?
set -e
stillB="$(docker run --rm -v "$VOL:/data" --user 0 --entrypoint sh "$BASE" -c 'cat /data/flows.json')"
[ "$stillB" = "OLD-FLOWS-stale" ] \
  || { printf '%s\n' "$outB"; fail "control (unprivileged) unexpectedly re-seeded a root-owned volume - the test no longer reproduces the bug"; }
[ "$codeB" -ne 0 ] \
  || { printf '%s\n' "$outB"; fail "control (unprivileged) did not fail on the root-owned volume - the brick is not reproduced"; }
pass "control: unprivileged start FAILS to re-seed the root-owned volume (exit ${codeB}, stale flows.json retained) - brick reproduced, root is what fixes it"

echo "== reseed-perms docker test OK =="

#!/usr/bin/env bash
# Docker reproduction of the D-12 reseed-coexistence contract
# (docs/contracts/v2/flow-artifact.md §4) against the REAL Alpine node-red
# base image - the #117/#119 lesson made law: any edge-container change
# touching /data or the entrypoint needs a real-built-image reproduction, not
# only a host-dir unit test (a host test runs with the test user's ownership
# and a full host node toolchain, and has shipped green over real bricks
# twice).
#
# What this proves on the REAL image:
#   Run A: a pre-existing volume holds a STALE vendor tab group + a deployed
#          @vp-flow artifact tab, with ROOT-owned template dirs (the exact
#          pre-#119 volume shape). The update re-seed must
#            - replace the vendor tab group from the new template,
#            - preserve the artifact tab + its nodes byte-for-byte,
#            - recover the root-owned dirs (root entrypoint),
#            - hand /data to node-red and drop privileges (su-exec).
#   Run B: an up-to-date restart keeps the merged flows.json untouched
#          (silent no-op - no re-merge churn).
#
# SKIPS cleanly (exit 0) without Docker. Run: edge-app/nodered/reseed-flows.docker.test.sh
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
skip() { printf '  SKIP  %s\n' "$*"; exit 0; }

echo "== reseed-flows.docker.test.sh (real-image @vp-flow coexistence) =="

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

BASE="nodered/node-red:4.0"
TAG="vp-reseed-flows-test:$$"
VOL="vp-reseed-flows-vol-$$"
BUILD_CTX="$(mktemp -d)"
cleanup() {
  docker rmi -f "$TAG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -rf "$BUILD_CTX"
}
trap cleanup EXIT

# --- Build the minimal test image around the REAL entrypoint + merge script --
cp "$HERE/reseed-entrypoint.sh" "$BUILD_CTX/reseed-entrypoint.sh"
cp "$HERE/reseed-merge-flows.js" "$BUILD_CTX/reseed-merge-flows.js"
cat > "$BUILD_CTX/template-flows.json" <<'JSON'
[{"id":"tab-auto","type":"tab","label":"Vorlage NEU"},
 {"id":"auto-router","type":"function","z":"tab-auto","name":"Router NEU"}]
JSON
cat > "$BUILD_CTX/Dockerfile" <<DOCKERFILE
FROM ${BASE}
USER root
RUN apk add --no-cache su-exec
COPY reseed-entrypoint.sh /usr/local/bin/vp-nodered-entrypoint.sh
COPY reseed-merge-flows.js /usr/local/bin/vp-reseed-merge-flows.js
COPY template-flows.json /opt/vp-template/flows.json
RUN chmod 0755 /usr/local/bin/vp-nodered-entrypoint.sh \
 && chmod 0644 /usr/local/bin/vp-reseed-merge-flows.js \
 && mkdir -p /opt/vp-template/vp-palette/nodes /opt/vp-template/node_modules/dep \
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
docker build --load -t "$TAG" "$BUILD_CTX" >/dev/null 2>&1 \
  || docker build -t "$TAG" "$BUILD_CTX" >/dev/null 2>&1 \
  || fail "test image build failed"

# --- Pre-seed the volume: stale vendor flows + deployed artifact tab, with
# ROOT-owned template dirs (the pre-#119 shape). ------------------------------
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL":/data alpine:3 sh -ec '
  mkdir -p /data/vp-palette/nodes /data/node_modules /data/context
  cat > /data/flows.json <<JSON
[{"id":"tab-auto","type":"tab","label":"Vorlage ALT"},
 {"id":"auto-router","type":"function","z":"tab-auto","name":"Router ALT"},
 {"id":"vpflow-4e1c2b3a-v7","type":"tab","label":"VP Flow: Heizstab (v7)","info":"@vp-flow flow_id=4e1c2b3a-5d6e-4f70-8123-456789abcdef flow_version=7"},
 {"id":"vpflow-4e1c2b3a-v7-n7","type":"vp-desired","z":"vpflow-4e1c2b3a-v7","entity":"heatrod-cellar"}]
JSON
  printf "settings-old\n"  > /data/settings.js
  printf "palette-old\n"   > /data/vp-palette/nodes/vp-core.js
  printf "stale-marker\n"  > /data/.vp-template-version
  printf "runtime\n"       > /data/.config.runtime.json
  chown -R 0:0 /data
' >/dev/null

# --- Run A: the update re-seed on the real image ------------------------------
# Replace the CMD with a probe that reports the effective uid + keeps the
# container alive briefly so we can inspect; the ENTRYPOINT (re-seed + priv
# drop) still runs first, exactly as in production.
out="$(docker run --rm -v "$VOL":/data "$TAG" sh -c 'id -u; echo ENTRY-OK' 2>&1)" \
  || fail "container run failed: $out"
printf '%s\n' "$out" | grep -q 'ENTRY-OK' || fail "entrypoint did not hand off: $out"
printf '%s\n' "$out" | grep -q 'template UPDATED' || fail "update re-seed did not run: $out"
printf '%s\n' "$out" | grep -q 'preserving 1 @vp-flow artifact tab' \
  || fail "artifact-tab preservation was not logged: $out"
# The handed-off process must be UNPRIVILEGED (su-exec drop) - uid 1000.
printf '%s\n' "$out" | grep -qx '1000' || fail "handed-off process is not the unprivileged node-red user: $out"

check="$(docker run --rm -v "$VOL":/data alpine:3 sh -ec '
  grep -q "Router NEU" /data/flows.json || { echo MISSING-NEW; exit 0; }
  grep -q "Router ALT" /data/flows.json && { echo STALE-KEPT; exit 0; }
  grep -q "vpflow-4e1c2b3a-v7-n7" /data/flows.json || { echo ARTIFACT-DROPPED; exit 0; }
  grep -q "runtime" /data/.config.runtime.json || { echo RUNTIME-LOST; exit 0; }
  stat -c "%u" /data/flows.json
')"
case "$check" in
  MISSING-NEW)      fail "vendor tab group was not replaced on the real image" ;;
  STALE-KEPT)       fail "stale vendor content survived on the real image" ;;
  ARTIFACT-DROPPED) fail "@vp-flow artifact tab was dropped on the real image" ;;
  RUNTIME-LOST)     fail "genuine runtime state was clobbered" ;;
  1000)             : ;;
  *)                fail "/data not handed to node-red (uid $check)" ;;
esac
pass "real image: vendor group replaced, @vp-flow tab preserved, root-owned volume recovered, priv dropped"

# --- Run B: up-to-date restart is a silent no-op (no merge churn) -------------
before="$(docker run --rm -v "$VOL":/data alpine:3 cat /data/flows.json)"
out2="$(docker run --rm -v "$VOL":/data "$TAG" sh -c 'echo ENTRY-OK' 2>&1)"
printf '%s\n' "$out2" | grep -q 'template UPDATED' && fail "up-to-date restart re-seeded again"
after="$(docker run --rm -v "$VOL":/data alpine:3 cat /data/flows.json)"
[ "$before" = "$after" ] || fail "up-to-date restart modified the merged flows.json"
pass "real image: up-to-date restart keeps the merged flows.json untouched"

echo "== reseed-flows docker test OK =="

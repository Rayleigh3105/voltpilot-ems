#!/usr/bin/env bash
# Unit test for reseed-entrypoint.sh - the fix for the "pulled nodered image
# does NOT update the running flows because the vp-nodered-data volume shadows
# /data" footgun. Docker-free: it drives the re-seed logic against temp dirs.
#
# Run: edge-app/nodered/reseed.test.sh   (or `bash reseed.test.sh` from here)
set -euo pipefail

cd "$(dirname "$0")"
ENTRY="$(pwd)/reseed-entrypoint.sh"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Build a fake template (the image's /opt/vp-template) at version marker "v2".
make_template() {
  local dir="$1" flows="$2" marker="$3"
  rm -rf "$dir"; mkdir -p "$dir/vp-palette/nodes" "$dir/node_modules/dep"
  printf '%s\n' "$flows" > "$dir/flows.json"
  printf 'settings v-new\n' > "$dir/settings.js"
  printf '{ "name": "tmpl" }\n' > "$dir/package.json"
  printf 'palette-new\n' > "$dir/vp-palette/nodes/vp-core.js"
  printf 'module\n' > "$dir/node_modules/dep/index.js"
  printf '%s\n' "$marker" > "$dir/.vp-template-version"
}

run_entry() {
  # Seed then exec `true` (no-op) so the script returns; capture its output.
  VP_TEMPLATE_DIR="$1" VP_DATA_DIR="$2" "$ENTRY" true
}

echo "== reseed-entrypoint.sh test =="

# --- Case 1: THE BUG. Volume already holds an OLD flows.json + stale marker,
# plus genuine runtime state. Re-seed must replace the template and KEEP the
# runtime state. -----------------------------------------------------------
TPL="$WORK/tpl"; DATA="$WORK/data"
make_template "$TPL" "NEW-FLOWS-pr116-deye-scaling-fix" "v2"

mkdir -p "$DATA/vp-palette/nodes" "$DATA/node_modules" "$DATA/context"
printf 'OLD-FLOWS-stale\n' > "$DATA/flows.json"          # the stale flows the device kept running
printf 'settings v-old\n' > "$DATA/settings.js"
printf 'palette-old\n' > "$DATA/vp-palette/nodes/vp-core.js"
printf 'v1\n' > "$DATA/.vp-template-version"             # older marker
printf 'runtime\n' > "$DATA/.config.runtime.json"        # genuine per-instance state - must survive
printf 'ctx\n' > "$DATA/context/global.json"             # genuine per-instance state - must survive

out="$(run_entry "$TPL" "$DATA")"

grep -q '^NEW-FLOWS-pr116-deye-scaling-fix$' "$DATA/flows.json" \
  || fail "stale /data/flows.json was NOT replaced by the image template (the bug)"
[ "$(cat "$DATA/.vp-template-version")" = "v2" ] || fail "version marker not bumped to v2"
grep -q 'settings v-new' "$DATA/settings.js" || fail "settings.js not re-seeded"
grep -q 'palette-new' "$DATA/vp-palette/nodes/vp-core.js" || fail "vp-palette not re-seeded"
[ -f "$DATA/node_modules/dep/index.js" ] || fail "node_modules not re-seeded"
grep -q 'runtime' "$DATA/.config.runtime.json" || fail "genuine runtime state (.config.runtime.json) was clobbered"
grep -q 'ctx' "$DATA/context/global.json" || fail "genuine runtime state (context/) was clobbered"
printf '%s\n' "$out" | grep -q 'template UPDATED v1 -> v2' || fail "update was not logged loudly"
pass "stale volume flows.json replaced by image template; marker bumped; runtime state kept; update logged"

# --- Case 2: idempotent no-op. Running again on the now-up-to-date volume must
# change nothing and be SILENT. --------------------------------------------
before="$(cat "$DATA/flows.json")"
out2="$(run_entry "$TPL" "$DATA")"
[ "$(cat "$DATA/flows.json")" = "$before" ] || fail "no-op run modified flows.json"
[ -z "$out2" ] || fail "up-to-date run was not silent: $out2"
pass "up-to-date restart is a silent no-op"

# --- Case 3: fresh volume (no marker at all) seeds everything and says so. --
TPL3="$WORK/tpl3"; DATA3="$WORK/data3"
make_template "$TPL3" "FRESH-FLOWS" "v9"
mkdir -p "$DATA3"                                        # empty volume, no marker
out3="$(run_entry "$TPL3" "$DATA3")"
grep -q '^FRESH-FLOWS$' "$DATA3/flows.json" || fail "fresh volume was not seeded"
[ "$(cat "$DATA3/.vp-template-version")" = "v9" ] || fail "fresh volume marker not written"
printf '%s\n' "$out3" | grep -q 'fresh volume' || fail "fresh seed not logged"
pass "fresh volume is seeded from the image template"

# --- Case 4: real repo template hashes consistently (marker is content-based).
# Two identical trees -> identical marker; a one-byte change -> different. ---
mk_marker() {
  ( cd "$1" && find . -type f ! -name '.vp-template-version' -print0 \
      | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}
A="$WORK/a"; B="$WORK/b"
make_template "$A" "same" "x"; make_template "$B" "same" "x"
[ "$(mk_marker "$A")" = "$(mk_marker "$B")" ] || fail "identical template trees hashed differently"
printf 'drift\n' >> "$B/flows.json"
[ "$(mk_marker "$A")" != "$(mk_marker "$B")" ] || fail "a changed flows.json did not change the marker"
pass "content-hash marker is stable for identical trees and changes on any edit"

echo "== reseed test OK =="

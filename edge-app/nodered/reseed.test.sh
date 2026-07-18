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

# --- Case 5: PRIVILEGE-DROP guard (prod-down 2026-07-09). Docker-free structural
# check that the entrypoint runs the re-seed as ROOT and drops to node-red - the
# real root-owned-volume reproduction lives in reseed-perms.docker.test.sh, but
# this keeps the regression guarded in a Docker-less lane. -----------------
grep -q 'id -u' "$ENTRY"     || fail "entrypoint lost the root (id -u) branch that lets the re-seed replace root-owned template dirs"
grep -q 'su-exec' "$ENTRY"   || fail "entrypoint lost the su-exec privilege drop (Node-RED must run as node-red, not root)"
grep -q 'chown -R' "$ENTRY"  || fail "entrypoint lost the chown of \$DATA_DIR to the run user"
pass "entrypoint re-seeds as root, chowns /data, and drops privileges via su-exec (structural guard)"

# --- Case 6: D-12 reseed coexistence (contract flow-artifact.md §4). The
# volume's flows.json carries a stale VENDOR tab group PLUS a deployed
# @vp-flow ARTIFACT tab; a template update must replace ONLY the vendor group
# and keep the artifact tab + its nodes byte-for-byte. ----------------------
TPL6="$WORK/tpl6"; DATA6="$WORK/data6"
TPL_FLOWS6='[{"id":"tab-auto","type":"tab","label":"Vorlage NEU"},{"id":"auto-router","type":"function","z":"tab-auto","name":"Router NEU"}]'
make_template "$TPL6" "placeholder" "v6"
printf '%s\n' "$TPL_FLOWS6" > "$TPL6/flows.json"
mkdir -p "$DATA6"
printf 'v5\n' > "$DATA6/.vp-template-version"
cat > "$DATA6/flows.json" <<'JSON'
[{"id":"tab-auto","type":"tab","label":"Vorlage ALT"},
 {"id":"auto-router","type":"function","z":"tab-auto","name":"Router ALT"},
 {"id":"vpflow-4e1c2b3a-v7","type":"tab","label":"VP Flow: Heizstab (v7)","info":"@vp-flow flow_id=4e1c2b3a-5d6e-4f70-8123-456789abcdef flow_version=7"},
 {"id":"vpflow-4e1c2b3a-v7-n7","type":"vp-desired","z":"vpflow-4e1c2b3a-v7","entity":"heatrod-cellar"}]
JSON
out6="$(VP_MERGE_SCRIPT="$(pwd)/reseed-merge-flows.js" VP_TEMPLATE_DIR="$TPL6" VP_DATA_DIR="$DATA6" "$ENTRY" true)"
grep -q 'Router NEU' "$DATA6/flows.json" || fail "vendor tab group was not replaced by the template"
grep -q 'Router ALT' "$DATA6/flows.json" && fail "stale vendor content survived the re-seed"
grep -q 'vpflow-4e1c2b3a-v7-n7' "$DATA6/flows.json" || fail "@vp-flow artifact NODES were dropped by the re-seed"
grep -q '@vp-flow flow_id=4e1c2b3a' "$DATA6/flows.json" || fail "@vp-flow artifact TAB was dropped by the re-seed"
node -e "JSON.parse(require('fs').readFileSync('$DATA6/flows.json','utf8'))" || fail "merged flows.json is not valid JSON"
printf '%s\n' "$out6" | grep -q 'preserving 1 @vp-flow artifact tab' || fail "preservation was not logged"
pass "vendor tab group replaced, @vp-flow artifact tab + nodes preserved (D-12)"

# --- Case 7: merge degradation. An UNREADABLE existing flows.json falls back
# to the pre-E2 wholesale copy with a LOUD warning (the retained deployment
# self-heals the artifact tabs). ---------------------------------------------
TPL7="$WORK/tpl7"; DATA7="$WORK/data7"
make_template "$TPL7" "WHOLESALE-FLOWS" "v7"
mkdir -p "$DATA7"
printf 'v6\n' > "$DATA7/.vp-template-version"
printf 'NOT-JSON\n' > "$DATA7/flows.json"
out7="$(VP_MERGE_SCRIPT="$(pwd)/reseed-merge-flows.js" VP_TEMPLATE_DIR="$TPL7" VP_DATA_DIR="$DATA7" "$ENTRY" true)"
grep -q '^WHOLESALE-FLOWS$' "$DATA7/flows.json" || fail "unreadable flows.json was not wholesale-seeded"
printf '%s\n' "$out7" | grep -q 'WARN: flows.json wholesale-seeded' || fail "wholesale fallback was not loudly warned"
pass "unreadable existing flows.json degrades to wholesale copy with a loud warning"

echo "== reseed test OK =="
echo "(root-owned-volume reproduction: run reseed-perms.docker.test.sh with Docker present;"
echo " artifact-tab survival on the real image: reseed-flows.docker.test.sh)"

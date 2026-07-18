#!/usr/bin/env bash
# Self-contained proof that the ACL grant writers keep every per-device grant
# ABOVE the catch-all default-deny (EMQX file authorizer is first-match) and
# self-heal a previously corrupted acl.conf. Regression for the 2026-07-08
# prod-down incident: a claimed device's grant was written BELOW the deny +
# {allow, all} (unreachable -> device kicked off the broker), with the template
# tail duplicated. Covers both voltpilot-ca.sh (issue/revoke) and
# merge-acl-grants.sh (deploy). No Docker/openssl/network needed.
#
# Run: bash tools/pki/test-acl-grants.sh   (also runs under sh/mawk/bwk-awk)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BASE="${DIR}/../../infra/mqtt/acl/acl.conf"
MERGE="${DIR}/merge-acl-grants.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The CA tool's grant functions, sourced without running main().
sed '/^main "\$@"$/d' "${DIR}/voltpilot-ca.sh" > "${WORK}/ca_lib.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
count() { grep -cF "$2" "$1" || true; }

# Assert: every "{allow, {username, "<hex...>"}" device rule sits above the
# first UUID default-deny line, and there is exactly one region + one tail.
assert_canonical() {
  local f="$1" label="$2"
  local deny; deny="$(grep -n 'deny, {username, {re' "$f" | head -1 | cut -d: -f1 || true)"
  [ -n "$deny" ] || { bad "$label: no default-deny line"; return; }
  local worst=0 ln
  while read -r ln; do
    ln="${ln%%:*}"
    [ -n "$ln" ] && [ "$ln" -gt "$deny" ] && worst=1
  done < <(grep -n 'allow, {username, "[0-9a-f]' "$f" || true)
  [ "$worst" -eq 0 ] && ok "$label: all device grants above the default-deny" \
                      || bad "$label: a device grant sits BELOW the default-deny"
  [ "$(count "$f" 'BEGIN GENERATED DEVICE GRANTS')" -eq 1 ] && ok "$label: exactly one BEGIN anchor" \
                      || bad "$label: BEGIN anchor not unique"
  [ "$(count "$f" 'END GENERATED DEVICE GRANTS')" -eq 1 ] && ok "$label: exactly one END anchor" \
                      || bad "$label: END anchor not unique"
  [ "$(count "$f" '{allow, all}.')" -eq 1 ] && ok "$label: exactly one {allow, all} tail" \
                      || bad "$label: duplicated tail"
  [ "$(grep -c 'deny, {username, {re' "$f")" -eq 1 ] && ok "$label: exactly one default-deny" \
                      || bad "$label: duplicated default-deny"
}

# Build a per-device grant block (the exact shape both writers emit, incl. the
# two v2/# wildcard lines - decision D-2).
block() { # id
  local d="$1" b="ems/t/s/$1"
  printf '%%%%<<device %s tenant t site s>>\n' "$d"
  printf '{allow, {username, "%s"}, publish,   ["%s/telemetry", "%s/status"]}.\n' "$d" "$b" "$b"
  printf '{allow, {username, "%s"}, subscribe, ["%s/schedule", "%s/command", "%s/config"]}.\n' "$d" "$b" "$b" "$b"
  printf '{allow, {username, "%s"}, publish,   ["%s/v2/#"]}.\n' "$d" "$b"
  printf '{allow, {username, "%s"}, subscribe, ["%s/v2/#"]}.\n' "$d" "$b"
  printf '%%%%<<end device %s>>\n' "$d"
}

SEED="00000000-0000-0000-0000-000000000003"
CDBA="cdba2ee8-0000-0000-0000-000000000009"

# The exact corrupted shape from the incident: grant below the deny + dup tail.
make_corrupt() { # outfile
  local tail
  tail="$(printf '%%%% --- Default-deny for devices. ---\n')"
  {
    printf '{allow, {username, "vp-internal"}, all, ["#"]}.\n'
    printf '%%%%<<BEGIN GENERATED DEVICE GRANTS>>\n'
    block "$SEED"
    printf '%%%%<<END GENERATED DEVICE GRANTS>>\n'
    printf '%s\n' "$tail"
    printf '{deny, {username, {re, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"}}, all, ["#"]}.\n'
    printf '{deny, all, subscribe, ["$SYS/#"]}.\n'
    printf '{allow, all}.\n'
    block "$CDBA"                                  # <-- unreachable, below the deny
    printf '%%%%<<END GENERATED DEVICE GRANTS>>\n' # <-- duplicated tail below
    printf '%s\n' "$tail"
    printf '{deny, {username, {re, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"}}, all, ["#"]}.\n'
    printf '{deny, all, subscribe, ["$SYS/#"]}.\n'
    printf '{allow, all}.\n'
  } > "$1"
}

echo "== voltpilot-ca.sh write_acl_grant self-heals the incident shape =="
CORRUPT="${WORK}/corrupt.conf"; make_corrupt "$CORRUPT"
CDBA_BEFORE="$(grep -n "allow, {username, \"${CDBA}\"" "$CORRUPT" | head -1 | cut -d: -f1)"
DENY_BEFORE="$(grep -n 'deny, {username, {re' "$CORRUPT" | head -1 | cut -d: -f1)"
[ "$CDBA_BEFORE" -gt "$DENY_BEFORE" ] && ok "precondition: corrupt file has cdba BELOW the deny" \
                                      || bad "precondition not corrupt"
VP_ACL_FILE="$CORRUPT" bash -c "set -e; source '${WORK}/ca_lib.sh'; write_acl_grant t s ${CDBA}" >/dev/null
assert_canonical "$CORRUPT" "ca-heal"
[ "$(count "$CORRUPT" "<<device ${CDBA}")" -eq 1 ] && ok "ca-heal: cdba block not duplicated" || bad "ca-heal: cdba duplicated"
[ "$(count "$CORRUPT" "<<device ${SEED}")" -eq 1 ] && ok "ca-heal: seed block preserved once" || bad "ca-heal: seed lost/duplicated"

echo "== write is idempotent (re-run byte-identical) =="
cp "$CORRUPT" "${WORK}/once.conf"
VP_ACL_FILE="$CORRUPT" bash -c "set -e; source '${WORK}/ca_lib.sh'; write_acl_grant t s ${CDBA}" >/dev/null
diff -q "${WORK}/once.conf" "$CORRUPT" >/dev/null && ok "idempotent re-write" || bad "re-write changed the file"

echo "== healthy file round-trips (write + remove == original) =="
cp "$BASE" "${WORK}/healthy.conf"
NEW="33333333-3333-3333-3333-333333333333"
VP_ACL_FILE="${WORK}/healthy.conf" bash -c "set -e; source '${WORK}/ca_lib.sh'; write_acl_grant 11111111-1111-1111-1111-111111111111 22222222-2222-2222-2222-222222222222 ${NEW}" >/dev/null
assert_canonical "${WORK}/healthy.conf" "ca-healthy-write"
VP_ACL_FILE="${WORK}/healthy.conf" bash -c "set -e; source '${WORK}/ca_lib.sh'; remove_acl_grant ${NEW}" >/dev/null
diff -q "$BASE" "${WORK}/healthy.conf" >/dev/null && ok "write+remove round-trips to the committed base" || bad "round-trip differs from base"

echo "== merge-acl-grants.sh heals a corrupted deployed file and drops no grant =="
make_corrupt "${WORK}/dep_corrupt.conf"
sh "$MERGE" "$BASE" "${WORK}/dep_corrupt.conf" "${WORK}/merged.conf"
assert_canonical "${WORK}/merged.conf" "merge-corrupt"
[ "$(count "${WORK}/merged.conf" "<<device ${CDBA}")" -eq 1 ] && ok "merge: cdba preserved (not dropped)" || bad "merge: cdba dropped/duplicated"
[ "$(count "${WORK}/merged.conf" "<<device ${SEED}")" -eq 1 ] && ok "merge: seed preserved" || bad "merge: seed lost"

echo "== merge preserves a grant appended at EOF (previously silently revoked) =="
{ cat "$BASE"; block "$CDBA"; } > "${WORK}/dep_eof.conf"
sh "$MERGE" "$BASE" "${WORK}/dep_eof.conf" "${WORK}/merged_eof.conf"
assert_canonical "${WORK}/merged_eof.conf" "merge-eof"
[ "$(count "${WORK}/merged_eof.conf" "<<device ${CDBA}")" -eq 1 ] && ok "merge: EOF grant preserved above the deny" || bad "merge: EOF grant dropped"

echo "== merge is idempotent =="
sh "$MERGE" "$BASE" "${WORK}/merged.conf" "${WORK}/merged2.conf"
diff -q "${WORK}/merged.conf" "${WORK}/merged2.conf" >/dev/null && ok "merge idempotent" || bad "merge not idempotent"

echo "== grant template is byte-identical to the Java writer (shared vector) =="
# The SAME fixed vector is pinned in AclGrantWriterTest (services/api) -
# change both together (the EdgeRef shared-vector discipline).
VT="00000000-0000-0000-0000-000000000001"
VS="00000000-0000-0000-0000-000000000002"
VD="00000000-0000-0000-0000-000000000003"
VB="ems/${VT}/${VS}/${VD}"
TPL="${WORK}/template.conf"
printf '%%%%<<BEGIN GENERATED DEVICE GRANTS>>\n%%%%<<END GENERATED DEVICE GRANTS>>\n{allow, all}.\n' > "$TPL"
VP_ACL_FILE="$TPL" bash -c "set -e; source '${WORK}/ca_lib.sh'; write_acl_grant ${VT} ${VS} ${VD}" >/dev/null
cat > "${WORK}/expected-block" <<EOF
%%<<device ${VD} tenant ${VT} site ${VS}>>
{allow, {username, "${VD}"}, publish,   ["${VB}/telemetry", "${VB}/status"]}.
{allow, {username, "${VD}"}, subscribe, ["${VB}/schedule", "${VB}/command", "${VB}/config"]}.
{allow, {username, "${VD}"}, publish,   ["${VB}/v2/#"]}.
{allow, {username, "${VD}"}, subscribe, ["${VB}/v2/#"]}.
%%<<end device ${VD}>>
EOF
sed -n '/<<device /,/<<end device /p' "$TPL" > "${WORK}/actual-block"
diff -u "${WORK}/expected-block" "${WORK}/actual-block" >/dev/null \
  && ok "template: shell block matches the pinned Java-writer vector (incl. v2/# lines)" \
  || bad "template: shell block drifted from the Java writer (see AclGrantWriterTest)"
grep -qF "${VB}/v2/#" "$BASE" \
  && ok "template: committed base seed grant carries the v2/# lines" \
  || bad "template: committed base seed grant is missing the v2/# lines"

echo
echo "ACL grant tests: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

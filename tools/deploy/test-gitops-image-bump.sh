#!/usr/bin/env bash
# =============================================================================
# test-gitops-image-bump.sh - offline self-check for tools/deploy/
# gitops-image-bump.sh. No Docker, no network, no cluster, no gitops clone:
# it runs against `testdata/gitops-prod-kustomization.yaml`, a VERBATIM copy of
# the real gitops prod overlay (apps/voltpilot/overlays/prod/kustomization.yaml
# as of gitops PR 16), so the mechanism is proven on the real file shape and a
# drift over there shows up as a failing expectation here.
#
#   bash tools/deploy/test-gitops-image-bump.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
BUMP=tools/deploy/gitops-image-bump.sh
FIXTURE=tools/deploy/testdata/gitops-prod-kustomization.yaml
SHA=1234567890abcdef1234567890abcdef12345678
OTHER=abcdef1234567890abcdef1234567890abcdef12

fail=0
pass() { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --------------------------------------------------------------------------
# 1. The real overlay: exactly the newTag lines move, nothing else.
# --------------------------------------------------------------------------
cp "$FIXTURE" "$WORK/real.yaml"
out="$(sh "$BUMP" "$WORK/real.yaml" "$SHA" 2>&1)"; rc=$?
[ $rc -eq 0 ] || bad "real overlay: expected exit 0, got $rc ($out)"

changed="$(diff "$FIXTURE" "$WORK/real.yaml" | grep -c '^[<>]')"
offenders="$(diff "$FIXTURE" "$WORK/real.yaml" | grep '^[<>]' | grep -vc 'newTag:')"
if [ "$offenders" -eq 0 ] && [ "$changed" -eq 18 ]; then
  pass "real overlay: 9 newTag lines rewritten, no other line touched"
else
  bad "real overlay: $changed changed lines, $offenders of them not newTag lines"
  diff -u "$FIXTURE" "$WORK/real.yaml" | head -40
fi

# Every entry really carries the new tag, and the count matches the pipeline's
# nine-image build matrix (a matrix/overlay drift must be loud, not silent).
n_new="$(grep -c "newTag: $SHA" "$WORK/real.yaml")"
n_entries="$(sed -n '/^images:/,$p' "$WORK/real.yaml" | grep -c '^  - name: ')"
if [ "$n_new" -eq 9 ] && [ "$n_entries" -eq 9 ]; then
  pass "real overlay: all 9 image entries pinned to the new sha"
else
  bad "real overlay: $n_entries entries / $n_new pinned (expected 9/9)"
fi

# Comments the operator depends on survive verbatim.
# shellcheck disable=SC2016  # these are literal needles, not expansions
for needle in 'NIE `:latest`' 'PLACEHOLDER-set-by-ci' 'kustomize edit set image' 'Probe-Doppel-Zustand'; do
  grep -qF "$needle" "$WORK/real.yaml" || bad "real overlay: comment lost: $needle"
done
# shellcheck disable=SC2016
if grep -qF 'NIE `:latest`' "$WORK/real.yaml"; then pass "real overlay: explanatory comment block intact"; fi

# --------------------------------------------------------------------------
# 2. Idempotency: a second run changes nothing and says so with exit 2.
# --------------------------------------------------------------------------
cp "$WORK/real.yaml" "$WORK/real.before"
out="$(sh "$BUMP" "$WORK/real.yaml" "$SHA" 2>&1)"; rc=$?
if [ $rc -eq 2 ] && cmp -s "$WORK/real.before" "$WORK/real.yaml"; then
  pass "idempotent: re-run at the same sha exits 2 and leaves the file byte-identical"
else
  bad "idempotent: expected exit 2 + untouched file, got rc=$rc ($out)"
fi

# --------------------------------------------------------------------------
# 3. Partial state (a hand-edited overlay, or a half-finished earlier run):
#    only the stale entries move, and the run still counts as a change.
# --------------------------------------------------------------------------
cp "$FIXTURE" "$WORK/partial.yaml"
sh "$BUMP" "$WORK/partial.yaml" "$SHA" >/dev/null 2>&1
# put ONE entry back on an older tag (awk, not `sed 0,/re/` - that address form
# is a GNU extension and this suite must run on a BSD sed too)
awk -v new="$OTHER" -v old="$SHA" '
  !done && $0 ~ ("newTag: " old) { sub(old, new); done = 1 } { print }
' "$WORK/partial.yaml" > "$WORK/partial.tmp" && mv "$WORK/partial.tmp" "$WORK/partial.yaml"
out="$(sh "$BUMP" "$WORK/partial.yaml" "$SHA" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ "$(grep -c "newTag: $SHA" "$WORK/partial.yaml")" -eq 9 ] \
   && printf '%s' "$out" | grep -q 'set 1 of 9'; then
  pass "partial state: only the stale entry is rewritten, exit 0"
else
  bad "partial state: rc=$rc ($out)"
fi

# --------------------------------------------------------------------------
# 4. Input validation: only a hex commit sha is accepted.
# --------------------------------------------------------------------------
for boguns in "latest" "main" "23ac1009720ca92ac519cf496472eac4be7f7bf" "" "1234567890abcdef1234567890abcdef12345678 ; rm -rf /" "23AC1009720CA92AC519CF496472EAC4BE7F7BFE"; do
  cp "$FIXTURE" "$WORK/v.yaml"
  sh "$BUMP" "$WORK/v.yaml" "$boguns" >/dev/null 2>&1; rc=$?
  if [ $rc -eq 1 ] && cmp -s "$FIXTURE" "$WORK/v.yaml"; then :; else
    bad "validation: tag '$boguns' should be refused (rc=$rc) and the file left alone"
  fi
done
pass "validation: non-hex / wrong-length / empty / shell-ish tags are refused, file untouched"

# A 7- and an 8-char short sha are legal (a hand invocation on the VM's short id).
cp "$FIXTURE" "$WORK/short.yaml"
if sh "$BUMP" "$WORK/short.yaml" 23ac100 >/dev/null 2>&1 \
   && [ "$(grep -c 'newTag: 23ac100$' "$WORK/short.yaml")" -eq 9 ]; then
  pass "validation: a 7-char short sha is accepted"
else
  bad "validation: short sha rejected"
fi

# --------------------------------------------------------------------------
# 5. Shape guards: the script refuses to guess.
# --------------------------------------------------------------------------
# 5a. no images block at all
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - a.yaml\n' > "$WORK/noimg.yaml"
if sh "$BUMP" "$WORK/noimg.yaml" "$SHA" >/dev/null 2>&1; then
  bad "guard: missing images block accepted"
else
  pass "guard: a file without an \`images:\` block is refused"
fi

# 5b. an entry without a newTag (would silently stay on the unpullable placeholder)
cat > "$WORK/untagged.yaml" <<EOF
kind: Kustomization
images:
  - name: reg/a
    newTag: old
  - name: reg/b
EOF
if ! sh "$BUMP" "$WORK/untagged.yaml" "$SHA" >/dev/null 2>&1 && grep -q 'newTag: old' "$WORK/untagged.yaml"; then
  pass "guard: an image entry without a newTag is refused, file untouched"
else
  bad "guard: untagged entry accepted"
fi

# 5c. two images keys
cat > "$WORK/dup.yaml" <<EOF
kind: Kustomization
images:
  - name: reg/a
    newTag: old
images:
  - name: reg/b
    newTag: old
EOF
if sh "$BUMP" "$WORK/dup.yaml" "$SHA" >/dev/null 2>&1; then
  bad "guard: duplicate images key accepted"
else
  pass "guard: a duplicate \`images:\` key is refused"
fi

# --------------------------------------------------------------------------
# 6. Block scoping: a newTag OUTSIDE the images block is never touched, and the
#    block ends at the next top-level key (not at EOF) when one follows.
# --------------------------------------------------------------------------
cat > "$WORK/scoped.yaml" <<EOF
kind: Kustomization
images:
  # a comment mentioning newTag: decoy stays a comment
  - name: reg/a
    newTag: old
helmCharts:
  - name: something
    newTag: keep-me-please
EOF
sh "$BUMP" "$WORK/scoped.yaml" "$SHA" >/dev/null 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q "    newTag: $SHA" "$WORK/scoped.yaml" \
   && grep -q 'newTag: keep-me-please' "$WORK/scoped.yaml" \
   && grep -q '# a comment mentioning newTag: decoy' "$WORK/scoped.yaml"; then
  pass "scoping: the block ends at the next top-level key; outside newTags and comments survive"
else
  bad "scoping: rc=$rc"; cat "$WORK/scoped.yaml"
fi

# --------------------------------------------------------------------------
# 7. The result is still parseable YAML (and still says what it said).
# --------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  if python3 - "$WORK/real.yaml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
imgs = d["images"]
assert len(imgs) == 9, imgs
tags = {i["newTag"] for i in imgs}
assert tags == {"1234567890abcdef1234567890abcdef12345678"}, tags
# untouched neighbours of the images block
assert d["namespace"] == "voltpilot-prod"
assert d["labels"][0]["includeSelectors"] is False
assert d["configMapGenerator"][0]["envs"] == ["config/site.env"]
PY
  then pass "result parses as YAML; images pinned, neighbouring blocks unchanged"
  else bad "result failed the YAML assertions"
  fi
else
  printf 'SKIP  YAML assertions (no python3 + PyYAML)\n'
fi

printf '\n'
[ $fail -eq 0 ] && printf 'gitops-image-bump: all checks passed\n' || printf 'gitops-image-bump: FAILURES above\n'
exit $fail

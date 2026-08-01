#!/usr/bin/env sh
# =============================================================================
# gitops-image-bump.sh - rewrite the image tags of the gitops prod overlay to
# one commit SHA. This is the write half of the CI target path ("Deploy =
# Commit"): after the image matrix is green, the pipeline points the gitops
# repo's `images:` block at the freshly built ${GITHUB_SHA} and commits.
# Argo CD rolls it out on its next sync. See the gitops README, "CI/CD-Zielpfad".
#
#   usage:  gitops-image-bump.sh <kustomization.yaml> <sha>
#   exit 0  file rewritten (something changed)  - caller commits
#   exit 2  every tag already IS <sha>          - caller skips, no empty commit
#   exit 1  refused (bad input / unexpected file shape) - caller fails loudly
#
# WHY A SURGICAL EDIT AND NOT `kustomize edit set image`
# ------------------------------------------------------
# `kustomize edit` is the official tool, and the gitops README sketches the
# target path with it - but it round-trips the WHOLE kustomization through
# kyaml. Measured against the real overlay with the version gitops CI pins
# (kustomize v5.8.1), one bump produces an 85-line diff instead of nine:
#   * every list is re-indented (2-space -> 0-space) and its keys re-sorted,
#   * `envs: [config/site.env]` is expanded to block style,
#   * `includeSelectors: false` is dropped (default-valued, so serialized away),
#   * the `images:` entries are re-sorted alphabetically and each grows a
#     redundant `newName:` equal to its `name:`,
#   * and - the real damage - the comments DETACH from what they document:
#     the "TEMPORARY - stage 2 only" note about `probe-double-replicas-0.yaml`
#     ends up above `patches:`, the configMapGenerator note above the wrong key.
# Those comments carry the cutover procedure and the "never :latest" rule.
# A bump commit that a reviewer cannot read at a glance ("only tags moved")
# defeats the auditability the whole Deploy=Commit design rests on, so this
# script touches nothing but the `newTag:` values inside the `images:` block -
# and then PROVES it: the guard below re-reads its own output and refuses if
# any other line differs. That guard is what makes a text edit safe here.
#
# The rendered result is unaffected either way; `tools/deploy/
# test-gitops-image-bump.sh` pins both the byte-level and the kustomize-render
# equivalence against a committed copy of the real overlay.
# =============================================================================
set -eu

file="${1:-}"
sha="${2:-}"

die() { printf 'gitops-image-bump: %s\n' "$*" >&2; exit 1; }

[ -n "$file" ] && [ -n "$sha" ] || die "usage: $0 <kustomization.yaml> <sha>"
[ -f "$file" ] || die "not a file: $file"

# A commit SHA and nothing else. This value is interpolated into the file and
# into a git commit message, so keep the alphabet closed: hex only.
case "$sha" in
  *[!0-9a-f]*|"") die "refusing tag '$sha': expected a lowercase hex commit sha" ;;
esac
case "${#sha}" in
  7|8|40) : ;;
  *) die "refusing tag '$sha': expected 7, 8 or 40 hex chars, got ${#sha}" ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.report"' EXIT

# ---------------------------------------------------------------------------
# The edit. The block is delimited structurally, not by line numbers: it opens
# at the top-level key `images:` and closes at the next top-level key (a line
# starting in column 1 that is neither blank nor a comment) or at EOF. Comments
# and indented lines in between belong to the block, so the long explanatory
# header above the entries is inside it and stays untouched - we only rewrite
# lines whose first non-blank token is `newTag:`.
# ---------------------------------------------------------------------------
awk -v sha="$sha" -v report="$tmp.report" '
  # Opening the block. Guard against a second `images:` key (invalid YAML, but
  # we would silently edit only the first one).
  /^images:[[:space:]]*$/ {
    if (seen_images) { print "duplicate-images-key" > report; exit 1 }
    seen_images = 1; in_images = 1; print; next
  }
  # Closing it: any other top-level key ends the block.
  in_images && /^[^[:space:]#]/ { in_images = 0 }

  in_images && /^[[:space:]]*-[[:space:]]*name:[[:space:]]/ { entries++ }

  in_images && /^[[:space:]]*newTag:[[:space:]]/ {
    tags++
    # Keep the original indentation; replace only the value.
    match($0, /^[[:space:]]*/)
    printf "%snewTag: %s\n", substr($0, 1, RLENGTH), sha
    next
  }
  { print }
  END {
    printf "seen=%d entries=%d tags=%d\n", seen_images, entries, tags > report
  }
' "$file" > "$tmp" || die "awk pass failed (duplicate \`images:\` key in $file?)"

read_report() { sed -n 's/.*'"$1"'=\([0-9]*\).*/\1/p' "$tmp.report"; }
seen="$(read_report seen)"; entries="$(read_report entries)"; tags="$(read_report tags)"

[ "${seen:-0}" = "1" ] || die "no top-level \`images:\` block in $file - refusing to guess"
[ "${tags:-0}" -ge 1 ] || die "\`images:\` block in $file carries no newTag lines - refusing to guess"
# Every entry must be tag-pinned. An entry without a newTag would stay on the
# base's deliberately unpullable PLACEHOLDER tag and fail at pull time, in the
# cluster, hours later - catch the shape change here instead.
[ "$entries" = "$tags" ] || die "\`images:\` has $entries entries but $tags newTag lines - shape changed, refusing"

# ---------------------------------------------------------------------------
# The guard: compare input and output line by line and refuse if ANY line that
# differs is not a newTag line on both sides. The rewrite never adds or drops a
# line, so a length change is by itself a bug.
# ---------------------------------------------------------------------------
[ "$(wc -l < "$file")" -eq "$(wc -l < "$tmp")" ] || die "line count changed - refusing to write"

if ! guard="$(awk '
    NR == FNR { old[FNR] = $0; next }
    old[FNR] != $0 {
      if (old[FNR] !~ /^[[:space:]]*newTag:[[:space:]]/ || $0 !~ /^[[:space:]]*newTag:[[:space:]]/) {
        printf "line %d: %s\n", FNR, old[FNR]; bad = 1
      } else { changed++ }
    }
    END { if (bad) exit 1; print changed + 0 }
  ' "$file" "$tmp")"; then
  printf 'gitops-image-bump: REFUSED - the edit would touch non-newTag lines:\n%s\n' "$guard" >&2
  exit 1
fi

if [ "$guard" -eq 0 ]; then
  printf 'gitops-image-bump: all %s image tags already at %s - nothing to do\n' "$tags" "$sha"
  exit 2
fi

cat "$tmp" > "$file"
printf 'gitops-image-bump: set %s of %s image tags to %s in %s\n' "$guard" "$tags" "$sha" "$file"

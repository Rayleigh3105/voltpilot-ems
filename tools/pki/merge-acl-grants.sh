#!/usr/bin/env sh
# Merge the committed EMQX ACL base with a deployed acl.conf's generated device
# grants. The rules OUTSIDE the generated region are configuration and come from
# the repo; the per-device grant blocks are runtime state (written by the api's
# enrollment issuance and by voltpilot-ca.sh issue/revoke) and must survive a
# deploy - a plain copy of the committed file would silently revoke every
# enrolled device.
#
# This is CANONICALIZING and self-healing (see the 2026-07-08 prod incident,
# AGENTS.md "Inverter control" / the AclGrantWriter Javadoc): every device grant
# block is collected from the deployed file WHEREVER it sits - including a block
# that a past bug appended BELOW the default-deny (unreachable) - and re-emitted
# INSIDE the committed base's single generated region, above the single default-
# deny tail. So a deploy over a corrupted acl.conf heals it, and no grant is
# ever dropped just because it was misplaced. Base grants (the dev seed) are
# kept too; the deployed copy wins on a conflicting device id.
#
# Usage: merge-acl-grants.sh <committed-base> <deployed-acl> <output>
# A missing <deployed-acl> (first deploy) degrades to a plain copy of the base.
set -eu

base="$1"
deployed="$2"
out="$3"

if [ ! -f "$deployed" ]; then
  cp "$base" "$out"
  exit 0
fi

awk -v deployed="$deployed" '
  function is_allow_all(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s == "{allow, all}." }
  # Collect every device grant block from a file into block[id] (id order in
  # order[]); the last occurrence of an id wins. Portable: the id is field 2 of
  # the "%%<<device <id> ..." opener (no gawk 3-arg match()).
  function collect(path,   line, id, openid) {
    openid = ""
    while ((getline line < path) > 0) {
      if (openid != "") {
        block[openid] = block[openid] line "\n"
        if (line ~ ("^%%<<end device " openid ">>")) openid = ""
        continue
      }
      if (line ~ /^%%<<device /) {
        n = split(line, f, " "); id = f[2]
        if (!(id in seen)) { seen[id] = 1; order[++norder] = id }
        block[id] = line "\n"
        openid = id
      }
    }
    close(path)
  }
  BEGIN {
    norder = 0
    collect(ARGV[1])   # base first: establishes the dev-seed grant + its order
    collect(deployed)  # deployed overrides / adds runtime grants
  }
  # Emit the base skeleton, replacing the generated region with the union of
  # collected blocks and collapsing to a single tail.
  {
    line = $0
    if (skipdev != "") {                       # inside a base device block
      if (line ~ ("^%%<<end device " skipdev ">>")) skipdev = ""
      next
    }
    if (line ~ /^%%<<device /) { m = split(line, g, " "); skipdev = g[2]; next }
    if (line ~ /^%%<<end device /) next        # stray unpaired end marker
    if (index(line, "%%<<BEGIN GENERATED DEVICE GRANTS>>")) {
      print line
      for (k = 1; k <= norder; k++) { id = order[k]; if (block[id] != "") printf "%s", block[id] }
      inregion = 1
      next
    }
    if (index(line, "%%<<END GENERATED DEVICE GRANTS>>")) {
      if (!emitted_end) { print line; emitted_end = 1 }   # keep exactly one END
      inregion = 0
      next
    }
    if (inregion) next                          # base region content already replaced
    if (donetail) next                          # drop any duplicated tail after allow-all
    print line
    if (is_allow_all(line)) donetail = 1
  }
' "$base" > "$out"

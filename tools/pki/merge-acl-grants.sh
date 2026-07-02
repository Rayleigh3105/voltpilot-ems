#!/usr/bin/env sh
# Merge the committed EMQX ACL base with a deployed acl.conf's generated
# device grants. The rules OUTSIDE the generated region are configuration and
# come from the repo; the per-device grant blocks BETWEEN the anchors are
# runtime state (written by the api's enrollment issuance and by
# voltpilot-ca.sh issue/revoke) and must survive a deploy - a plain copy of
# the committed file would silently revoke every enrolled device.
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
  /%%<<BEGIN GENERATED DEVICE GRANTS>>/ {
    print
    skip = 1
    inregion = 0
    while ((getline line < deployed) > 0) {
      if (line ~ /%%<<END GENERATED DEVICE GRANTS>>/) inregion = 0
      if (inregion) print line
      if (line ~ /%%<<BEGIN GENERATED DEVICE GRANTS>>/) inregion = 1
    }
    close(deployed)
    next
  }
  /%%<<END GENERATED DEVICE GRANTS>>/ { skip = 0 }
  !skip
' "$base" > "$out"

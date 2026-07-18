#!/bin/sh
# VoltPilot Edge-App Layer 1 (Node-RED) entrypoint.
#
# WHY THIS EXISTS
# ---------------
# docker-compose mounts the named volume `vp-nodered-data` at /data. After the
# FIRST run that volume SHADOWS the image's /data, so a pulled image update
# (new flows.json / settings.js / vp-palette / node_modules) never reaches the
# running Node-RED - it keeps executing the STALE flows from the volume. That
# is a real footgun: a Deye decode fix shipped in :latest and pulled would be
# silently ignored, and the dashboard would keep showing the old, wrong values.
#
# The Node-RED flows here are VoltPilot-OWNED template + self-wiring: the
# customer never hand-edits them (the "Wechselrichter (automatisch)" tab
# self-wires from the retained inverter selection over MQTT, and the flow
# CONTEXT re-populates from that retained config on connect). So the IMAGE is
# the source of truth and re-seeding the template on update is CORRECT, not
# data loss. Genuine per-instance runtime state that Node-RED writes into /data
# (.config.*.json, flows_cred.json, .sessions.json, context/) is left untouched.
#
# HOW
# ---
# The template assets are baked at a NON-shadowed image path (/opt/vp-template)
# together with a content-hash version marker. On every start we compare that
# marker against the copy in /data and re-seed ONLY when they differ, then run
# Node-RED. So an up-to-date volume start is a SILENT no-op; an actual update
# re-seeds and logs loudly what it replaced. This makes future `docker compose
# pull && up -d` updates take automatically, with no manual volume wipe and
# without touching vp-edge-data (the core's identity/certs/inverter config).
#
# PRIVILEGE (prod-down fix, 2026-07-09)
# -------------------------------------
# This entrypoint MUST run as ROOT. An OLDER image seeded the vp-palette /
# node_modules dirs into /data at BUILD time via `COPY ... /data`, so on a
# pre-existing `vp-nodered-data` volume those dirs are ROOT-owned. If the
# re-seed ran unprivileged (the old Dockerfile did `USER node-red` before the
# ENTRYPOINT), `rm -rf "$DATA_DIR/vp-palette"` failed with `Permission denied`
# (rm needs write on the root-owned parent), `set -e` aborted, the container
# looped, and the device went dark - no telemetry. So the Dockerfile now leaves
# the ENTRYPOINT running as root; we re-seed with enough privilege to replace
# any prior ownership, `chown` /data to the run user, and then DROP privileges
# to run Node-RED itself UNPRIVILEGED (su-exec), exactly as before.
set -eu

# Paths are overridable so the re-seed logic is unit-testable off a temp dir
# (see reseed.test.sh); the defaults are the production image/volume paths.
TEMPLATE_DIR="${VP_TEMPLATE_DIR:-/opt/vp-template}"
DATA_DIR="${VP_DATA_DIR:-/data}"
# The unprivileged user Node-RED runs as (also who ends up owning /data).
RUN_USER="${VP_RUN_USER:-node-red:node-red}"
MARKER="${DATA_DIR}/.vp-template-version"
VERSION_FILE="${TEMPLATE_DIR}/.vp-template-version"
# The @vp-flow merge helper: baked next to this script in the image
# (vp-reseed-merge-flows.js); in the repo it sits next to this script under
# its source name. VP_MERGE_SCRIPT overrides for tests.
MERGE_SCRIPT="${VP_MERGE_SCRIPT:-}"
if [ -z "$MERGE_SCRIPT" ]; then
  for cand in "$(dirname "$0")/vp-reseed-merge-flows.js" "$(dirname "$0")/reseed-merge-flows.js"; do
    if [ -f "$cand" ]; then MERGE_SCRIPT="$cand"; break; fi
  done
fi

# Set to 1 by reseed_template when it actually replaced anything, so the
# (recursive, thousands-of-files in node_modules) chown below runs ONLY when
# ownership might be wrong - a healthy up-to-date start stays cheap and quiet.
DID_RESEED=0

log() { echo "[vp-edge/nodered] $*"; }

reseed_template() {
  [ -f "$VERSION_FILE" ] || { log "WARN: no template version marker at ${VERSION_FILE}; skipping re-seed"; return 0; }

  want="$(cat "$VERSION_FILE")"
  have=""
  [ -f "$MARKER" ] && have="$(cat "$MARKER" 2>/dev/null || true)"

  # Up to date -> silent no-op (no log noise on a healthy restart).
  [ "$want" = "$have" ] && return 0

  mkdir -p "$DATA_DIR"
  if [ -z "$have" ]; then
    log "seeding Node-RED template assets into ${DATA_DIR} (fresh volume, version ${want})"
  else
    log "template UPDATED ${have} -> ${want}; re-seeding flows.json, settings.js, package.json, vp-palette, node_modules"
  fi

  # Template FILES: settings/package are overwritten outright - the image is
  # the source of truth for them.
  for f in settings.js package.json; do
    [ -e "$TEMPLATE_DIR/$f" ] && cp -f "$TEMPLATE_DIR/$f" "$DATA_DIR/$f"
  done

  # flows.json is MERGED, not replaced (D-12 reseed coexistence, contract
  # docs/contracts/v2/flow-artifact.md §4): the VENDOR tab group comes from
  # the image, while user-flow ARTIFACT tabs (info starts with "@vp-flow") in
  # the existing file survive byte-for-byte together with their nodes. When
  # the merge cannot run (no node binary, corrupt existing file) we fall back
  # to the pre-E2 wholesale copy with a LOUD warning - safe either way: the
  # core re-applies the retained deployment set and restores dropped artifact
  # tabs (the contract's "self-healing either way").
  if [ -e "$TEMPLATE_DIR/flows.json" ]; then
    merged=0
    if [ -f "$DATA_DIR/flows.json" ] && [ -f "$MERGE_SCRIPT" ] && command -v node >/dev/null 2>&1; then
      if node "$MERGE_SCRIPT" "$TEMPLATE_DIR/flows.json" "$DATA_DIR/flows.json" \
           > "$DATA_DIR/.vp-flows-merged.json" 2> "$DATA_DIR/.vp-flows-merge.log"; then
        mv "$DATA_DIR/.vp-flows-merged.json" "$DATA_DIR/flows.json"
        merged=1
        while IFS= read -r line; do log "flows-merge: $line"; done < "$DATA_DIR/.vp-flows-merge.log"
      fi
      rm -f "$DATA_DIR/.vp-flows-merged.json" "$DATA_DIR/.vp-flows-merge.log"
    fi
    if [ "$merged" = "0" ]; then
      if [ -f "$DATA_DIR/flows.json" ]; then
        log "WARN: flows.json wholesale-seeded (merge unavailable or existing file unreadable); @vp-flow artifact tabs self-heal from the retained deployment"
      fi
      cp -f "$TEMPLATE_DIR/flows.json" "$DATA_DIR/flows.json"
    fi
  fi

  # Template DIRS: replace outright so removed nodes/deps never linger. The
  # rm -rf can only remove root-owned dirs left by an OLDER image because the
  # entrypoint runs as root (see the PRIVILEGE note above). The vp-palette
  # `file:` dep is a symlink (node_modules/@voltpilot/... -> ../../vp-palette)
  # inside node_modules, so copying BOTH at the same relative layout keeps that
  # link valid. `cp -RP` copies recursively and PRESERVES the symlink (-P =
  # never dereference), but deliberately NOT ownership (no -a / -p): the copies
  # inherit the copier's uid (root here), and the `chown -R` below hands the
  # whole tree back to the node-red run user. `-RP` is portable across the
  # image's BusyBox cp, GNU coreutils, and BSD/macOS cp (the reseed.test.sh host).
  for d in vp-palette node_modules; do
    if [ -e "$TEMPLATE_DIR/$d" ]; then
      rm -rf "$DATA_DIR/$d"
      cp -RP "$TEMPLATE_DIR/$d" "$DATA_DIR/$d"
    fi
  done

  printf '%s\n' "$want" > "$MARKER"
  DID_RESEED=1
  log "re-seed complete (version ${want})"
}

reseed_template

# When we run as root (the production ENTRYPOINT path), hand /data to the run
# user and drop privileges so Node-RED runs UNPRIVILEGED. Re-seeding may have
# replaced dirs an OLDER image left root-owned (build-time COPY into /data), and
# Node-RED needs to own its userDir to write runtime state - so chown /data
# after a re-seed. We only chown when we actually re-seeded: a volume already
# seeded by THIS image is node-red-owned, so a healthy restart skips the walk.
if [ "$(id -u)" = "0" ]; then
  if [ "$DID_RESEED" = "1" ]; then
    chown -R "$RUN_USER" "$DATA_DIR" 2>/dev/null \
      || log "WARN: could not chown ${DATA_DIR} to ${RUN_USER} (Node-RED may fail to write runtime state)"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec "$RUN_USER" "$@"
  fi
  # Never silently run Node-RED as root: loud warning + still hand off, so the
  # process starts (telemetry over privilege hygiene) but the break is visible.
  log "WARN: su-exec not found; running '$*' as ROOT (Node-RED should run unprivileged)"
fi

# Non-root already (host unit tests, or an operator running the container with
# --user): nothing to drop, run the command as-is.
exec "$@"

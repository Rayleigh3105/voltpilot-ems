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
set -eu

# Paths are overridable so the re-seed logic is unit-testable off a temp dir
# (see reseed.test.sh); the defaults are the production image/volume paths.
TEMPLATE_DIR="${VP_TEMPLATE_DIR:-/opt/vp-template}"
DATA_DIR="${VP_DATA_DIR:-/data}"
MARKER="${DATA_DIR}/.vp-template-version"
VERSION_FILE="${TEMPLATE_DIR}/.vp-template-version"

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

  # Template FILES: overwrite outright - the image is the source of truth.
  for f in flows.json settings.js package.json; do
    [ -e "$TEMPLATE_DIR/$f" ] && cp -f "$TEMPLATE_DIR/$f" "$DATA_DIR/$f"
  done

  # Template DIRS: replace outright so removed nodes/deps never linger. The
  # vp-palette `file:` dep is a symlink (node_modules/@voltpilot/... ->
  # ../../vp-palette) inside node_modules, so copying BOTH at the same relative
  # layout keeps that link valid. `cp -RP` copies recursively and PRESERVES the
  # symlink (-P = never dereference), but deliberately NOT ownership: the
  # container runs as the non-root node-red user, and preserving ownership
  # (cp -a / -p) would EPERM-warn on the volume filesystem - the copied files
  # are node-red-owned anyway (the writer). `-RP` is portable across the image's
  # BusyBox cp, GNU coreutils, and BSD/macOS cp (the reseed.test.sh host).
  for d in vp-palette node_modules; do
    if [ -e "$TEMPLATE_DIR/$d" ]; then
      rm -rf "$DATA_DIR/$d"
      cp -RP "$TEMPLATE_DIR/$d" "$DATA_DIR/$d"
    fi
  done

  printf '%s\n' "$want" > "$MARKER"
  log "re-seed complete (version ${want})"
}

reseed_template
exec "$@"

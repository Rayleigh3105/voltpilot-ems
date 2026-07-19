# syntax=docker/dockerfile:1
# VoltPilot Edge-App Layer 1: Node-RED with the vp-palette + template flows.
# Multi-arch base (arm64 for Pi + amd64). The editor is LAN-only and behind
# adminAuth - VoltPilot wires the flows per customer, the customer never does.

# --- stage 1: build the `deye` CLI (github.com/s10l/deye-logger-at-cmd) --------
# A dependency-free Go binary that speaks the Deye WiFi logger's AT-command
# Modbus tunnel (UDP 48899). The self-wiring read path uses Solarman-V5 (TCP
# 8899), NOT this CLI - it is kept on PATH only as a DIAGNOSTIC tool (the at_cli
# fallback + ad-hoc register dumps documented in DEYE.md). The stage pins itself
# to $BUILDPLATFORM and cross-compiles (GOOS/GOARCH from $TARGETARCH), so an
# arm64 (Pi) image builds on the amd64 runner WITHOUT emulation - the CLI is
# pure Go with CGO disabled. Pin DEYE_REF for reproducible builds.
FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS deye-build
ARG TARGETOS TARGETARCH
# Pinned to a commit for reproducible builds; override to a branch/tag/SHA.
ARG DEYE_REF=2c09976a5d1480432170376c539dec758bd02d00
RUN git clone --filter=blob:none \
      https://github.com/s10l/deye-logger-at-cmd.git /src \
 && cd /src \
 && git checkout ${DEYE_REF} \
 && cd src \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -o /out/deye .

# --- stage 2: the Node-RED image ---------------------------------------------
FROM nodered/node-red:4.0

# Build version stamp (--build-arg VERSION, the short commit SHA from the
# edge-images workflow). Unlike the core binary this image has no runtime
# version surface, so it is recorded as an OCI image label - `docker inspect`
# then shows which commit an edge device's Node-RED layer is running.
ARG VERSION=dev
LABEL org.opencontainers.image.version="$VERSION"

# Everything below runs as root - at BUILD time AND at RUNTIME. The re-seed
# ENTRYPOINT must be root: an OLDER image left the vp-palette / node_modules
# dirs root-owned in the /data volume (build-time COPY into /data), so an
# unprivileged re-seed hit `rm: Permission denied` and looped the container
# (prod-down 2026-07-09). The entrypoint re-seeds as root, chowns /data to the
# node-red user, then DROPS privileges via su-exec, so Node-RED still runs
# UNPRIVILEGED. We therefore deliberately do NOT `USER node-red` here.
#
# su-exec: the tiny Alpine privilege-drop helper (postgres/redis-alpine idiom).
# The base image is Alpine, which ships neither gosu nor a util-linux setpriv -
# its BusyBox setpriv can't --reuid/--regid - so su-exec is the right tool.
# The deye CLI stays on PATH so the exec nodes work out of the box.
USER root
RUN apk add --no-cache su-exec
COPY --from=deye-build /out/deye /usr/local/bin/deye
COPY reseed-entrypoint.sh /usr/local/bin/vp-nodered-entrypoint.sh
# The @vp-flow merge helper the entrypoint uses to preserve user-flow artifact
# tabs across template re-seeds (D-12; docs/contracts/v2/flow-artifact.md §4).
COPY reseed-merge-flows.js /usr/local/bin/vp-reseed-merge-flows.js
RUN chmod 0755 /usr/local/bin/deye /usr/local/bin/vp-nodered-entrypoint.sh \
 && chmod 0644 /usr/local/bin/vp-reseed-merge-flows.js \
 && mkdir -p /opt/vp-template

# The template assets (VoltPilot-owned flows + palette + settings) are baked at
# a NON-shadowed image path, NOT at /data - because the compose named volume
# `vp-nodered-data` mounts over /data and would otherwise pin the first run's
# copy forever, so image updates (new flows.json / palette / settings) would
# never reach the running Node-RED. The entrypoint below re-seeds them into
# /data on start (marker-guarded), so a `pull && up -d` update takes
# automatically. See reseed-entrypoint.sh for the full rationale.
#
# vp-palette (local package) + Modbus nodes + bcryptjs (adminAuth hash in
# settings.js), installed alongside the template.
COPY vp-palette /opt/vp-template/vp-palette
COPY package.json /opt/vp-template/package.json
RUN cd /opt/vp-template && npm install --omit=dev

# Flows: "Wechselrichter (automatisch)" - the self-wiring path that reads the
# retained edge/inverter/config selection and runs the matching read adapter
# (Deye Solarman-V5 or generic Modbus-TCP) WITHOUT a per-customer flow edit -
# plus "SunSpec (Simulator)" for the hardware-free e2e (compose `sim` profile).
# The former manual "Vorlage" tabs are retired (the selection now drives it).
COPY settings.js /opt/vp-template/settings.js
COPY flows.json /opt/vp-template/flows.json

# Content-hash marker over the whole template tree. On start the entrypoint
# compares it against /data/.vp-template-version and re-seeds only on a change,
# so a healthy up-to-date restart is a silent no-op. A fresh build with changed
# template content yields a new marker -> the next `up -d` re-seeds and logs it.
RUN cd /opt/vp-template \
 && find . -type f ! -name '.vp-template-version' -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 \
    > .vp-template-version

# Re-seed the image's template into /data (over the shadowing volume) on every
# start, then hand off to the base image's own entrypoint (./entrypoint.sh in
# WORKDIR /usr/src/node-red - it runs red.js --userDir /data and forwards
# SIGTERM/SIGINT for a clean shutdown). Our wrapper runs the re-seed as root,
# chowns /data to node-red, then `exec su-exec node-red:node-red ./entrypoint.sh`
# - so Node-RED runs as the non-root node-red user (PID-forwarded) exactly as
# before, only the re-seed step gains root. No `USER node-red` here on purpose.
ENTRYPOINT ["/usr/local/bin/vp-nodered-entrypoint.sh"]
CMD ["./entrypoint.sh"]

EXPOSE 1880

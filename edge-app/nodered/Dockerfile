# syntax=docker/dockerfile:1
# VoltPilot Edge-App Layer 1: Node-RED with the vp-palette + template flows.
# Multi-arch base (arm64 for Pi + amd64). The editor is LAN-only and behind
# adminAuth - VoltPilot wires the flows per customer, the customer never does.

# --- stage 1: build the `deye` CLI (github.com/s10l/deye-logger-at-cmd) --------
# A dependency-free Go binary that speaks the Deye WiFi logger's AT-command
# Modbus tunnel; the "Deye (Vorlage)" flow tab shells out to it via exec nodes.
# Under buildx the golang stage runs per target platform, so `go build` yields
# the correct arch natively - no cross-compile flags needed. Pin DEYE_REF to a
# commit/tag for reproducible builds.
FROM golang:1.22-bookworm AS deye-build
# Pinned to a commit for reproducible builds; override to a branch/tag/SHA.
ARG DEYE_REF=2c09976a5d1480432170376c539dec758bd02d00
RUN git clone --filter=blob:none \
      https://github.com/s10l/deye-logger-at-cmd.git /src \
 && cd /src \
 && git checkout ${DEYE_REF} \
 && cd src \
 && CGO_ENABLED=0 go build -trimpath -o /out/deye .

# --- stage 2: the Node-RED image ---------------------------------------------
FROM nodered/node-red:4.0

# The deye CLI on PATH so the exec nodes work out of the box.
USER root
COPY --from=deye-build /out/deye /usr/local/bin/deye
RUN chmod 0755 /usr/local/bin/deye
USER node-red

# vp-palette (local package) + Modbus nodes + bcryptjs (adminAuth hash in
# settings.js), installed into the Node-RED user dir.
COPY vp-palette /data/vp-palette
COPY package.json /data/package.json
RUN cd /data && npm install --omit=dev

# Template flows: "SunSpec (Simulator)" active (hardware-free e2e via the
# compose `sim` profile) + the disabled per-customer templates
# "SunSpec Wechselrichter (Vorlage)" and "Deye (Vorlage)".
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

EXPOSE 1880

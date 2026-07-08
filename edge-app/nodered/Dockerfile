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

# Flows: "Wechselrichter (automatisch)" - the self-wiring path that reads the
# retained edge/inverter/config selection and runs the matching read adapter
# (Deye Solarman-V5 or generic Modbus-TCP) WITHOUT a per-customer flow edit -
# plus "SunSpec (Simulator)" for the hardware-free e2e (compose `sim` profile).
# The former manual "Vorlage" tabs are retired (the selection now drives it).
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

EXPOSE 1880

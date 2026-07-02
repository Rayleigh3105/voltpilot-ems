# syntax=docker/dockerfile:1
# VoltPilot Edge-App Layer 1: Node-RED with the vp-palette + template flows.
# Multi-arch base (arm64 for Pi + amd64). The editor is LAN-only and behind
# adminAuth - VoltPilot wires the flows per customer, the customer never does.
FROM nodered/node-red:4.0

# vp-palette (local package) + Modbus nodes + bcryptjs (adminAuth hash in
# settings.js), installed into the Node-RED user dir.
COPY vp-palette /data/vp-palette
COPY package.json /data/package.json
RUN cd /data && npm install --omit=dev

# Template flows: "SunSpec (Simulator)" active (hardware-free e2e via the
# compose `sim` profile) + the disabled per-customer template
# "SunSpec Wechselrichter (Vorlage)".
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

EXPOSE 1880

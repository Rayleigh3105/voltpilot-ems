# syntax=docker/dockerfile:1
# Node-RED edge (thin by design). Multi-arch base (ARM+x86).
FROM nodered/node-red:4.0

# Modbus/SunSpec nodes for the acquisition + guard-write flows. Declared in
# package.json and installed into the Node-RED user dir (/data).
COPY package.json /data/package.json
RUN cd /data && npm install --omit=dev

# Seed the flows and settings. In production the flows/credentials and the
# mTLS MQTT + x.509 device identity are provisioned per device (future work).
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

# The edge exposes only the local editor UI in dev; in production it makes only
# OUTBOUND MQTT connections (no inbound ports).
EXPOSE 1880

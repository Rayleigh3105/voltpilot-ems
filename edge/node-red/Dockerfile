# syntax=docker/dockerfile:1
# Node-RED edge skeleton (thin by design). Multi-arch base (ARM+x86).
FROM nodered/node-red:4.0

# Seed the placeholder flows and settings. Real Modbus/SunSpec nodes and mTLS
# MQTT credentials are provisioned per device (future work).
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

# The edge exposes only the local editor UI in dev; in production it makes only
# OUTBOUND MQTT connections (no inbound ports).
EXPOSE 1880

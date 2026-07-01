# VoltPilot standalone edge simulator.
# Small, multi-arch (works on Raspberry Pi arm64/armv7 and x86_64).
FROM python:3.12-slim

# Run as an unprivileged user; the sim never needs root.
RUN useradd --create-home --uid 10001 edgesim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY voltpilot_edge_sim.py ./

USER edgesim

# All configuration is via EDGE_SIM_* env vars (or flags appended to the run).
# Mount device certs read-only at /certs for mTLS, e.g.:
#   docker run --rm -v "$PWD/certs:/certs:ro" \
#     -e EDGE_SIM_HOST=mqtt.example.com -e EDGE_SIM_PORT=8883 \
#     -e EDGE_SIM_CA_CERT=/certs/device-ca.crt \
#     -e EDGE_SIM_CLIENT_CERT=/certs/device.crt \
#     -e EDGE_SIM_CLIENT_KEY=/certs/device.key \
#     voltpilot-edge-sim
ENTRYPOINT ["python", "voltpilot_edge_sim.py"]

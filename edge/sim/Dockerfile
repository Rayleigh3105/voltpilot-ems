# syntax=docker/dockerfile:1
# Simulated SunSpec Modbus TCP inverter/battery source (dev only, no hardware).
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY sunspec-sim.js sim-model.js ./

# Modbus TCP.
EXPOSE 502

CMD ["node", "sunspec-sim.js"]

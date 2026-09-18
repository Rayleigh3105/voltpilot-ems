#!/usr/bin/env bash
# Prints a command template only. Never expands operator values, runs rpk or contacts a broker.
set -euo pipefail
set +x
cat <<'COMMAND'
# TROCKENLAUF: Vorlage, NICHT ausgefuehrt. Writer zuvor auf null, Gruppe ohne Mitglieder.
# RPK_CONFIG: Betreiberdatei mit Broker/TLS/SASL; WRITER_REPLAY_EPOCH_MS: gewaehlter Rueckweg-Punkt.
# Gruppe/Topics bei abweichender Deployment-Konfiguration entsprechend setzen.
rpk --config "${RPK_CONFIG:?}" group describe "${WRITER_GROUP:-timescale-writer}"
rpk --config "${RPK_CONFIG:?}" group seek "${WRITER_GROUP:-timescale-writer}" \
  --to "${WRITER_REPLAY_EPOCH_MS:?}" \
  --topics "${WRITER_TOPICS:-telemetry.raw,telemetry-v2.raw,measurements.raw,events.raw}" \
  --allow-new-topics
rpk --config "${RPK_CONFIG:?}" group describe "${WRITER_GROUP:-timescale-writer}"
COMMAND

#!/bin/bash
# Simuliert die DB-Wirkung des Status-Herzschlags der Boxen (alle 15 s, wie agent.go):
# device_status_seen_at der lt-Boxen auf jetzt. Laeuft, bis die Datei herzschlag.stop existiert.
cd "$(dirname "$0")"
rm -f herzschlag.stop
while [ ! -f herzschlag.stop ]; do
  ./q.sh -c "UPDATE device SET device_status_seen_at = now() WHERE external_ref LIKE 'lt-box-%'" >/dev/null 2>&1
  sleep 15
done

#!/bin/sh
# Waechter fuer einen Wartungstunnel (cron, alle 5 min). Gehoert zum
# Betriebssystem, NICHT zu vp-edge-light: ein Update, ein Absturz oder ein
# falsches Programm beruehren ihn nicht.
#
#   service-tunnel-watch.sh [schnittstelle]   (Vorgabe wg_service)
#
# Ohne Handshake seit MAX_AGE Sekunden wird die Schnittstelle neu gestartet;
# netifd loest dabei auch den Servernamen neu auf (neue IP des Servers).
IFACE="${1:-wg_service}"
MAX_AGE=600

hs="$(wg show "$IFACE" latest-handshakes 2>/dev/null | awk 'NR==1 {print $2}')"
if [ -z "$hs" ]; then
  logger -t vp-service-tunnel "Schnittstelle $IFACE fehlt oder ohne Gegenstelle - ifup"
  ifup "$IFACE"
  exit 0
fi
age=$(($(date +%s) - hs))
if [ "$hs" -eq 0 ] || [ "$age" -gt "$MAX_AGE" ]; then
  logger -t vp-service-tunnel "kein Handshake seit mehr als $MAX_AGE s - $IFACE wird neu gestartet"
  ifup "$IFACE"
fi

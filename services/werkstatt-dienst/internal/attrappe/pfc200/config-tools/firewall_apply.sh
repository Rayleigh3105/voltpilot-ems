#!/bin/sh
# Wie am Geraet: der Aufruf des Werkzeugs firewall, dazu "--apply up", wenn der
# Dienst laeuft. Die Attrappe wendet jede Einstellung sofort an.
exec "$(dirname "$0")/firewall" "$@"

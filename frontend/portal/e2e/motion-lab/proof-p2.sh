#!/usr/bin/env bash
# HARNESS · Bewegung P2 — die Beweise (a)-(g) in EINEM Aufruf.
#
#   e2e/motion-lab/proof-p2.sh [PORT] > .../proof.txt
#
# Vier Durchlaeufe, weil vier verschiedene GERAETE-Lagen gemessen werden
# (Schreibtisch · Telefon · reduzierte Bewegung · gedrosselte CPU) und jede
# einen eigenen Browser-Kontext braucht: `reducedMotion` und `hasTouch` stehen
# beim Anlegen des Kontexts fest und lassen sich danach nicht umlegen.
set -u
cd "$(dirname "$0")/../.." || exit 1
PORT="${1:-5182}"
echo "# Bewegung P2 · Browser-Beweis $(date -u +%Y-%m-%dT%H:%MZ) · Port $PORT"
echo "# Anlage: Solarpark Dachau (Dev-Seed) · Chrome/Playwright headless"
node e2e/motion-lab/proof-p2.mjs --port "$PORT"                      # (a)(b)(c)(e) @1440
node e2e/motion-lab/proof-p2.mjs --port "$PORT" --vw 375             # (d) @375, hasTouch
node e2e/motion-lab/proof-p2.mjs --port "$PORT" --reduced            # (f)
node e2e/motion-lab/proof-p2.mjs --port "$PORT" --vw 375 --cpu 4 | grep '^(g)'   # (g)

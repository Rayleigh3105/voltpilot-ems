#!/usr/bin/env bash
# Layout-Wächter im echten Browser (UX-Review V-07, 24.09.2026).
#
# Warum es ihn gibt: die Symbole im Energiefluss des Cockpits wurden auf die
# ganze Diagrammfläche aufgeblasen - in Chromium 141 ja, in 151 nein. Vitest
# rendert kein CSS-Layout, und das Gate baute nur. Dieser Schritt vermisst
# Cockpit und Fahrplan in einem echten Browser (`e2e/layout-waechter.spec.ts`):
# Symbolgröße, Überlauf, Leerraum unter dem Fluss, das Tagesbild des
# Fahrplans und das Budget seines ersten Bildschirms (E9: alle Antworten
# beginnen sichtbar). Geometrie statt Pixelvergleich, damit eine
# Browser-Aktualisierung den Wächter nicht rot färbt.
#
# Ablauf:
#   1. Chromium und WebKit (Safari) für die gepinnte Playwright-Version holen
#      (`LAYOUT_SMOKE_NO_INSTALL=1` überspringt das, wenn Browser schon da sind).
#   2. Prüfen, welcher Browser auf diesem Runner wirklich startet. WebKit
#      braucht Systembibliotheken, die ein Runner ohne root nicht nachladen kann.
#   3. Den Wächter in jedem startfähigen Browser laufen lassen:
#      Chromium als `desktop-chromium` (1440 px) und `mobile-chromium` (375 px),
#      WebKit als `mobile-webkit` (375 px).
#
# Startet KEIN Browser, endet der Schritt mit einer Warnung statt rot - wie der
# Browser-Teil von `csp-smoke.sh`. Rot wird er nur durch einen echten
# Layout-Fehler.
#
# Aufruf: test/layout-smoke.sh   (aus `frontend/portal/`)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== 1/3 · Browser holen =="
if [ "${LAYOUT_SMOKE_NO_INSTALL:-}" = "1" ]; then
  echo "übersprungen (LAYOUT_SMOKE_NO_INSTALL=1)"
elif npx playwright install chromium webkit >/tmp/vp-layout-install.log 2>&1; then
  echo "ok"
else
  echo "WARN: playwright install ist gescheitert - es zählt, was schon da ist."
  tail -5 /tmp/vp-layout-install.log | sed 's/^/       /'
fi

echo "== 2/3 · Welche Browser starten? =="
startfaehig=$(node -e '
  const pw = require("@playwright/test");
  (async () => {
    const ok = [];
    for (const name of ["chromium", "webkit"]) {
      try {
        const b = await pw[name].launch();
        await b.close();
        ok.push(name);
      } catch (e) {
        console.error(`WARN: ${name} startet nicht: ${String(e.message).split("\n")[0]}`);
      }
    }
    process.stdout.write(ok.join(" "));
  })();
')
projekte=()
for b in $startfaehig; do
  case "$b" in
    chromium) projekte+=(--project=desktop-chromium --project=mobile-chromium) ;;
    webkit) projekte+=(--project=mobile-webkit) ;;
  esac
done
if [ ${#projekte[@]} -eq 0 ]; then
  echo "WARN: kein Browser startet auf diesem Runner - Layout-Wächter übersprungen."
  exit 0
fi
echo "ok: ${startfaehig}"

echo "== 3/3 · Layout-Wächter =="
npx playwright test e2e/layout-waechter.spec.ts "${projekte[@]}"

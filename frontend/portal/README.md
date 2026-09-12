# Portal

React-Anwendung für Kunden und Plattformverwaltung. [Bedienmodell und Entwicklungsregeln](../../docs/portal.md); [lokaler Gesamtstack](../../docs/development.md).

## Start und Prüfung

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Vite startet auf <http://localhost:5173>. API-/Keycloak-Adressen werden über `VITE_*` konfiguriert; Anmeldung und lokale Demozugänge stehen in der Entwicklungsanleitung.

## Aufbau

| Bereich | Quelle |
|---|---|
| Routen und alte Lesezeichen | `src/nav.ts` |
| Anlagenbereiche und verfügbare Ansichten | `src/anlageNav.ts`, `src/surface.ts` |
| Gemeinsame UI / Tokens | `designsystem/` |
| Kundenhilfe mit Screenshots | [src/help](src/help/README.md) |
| Browserprüfung | `e2e/`, `playwright.config.ts` |

Gezielte Browserfälle: `npm run test:e2e -- help.spec.ts`; weitere Fälle entsprechend auswählen. Browserabhängigkeiten einmalig mit `npx playwright install chromium webkit` installieren.

## Messbare Ladezeiten

Wiederholbare Cockpit-/Anlagenwechsel-Messungen: [Performance-Rig](e2e/performance/README.md). `npm run test:bundle` prüft die Grenzen für Einstieg (230 kB gzip) und gemeinsames Chart-Bundle (210 kB gzip).

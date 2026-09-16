# Portal-Hilfe pflegen

26 deutsche Artikel unter `#/hilfe` und im kontextbezogenen Dialog. Artikelquelle: `content/`; Darstellung: `HelpArticleView`. Die Hilfe ist ohne aktuelle Messdaten erreichbar.

## Redaktion

- Artikel-/Abschnitts-IDs sind Lesezeichen und bleiben stabil. Links über `helpHref()` erzeugen.
- Pro Abschnitt eine kurze Erklärung oder Schrittfolge. Voraussetzungen optionaler Funktionen nennen, tatsächliche UI-Bezeichnungen verwenden.
- Plan, Geräteantwort und Messwirkung unterscheiden. Keine fehlenden Werte als Null erklären.
- SVG-Illustrationen in `assets/` erklären Zusammenhänge; `HelpDiagram` verbindet Bild, Alternativtext und Bildunterschrift. Dieselben SVGs werden in der Projektdoku verwendet.
- Neue IDs in `model.ts`, kontextbezogene Einstiege in `context.ts`, Formularverweise mit `HelpLink` ergänzen.

## Screenshots erneuern

Die PNGs zeigen echte React-Komponenten mit eingefrorenen **fiktiven** Daten aus `e2e/help-fixtures.ts`. Fixtures bleiben außerhalb des Produktionsbundles. Nummerierte Hinweise liegen als zugängliche HTML-Overlays über dem Bild.

Aus `frontend/portal`:

```bash
npm run help:screenshots                    # alle Aufnahmen, Port 4176
npm run help:screenshots -- cockpit fahrplan # einzelne Capture-IDs
```

Bei Bedarf vorher `npx playwright install chromium`. Routen, Bildausschnitt und DOM-Anker stehen in `e2e/help-captures.mjs`. Capture blockiert externe Datenzugriffe und prüft die Ankerpositionen. PNGs und `screenshots.generated.json` gemeinsam übernehmen; Capture vor den Tests ausführen.

## Prüfen

```bash
npm run typecheck
npm test -- src/help src/nav.test.ts src/shell/AppShell.test.tsx
npm run test:e2e -- help.spec.ts
npm run build
```

Lokal mit Vite: `/e2e/help.html#/hilfe`. `?state=empty`, `error`, `admin`, `single` prüfen Einstiegssituationen; `?scene=claim` und `rule` öffnen echte Formulare mit Beispieldaten. Tests prüfen Suche, Deep Links, Fokus, Formulargerüst, Bildvergrößerung und mehrere Bildschirmgrößen. Nach Text-/Bildänderungen auch die mobile Lesbarkeit ansehen.

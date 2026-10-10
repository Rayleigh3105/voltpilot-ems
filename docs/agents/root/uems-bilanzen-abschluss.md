# UEMS-Bilanzen-Abschluss (AP-10 IP-18)

AP-10 ist mit dem Bestandsschutz der Historie abgeschlossen. Der fachliche Fix
aus E16 Nr. 5 sitzt am Rand der bestehenden Historienantwort; Messreihen,
Rollups und Exporte werden dafür nicht umgerechnet.

## Historienquote und Rückbau

- `HistoryService.totals` berechnet Autarkie und Eigenverbrauch. Das waren die
  beiden Aufrufer der früheren Werte-Klemme `clampPct`: beide liefern heute den
  ungeklemmten Wert an `HistoryTotalsDto`.
- `HistoryTotalsDto` leitet daraus
  `autarkieUnplausibel`/`eigenverbrauchUnplausibel` ab. Unbekannt bleibt `null`;
  ein Wert außerhalb 0…100 % trägt `true`.
- Das Portal bündelt die Regel in `quoteUnplausibel.ts`. In „Verlauf ›
  Messwerte“ steht dann „Messwerte passen nicht zusammen (… %)“; für eine
  unplausible Quote wird kein geklemmter Balken oder Bogen gezeichnet.
- Rückbau-Schalter:
  `voltpilot.uems.historie.ungeklemmte-quoten-enabled` /
  `VOLTPILOT_UEMS_HISTORIE_UNGEKLEMMTE_QUOTEN_ENABLED`, Vorgabe **AN**. AUS
  stellt nur die alte sichtbare 0-/100-%-Klemme wieder her.
- Die weiteren Funktionen namens `clampPct` gehören nicht zu diesem Lesewert:
  `peakBand.ts` begrenzt Füllung und Zielmarke, `MiniChart.tsx` ausschließlich
  die CSS-Breite eines `MiniShareBar`. Die beschrifteten Werte bleiben dort
  unverändert.

## Summenwert-Wegweiser

Der aus PR 689 hervorgegangene Fluss heißt heute `SummenwertAssistent`. Typen,
Tagesfassungen, Kennzeichen und Rechte stehen im
[Portal-Wegweiser](../portal/summenwert-assistent-und-karte.md). Kundenwort ist
`SUMMENWERT`; `GESAMTWERT` bleibt nur Übergangs-Alias. `copy.test.ts` hält Alias,
Altwörter und die Summenwert-Flächen fest.

## Prüfen

```bash
(cd services/api && ./mvnw clean test -Dtest=HistoryRangeTest,UemsBilanzenBestandsschutzTest)
(cd frontend/portal && npx vitest run src/quoteUnplausibel.test.ts src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/historie-unplausibel.spec.ts --project=desktop-chromium)
bash tools/agents-md-budget.sh
```

`UemsBilanzenBestandsschutzTest` füllt alle sechs Kern-Rollups und nimmt den
Geräte-Export in `decoded` und `raw` auf. Nach beiden Quotenableitungen bleiben
Rollups und Export byte-gleich; Werte innerhalb 0…100 % behalten Zahl und Skala.

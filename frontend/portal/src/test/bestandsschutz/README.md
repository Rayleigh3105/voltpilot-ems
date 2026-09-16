# AP-13 IP-14: Bestandsaufnahmen

Bezugsstand: **84f8307ffbd668cf5dcd0cbb1f4ebfedf84062a3**, 15.09.2026, der Konzeptstand aus AP-13 §8.4
vor dem ersten AP-13-Paket (`7d072aaf`). Die Paketbasis `35e5c54e` enthält bereits IP-1–IP-13 und ist deshalb
kein Aufnahme-Stand. `package.json` und Lockdatei sind zwischen Bezugsstand und Paketbasis identisch.

Die elf HTML-Dateien wurden mit denselben Testfällen und Fixtures auf einem frischen `git archive` des
Bezugsstands erzeugt. Keine Wörter, Zahlen, CSS-Klassen oder Attribute werden aus dem HTML entfernt oder
normalisiert. Feste Uhr und feste Telemetrie-Zeitpunkte gehören zu den Testeingaben, nicht zur Ausgabe.
Die Fixtures stammen aus den vorhandenen Bestands-Komponententests; keine neue Beispiel-Fachrechnung.

| Aufnahme | Testdatei in `src/` |
|---|---|
| Cockpit | `pages/AnlagenPage.test.tsx` |
| Verlauf Messwerte | `pages/HistorieWelten.test.tsx` |
| Verlauf Erlöse | `pages/ErloeseKarten.test.tsx` |
| Verlauf Ladevorgänge | `pages/LadevorgaengeSection.test.tsx` |
| Verlauf Lastspitzen | `pages/LastspitzenSection.test.tsx` |
| Verlauf Marktpreise | `pages/VerlaufChrome.test.tsx` |
| Verlauf Prognosequalität | `pages/PrognoseSchalter.test.tsx` |
| Portfolio Messwerte/Erlöse | `pages/PortfolioWelten.test.tsx` |
| Portfolio Übersicht | `components/PortfolioCockpit.test.tsx` |
| Geräteseite | `pages/GeraetSeiteSection.test.tsx` |

**Nachgezogener main-Bestand an der Geräteseite:** `geraeteseite.html` enthält seit
dem Merge von [PV-Einstieg ohne PV-Aspekt](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/810)
zusätzlich die Karte „PV-Produktion dieses Geräts“. Die Hybrid-Fixture meldet Solarstrom,
hat aber keinen PV-Aspekt. Der ausgelieferte main-Fix zeigt die Karte dann an der Speicher-Entität;
auf dem ursprünglichen UEMS-Bezugsstand fehlte dieser Fix noch. Diese eine Aufnahme wurde auf
`0881ef92` (UEMS) plus `e3f000a2` (main) neu erzeugt. Der Vergleich belegt ausschließlich
die eingefügte PV-Karte; der übrige HTML-Inhalt und die zehn anderen Aufnahmen sind bytegleich
zum ursprünglichen Bezugsstand. Dies ist ein Nachzug ausgelieferten Verhaltens, keine AP-13-Änderung.

`uemsBestandsschutz.test.tsx` ergänzt neun Snapshots: vier O18-Fälle, sechs Verlauf-Reiter in einem Snapshot,
drei Portfolio-Reiter und die `startEbene`-Matrix (64 Eingaben). Die fünf in den Bestands-Tests gestubbten
Canvas-/Diagrammkomponenten schützt zusätzlich `diagramme.json` mit SHA-256 des Bezugsstands.
Damit sind HTML und unveränderte Diagrammquellen geprüft; dies ist keine Pixelaufnahme eines Browsers.

Aus `frontend/portal` gezielt ausführen (auch nach einem Rebase):

```bash
npx vitest run src/uemsBestandsschutz.test.tsx src/pages/AnlagenPage.test.tsx src/pages/HistorieWelten.test.tsx src/pages/ErloeseKarten.test.tsx src/pages/LadevorgaengeSection.test.tsx src/pages/LastspitzenSection.test.tsx src/pages/VerlaufChrome.test.tsx src/pages/PrognoseSchalter.test.tsx src/pages/PortfolioWelten.test.tsx src/pages/GeraetSeiteSection.test.tsx src/components/PortfolioCockpit.test.tsx -t 'AP-13 Bestandsschutz' --maxWorkers=1 --minWorkers=1 --no-cache
```

Zum historischen Vergleich einen **neuen** Archivbaum unter einem ignorierten lokalen Testverzeichnis anlegen,
`frontend/portal` und `docs/contracts/v2` aus dem Bezugsstand auspacken, nur die oben genannten Testdateien,
`uemsBestandsschutz.test.tsx`, den Snapshot-Helfer und diese Aufnahmen hineinkopieren und die unveränderten
Abhängigkeiten verwenden. Mit `--root <Archivbaum>/frontend/portal` denselben Befehl ausführen.
Keinen gemeinsamen Vite-Transform-Cache verwenden (`--no-cache`); keine alten Build-Ergebnisse kopieren.

**Kein `--update` am aktuellen Produktstand.** Eine echte Abweichung ist ein Befund, kein neuer Sollwert.
Der gefundene O18-Bruch (neue Standortnavigation ohne Messfunktion) wird in IP-14 aufgrund des ausdrücklichen
firstmate-Entscheids durch E2/Q2 behoben; die alten leeren Snapshots bleiben unverändert.

Für Änderungen am Wächter: `npx vitest run src/uemsKeineRechnung.test.ts`. Die Ausnahmen sind einzeln geprüft
und dürfen nicht automatisch nachgezogen werden. Neue fachliche Summen, Mittel, Anteile oder Δ gehören
zum Vertrags-Zwilling. Release-Note und fachliche Wegweiser: [Oberflächen-Abschluss](../../../../../docs/agents/root/uems-oberflaechen-ebenen.md).

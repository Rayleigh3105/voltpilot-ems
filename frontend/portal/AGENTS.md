# Portal: Arbeitsregeln

React/Vite/TypeScript. [Bedienmodell](../../docs/portal.md), [Hilfe bearbeiten](src/help/README.md), [Build und Tests](README.md).

## Änderungen prüfen

- `npm run typecheck`, passende Vitest-Fälle und `npm run build` ausführen. Für Interaktion/Layout passende Playwright-Fälle verwenden.
- Eine e2e-Spec, die beim LADEN wirft oder eine Umgebungsvariable braucht, gehört nicht in den Standardsatz: ein Sammelfehler in einer Datei setzt `npx playwright test` auf `0 tests in 0 files` und Exit 1 — der komplette Lauf findet dann nichts mehr. Solche Specs über `testIgnore` in `playwright.config.ts` ausnehmen und nur ihr Werkzeug sie einschalten lassen.
- Bestehende Komponenten und Tokens in `designsystem/` nutzen. `Input` reicht seinen Ref zum nativen Feld durch; Picker und Input teilen den Feldrand.
- `ebenenNav.ts` bestimmt Bereiche und Reiter aus `surface.ts`; `nav.ts` hält stabile Hash-Routen und Legacy-Umleitungen. Keine neuen Seiten ohne Navigationszuordnung.
- Getrennte Portfolioreiter und Anlagenansichten erhalten; CSS für Portfolio-KPIs/Tabellen auf den Portfolio-Kontext begrenzen.
- Geräteansichten adressieren Box-Referenz und Gerätekennung. Queryparameter bei Umleitungen und Rückwegen erhalten.

## Darstellung und Verhalten

- Fehlend ist keine Null. Veraltete Daten nicht als aktuell zeigen; Datenalter, Einheit und Mess-/Planstatus erhalten.
- Portal-Typen folgen der Route: eine nullable Spalte ist im Typ `| null`, nie still nicht-null. Ein Zeichenfehler bleibt in `components/Fehlergrenze.tsx` (steckt in `LazyBoundary` und um die Kennzahl-Reiter) statt das Portal durch die Boot-Karte zu ersetzen.
- Annahme, Geräteantwort und Wirkung eines Befehls nicht gleichsetzen. Erlös-/Ersparnisangaben brauchen den tatsächlichen Datenbezug.
- Wirkliche Abhängigkeiten und Folgen einer Änderung erklären. Kein Formular darf durch unsichtbare Voraussetzungen ohne Ausweg bleiben.
- Gemeinsamen `VpPicker` statt paralleler Auswahlmuster verwenden. Bei ungültigem Submit Fehler zeigen und erstes Feld fokussieren.
- Ein Ort zum Anlegen: Anlagen, VoltPilot-Boxen und Geräte entstehen im Aufbau (`Standort › Aufbau` ist derselbe Baum wie `Anlage › Aufbau`); andere Einstiege führen mit `aufbauHash`/`standortAufbauHash` (`?neu=`) dorthin statt eigene Dialoge zu öffnen. Stammdaten, Geräteverbindung und Betriebsregel nicht vermischen.
- Geräteverwaltung öffnet auf Updates; Registrierung bleibt eigener Reiter. Laufende, Ziel- und neueste Version getrennt bewerten.
- Betriebsmodellwahl und aktive Regeln aus dem tatsächlichen Zustand ableiten. Bedingte Ansichten folgen den verfügbaren Fähigkeiten.

## Mobil und Overlays

- Header und technische Zustandszeilen gemeinsam layouten. Sticky-Höhen nicht mit festen Schätzwerten kompensieren.
- Flex-/Grid-Kinder müssen schrumpfen und Texte umbrechen können; Tabellen scrollen lokal. Unsichtbare Schaltertexte dürfen die Seite nicht verbreitern.
- Dialog: Fokusfalle, Escape, Rückkehr zum Auslöser und Erhalt darunterliegender Formulare testen. Fehler nach einem deaktivierten Submit müssen den Fokus sinnvoll wiederherstellen.
- Überlagerungen teilen EINEN gezählten Scroll-Sperrer und Stapel (`designsystem/components/shell/ueberlagerung.js`): `Modal` und `BottomSheet` über `useUeberlagerung` (Escape nur für die oberste, Fokus-Rückgabe durch die Kette), andere Flächen mindestens über `sperreSeitenScroll()`. Nie `body.style.overflow` je Fläche merken und zurückschreiben - nach Blatt → Blatt oder Blatt → Modal blieb die Seite sonst gesperrt. Tab-Fallen enden mit `fokusFalle` (kein Durchreichen an die äußere Fläche).
- Auf iOS/Safari wird ein angeklickter Button nicht zwingend fokussiert; den Rückkehr-Auslöser ausdrücklich speichern.

## Hilfe und Auth

- Globale Hilfe vor Mandanten-, Fehler- und Onboarding-Sperren rendern. Artikel und Hilfedialog teilen dieselbe Datenquelle.
- Artikel-/Abschnittskennungen sind Lesezeichen. Screenshots nur aus den fiktiven E2E-Fixtures erzeugen; Fixtures nie ins Produktionsbundle importieren.
- Capture zuerst, danach Tests des generierten Screenshot-Indexes. Keine parallelen Schreib-/Leseläufe auf diesen Dateien.
- Auth-Token-Store bleibt tabbezogen. `initAuth` validiert gespeicherte Tokens vor Initialisierung; keycloak-js nicht zweimal initialisieren.
- Anonyme Registrierung darf nicht über einen Request-Wrapper laufen, der Token-Refresh und Login erzwingt.
- Referenznormalisierung mit API/Go-Prüfungen synchron halten; gemeinsame Texte aus `anlageFlow.ts` wiederverwenden.

## Maintaining this file

Historische UI-Implementierungen nicht als aktuelle Architektur dokumentieren. Dauerhafte Regeln hier kurz halten, Fachdetails im [Portal-Dokument](../../docs/portal.md) pflegen. `CLAUDE.md` bindet diese Datei über `@AGENTS.md` ein.

## Regeln des aktuellen Portals

- Aufgabenflächen verwenden das zentrierte `Modal`; keine Seitenleisten wieder einführen. Der Wächter `src/keineSeitenleisten.test.ts` prüft dies.
- UEMS-Zahlenformat (AP-08 E11): nur zur Anzeige runden — kWh je Viertelstunde/Stunde 1 Stelle, Tag/Monat/Jahr 0; kW und m³ 1, Prozent 0. `de-DE`-Tausenderpunkt, geschütztes Leerzeichen vor der Einheit und echtes Minus verwenden; CSV bleibt ungerundet mit Dezimalpunkt und ISO-Zeit. Vertragswerte rechnen ungerundet, Rundungsdifferenzen nie verstecken.
- UEMS-Oberflächen (AP-13): Quelle je Fläche, Zone einmal im Kopf; Bestandsflächen behalten ihre Zahlen. Mengen nur über Vertrags-Zwillinge; Wächter und Orte: [Oberflächen-Abschluss](../../docs/agents/root/uems-oberflaechen-ebenen.md).
- Bezugsgrößen (UEMS AP-09): deutsche Zahleneingaben ausschließlich über `zahl.ts` (`zahlText`, keine lokalen Komma-Parser); Datum plus Uhrzeit und sichtbare Standortzone über `VpZeitpunktPicker`/`picker/zeitpunkt.ts`, mehrdeutige Stunden ausdrücklich wählen und fehlende nie verschieben. Stand und Import-Fallen: [Bezugsgrößen-Abschluss](../../docs/agents/root/uems-bezugsgroessen-abschluss.md).
- Fachableitungen bleiben reine Module; Komponenten rendern ihr Ergebnis. Tokens und `chartTheme()` verwenden, keine zweite Chart-Palette anlegen.
- `VpPicker`, `VpDatePicker` und `VpTimePicker` statt nativer Auswahlfelder verwenden.
- Kundenwörter zuerst im [Fachmodell-Glossar](../../docs/fachmodell/glossar.md) pflegen; Konstanten: `src/glossar.ts`, Textprüfung: `src/copy.test.ts`.
  Die `glossar.md` ist erzeugt: Text in `docs/fachmodell/tools/fachmodell.py` ändern (Zusätze je Begriff in `ABSCHNITTE_NACH`), dann `python3 docs/fachmodell/tools/build_fachmodell.py`; `--check` meldet Handänderungen.
- Ein Summenwert-Assistent für Geräte, Anlage und Kennzahlen: `components/SummenwertAssistent.tsx`; `GesamtwertDialog.tsx` ist nur ein Einstieg. Typen, Tagesfassungen, Kennzeichen und Rechte bleiben in diesem Fluss; Quellen aus dem vollen Registerkatalog, Boxzuordnung über dieselbe Regel wie der Registry-Push. Portal-Wegweiser: [Assistent und Anzeige](../../docs/agents/portal/summenwert-assistent-und-karte.md), Schnittstelle: [H-5/H-6](../../docs/agents/root/uems-summenwert-assistent.md).
- Richtungslose Register (`RegisterZeile.richtungslos`: summierbar, `direction:null`) brauchen die AP-08-Entscheidung „gilt als Erzeugung", sonst lehnt der Server den Term mit 400 ab. Ehrlichkeitsregeln (fix-forward B1/B2): der Precheck (`vorauswahl`) hakt NUR `richtung === 'Erzeugung'` vorab an - richtungslose NIE still; das Aufnehmen über „+ Beobachten" macht kein hakenlos-gezähltes Register, sondern zeigt den Entscheidungs-Schalter; `richtungsloseOhneEntscheidung` sperrt „Speichern" client-seitig mit Grund (nie den 400 provozieren). NICHT jedes `direction:null`-`active_power` ist der Gen-Port: nur der ambivalente Anschluss-Kanal (`istGenPort`, `…generator[-lN]-power`) trägt das Gen-Port-Wording, generische richtungslose Register bekommen die neutrale Erzeugungs-Frage.
- Katalog-Register tragen `quantity`/`direction`/`aggregation_kind`; die Vertrags-Wertart des Formel-Modells (`uemsMessstelle` `GROESSEN_KATALOG.wertarten`) ist deutsch (`Momentanwert`/`Zählerstand`) - NICHT das rohe `gauge`/`counter`. `registerAbbildung.wertartAus` bildet es ab; ein rohes `gauge` als `Quellwert.wertart` erzwingt sonst `groessen_gemischt` und sperrt „Speichern".
- Kennzahlen (UEMS AP-11): die Zahl bildet nur der Server (`KennzahlRegeln`, Summe ÷ Summe, nie ein Mittel) und liefert sie ungerundet; das Portal rundet nur zur Anzeige (Karte zwei, Versionen vier Stellen). `uemsKennzahl.ts` ist sein Zwilling gegen `kennzahl-vectors.json` und trägt Prüfsätze, keine eigene Zahl; die Vorlagen-Kopie `src/kennzahlen/` bleibt byte-gleich (`kennzahlVorlagen.sync.test.ts`). Welt `#/portfolio/kennzahlen`, am Standort `#/standort/{id}/kennzahlen` (AP-13 IP-2); Stand und Lücken: [Kennzahlen-Abschluss](../../docs/agents/root/uems-kennzahlen-abschluss.md).
- Berichte (UEMS AP-12): der Abzug eines Stands IST das Dokument — `berichtSeite.ts` spricht ihn wörtlich (Zahl über `uemsBericht.anzeige`) und ersetzt nie etwas aus lebenden Zeilen; `uemsBericht.ts` ist sein Zwilling gegen `bericht-vectors.json`. PDF/CSV hängen an jedem Stand (`darfAusgabe`: PDF nach dem Lesen, CSV mit `export.*`, die Managementbewertung ohne CSV; Abruf in `BerichtSeite`). Eine Uhr in Nachweisen: Bericht-Routen tragen `abruf`, die Seiten merken den Tag ihrer Route (`routenUhr.ts`, `merkeAbruf`/`merkeAugenblick`), Dialoge lesen `routenHeute()` - nie `new Date()` oder den UTC-Tag eines Zeitstempels. Die Welt `#/portfolio/berichte` (am Standort `#/standort/{id}/berichte`) zeigt die Navigation erst, wenn ein Standort misst (`ebenenNav.ts`); `copy.test.ts` liest JSX-Bedingungen als Text. Stand und Lücken: [Berichte-Abschluss](../../docs/agents/root/uems-berichte-abschluss.md).
- Auswerten (Konzept a1): die Gruppe trägt Verbrauch · Kennzahlen · Bewertung.
  `#/portfolio/verbrauch` liest nur Rangliste und Messabdeckung des gewählten Zeitraums, das Vorjahr als zweiten Abruf; die Monatssäulen kommen aus `herkunft.nenner.bilanzwerte` (Hauptzähler je Anlage und Monat), Ableitungen in `verbrauch.ts` und `einsatzSeite.ts`.
  Der laufende Monat hat noch keine Monatsmengen (Rangliste leer), darum endet die Zeitleiste am letzten vollen Monat.
  Die Seite eines Energieeinsatzes wohnt unter `…/verbrauch/{id}`; `#/portfolio/bewertung/{id}` leitet mit Parametern weiter (`canonicalVerbrauchHash`).
  Ihre Kriterien gelten für die Datengrundlage der Bewertung, ihr Verbrauch für den letzten vollen Monat (in der Demo zwei Uhren).
  Summen je Monat, Rest-Anteil und Δ bilden nur die Zwillinge (`uemsBewertung.nenner`/`menge`/`prozent`, `uemsBericht.vergleich`; `verbrauch.ts`, `einsatzSeite.ts` und `bewertungErgebnis.ts` stehen im Q5-Wächter); ein Vorjahresvergleich nur zwischen vollständigen Seiten (Ersatz zählt), sonst „Vorjahr unvollständig“; nicht belastbare/anwendbare Kriterien nie als „nicht erfüllt“.
- Bewegungsregeln: `src/motionPresets.ts` und [Bewegung](../../docs/agents/portal/bewegung.md). `prefers-reduced-motion` zentral beachten.
- Browserprüfung bei 1440 und 375 Pixeln: kein horizontaler Überlauf, keine überstehenden Elemente oder Konsolenfehler. Weitere Regeln gezielt über den [Themenindex](../../docs/agents/README.md) suchen.

## Themen-Index (der ausgelagerte Bestand)

Der [gemeinsame Themenindex](../../docs/agents/README.md) erschließt die Detailregeln unter `docs/agents/`. Neue dauerhafte Details am zuständigen Thema ergänzen und dort verlinken; dieser Wegweiser bleibt kurz.

# Portal: Arbeitsregeln

React/Vite/TypeScript. [Bedienmodell](../../docs/portal.md), [Hilfe bearbeiten](src/help/README.md), [Build und Tests](README.md).

## Änderungen prüfen

- `npm run typecheck`, passende Vitest-Fälle und `npm run build` ausführen. Für Interaktion/Layout passende Playwright-Fälle verwenden.
- Bestehende Komponenten und Tokens in `designsystem/` nutzen. `Input` reicht seinen Ref zum nativen Feld durch; Picker und Input teilen den Feldrand.
- `anlageNav.ts` bestimmt Bereiche und Reiter aus `surface.ts`; `nav.ts` hält stabile Hash-Routen und Legacy-Umleitungen. Keine neuen Seiten ohne Navigationszuordnung.
- Getrennte Portfolioreiter und Anlagenansichten erhalten; CSS für Portfolio-KPIs/Tabellen auf den Portfolio-Kontext begrenzen.
- Geräteansichten adressieren Box-Referenz und Gerätekennung. Queryparameter bei Umleitungen und Rückwegen erhalten.

## Darstellung und Verhalten

- Fehlend ist keine Null. Veraltete Daten nicht als aktuell zeigen; Datenalter, Einheit und Mess-/Planstatus erhalten.
- Annahme, Geräteantwort und Wirkung eines Befehls nicht gleichsetzen. Erlös-/Ersparnisangaben brauchen den tatsächlichen Datenbezug.
- Wirkliche Abhängigkeiten und Folgen einer Änderung erklären. Kein Formular darf durch unsichtbare Voraussetzungen ohne Ausweg bleiben.
- Gemeinsamen `VpPicker` statt paralleler Auswahlmuster verwenden. Bei ungültigem Submit Fehler zeigen und erstes Feld fokussieren.
- Ein primärer Geräte-Anlegeweg; Stammdaten, Geräteverbindung und Betriebsregel nicht miteinander vermischen.
- Geräteverwaltung öffnet auf Updates; Registrierung bleibt eigener Reiter. Laufende, Ziel- und neueste Version getrennt bewerten.
- Betriebsmodellwahl und aktive Regeln aus dem tatsächlichen Zustand ableiten. Bedingte Ansichten folgen den verfügbaren Fähigkeiten.

## Mobil und Overlays

- Header und technische Zustandszeilen gemeinsam layouten. Sticky-Höhen nicht mit festen Schätzwerten kompensieren.
- Flex-/Grid-Kinder müssen schrumpfen und Texte umbrechen können; Tabellen scrollen lokal. Unsichtbare Schaltertexte dürfen die Seite nicht verbreitern.
- Dialog: Fokusfalle, Escape, Rückkehr zum Auslöser und Erhalt darunterliegender Formulare testen. Fehler nach einem deaktivierten Submit müssen den Fokus sinnvoll wiederherstellen.
- Auf iOS/Safari wird ein angeklickter Button nicht zwingend fokussiert; den Rückkehr-Auslöser ausdrücklich speichern.

## Hilfe und Auth

- Globale Hilfe vor Mandanten-, Fehler- und Onboarding-Sperren rendern. Artikel und Hilfedialog teilen dieselbe Datenquelle.
- Artikel-/Abschnittskennungen sind Lesezeichen. Screenshots nur aus den fiktiven E2E-Fixtures erzeugen; Fixtures nie ins Produktionsbundle importieren.
- Capture zuerst, danach Tests des generierten Screenshot-Indexes. Keine parallelen Schreib-/Leseläufe auf diesen Dateien.
- Auth-Token-Store bleibt tabbezogen. `initAuth` validiert gespeicherte Tokens vor Initialisierung; keycloak-js nicht zweimal initialisieren.
- Anonyme Registrierung darf nicht über einen Request-Wrapper laufen, der Token-Refresh und Login erzwingt.
- Referenznormalisierung mit API/Go-Prüfungen synchron halten; gemeinsame Texte aus `anlageFlow.ts` wiederverwenden.

## Maintaining this file

Historische UI-Implementierungen nicht als aktuelle Architektur dokumentieren. Dauerhafte Regeln hier kurz halten, Fachdetails im [Portal-Dokument](../../docs/portal.md) pflegen. `CLAUDE.md` bleibt ein Symlink.

## Regeln des aktuellen Portals

- Aufgabenflächen verwenden das zentrierte `Modal`; keine Seitenleisten wieder einführen. Der Wächter `src/keineSeitenleisten.test.ts` prüft dies.
- Fachableitungen bleiben reine Module; Komponenten rendern ihr Ergebnis. Tokens und `chartTheme()` verwenden, keine zweite Chart-Palette anlegen.
- `VpPicker`, `VpDatePicker` und `VpTimePicker` statt nativer Auswahlfelder verwenden.
- Kundenwörter zuerst im [Fachmodell-Glossar](../../docs/fachmodell/glossar.md) pflegen; Konstanten: `src/glossar.ts`, Textprüfung: `src/copy.test.ts`.
- Ein Summenwert-Assistent für Geräte und Anlage: `components/SummenwertAssistent.tsx`; `GesamtwertDialog.tsx` ist nur ein Einstieg. Quellen aus dem vollen Registerkatalog, Boxzuordnung über dieselbe Regel wie der Registry-Push. Schnittstelle und Prüfungen: [H-5/H-6](../../docs/agents/root/uems-summenwert-assistent.md).
- Richtungslose Register (`RegisterZeile.richtungslos`: summierbar, `direction:null`) brauchen die AP-08-Entscheidung „gilt als Erzeugung", sonst lehnt der Server den Term mit 400 ab. Ehrlichkeitsregeln (fix-forward B1/B2): der Precheck (`vorauswahl`) hakt NUR `richtung === 'Erzeugung'` vorab an - richtungslose NIE still; das Aufnehmen über „+ Beobachten" macht kein hakenlos-gezähltes Register, sondern zeigt den Entscheidungs-Schalter; `richtungsloseOhneEntscheidung` sperrt „Speichern" client-seitig mit Grund (nie den 400 provozieren). NICHT jedes `direction:null`-`active_power` ist der Gen-Port: nur der ambivalente Anschluss-Kanal (`istGenPort`, `…generator[-lN]-power`) trägt das Gen-Port-Wording, generische richtungslose Register bekommen die neutrale Erzeugungs-Frage.
- Katalog-Register tragen `quantity`/`direction`/`aggregation_kind`; die Vertrags-Wertart des Formel-Modells (`uemsMessstelle` `GROESSEN_KATALOG.wertarten`) ist deutsch (`Momentanwert`/`Zählerstand`) - NICHT das rohe `gauge`/`counter`. `registerAbbildung.wertartAus` bildet es ab; ein rohes `gauge` als `Quellwert.wertart` erzwingt sonst `groessen_gemischt` und sperrt „Speichern".
- Bewegungsregeln: `src/motionPresets.ts` und [Bewegung](../../docs/agents/portal/bewegung.md). `prefers-reduced-motion` zentral beachten.
- Browserprüfung bei 1440 und 375 Pixeln: kein horizontaler Überlauf, keine überstehenden Elemente oder Konsolenfehler. Weitere Regeln gezielt über den [Themenindex](../../docs/agents/README.md) suchen.

## Themen-Index (der ausgelagerte Bestand)

Der [gemeinsame Themenindex](../../docs/agents/README.md) erschließt die Detailregeln unter `docs/agents/`. Neue dauerhafte Details am zuständigen Thema ergänzen und dort verlinken; dieser Wegweiser bleibt kurz.

# Meldungstext (Kunden-Alarmierung P1)

Was eine Meldung sagt – in Mail, Push, Team-Kanal, Telegram und im Portal derselbe Wortlaut.

## Quelle

- Vorlagen: `services/api/src/main/resources/wertekatalog/katalog.json`
  - `meldung_allgemein`: Rahmen (Titel „{ort}: {titel}“, Push-Titel, Links, Erinnerung, Ersatz-Orte) und die
    Vorlagen der **eigenen Überwachung** je Bedingungsart.
  - je Eintrag `meldung`: eine **feste Meldungsart** (Box meldet sich nicht, Gerät liefert keine Daten,
    Wallbox, Ladeziel, Auto angesteckt/fertig, Strom gerade günstig, Lastspitze droht, sechs Erzeuger-Vorlagen).
    Sie gilt, wenn der Zustand beim Auslösen in `gilt_bei.zustaende` steht oder die Regel die
    `gilt_bei.herkunft` hat (Preis und Lastspitze nur ab Werk); sonst gilt die eigene Überwachung.
  - je Eintrag `zustandsworte`: Kundenwort je Zustand bzw. Ereignis.
- Portal-Zwilling: `frontend/portal/src/meldungsTexte.ts` (Drift-Wächter `meldungsTexte.sync.test.ts`).
- Renderer: `MeldungsText.java` (Server: Mail, Push, Team-Kanal, Telegram, Erinnerung, Tages-Zusammenfassung)
  und `meldungsText.ts` (Portal).
- Vektoren: [`meldungs-text-vectors.json`](meldungs-text-vectors.json), geprüft von `MeldungsTextVektorTest`
  und `meldungsText.vectors.test.ts`.

## Eingabe

Das Feld `text` jeder Meldung aus `GET /api/v1/meldungen` ist genau die Eingabe des Renderers:
`wertart`, `herkunft`, `regelName`, `schwere`, `bezugArt`, `ort` (Name des Bezugs oder `null`), `bedingung`
der Regel, `wert` beim Auslösen (`zahl`+`einheit` oder `zustand`, dazu `satz` des Lesers), `beginn`, `ende`.

- `beginn` = Auslösezeit − `dauer_s`, `ende` = „wieder normal“ − `erholen_s` (Vorgabe 300 s). Server und
  Portal rechnen gleich; genau bis auf einen Takt des Läufers (15 s).
- `ende` ist `null`, solange die Meldung offen ist oder wenn sie anders endete; dann gibt es keine Entwarnung.

## Regeln

- Ein Feld ist ein Text oder eine Liste von Alternativen; es gilt die erste, deren Platzhalter alle belegt sind.
  Passt keine, entfällt der Satz – nie ein leerer oder halber Satz.
- Keine internen Schlüssel, keine Rohwerte, keine ISO-Zeit. Zeiten in Europe/Berlin: „12:18 Uhr“,
  „gestern, 23:50 Uhr“, „10.11., 9:05 Uhr“, mit Jahr wenn anders.
- Zahlen: Euro zwei Stellen, Prozent keine, kWh ab 100 keine, sonst eine; Tausenderpunkt, echtes Minus,
  geschütztes Leerzeichen vor der Einheit.
- Dauer auf die Minute gerundet („42 Minuten“, „eine Stunde und 5 Minuten“).
- Externe Empfänger bekommen nur den Namen der Regel oder Wertart, keine Schwelle und keinen Messwert
  (Entscheid 11B).
- Links der Mail: `#/meldungen?meldung=<Kennzeichen>` und `#/einstellungen`; ein Push öffnet
  `#/meldungen?meldung=<Kennung>` (ein Bündel die Liste).

Ändern: erst `katalog.json`, dann den Zwilling; neue Fälle in die Vektoren mit beiden Renderern.

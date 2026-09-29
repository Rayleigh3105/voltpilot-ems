# Preise und Wetter am Telefon (Konzeptentwurf)

**Status: Entwurf vom 29.09.2026, Fassung 2 (interaktiv), noch nicht abgenommen.** Der klickbare Prototyp liegt daneben: [prototyp.html](prototyp.html). Die Datei im Browser öffnen; sie funktioniert ohne Server. Alle Zahlen darin sind erfunden. Die Anlage „Sonnenhof“ stammt aus den fiktiven Test-Fixtures.

## Zweck

Die Reiter „Preise“ und „Wetter“ im Fahrplan (ohne Speicher: im Verlauf) sollen am Telefon auf den ersten Blick verständlich sein. Vorgaben aus dem Auftrag vom 29.09.2026:

- Telefon zuerst, danach der Rechner.
- Nach fünf Sekunden versteht der Kunde, was die Seite zeigt.
- Intuitiv, ruhig und seriös.
- Nur diese zwei Seiten.

Jede Seite beantwortet oben eine Frage und ist zugleich ein Werkzeug für „Wann?“:

- **Preise:** Was kostet Strom jetzt, und wann startet ein Gerät am günstigsten?
- **Wetter:** Wie viel Sonne bekommt die Anlage heute und in den nächsten Tagen, und wann am meisten?

### Fassungen

- **Fassung 1 (verworfen am 29.09.2026):** Preise als ruhige Linie mit zwei benannten Fenstern, Preisleiter und drei Kennzahlen-Zeilen; Wetter mit Himmel und Temperatur als Kopf, Tagesbild und Tagesliste. Rückmeldung: Die Börsenpreis-Seite gefiel nicht, beide Seiten sollten interaktiver sein.
- **Fassung 2 (dieser Stand):** Die große Zahl folgt dem Finger, die Preise als Balken in drei Stufen, ein Rechner „Wann starten?“ bzw. „Wann ist am meisten Sonne?“, ein Schalter „Börse“/„Ihr Preis“, wischbare Tageskarten und antippbare Stunden beim Wetter.

## Befunde heute

Aufgenommen bei 375 × 812 Pixeln mit den fiktiven Fixtures (`e2e/verlauf.html`, 10.09.2026, 12:00 Uhr). Die Bilder liegen in `quelle/bilder/heute-*.jpg`. Die Fixtures enthalten fürs Wetter nur einen Tag; im Betrieb reicht die Kurve bis zu drei Tage.

| Thema | Heute | Im Konzept |
|---|---|---|
| Preise: erster Blick | Zeitraum (Tag, Woche, Monat, Jahr), Blättern und „Heute“ stehen vor der Antwort. | Oben steht die Antwort. Der Rückblick zieht in eine eigene Zeile weiter unten. |
| Preise: Kernsatz | `preisKern` rechnet über den ganzen Tag. Um 12:00 Uhr nennt er „05:45 bis 08:00 Uhr“, das Fenster ist vorbei. | Der Satz schaut nur nach vorn: das nächste Fenster heute, sonst morgen, sonst wann die Preise für morgen kommen. |
| Preise: Jetzt | `PriceHistoryChart` hat keine Jetzt-Marke. Vergangenes sieht aus wie Kommendes. | Jetzt-Linie mit Punkt, Vergangenes grau, Kommendes blau. |
| Preise: Urteil | „Normal“ nach festen Schwellen (`GUENSTIG_CT` 5, `TEUER_CT` 15). Am Testtag liegen alle Preise zwischen 3 und 10 ct, „teuer“ kommt nie vor. | Urteil im Vergleich zum Tag, sichtbar auf einer Preisleiter (E2). |
| Preise: Wörter | „Day-Ahead heute & morgen · DE-LU“, „15 min“, „Profi-Detail“. | Kundensprache oben, Fachbegriffe und EUR/MWh in der Erklärung. |
| Preise: Zahlen | Fünf Zeilen, zwei sagen fast dasselbe („die günstigsten 2½ Stunden“ und „Günstigste Zeit“). | Drei Zeilen: am günstigsten, am teuersten, Durchschnitt. Vergangene Fenster tragen „vorbei“. |
| Preise: Folge | Nur der Verweis „Ihr Fahrplan nutzt genau diese Preise“. | Unter der Kurve steht, wann der Speicher laut Plan lädt und abgibt (E5). |
| Wetter: erster Blick | Die große Zahl ist „8,0 kW“. Himmel und Temperatur stehen klein darunter. | Himmel und Temperatur zuerst, in Wort und Symbol, darunter ein Satz zum Sonnenstrom. |
| Wetter: Tage | `WeatherChart` zeigt die ganze Vorhersage in einem Bild, bis zu drei Tage auf gut 300 Pixeln. Die kW-Linie endet, wo der Fahrplan endet. Einen Überblick je Tag gibt es nicht. | Heute und morgen je als eigenes Bild, drei Tage als Liste. |
| Wetter: Messung | Die Kurve zeigt nur die Prognose. | Bis jetzt gemessen und gefüllt, danach erwartet und schraffiert, wie im Cockpit. |
| Wetter: Achse | Erste Beschriftung abgeschnitten („o, 00 Uhr“), lange Beschriftungen, Stunden ohne Sonne nehmen etwa die Hälfte der Breite ein. | Nur die Stunden mit Sonne, kurz beschriftet. |
| Wetter: doppelt | Am Testtag nennen die große Zahl und „Spitze heute“ denselben Wert (8,0 kW). „Vorhersagehorizont“ ist eine Systemangabe. | Jede Angabe steht einmal. |
| Wetter: ohne Prognose | W/m² als große Zahl und `OHNE_FAHRPLAN_SATZ`. | Himmel und Temperatur bleiben gleich. Die Kurve zeigt die Sonneneinstrahlung, ein kurzer Hinweis nennt den Grund. |
| Wetter: Wörter | „bedeckt“ in den Himmelsblöcken (`wetterLeistung.ts`), „bewölkt“ im Morgen-Ausblick (`weather.ts`). | Ein Wortsatz: sonnig, wechselnd, bewölkt. |

Seitenhöhe bei 375 Pixeln: Preise heute 1.629 px, im Prototyp 1.391 px (mit Rechner); Wetter heute 1.234 px, im Prototyp 1.382 px (dafür drei Tage, Rechner und Stunden).

## Die Idee (Fassung 2)

Beide Seiten haben dieselbe Bedienung:

1. **Der Moment oben folgt dem Finger.** Zuerst zeigt er jetzt. Wischen über das Bild, eine Stunde antippen oder die Pfeiltasten wählen eine andere Viertelstunde; die Auswahl bleibt nach dem Loslassen stehen, „Jetzt“ springt zurück. Mit der Maus zeigt Überfahren eine Vorschau, Klicken setzt die Auswahl. Das Telefon gibt beim Wechsel der Stunde einen kurzen Impuls, wo es das kann.
2. **Das Tagesbild** mit Jetzt-Linie, Vergangenes blass, Heute/Morgen als Umschalter.
3. **Ein Rechner „Wann?“:** Dauer antippen (1 bis 4 Stunden), das beste Zeitfenster erscheint als Klammer im Bild und als Zahl. Ohne Auswahl bleibt das Bild ruhig.
4. **Wege und Erklärung** am Ende.

### Preise

- **Moment:** „Börsenpreis · jetzt 10:30–10:45“, der Preis groß, daneben günstig, mittel oder teuer im Vergleich zum Tag. Darunter der Satz nach vorn („Am günstigsten wird es heute 12:00–14:30 Uhr.“, leise „Teuer wird es 18:00–20:30 Uhr.“) und Ihr Preis. Beim Wischen: „14:15–14:30 · in 3 Std 35 Min“, Preis, Urteil und was der Speicher laut Plan in dieser Viertelstunde tut. Für morgen ohne Auswahl: der Tagesdurchschnitt und die Fenster des Tages.
- **Balken je Viertelstunde** in drei Stufen: grün günstig, grau mittel, rot teuer, jeweils Drittel des Tages; Negativpreise in Petrol als „unter null“. Unter 5 ct/kWh Tagesspanne gibt es keine Stufen. Die Balken wachsen beim Wechsel von Tag oder Preisart kurz auf, bei reduzierter Bewegung nicht.
- **Schalter „Börse“/„Ihr Preis“:** dieselben Balken als Endpreis aus dem Fahrplan (`importPriceCtKwh`). Die jeweils andere Zahl steht unter dem Moment („Davon Börse: −4,1 ct/kWh …“). Bei Negativpreisen heißt das Urteil dann „Börse unter null“.
- **Plan-Streifen** unter den Balken: Speicher lädt, gibt ab, laut Plan. Nur mit Speicher.
- **Wann starten?** Günstigster zusammenhängender Block der gewählten Dauer unter den bekannten kommenden Viertelstunden, heute ab jetzt und morgen, sobald veröffentlicht. Ergebnis für 3 Stunden um 10:40 Uhr: „Start heute 11:45 Uhr, fertig 14:45 Uhr · Ø 2,1 ct/kWh“, dazu „1,1 ct/kWh weniger als bei Start jetzt“ oder „Später wird es für diese Dauer nicht günstiger.“ Liegt das Fenster morgen, wechselt das Bild auf morgen. „In den Balken zeigen“ setzt den Moment auf den Start.
- **Kennzahlen** als eine Zeile unter dem Bild (Ø, günstigste, teuerste). Rückblick und Erklärung wie in Fassung 1.

### Wetter

- **Tageskarten** für heute, morgen und übermorgen: Symbol, Himmel als Wort, Temperaturspanne, Sonnenstrom (heute gemessen plus erwartet, morgen erwartet, übermorgen „Prognose folgt“). Am Telefon zum Wischen, die gewählte Karte ist umrandet; ab 560 Pixeln stehen alle drei nebeneinander. Die Karte wählt den Tag für alles darunter.
- **Satz zum Tag:** „Am meisten Sonnenstrom heute gegen 13 Uhr, bis 6,5 kW.“ Ist die stärkste Sonne vorbei, nennt er die kWh bis zum Abend.
- **Moment in der Karte:** „Jetzt · 10:40“, Symbol, „17 °C · sonnig“, „4,9 kW Sonnenstrom · erwartet“. Beim Wischen oder Antippen einer Stunde die gewählte Viertelstunde, gemessen oder erwartet.
- **Tagesbild:** Himmel als benannte Blöcke, Leistung gemessen (gefüllt) und erwartet (schraffiert), Spitze mit Wert. Übermorgen und ohne Prognose zeigt es die Sonneneinstrahlung in W/m² mit Hinweis.
- **Wann ist am meisten Sonne?** Das Zeitfenster der gewählten Dauer mit der höchsten erwarteten Erzeugung, heute ab jetzt und morgen. Dabei steht: „Erwartete Erzeugung der Anlage. Haus und Speicher brauchen einen Teil davon.“
- **Stunde für Stunde:** antippbar, wählt die Stunde im Bild.

### Am Rechner

Ab 820 Pixeln Inhaltsbreite stehen Moment und Tagesbild links, Rechner und Angaben rechts. Es ist dieselbe Seite, umgeschaltet per Container-Abfrage.

## Regeln im Bild

- Nie ein vergangenes Fenster als Rat. Der Satz oben und beide Rechner schauen nur nach vorn; vergangene Viertelstunden sind blass und heißen „vorbei“.
- Rechnen, nicht planen: „Wann starten?“ nutzt nur feststehende Preise und schaltet nichts. Die Ersparnis steht in ct/kWh, nicht in Euro, weil der Verbrauch des Geräts unbekannt ist.
- Erzeugung ist kein Überschuss: „Wann ist am meisten Sonne?“ sagt das dazu.
- Unbekannt ist keine Null: „—“ mit Grund, und fehlt der Folgetag, steht, wann er kommt.
- Gemessen gefüllt, erwartet schraffiert, geplant mit „laut Plan“.
- Börsenpreis und Ihr Preis getrennt; Ihr Preis wird gelesen, nie aus Tariffeldern gerechnet.
- Ein Urteil braucht eine Spanne: unter 5 ct/kWh Tagesspanne kein günstig oder teuer und keine Fenster (`MIN_SPANNE_CT`).
- Keine zweite Erzeugungsprognose: kW nur aus der gespeicherten PV-Prognose, nie aus Bewölkung und kWp.
- Farbe nie allein: Balkenfarben mit Legende, das Urteil des gewählten Balkens als Wort. Vor der Umsetzung die drei Stufen mit dem Dataviz-Validator prüfen (Rot/Grün bei Farbsehschwäche).
- Die Einheit steht am Wert: ct/kWh, kW, kWh, °C.

## Daten

| Angabe | Quelle | Stand |
|---|---|---|
| Börsenpreis je Viertelstunde | `/price-history?range=day` (energy-charts.info, Fraunhofer ISE) | vorhanden |
| Ihr Preis jetzt | `/schedule` → `importPriceCtKwh` | vorhanden |
| Speicher laut Plan | `/schedule` → `batteryKw`, `slotRole` | vorhanden |
| Rückblick | `/price-history?range=week|month|year` | vorhanden |
| Himmel und Temperatur | `/weather` (Open-Meteo, drei Tage, stündlich) | vorhanden |
| PV gemessen heute | `/history?range=day` | vorhanden, neu auf dieser Seite |
| PV erwartet | heute nur `/schedule` → `pvKw`; gespeichert in `forecast` (`kind = 'pv'`, 15 Minuten, bis 48 h, `FORECAST_HORIZON_HOURS`) | neuer Lese-Endpunkt (E4) |

## Umsetzung in Schritten

1. **Ableitungen:** Stufen im Tagesvergleich, Satz nach vorn, „Wann starten?“ und „Wann ist am meisten Sonne?“ als reine Module mit Tests (etwa `marktpreise.ts`, neu `startfenster.ts`). `preisFenster.ts` bleibt die Grammatik für den Satz und das Cockpit.
2. **Preise, Moment und Balken:** Balken je Viertelstunde mit Stufen, Jetzt, Auswahl per Wischen, Maus und Tasten (`PriceHistoryChart.tsx` oder eigenes SVG), Moment oben, Schalter „Börse“/„Ihr Preis“, Plan-Streifen aus `/schedule`.
3. **Preise, Rechner und Rückblick:** Karte „Wann starten?“, Rückblick als Blatt (`BottomSheet`) bzw. Modal am Rechner. Adressen mit `z=`/`at=` bleiben gültig.
4. **Wetter:** Tageskarten mit Wischen, Moment, Tagesbild mit gemessen und erwartet (`/history?range=day`), Rechner, antippbare Stunden (`WetterSection`, `wetterKarte.ts`, `WeatherChart.tsx`). Ein Wortsatz für den Himmel in `weather.ts` und `wetterLeistung.ts`.
5. **PV-Prognose (E4):** Lese-Endpunkt auf `forecast` für das aktive PV-Modell der Anlage, jüngster Lauf, mandantengetrennt wie die übrigen `/sites`-Routen. Zu prüfen, ob Anlagen ohne Speicher dort Werte haben.
6. **Prüfen:** 375 und 1440 Pixel im Layout-Wächter, Wischen und Tasten, reduzierte Bewegung, Haptik nur über `haptik.ts`. Hilfe-Aufnahmen `marktpreise` und `wetter` neu erzeugen (`e2e/help-captures.mjs`), neue Kundenwörter ins Glossar.

## Offene Entscheidungen

Der Prototyp zeigt jeweils Option A.

- **E1 · Was der Schalter zuerst zeigt.** A: Börse, Ihr Preis als Zeile darunter und einen Tipp entfernt. B: Ihr Preis (ohne Fahrplan gibt es ihn nicht, dann fällt der Schalter weg).
- **E2 · Wie die Kurve günstig und teuer zeigt.** A: Balken in drei Stufen im Tagesvergleich (Fassung 2). Weicht von der heutigen Regel ab, die nur zwei benannte Fenster auf einer Linie erlaubt (`preisFenster.ts`, kein Ampel-Verlauf). B: Linie mit zwei Fenstern wie Fassung 1 und heute.
- **E3 · Ort des Rückblicks.** A: eigene Ansicht über die Zeile „Rückblick“. B: Zeitleiste oben wie heute; die Antwort rutscht um etwa 140 Pixel nach unten.
- **E4 · Quelle der erwarteten Leistung.** A: neuer Lese-Endpunkt auf `forecast` (bis 48 h, morgen auch am Vormittag). B: weiter nur über den Fahrplan; morgen erscheint erst, wenn der Plan so weit reicht, ohne Speicher gibt es keine Leistung.
- **E5 · Speicher-Plan unter den Balken.** A: ja, nur mit Speicher. B: nein, nur der Verweis zum Fahrplan.
- **E6 · Womit der Rechner nach der Dauer fragt.** A: 1 bis 4 Stunden. B: Gerätevorlagen (Waschmaschine, Spülmaschine, Trockner, Auto).

## Prototyp neu bauen

Der Prototyp ist eine einzelne HTML-Datei. Er bettet die Portal-Schriften (Plus Jakarta Sans, Inter) aus `frontend/portal/designsystem/assets` und die Vergleichsbilder aus `quelle/bilder` ein. Die Quellen liegen in `quelle/`: `style.css`, `body.html`, `daten.js` für die Beispieldaten und `app.js` für Ableitungen und Darstellung.

```bash
python3 docs/konzepte/preise-und-wetter/build.py
```

Das Skript schreibt `prototyp.html` neu. Mit `#nur-preise` oder `#nur-wetter` hinter der Adresse zeigt der Prototyp nur die Seite in voller Breite; daraus stammen `quelle/bilder/neu-*.jpg`. Zur Besprechung mit Lavish: `npx -y lavish-axi docs/konzepte/preise-und-wetter/prototyp.html`. Der Prototyp ist kein Teil des Portal-Bundles.

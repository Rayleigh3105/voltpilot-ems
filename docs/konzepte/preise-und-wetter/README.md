# Preise und Wetter am Telefon (Konzeptentwurf)

**Status: Entwurf vom 29.09.2026, noch nicht abgenommen.** Der klickbare Prototyp liegt daneben: [prototyp.html](prototyp.html). Die Datei im Browser öffnen; sie funktioniert ohne Server. Alle Zahlen darin sind erfunden. Die Anlage „Sonnenhof“ stammt aus den fiktiven Test-Fixtures.

## Zweck

Die Reiter „Preise“ und „Wetter“ im Fahrplan (ohne Speicher: im Verlauf) sollen am Telefon auf den ersten Blick verständlich sein. Vorgaben aus dem Auftrag vom 29.09.2026:

- Telefon zuerst, danach der Rechner.
- Nach fünf Sekunden versteht der Kunde, was die Seite zeigt.
- Intuitiv, ruhig und seriös.
- Nur diese zwei Seiten.

Jede Seite beantwortet oben eine Frage, bevor sie etwas zum Bedienen anbietet:

- **Preise:** Was kostet Strom jetzt, und wann wird er günstig?
- **Wetter:** Wie viel Sonne bekommt die Anlage heute und in den nächsten Tagen?

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

Seitenhöhe bei 375 Pixeln: Preise heute 1.629 px, im Prototyp 1.285 px; Wetter heute 1.234 px, im Prototyp 1.356 px (dafür drei Tage und Stunden statt nur heute).

## Die Idee

Beide Seiten folgen derselben Reihenfolge. Sie ist die Aussage:

1. **Antwort auf der Fläche**, nicht in einer Karte: eine Zahl oder ein Wort, dazu ein Satz.
2. **Tagesbild** mit Jetzt, Heute/Morgen als Umschalter direkt darüber.
3. **Zeilen zum Nachschlagen**, jede Angabe einmal.
4. **Wege und Erklärung** am Ende.

### Preise

- **Kopf:** „Börsenstrompreis · jetzt 10:30–10:45“, der Preis groß in ct/kWh, daneben das Urteil (günstig, mittel, teuer, unter null, gleichmäßig). Darunter die Preisleiter: günstigster und teuerster Preis des Tages mit einem Punkt für jetzt.
- **Satz nach vorn:** höchstens zwei Sätze. Der erste nennt, was jetzt gilt oder als Nächstes kommt, der zweite das Gegenstück („Teuer wird es heute 18:00–20:30 Uhr.“ und „Morgen am günstigsten: 11:45–14:15 Uhr.“). Vor der Veröffentlichung heißt es „Die Preise für morgen kommen gegen 13 Uhr.“
- **Ihr Preis:** „Ihr Preis jetzt: 24,2 ct/kWh mit Netzentgelt, Abgaben und Steuern“. Gelesen aus `importPriceCtKwh`, ohne Fahrplan entfällt die Zeile.
- **Kurve:** Treppe je Viertelstunde (der Preis gilt die ganze Viertelstunde), Vergangenes grau, Kommendes blau, Jetzt als Linie mit Punkt. Die Fenster aus `preisFenster.ts` tragen ihr Wort über dem Bild („günstig“, „teuer“, „unter null“), vergangene Fenster leiser. Die Nulllinie wird nur betont, wenn es darunter geht.
- **Wischen:** Über der Kurve steht die gewählte Viertelstunde mit Preis und Plan („13:15–13:30 Uhr · 1,42 ct/kWh · Speicher lädt“). Am Rechner Pfeiltasten, mit Umschalt eine Stunde. Kein Zoom durch Ziehen (E7 vom 03.09.2026 bleibt).
- **Plan-Streifen:** unter der Kurve, auf derselben Zeitachse: Speicher lädt (grün), gibt ab (dunkelrot), laut Plan. Nur mit Speicher.
- **Zeilen:** am günstigsten (bzw. unter null), am teuersten, Durchschnitt. Am Rechner als eigene Karte „Heute in Zahlen“ rechts.
- **Rückblick:** eine Zeile öffnet Woche, Monat und Jahr als Blatt, mit Tages- bzw. Monatsmitteln und dem günstigsten und teuersten Tag. Adressen mit `z=` und `at=` öffnen ihn direkt.
- **Erklärung:** „Was ist der Börsenstrompreis?“ mit Day-Ahead, Gebotszone DE-LU, Viertelstunde, Veröffentlichung gegen 13 Uhr, Ihr Preis, Regel für günstig und teuer, EUR/MWh-Werte und Quelle.

### Wetter

- **Kopf:** „Wetter heute · Di. 29.09.“, Symbol und Wort („Sonnig“) groß, darunter die Temperaturspanne. Der Tag bekommt sein Wort aus dem Mittel der Bewölkung von 6 bis 21 Uhr (dieselbe Regel wie `weatherWhyTomorrow`).
- **Satz:** „Sonnenstrom heute: ≈ 46 kWh, am meisten 11:45–14:15 Uhr.“ und leise „Morgen wechselnd, ≈ 39 kWh.“ Die kWh sind gemessen bis jetzt plus erwartet danach. Ohne Prognose: „Die Sonne ist heute am stärksten 11:45–14:15 Uhr.“
- **Tagesbild:** Himmel als benannte Blöcke über dem Bild (sonnig, wechselnd, bewölkt; Blöcke unter zwei Stunden gehen im Nachbarn auf). Darunter die Leistung in kW: gemessen gefüllt, erwartet schraffiert und gestrichelt, Jetzt als Linie, die Spitze mit Wert, „am stärksten“ als Fenster derselben Länge wie bei den Preisen. Nur die Stunden mit Sonne und eine Stunde davor und danach.
- **Die nächsten Tage:** heute, morgen, übermorgen mit Symbol, Wort, Temperatur und Sonnenstrom. Wo die Prognose nicht hinreicht: „— Prognose folgt“.
- **Stunde für Stunde:** waagrecht wischbar, ab jetzt zwölf Stunden: Symbol, Temperatur, erwartete Leistung.
- **Erklärung:** Quellen (Open-Meteo, PV-Prognose, Messwerte) und die Regel für den Himmel.

### Am Rechner

Ab 820 Pixeln Inhaltsbreite stehen Antwort und Tagesbild links, die Angaben zum Nachschlagen rechts. Es ist dieselbe Seite, umgeschaltet per Container-Abfrage.

## Regeln im Bild

- Nie ein vergangenes Fenster als Rat. Vergangene Fenster stehen in den Zeilen mit „vorbei“.
- Unbekannt ist keine Null: „—“ mit Grund, und fehlt der Folgetag, steht, wann er kommt.
- Gemessen gefüllt, erwartet schraffiert, geplant mit „laut Plan“.
- Börsenpreis und Ihr Preis getrennt; Ihr Preis wird gelesen, nie aus Tariffeldern gerechnet.
- Ein Urteil braucht eine Spanne: unter 5 ct/kWh Tagesspanne kein günstig oder teuer und keine Fenster (`MIN_SPANNE_CT`).
- Keine zweite Erzeugungsprognose: kW nur aus der gespeicherten PV-Prognose, nie aus Bewölkung und kWp.
- Farbe nie allein: jedes Fenster, jede Fläche und jedes Urteil trägt ein Wort.
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

1. **Preise, Kopf:** Urteil im Tagesvergleich und „nächstes Fenster“ als reine Ableitungen in `marktpreise.ts`, mit Tests. `preisFenster.ts` bleibt die eine Fenster-Grammatik für Seite und Cockpit. Kein Backend.
2. **Preise, Kurve:** Treppe, Jetzt-Linie, Vergangenes grau, Wischen mit Anzeige, Pfeiltasten (`PriceHistoryChart.tsx`).
3. **Preise, Plan und Ihr Preis:** Plan-Streifen aus `/schedule`, nur mit Speicher. Ihr Preis wie heute.
4. **Preise, Rückblick:** Woche, Monat, Jahr als Blatt (`BottomSheet`) bzw. Modal am Rechner. Adressen mit `z=`/`at=` bleiben gültig.
5. **Wetter, Seite:** Kopf, Tagesbild mit gemessen und erwartet, nächste Tage, Stunden (`WetterSection`, `wetterKarte.ts`, `WeatherChart.tsx`). Ein Wortsatz für den Himmel in `weather.ts` und `wetterLeistung.ts`.
6. **Wetter, PV-Prognose (E4):** Lese-Endpunkt auf `forecast` für das aktive PV-Modell der Anlage, jüngster Lauf, mandantengetrennt wie die übrigen `/sites`-Routen. Zu prüfen, ob Anlagen ohne Speicher dort Werte haben.
7. **Prüfen:** 375 und 1440 Pixel im Layout-Wächter, Tastatur, reduzierte Bewegung. Hilfe-Aufnahmen `marktpreise` und `wetter` neu erzeugen (`e2e/help-captures.mjs`), neue Kundenwörter ins Glossar.

## Offene Entscheidungen

Der Prototyp zeigt jeweils Option A.

- **E1 · Große Zahl auf der Preisseite.** A: Börsenpreis, Ihr Preis als Zeile darunter. B: Ihr Preis groß (fehlt ohne Fahrplan).
- **E2 · Maßstab für günstig und teuer.** A: im Vergleich zum Tag (unteres und oberes Drittel, Negativpreise immer „unter null“). B: feste Schwellen wie heute (5 und 15 ct/kWh).
- **E3 · Ort des Rückblicks.** A: eigene Ansicht über die Zeile „Rückblick“. B: Zeitleiste oben wie heute; die Antwort rutscht um etwa 140 Pixel nach unten.
- **E4 · Quelle der erwarteten Leistung.** A: neuer Lese-Endpunkt auf `forecast` (bis 48 h, morgen auch am Vormittag). B: weiter nur über den Fahrplan; morgen erscheint erst, wenn der Plan so weit reicht, ohne Speicher gibt es keine Leistung.
- **E5 · Speicher-Plan unter der Preiskurve.** A: ja, nur mit Speicher. B: nein, nur der Verweis zum Fahrplan.

## Prototyp neu bauen

Der Prototyp ist eine einzelne HTML-Datei. Er bettet die Portal-Schriften (Plus Jakarta Sans, Inter) aus `frontend/portal/designsystem/assets` und die Vergleichsbilder aus `quelle/bilder` ein. Die Quellen liegen in `quelle/`: `style.css`, `body.html`, `daten.js` für die Beispieldaten und `app.js` für Ableitungen und Darstellung.

```bash
python3 docs/konzepte/preise-und-wetter/build.py
```

Das Skript schreibt `prototyp.html` neu. Mit `#nur-preise` oder `#nur-wetter` hinter der Adresse zeigt der Prototyp nur die Seite in voller Breite; daraus stammen `quelle/bilder/neu-*.jpg`. Zur Besprechung mit Lavish: `npx -y lavish-axi docs/konzepte/preise-und-wetter/prototyp.html`. Der Prototyp ist kein Teil des Portal-Bundles.

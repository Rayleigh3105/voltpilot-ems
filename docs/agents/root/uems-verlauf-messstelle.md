# UEMS-Fläche: der Verlauf einer Messstelle mit Lücken und Markern (AP-13 IP-4 = AP-08 IP-10)

Neu am 15.09.2026. Reines Portal: keine Route, keine Migration, keine Vertragsdatei. Spezifikation:
`data/vp-uems-ap13-oberflaechen/report.md` §4.6 (V1–V7), Kasten E5, §8 IP-4; die Diagramm-Regeln sind AP-08 §5
(K1–K11), die Auflösung W3 macht aus zwei Paketen eines. Meilenstein 2 des Konzepts: auf EINER Fläche erkennt der
Kunde, was gemessen wurde, welchen Zeitraum er betrachtet und warum eine Zahl fehlt oder eingeschränkt ist.

| Teil | Datei (`frontend/portal/…`) |
|---|---|
| Ableitung (rein): Zeit-Leiste, Anfragen je Zeitraum, Schritte, Lücken, Marker, Kernaussage, Tooltip, Schritt-Karte, Bild-Geometrie | `src/uemsVerlauf.ts` · `uemsVerlauf.test.ts` (F8/F13 gegen `verbrauch-vectors.json`, der Marker-Satz gegen `events-vocabulary-vectors.json`) |
| Darstellung (eigenes SVG, `data-von` · `data-zustand` je Schritt) | `src/components/MessstellenVerlauf.tsx` (+ `.css`) · `MessstellenVerlauf.test.tsx` |
| Wirt: Zeit-Leiste Tag · Woche · Monat · Jahr, Verlauf unter der Karte | `src/components/WerteSektion.tsx` · `WerteSektion.test.tsx`; Adresse `periode=JJJJ-MM-TT · JJJJ-Www · JJJJ-MM · JJJJ` über `uemsWerteKarte.periodeAus` |
| Wörter | `src/glossar.ts` (`UEMS_ZEITRAEUME`, `UEMS_KEINE_WERTE_*`, `UEMS_EREIGNIS_*`, `UEMS_ERHALTEN`, `UEMS_WOCHE_OHNE_ZAHL`, `UEMS_VERLAUF_WAHL`) |
| Wächter | `copy.test.ts` `CHART_FILES_OBERFLAECHEN` (Messstellen-Verlauf UND Kennzahl-Balken) · `messstellenVerlaufKontrast.test.ts` · `verlaufMobil.test.ts` (Tippflächen) |
| Antworten (nur Ahrenberg) und Browser | `src/test/werteKarteFixtures.ts` (`f8Viertelstunden`, `f13Viertelstunden`, `grundlastWoche`, `jahr2026` …) · `e2e/messstelle-seite.spec.ts` (O1, O14, E5) · `e2e/tageskarte.spec.ts` (der Dialog fragt jetzt auch Viertelstunden) |

## Die Fallen

1. **Die Woche hat keine Karte.** Die Route kennt kein Wochen-Raster, und summiert wird nie: in der Woche stehen der
   Verlauf in Stunden und die Tage als Liste, der Kopf sagt `UEMS_WOCHE_OHNE_ZAHL`. Keine Wochensumme „der Übersicht
   halber“ nachrüsten — das wäre eine neue Rechenregel.
2. **Im Monat und im Jahr IST der Verlauf die Liste** (`gleicheAnfrage`) — EINE Anfrage. Am Tag (Viertelstunden) und in
   der Woche (Stunden) fragt der Verlauf selbst; scheitert er, bleiben Karte und Liste stehen („Der Verlauf konnte nicht
   geladen werden.“). ⚠ Ein Mock nach Raster (`MessstelleSeite.test.tsx`, Bühnen) wird jetzt auch mit `viertelstunde`
   gefragt — eine unbekannte Antwort ist ein Fehler, nie eine leere Zeichnung.
3. **Nur `data_gap` spricht seinen Standard-Satz** aus `{von, bis}` der Route. Jede andere Art (Zählerwechsel, Übergabe,
   Box-Tausch …) bräuchte Felder, die die Werte-Route nicht liefert — dort steht der Name der Art mit ihrer Zeit
   (`markerSatz`), nie `undefined` und nie ein geratenes Feld. Die Lücke nennt am Beginn das Datum („Lücke von
   03.11.2026 14:00 bis 17:31 — nie als 0 gerechnet“): so spricht das Vokabular, O1 schrieb die Uhrzeit allein.
4. **Schraffur heißt „keine Werte“ — wörtlich V4.** Auch ein Schritt mit Grund `keine_quelle` trägt diesen Zustand
   (die Route setzt ihn), darum zeigt das Jahr 2026 vor der Einführung „keine Werte von Januar 2026 bis September 2026“.
   Ein Schritt „unvollständig“ ohne Menge (F8 14:00–14:15) hat KEINEN Balken und KEINE Schraffur; ein nicht gesprochener
   Schritt (Grund ohne Zustand) weder Balken noch Fläche noch Wort im Bild.
5. **Farbe UND Wort, und die Farben trennen auch bei Rot-Grün-Schwäche:** vollständig = `--vp-chart-load-line`,
   unvollständig = `--vp-warn-ink`, mit Ersatzwert = blaue Schraffur, keine Werte = graue Schraffur über die volle Höhe.
   Das Grün des Abzeichens „vollständig“ gegen Bernstein fiel im dataviz-Prüfer durch (ΔE 5,8) — nicht „aus Symmetrie“
   zurück auf Grün. Die Legende nennt nur die Zustände im Bild.
6. **Eigenes SVG, keine ECharts-Leinwand:** jeder Schritt ist ein Ziel über die volle Höhe mit `data-von` und
   `data-zustand`; Playwright klickt `[data-von="…"]`. Die Breite ist die gemessene (`useContainerWidth`, K11).
7. **Die letzte Viertelstunde heißt „23:45–00:00“** (Vertrag `uemsErgebnis.raster`), die Stunden der Woche nennen ihren
   Tag („So 25.10. 02:00–03:00 MEZ“).
8. **Die Karte des gewählten Schritts ist eine `WerteKarte` mit `testId="verlauf-schritt-karte"`** — `werte-karte` bleibt
   die der Periode und eindeutig. Sie spricht über `uemsWerteKarte.karte` (Herkunft, Fassung, Lückenzahl, Grund) und
   hängt „14 von 15 Werten“ an das Verlauf-Abzeichen.
9. **Kernaussage (K1/V6):** abgeleitet aus der Karte der Periode („Di 03.11.2026: 2.304 kWh · vollständig · vorläufig“).
   Ohne Zahl hat nur `noch_nicht_gebildet` einen Grund; jeder andere Grund lässt den Kopf leer, bis IP-6 die Grund-Sätze
   an die Karte bringt.

## Offen (Befunde)

- Die Zusätze des Lücken-Satzes („Zuwachs 337,6 kWh“, „nachgeliefert am …“) erscheinen erst, wenn eine Ereignis-Route
  die Felder liefert (Befund AP-07, V5). Die Werte-Route liefert nur `{id, art, von, bis}`.
- AP-08 §8 IP-10 nennt „Hebel“ an den Markern (Links auf AP-08 IP-16) und den Chip „nachgeliefert“ — ohne Ziel und ohne
  Feld nicht gebaut.
- O1 schreibt „unvollständig (14 von 15)“; die Karte sagt „unvollständig (Menge aus Zählerständen)“ (Vertrag 1.6) und
  „Verlauf 93 % · 14 von 15 Werten“.
- Nebengrößen (V8), Vergleich (IP-5), Grund- und Ablehnungssätze (IP-6) folgen.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/uemsVerlauf.test.ts src/components/MessstellenVerlauf.test.tsx \
  src/components/WerteSektion.test.tsx src/uemsWerteKarte.test.ts src/pages/MessstelleSeite.test.tsx src/copy.test.ts \
  src/messstellenVerlaufKontrast.test.ts src/verlaufMobil.test.ts)
(cd frontend/portal && MESSSTELLE_SEITE_BILDER=/tmp/mss npx playwright test e2e/messstelle-seite.spec.ts \
  e2e/tageskarte.spec.ts --project=mobile-chromium --project=desktop-chromium)
```

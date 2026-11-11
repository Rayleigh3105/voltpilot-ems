# Preise und Wetter (Fassung 3): Antwort zuerst, feste Jetzt-Linie

Umsetzung des Konzepts „Preise und Wetter", Fassung 3 (Entscheide E1–E8 = A vom 20.10.2026,
firstmate `data/vp-preise-wetter-konzept-f3`). Vorgänger: [Fassung 2](../../konzepte/preise-und-wetter/README.md),
nie umgesetzt. Seitdem gilt für die Reiter Preise und Wetter:

- **Drei Regeln für beide Reiter:** oben die Antwort für jetzt (keine Bedienung davor), ein Bild mit
  dunkler Jetzt-Linie und Marke (Vergangenes blass), unten Zeilen, die Blätter öffnen (`Modal blatt`).
- **Bedienung wie Cockpit-Entscheid b1:** der Finger tippt (Wischen > 10 px wählt nichts), nur die Maus
  zieht; ‹ › gehen je 15 Minuten, „Jetzt" und Escape führen zurück; kein Hinweissatz.
- **Preise:** `pages/PreisSeite.tsx`, Bausteine `components/PreisZeitstrahl.tsx`, Regeln rein in
  `preisZeitstrahl.ts`. Das Bild beginnt am Telefon 2 Std vor jetzt (E1), ab 721 px heute 0 Uhr; drei
  Stufen je ein Drittel der KOMMENDEN Preise (E2, Tokens `--vp-chart-preis-*`, CVD 11,0), unter null eigene
  Stufe; unter `MIN_SPANNE_CT` keine Stufen und keine Fenster, die Antwort nennt dann die Spanne als Zahl.
  Die Kacheln „Am günstigsten/teuersten" sind 2-Std-Fenster nur ab jetzt, immer mit Tag. Speicher-Streifen
  aus `/schedule` `batteryKw` (positiv lädt). Rückblick Tag/Woche/Monat/Jahr im Blatt (E3); die Adresse
  trägt `z=`/`at=` nur, solange es offen ist, und `z=woche|monat|jahr` oder ein vergangener Tag öffnet es.
  `preisFenster.ts` bleibt die Grammatik der Linie (Cockpit-Streifen, Rückblick-Kurve).
- **Wetter:** `pages/WetterSeite.tsx`, `components/WetterTag.tsx`, Regeln in `wetterTag.ts`. Wetter zuerst
  (E5): Symbol, °C, ein Wortsatz (sonnig · wechselnd · bewölkt, nachts klar · bewölkt; Schwellen 40/65 aus
  `weather.ts`), dann Sonnenstrom jetzt (letzte ABGESCHLOSSENE gemessene Viertelstunde, höchstens 20 min alt)
  und heute (gemessen + erwartet, nur wenn die Prognose ≥ 90 % der hellen Viertelstunden deckt). Drei
  Tageskarten steuern das Bild; ohne Prognose Sonnenstärke und Sonnenstunden (DNI > 120 W/m²) mit Grund.
  Die Vorhersage wird auf volle Stunden gemittelt. `WeatherChart`, `wetterKarte`, `wetterLeistung` sind gelöscht.
- **Prüfen:** `preisZeitstrahl.test.ts`, `wetterTag.test.ts`, `pages/PreisSeite.test.tsx`,
  `pages/WetterSeite.test.tsx`; im Browser `e2e/preise.spec.ts` und `e2e/wetter.spec.ts` mit den Fixtures
  `e2e/preise.html?fall=normal|negativ|flach|leer` und `e2e/wetter.html?fall=normal|ohne` (Uhr über
  `page.clock`). Hilfe-Aufnahmen `marktpreise` (Uhr 05:00, damit die Beispielreihe Stufen hat) und `wetter`.
- **Offen (E6, E8):** ein Lesepunkt für die gespeicherte PV-Prognose (`forecast`, bis 48 h, auch ohne
  Speicher) statt `schedule.pvKw`, und Niederschlag (Open-Meteo `precipitation`, heute nicht abgefragt).

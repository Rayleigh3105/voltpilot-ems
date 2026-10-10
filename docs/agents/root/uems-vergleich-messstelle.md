# UEMS-Fläche: der Vergleich einer Messstelle (AP-13 IP-5, E6 = A, VG1–VG5)

Der Vergleich ist die zweite Hälfte des Verlaufs (`uems-verlauf-messstelle.md`): aus einer Reihe wird eine Einordnung.
**Gerechnet wird nichts in AP-13** — die Differenz und der Prozentsatz kommen aus dem Zwilling `uemsBericht.vergleich`
(AP-12 IP-3, Regeln Q5/DA1), die Gründe aus dessen Vokabular `grund_ohne_vergleich`.

- Reines Modul `frontend/portal/src/uemsVergleich.ts`, Render `components/WerteVergleich.tsx`, Abruf-Cache
  `src/uemsWerteCache.ts` (stale-while-revalidate, 60 s, 32 Einträge). Wirt ist die `WerteSektion` (IP-3).
- **Zwei Formen, nie beide im Bild (VG1).** (a) Umschalter `aus · Vorperiode · Vorjahr`, Adresse `v=`: dieselbe
  Messstelle in ihrer eigenen Vergangenheit, blass im SELBEN Schlitz hinter der eigenen Reihe. (b) „Weitere
  Messstelle“ (`VpPicker`): bis `VERGLEICH_HOECHSTENS` = 3 Reihen nebeneinander, dann trägt die Farbe die REIHE.
- **Die Δ-Zeile steht direkt unter der Karte** (O11): `+260 kWh (+4,3 %) gegenüber Oktober 2026 · korrigiert
  (Version 2)`. Der Zusatz nennt den Zustand der Basis, wenn er nicht „vollständig“ ist, und die Fassung des
  Vergleichswerts über `uemsErgebnis.korrigiert` — Version 1 ist nie „korrigiert“ und steht gar nicht da.
- **Ohne Vergleichswert steht der Grund, nie eine 0** (VG2, VG5): `November 2025: keine Werte — vor Beginn`.
- **Zwischen zwei Messstellen gibt es kein Δ** (VG4). Der Umschalter setzt statt dessen die Δ-Zeile JEDER Reihe gegen
  IHRE eigene Vorperiode — genau so nennt O11 MS-12 und MS-10 nebeneinander.

## Die Fallen

1. **„Passend“ liest das REGISTER, nicht die Werte-Route.** `reihenOptionen(basis, zeilen, schon)` bekommt die
   `hauptgroesse` der Registerzeile; `schon` sind KENNZEICHEN, keine Kennungen. Grund: die Fixtures der Werte-Route
   schreiben `richtung: 'bezug'`, das Register `'Bezug'` — und die Kennung der Messstelle ist in beiden Quellen nicht
   dieselbe. Eine Seite ohne Register (der `WerteDialog` an den Gesamtwert-Karten) zeigt den Vergleich gar nicht.
2. **Das Δ rechnet in der GESPEICHERTEN Einheit.** `uemsBericht.vergleich` bekommt die Beträge der Route und die
   ANZEIGE-Einheit (sonst wirft `zahl()` bei `Wh`/`MWh`); seine eigene Schreibweise `anzeige_differenz` wird NICHT
   gelesen — die Zahl spricht `uemsErgebnis.menge` (E11). Der Prozentsatz ist maßstabsfrei und kommt unverändert.
3. **Die Woche hat keine Zahl** (die Route kennt kein Wochen-Raster) — also auch kein Δ; der Satz sagt es.
   Im **Jahr** fallen „Vorperiode“ und „Vorjahr“ zusammen: der Umschalter bietet dort nur `aus · Vorjahr`.
4. **`v=` kommt ROH aus der Adresse.** `nav.parseMessstelleWerte` liest den Text, `uemsVergleich.wahlAus(v, zeitraum)`
   entscheidet, ob ihn dieser Zeitraum anbietet — sonst „aus“. „aus“ steht nie im Hash. Ein Zeitraum-Wechsel behält
   `v=` (die Version nicht).
5. **Die Skala umfasst ALLE Reihen** (`uemsVerlauf.bild(…, weitere, gruppiert)`). Die Balken tragen `reihe`; ohne
   Gruppierung liegt die Vergleichsreihe im selben Schlitz und wird VOR der eigenen gezeichnet (sonst verdeckt die
   Vergangenheit die Gegenwart). Schritte jenseits der eigenen Reihe (ein längerer Vormonat) fallen weg.
6. **Farbe ist nie der einzige Kanal.** Mit mehreren Messstellen ersetzt die Reihen-Legende (mit NAMEN) die
   Zustands-Legende, und jede Reihe hat unten ihre eigene Karte. Die drei Töne stehen in `MessstellenVerlauf.css`
   (`--vp-mv-reihe-eigen|zwei|drei`) und werden in `messstellenVerlaufKontrast.test.ts` nachgerechnet.

## Offen (Befunde)

- **Der Beginn des Energiemanagements fehlt in jeder Route, die diese Fläche liest.** O11 schreibt „vor Beginn
  (Energiemanagement seit 01.10.2026)“; das Portal kennt nur die Bindungen der Messstelle aus dem Register und sagt
  deshalb „vor Beginn“ ohne Datum. `uemsVergleich.grundSatz(grund, emsSeit)` nimmt das Datum, sobald eine Route es
  nennt (Kennzeichen `vor_beginn` des Bericht-Vertrags). Befund an AP-02/AP-12.
- **Wortlaut:** O11 schreibt „(Version 2, korrigiert)“; gebaut ist das Kennzeichen des Ergebnis-Vertrags
  „korrigiert (Version 2)“ — ein geschlossenes Vokabular wird nicht für eine Fläche umformuliert.
- **VG3 „unvollständig → mindestens“** ist an der Δ-ZEILE nicht gebaut: eine unvollständige Basis macht den
  Unterschied nicht zu einer Untergrenze (er wäre eine OBERgrenze), sondern trägt ihr Zustandswort. Die Regel gilt
  weiter für den WERT — dort spricht sie die Karte.
- Die Wege „Reihe als Kennzahl anlegen“ und ein Export der zwei Reihen gibt es nicht; beides hat keine Route.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/uemsVergleich.test.ts src/components/WerteVergleich.test.tsx \
  src/components/WerteSektion.test.tsx src/uemsVerlauf.test.ts src/nav.test.ts src/copy.test.ts \
  src/messstellenVerlaufKontrast.test.ts src/verlaufMobil.test.ts)
(cd frontend/portal && MESSSTELLE_SEITE_BILDER=/tmp/mss npx playwright test e2e/messstelle-seite.spec.ts \
  --project=mobile-chromium --project=desktop-chromium)
```

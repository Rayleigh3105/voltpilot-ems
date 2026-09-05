# Erlöse „Neu modern" (Variante C) · P7 — die ABNAHME, und was sie gelehrt hat

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 40).


Der Browser-Beweis über den gemergten Gesamtstand (P0–P6), gemessen in echtem
Chrome bei 1440/768/375 aus ZWEI Quellen: den Beweis-Harnessen UND der laufenden
App gegen den lokalen Stack. Das vollständige Protokoll steht im PR-Rumpf; hier
nur, was jede spätere Messung braucht.

- **⚠ DIE HARNESS ALLEIN BEWEIST ES NICHT — fünf von acht Befunden waren NUR in
  der laufenden App zu sehen.** Die Fixtures tragen alle ein POSITIVES Netto
  (also nie einen roten Betrag auf der Muted-Summenzeile), rendern die
  Diagramm-Karten nicht und die Ereignis-Spur nicht. Wer eine C-Fläche misst,
  misst sie an einer echten Anlage mit — Direktvermarktung UND feste Vergütung,
  weil die zwei verschiedene Zustände zeigen.
- **⚠ Die Rechteck-Messung von `measure.js` SIEHT KEINE `::after`-Overlays** und
  meldet damit weder eine echte noch eine scheinbare Trefferfläche richtig. Die
  44 px gegenprüfen heißt `elementFromPoint(±21 px)` in alle vier Richtungen —
  und dabei die IDENTITÄT prüfen: trifft man einen GLEICHNAMIGEN Nachbarn, ist
  das kein Treffer, sondern eine Overlay-Kollision (genau so gefunden: die
  Legenden-Chips überlappten ihre Overlays um 9 px und waren nur 35 px tief
  antippbar). **Ein Overlay ist eine Zusage über ZWEI Zahlen — seine eigene
  Größe und den Abstand zum Nachbarn.**
- **⚠ `measure.js` zählt `vp-sr-only` mit** (1×1 px, `overflow: hidden`, aber
  nicht `display: none`) — der Welt-Kopf erscheint als 32-px-Schriftgröße, die
  niemand sieht. Vor jeder Zählung abziehen.
- **⚠ Ein Kontrast-Paar gilt nur für den Grund, gegen den es geprüft wurde.**
  `--vp-c-destructive` war mit „4,8:1 auf Weiss" dokumentiert und stand in der
  SUMMENZEILE auf `--vp-c-muted` — dort 4,18:1. Der Token ist seither **#B91C1C**
  (6,5 auf Weiss, 5,6 auf Muted), und die Paar-Tabelle in
  `erloeseKontrast.test.ts` trägt das fehlende Paar. **Wer einen Token auf einer
  zweiten Fläche verwendet, trägt das Paar dort nach.**
- **⚠ Der Beweis-Harness NAGELT seit P7 auch die Skala fest** (`SKALA_BUDGET` +
  `inventur()` in `e2e/erloese-proof.tsx`): jede Fixture stempelt `data-skala` /
  `data-skala-ueber` neben ihre Wortzahl. Es steht dort und nicht in einem
  Unit-Test, weil die Werte aus kaskadiertem CSS entstehen, das jsdom nicht
  rechnet.
- **⚠ Der 12-px-Boden ist eine Zahl, die man SUCHEN muss** — vier Schriften lagen
  bei 0,70/0,72/0,74/0,76 rem knapp darunter, jede in einer anderen Datei. Eine
  neue `font-size` unter `0.75rem` auf einer Kunden-Fläche ist ein Befund.
- **⚠ Eine Größe unmittelbar NEBEN einer Stufe der Skala ist eine eigene Stufe.**
  0,92 rem (14,7) neben 14 und 0,76 rem (12,2) neben 12 waren die zwei, mit denen
  die Seite bei 375 auf acht statt sechs Schriftgrößen kam. Auf 0,875 bzw.
  0,75 rem gefaltet sieht das niemand — gezählt wird es sehr wohl.
- **⚠ `flex-wrap: nowrap` + `min-width: auto` ist die 768-px-Falle.** Ein
  Flex-Kind schrumpft NICHT unter seine min-content-Breite, solange niemand
  `min-width: 0` setzt — bei 1440 fällt das nie auf, bei 375 gilt die
  Mobil-Fassung, und dazwischen schiebt das letzte Element über die Fläche
  (hier 35..45 px). **768 px ist die Breite, an der eine einzeilige Leiste
  bricht** — sie gehört in jede Messung.
- **Gemessen (nach den acht Fixes):** Ergebnis-Fläche an allen drei Breiten und
  in beiden Quellen **4 Schriftgrößen · 4 Textfarben (+ Warnton) · 1 Fläche ·
  ≤ 3 Chips · min 12 px · Kontrast 5,17 · 0 Verstöße · 0 Trefferflächen < 44 ·
  0 px Überlauf**; Cockpit-Karte 4/4/1/2; Portfolio 4/5/1/2..3; Chrome 58 px
  klebend (1440/768) bzw. 108 px nicht klebend (375) in allen vier Welten;
  0 Konsolenmeldungen.
- **Offen gemeldet, nicht behoben:** die ganze Erlöse-Seite trägt bei 1440/768
  acht statt sechs Schriftgrößen — die zwei Überzähligen (`.vp-note` /
  `.vp-chart-more-was` 0,85 rem, `.vp-ereignis-legendeitem` 0,76 rem) sitzen in
  den Karten *Der Tag im Bild* und *Ereignis-Spur*, die P1–P6 nie ins C-Kleid
  gehoben haben; `.vp-note` allein steht in 48 Dateien. Bei Woche/Monat/Jahr
  rendern diese Karten nicht und die Seite misst sechs.


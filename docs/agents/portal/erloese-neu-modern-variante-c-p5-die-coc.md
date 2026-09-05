# Erlöse „Neu modern" (Variante C) · P5 — die COCKPIT-Erlöskarte

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 38).


Captain-Entscheide 03.09.2026 auf `data/vp-erloese-lesbar-konzept-u3`: **E2 = (b)** (die
Leseprinzipien gelten auch für die Cockpit-Karte), **E11 = (a)** (das Widget „Erlöse" entfällt),
**E9** („Netto überall").

- **EIN Bauteil für zwei Breiten:** `components/erloese/CockpitErgebnis.tsx` (Label · Zahl ·
  Zeitraum-Segment · DIESELBE `SpeicherKarte` wie die Erlöse-Seite · die zwei Ringe). Telefon
  (`MobileMoneyCard`) und Bühne (`CockpitHero`, Block `.vp-hero-money`) rendern es beide — die
  frühere DREI-Blöcke-Leiste („Bilanz"-Kopfzeile + Geld + Ringe) und die Ring-CHIPS des Telefons
  sind ERSATZLOS entfallen (eine Kennzahl in zwei Formen war Befund B7).
- **⚠ `HeroMoney` trägt seit P5 `kosten` + `speicher`** (die volle `SpeicherAussage`, nicht nur die
  Kurzform `attribution`) — abgeleitet in `cockpitHero()`, damit Cockpit und Erlöse-Seite über
  dieselbe Stunde nie Verschiedenes behaupten. `attribution` BLEIBT für Flächen mit nur einer Zeile
  (Sticky-Kopf, Portfolio).
- **⚠ Die Cockpit-Karte trägt WEDER Satz NOCH Provenienz-Chip** — `Statement`s `satz`/`provenienz`
  sind dafür optional geworden. Beides ist eine MESS-Entscheidung: der Mockup `rvC-375-cockpit.png`
  hat keines von beidem, und ein drittes Chip sprengte das 2-Chip-Budget (§2 Prinzip 5). Die
  Einordnung bleibt weg, solange `cockpitHero()` keinen Gleiche-Stunde-Vergleich liefert.
- **⚠ Die Speicher-Sektion läuft als `variant="sektion"`** (kein eigener Rahmen, keine eigene
  Fläche) — eine Karte in der Karte war Befund B2.
- **⚠ Das Haus-Segment `.vp-seg` bringt in eine gemessene C-Fläche VIER Verstöße mit:** eine fünfte
  Schriftgröße (0,78 rem), eine zweite Fläche (`--vp-bg-light`), zwei weitere Textfarben und einen
  Schatten — und sein aktiver Knopf fiel mit **3,28:1** durch. `.vp-c-ck-seg` überschreibt das mit
  den C-Token; **die Doppelklasse `.vp-seg.vp-seg-compact button` ist nötig**, weil
  `CockpitBlocks.css` mit (0,3,1) sonst gewinnt.
- **Der Widget-Katalog kennt `erloes` weiter, PRODUZIERT ihn aber nicht mehr** (`cockpitWidgets.ts`:
  der `case 'erloes-komposition'` ist entfallen, `widgetTarget('erloes')` bleibt gepflegt). Der
  BLOCK bleibt — er trägt Nav-Eintrag und Lead-Slot der Erlöse-Welt —, also hinterlässt eine
  gespeicherte `cockpit_layout`-Schicht keine Lücke. Wächter: `cockpitWidgets.test.ts` („E11 …").
- **Beweis-Harness:** `e2e/cockpit-erloes.html` (Fixture `dv-tag-laufend`, beide Breiten).
  Gemessen 375 / 1440: **4 Schriftgrößen** (36 bzw. 48 / 16 / 14 / 12) · **4 Textfarben** ·
  **1 Fläche** · **2 Chips** · Kontrast **5,17** · 0 Trefferflächen < 44 · 0 px Überlauf.
  **⚠ 39 Wörter statt der 32 des Auftrags — und der Soll-Mockup selbst misst mit derselben
  `measure.js` 37** (plus 5 Farben und 2 Flächen); die zwei Wörter Differenz sind der vom Auftrag
  verlangte Chip „stur − 4,12 €", den der Mockup weglässt.
- **⚠ `chrome-devtools-axi resize` ist ein NO-OP, wenn die Zielgröße schon gesetzt scheint,** und
  klemmt auf die Fenster-Mindestbreite (gemessen 500 px). Für 375 immer `emulate --viewport
  "375x812x2,mobile,touch"` nehmen und `innerWidth` NACHLESEN, bevor gemessen wird.


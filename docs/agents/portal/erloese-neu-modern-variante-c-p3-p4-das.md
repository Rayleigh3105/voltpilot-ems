# Erlöse „Neu modern" (Variante C) · P3+P4 — das CHROME der Welt-Seiten

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 37).


Captain-Entscheide 03.09.2026 auf `data/vp-erloese-lesbar-konzept-u3` (E3 · E9 · E10 · E12).
Die Erlöse-Seite ist der **Pilot fürs ganze Portal**: `WeltKopf`, `ZeitLeiste` und `KartenKopf`
sind GETEILTE Bauteile, also ändern sie die **Messwerte-** und die **Portfolio-Welt** mit — das
ist gewollt, kein Nebeneffekt.

- **Der Welt-Kopf ist eine unsichtbare Überschrift** (`vp-sr-only`), keine Karte. Sie bleibt, weil
  die Schale nur den Pfad trägt und die Seite sonst gar keine Überschrift hätte; sie kostet 0 px.
  In der Portfolio-Welt reist der Kontext-Satz („2 Anlagen · Juli 2026") darin mit.
  `PortfolioWeltKopf` ist der Zwilling — **beide zusammen ändern**.
- **Die Zeit-Leiste ist EINE Zeile, 58 px, klebend** am Schreibtisch; am Telefon zwei Zeilen,
  108 px, **nicht klebend** (`.vp-zeitleiste-mobil`, aus `useIsPhone()`). Monatsstreifen,
  „Vergleichen", Datenlage und — am Telefon — das Sprungfeld wohnen hinter dem ⋯-Knopf
  (`ZeitPopover`, aus `HistorieWelt.tsx`, von der Portfolio-Welt mitbenutzt).
- **⚠ `position: sticky` MUSS in `.vp-zeitleiste:not(.vp-zeitleiste-mobil)` wiederholt werden.**
  Der Selektor ist spezifischer als die Basisregel; ein `relative` dort (der naheliegende Anker
  fürs ⋯-Panel) nimmt der Leiste ihr Kleben, und das fällt in KEINEM Unit-Test auf. `sticky` ist
  selbst ein Bezugsrahmen für absolut positionierte Kinder — das Panel braucht keinen zweiten.
- **⚠ Die 58 px sind eine RECHNUNG, kein Wunsch:** 6 + 44 (Bedienelement) + 6 + 2 (Rahmen). Wer ein
  Element in die Leiste stellt, nagelt es auf 44 fest — die Haus-Segment-Schiene (`.vp-seg`,
  3 px Polster + 1 px Rahmen) und der Picker-Auslöser (frei 46 px) taten es nicht und ergaben 66.
- **Kartenköpfe tragen keine Icon-Kachel** (E9): Titel 16/700, Abzeichen als `.vp-chip` rechts.
- **⚠ `Badge variant="tint"` ist auf einer Kundenfläche verboten** (#5A8DE8 auf #95B9FF = **1,66:1**,
  Befund B7). Ein Zustands- oder Herkunftswort trägt die EINE Chip-Form `.vp-chip` (P0).
- **Trefferflächen (B12):** ein Bedienelement misst 44 px. Wo die Höhe gebraucht wird, wächst nur
  die FLÄCHE per `::after`-Overlay (das Haus-Muster des InfoTips) — so behält der 30-px-Legenden-Chip
  am Telefon seine Höhe und der 24-px-Zeilenname der Portfolio-Tabelle seine Zeilenhöhe.
- **⚠ Ein Sticky- oder Trefferflächen-Befund ist nur IM BROWSER zu sehen.** Die Beweis-Harness ist
  `e2e/erloese-chrome.html?welt=erloese|messwerte|portfolio-erloese|portfolio-messwerte`: sie
  rendert GENAU EINE Welt unter einer 68-px-Schalen-Kopfzeile — demselben Bezugspunkt, gegen den
  die Leiste klebt. `e2e/erloese-proof` stapelt bewusst mehrere Sektionen und taugt dafür nicht.
- Gemessen (1440 / 375): Hero-Oberkante **114 / 232 px**, klebendes Chrome **58 / 0 px**,
  0 Trefferflächen < 44, 0 px Überlauf, kleinste Chart-Schrift ≥ 12 px in allen vier Welten.


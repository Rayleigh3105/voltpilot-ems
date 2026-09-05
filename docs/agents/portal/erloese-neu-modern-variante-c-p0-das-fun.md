# Erlöse „Neu modern" (Variante C) · P0 — das Fundament für die ganze Fläche

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 36).


Konzept `data/vp-erloese-lesbar-konzept-u3` §3.10 (Captain-Entscheide E1 = Variante C,
**E12 = Pilot fürs ganze Portal**, E5 Typo-Skala, E6 Chips nur Zustandswörter, E8 Minus mit
Zeichen). P0 ist das FUNDAMENT — Tokens, Schrift, Leisten-Kleid, EINE Chip-Klasse, die Skala.
Die Karten-ANATOMIE (Ergebnis-Karte, Ebenen, Kartenköpfe, Cockpit, Portfolio) räumen P1–P6.

- **Die Tokens stehen in EINEM zweiten `:root`-Block in `src/index.css`** (`--vp-c-*` Palette,
  `--vp-erl-fs-*`/`-fw-*`/`-lh-*` die Skala). **Kein Haus-Token ist umdefiniert** — die C-Werte
  liegen NEBEN ihnen, damit jede weitere Fläche nachzieht, ohne dass eine bestehende kippt.
- **Die Sechser-Skala ist 12 · 14 · 16 · 20 · 24 · 48** (+ 36 für den Hero am Telefon), die
  Gewichte sind {400, 600, 700, 800}. Sie gilt für die Erlöse-Blätter (`Erloese.css`,
  `SteuerungFormel.css`, `ErloesKomposition.css` — `SpeicherBlock.css` ist seit P1/P5 durch
  `src/components/erloese/` abgelöst) und wird von
  `src/erloeseSkala.test.ts` an den AUSGELIEFERTEN Dateien nachgeprüft — eine neue Regel mit
  `font-size: 0.82rem` fällt dort auf, bevor sie eine Fläche erreicht.
- **`.vp-chip` ist die EINE Chip-Form** (`index.css`), `.vp-chip--warn` ihr einziger
  Modifikator. Die fünf früheren Formen (`.vp-ez-chip`, `.vp-ez-chip-warn`, `.vp-spb-chip`,
  `.vp-spb-badge`, `.vp-prov`) hängen daran und setzen ihre Form NICHT mehr selbst.
  ⚠ Der frühere `.vp-chip` war eine interaktive TASTE und heißt seither **`.vp-chip-action`**
  (Auswahl-Chips im Anlagen-Dialog, Voreinstellungen der Optimizer-Seite) — eine Taste ist kein
  Zustandswort.
- **⚠ DAS DUNKLE LEISTEN-KLEID IST SEIT P8 ZURÜCKGENOMMEN — Kopf-, Seiten- und Fussleiste sind
  wieder HELL** (Captain-Korrektur 03.09.2026, wörtlich: „wieso sind der Header und Footer blau,
  bitte so wie davor."). Der Anstrich von E12 („App-Leiste und Seitenleiste in Foreground mit
  weisser Schrift", §3.10 Anatomie C Punkt 5) ist damit **bewusst nicht umgesetzt**: die Leisten
  tragen die HAUS-Regeln (`--vp-surface`, `--vp-border`, `--vp-primary-deep`/`--vp-action` als
  Zustände), `Shell.css` ist bis auf EINE Zeile (`--vp-c-font`) byte-identisch zum Stand vor P0.
  Was von der Variante C auf den Leisten bleibt, ist NUR die Schrift. Wer sie je wieder dunkel
  macht, braucht eine neue Captain-Entscheidung — und dann wieder die Regel darunter.
- **⚠ DIE LADEREIHENFOLGE ENTSCHEIDET, WO EINE LEISTEN-FARBE STEHEN MUSS** (weiter gültig für
  JEDE künftige Leisten-Farbe, auch wenn heute keine steht). `src/index.css` kommt aus
  `main.tsx`, `src/shell/Shell.css` aus `AppShell.tsx` — also SPÄTER. Bei zwei Regeln gleicher
  Spezifität (je EINE Klasse) entscheidet damit die Reihenfolge, und `index.css` verliert.
  Gemessen (P0): die Telefon-Leiste blieb weiß mit dunkler Schrift (1,0:1), der Pfad der
  Kopfzeile stand mit 2,9:1 auf dem dunklen Grund. **Regel: eine Farbe, die eine Regel in
  `Shell.css` ebenfalls setzt, gehört NACH `Shell.css`** (`.vp-bottombar*`, `.vp-crumb-*`,
  der Zähler der Anlagen-Navigation); nur was dort gar nicht vorkommt oder wo `index.css` die
  höhere Spezifität hat (`.vp-sidebar .vp-navitem`), darf in `index.css` bleiben. Dasselbe gilt
  für die Bereichs-Reiter — sie liegen deshalb in `BereichTabs.css`.
- **⚠ Die Token `--vp-c-fg-state`/`--vp-c-on-fg-muted` haben seit P8 KEINEN Leser mehr.** Sie
  bleiben definiert, weil sie die gemessene Grundlage für einen künftigen dunklen Grund sind
  (Zustandsfläche 82 % + Weiss auf `--vp-c-fg`, gedämpfte Schrift #CBD5E1 = 9,8:1) — ein
  `grep` auf sie findet also nichts, was rendert. `--vp-c-fg` selbst ist weiter überall die
  TINTE der Inhaltsflächen.
- **Der Browser-Beweis ist `e2e/erloese-c-p0.html`** (Leisten mit den ECHTEN Klassennamen +
  eine Typo-Probe) neben `e2e/erloese-proof.html` (die Fläche mit ihren 15 Zuständen). Der
  Messweg steht im PR-Rumpf des P0-Merges; er misst NUR die Klassen der vier Blätter, denn
  `#root` einer Fixture-Seite enthält auch die Seiten-Chrome (das ist P3).


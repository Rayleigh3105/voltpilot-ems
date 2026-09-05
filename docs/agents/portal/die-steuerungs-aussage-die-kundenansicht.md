# Die STEUERUNGS-AUSSAGE: die Kundenansicht misst gegen einen STUREN Speicher (`speicherAussage.ts`)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 35).


**Captain-Order 04.09.2026, wörtlich zum Screenshot der Live-Anlage Pilsting/Herzogau (Erlöse →
Monat): „Das ist doch Quatsch, du musst Anlage immer mit Speicher berechnen, einer halt ohne
smart Steuerung."** Sie ERSETZT die Entscheide E2/E8 vom 02.09.2026 („BEIDES", `savedEur` über
`savedSteuerungEur`, `data/vp-erloese-seite-konzept-e2` §3.5/§3.6).

- **⚠ DIE EINE REGEL, an der alles hängt: eine KUNDENFLÄCHE zeigt AUSSCHLIESSLICH
  `savedSteuerungEur`** — den Mehrwert gegenüber DEMSELBEN Speicher ohne smarte Steuerung.
  **`savedEur`/`savedSpeicherEur`/`baselineEur` sind ADMIN-Zahlen** (Plattform-Optimizer,
  Flotten-Admin führen sie weiter); sie messen gegen eine Anlage GANZ OHNE Speicher und
  beantworten damit eine Frage, die kein Kunde hat — sein Speicher steht bereits im Keller.
  Der Screenshot zeigte „Speicher im Zeitraum + 92,02 €" als große Zahl über den 43,65 €, die
  wirklich zählen.
- **⚠ OHNE VERGLEICH GIBT ES KEINE ZAHL — und die Gesamtzahl ist KEIN ERSATZ.** Fehlen die
  Batterie-Stammdaten (`steuerungSplitReason: 'no_battery_data'`), sagt die Fläche den GRUND im
  Klartext (`speicherAussage.ohneVergleich`) und bietet den Nachtrag-Weg an. Ein ÄLTERES Backend,
  das die Felder gar nicht kennt, bekommt GAR KEINE Aussage (`null`) und keine
  Nachtrag-Aufforderung — **ein fehlendes FELD ist kein fehlendes STAMMDATUM**.
- **⚠ `speicherAussage(money, ctx)` (rein) ist die EINE Ableitung** für die Steuerungs-Karte
  (`components/erloese/SpeicherKarte.tsx`, Überschrift „VoltPilots Steuerung"), die
  Cockpit-Erlöskarte und den Steuerungs-Bereich (beide `kurz`). Wer eine vierte Fläche baut,
  konsumiert sie — nie eine Geld-Zahl roh unter dem Wort „Steuerung".
- **Die RECHENSCHRITTE sind DREI** (`erloesEbenen.speicherSchritte`): ① gemessen (Ihre
  Stromrechnung mit VoltPilot) → ② gerechnet: dieselbe Anlage mit Speicher, aber ohne smarte
  Steuerung → ③ Steuerung = die Differenz, mit dem Kassenrechnungs-Hinweis. **Schritt ② wird
  NICHT zusätzlich gerechnet, sondern umgestellt:** als Gutschrift gelesen ist er exakt
  `gemessen − savedSteuerungEur` (die Identität `savedSteuerungEur = sturKosten − actualEur` der
  Dreiteilung, `EarningsDto`), und die `probe` der Zeile prüft es. „Schritt 4 · sturer Speicher"
  und „Schritt 3 · Speicher gesamt" sind ERSATZLOS entfallen.
- **⚠ Die PLAN-ZEILE hängt an `history.totals.steuerungPlannedEur`**, NIE an
  `batterySavingsPlannedEur` (das misst gegen „ohne Speicher"). Ohne das Feld bleibt die Zeile
  WEG — nie die alte Zahl unter dem neuen Wort.
- **⚠ Der IDENTITÄTS-WÄCHTER ist fail-soft, aber strenger als vorher:** ergibt
  `savedSpeicherEur + savedSteuerungEur` nicht `savedEur` (Toleranz 0,005 €), wird GAR KEINE
  Steuerungs-Zahl behauptet (`console.warn`) — eine Zahl, der die eigene Prüfsumme widerspricht,
  ist schlimmer als keine. `savedEur`/`savedSpeicherEur` werden dort NUR als Prüfsumme gelesen.
- **⚠ Die TAGES-REIHE liest `EarningsDaily.savedSteuerungEur`** (`fleet.tagesSteuerung` — die EINE
  Stelle; `savedOnDay`/`sparkDays`/`fleetDailySaved` hängen daran). Ein Tag ohne den Anteil zeigt
  NICHTS, nie einen Rückfall auf `savedEur`; und **`fleetDailySaved` lässt den GANZEN Tag weg,
  sobald auch nur eine Anlage ihn nicht trägt** (eine Teil-Summe ist keine Messung).
- **DER WÄCHTER ist `src/messlatte.test.ts`** und hat zwei Hälften: eine GIFT-Zahl als `savedEur`
  durch jede Kunden-Ableitung (sie darf in keinem erzeugten Text stehen) UND ein Text-Scan der
  Kunden-Ableitungsdateien auf die Wörter der alten Messlatte („ohne Speicher", „ungeregelt",
  „sturer Speicher", „Speicher gesamt", „Ihr Speicher hat"). **Die Ausnahmen-Liste ist eine
  RATSCHE — sie wird nur kürzer;** heute stehen dort genau die drei `proofLine`/`realizedFinePrint`-
  Literale von `fleet.ts` mit ihrem Grund.
- **⚠ BEWUSST NICHT umgestellt: die FAHRPLAN-Welt** (`schedule.ts` `plannedSavingLabel`/
  `planKernaussage`/`fleet.proofAnchor`, die Fahrplan-Seite und `pages/DataPages.tsx`). Ihre
  Sätze beschreiben die Plan-Baseline DES OPTIMIERERS je Slot (`schedule.baselineCostEur`), nicht
  die gemessene Kasse — sie nennen ihre Messlatte ausdrücklich und sind damit ehrlich. Wer sie
  umstellt, stellt zuerst den Optimierer um.
- **Vektoren:** `src/test/fixtures/speicherAussage.vektoren.json` trägt die **15 Konzept-Fixtures**
  aus `derived.json` — seit dem 04.09.2026 nur noch als EINGABEN; ihre `erwartet`-Blöcke
  beschrieben die gestrichene zweizeilige Form. Die Erwartungen stehen ausgeschrieben in
  `speicherAussage.test.ts`.


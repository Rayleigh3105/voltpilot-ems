# frontend/portal — Project agent memory (Wegweiser)

**Diese Datei wird beim Arbeiten in `frontend/portal` in den Kontext geladen** (`CLAUDE.md`
ist ein Symlink darauf). Sie ist ein WEGWEISER: hier steht, was fast jede Portal-Sitzung
braucht; jedes Flächen-Detail wohnt byte-verbatim in `docs/agents/portal/` und ist über den
**Themen-Index** unten zu finden. **Nie eine `docs/agents/`-Datei ganz lesen — greppen.**
Plattform-Wissen (Dienste, Migrationen, Verträge): `../../AGENTS.md`.

## Bauen & testen

```bash
npm install
npm run build      # tsc && vite build — der Type-Check IST das CI-Gate
npm test           # vitest run (jsdom);  npm run test:watch beim Arbeiten
npm run test:agents-md      # Größen-Wächter dieser Datei
npm run test:csp / test:cache / test:bundle   # Smokes gegen das ECHTE nginx-Image (Docker)
npx vitest run src/<datei>.test.ts            # gezielt, immer mit `2>&1 | tail -10`
```

`src/**/*.test.ts{,x}` sind aus dem `tsc`-Build AUSGESCHLOSSEN (`tsconfig.json`), der
Produktions-Build hängt also nicht an den Tests. Die Test-Umgebung leert `sessionStorage`
vor jedem Test. CI (`.forgejo/workflows/deploy.yaml`, Leg `frontend`) fährt **nur**
`npm install && npm run build` plus die drei Smokes — **`npm test` läuft dort NICHT**, also
gezielt lokal fahren.

## Die harten Hausregeln

- **Ableitung ist REIN, die Fläche RENDERT nur.** Jede Regel, jeder deutsche Satz und jedes
  Urteil leben in einem `src/*.ts`-Modul mit eigenem Unit-Test; `components/`/`pages/` setzen
  das zusammen. Zwei Ableitungen über dieselbe Sache sind zwei Wahrheiten.
- **Ehrlichkeit der Zahlen.** `null` ist eine Lücke, `0` eine gemessene Null — sie dürfen nie
  gleich aussehen. Ein Wert ohne Beleg wird nicht behauptet; eine Einheit kommt vom Server
  (`scaleUnit`) und wird NIE geraten; das Alter eines Messwerts kommt aus dem Zeitstempel, nie
  aus der Farbe; ein Grund wird weggelassen, wenn er dasselbe sagt wie das Zustandswort.
- **Ein Satz, der eine URSACHE behauptet, braucht einen exportierten Fakt dafür** — sonst nennt
  er nur die Beobachtung (`src/begruendung.test.ts` prüft das strukturell).
- **Ein Knopf, der nichts bewirken kann, wird nicht angeboten** — stattdessen der GRUND und der
  WEG. Ein langer Vorgang sagt sich an; eine Rückfrage trägt ihre Folgenliste.
- **Farbe und Maß kommen aus Tokens** (`designsystem/tokens/*.css`, portal-eigene in
  `src/index.css`). Interaktive Tinte ist `--vp-action`; Charts lesen `src/chartTheme.ts`
  (`chartTheme()`), weil Canvas kein `var()` auflöst. ⚠ Zwei nicht existierende Token-Namen
  fallen still auf hart kodiertes Hex zurück: `--vp-border`/`--vp-primary` (NICHT
  `--vp-color-*`). Kein neues Hex in einem Blatt.
- **Kein natives `<select>`, `date`, `time`, `datetime-local`, `datalist`** — `VpPicker`,
  `VpDatePicker`, `VpTimePicker` (Nullbestands-Wächter in `src/migration.test.ts`).
- **Keine Seitenleisten:** jede Aufgabenfläche ist das zentrierte `Modal`
  (`src/keineSeitenleisten.test.ts` verweigert schon den Bausteinnamen `Drawer`).
- **Kunden-Vokabular.** Interne Wörter (Entität, Messpunkt, Mandant, Modus, Broker, RLS …)
  stehen in keinem Kundentext; `src/copy.test.ts` liest die Quellen und wacht darüber.
- **Bewegung** ist die letzte Sektion dieser Datei (verbatim, weil parallel gepflegt): EIN
  Token-Satz, Presets in `src/motionPresets.ts`, Wächter `src/motionTokens.test.ts` +
  `src/chartMotion.test.ts`, `prefers-reduced-motion` an EINER Stelle.

## Die Text-Wächter (quellenlesende Tests — das Muster für neue Regeln)

`migration.test.ts` (Nullbestände + Abbau-Wächter) · `copy.test.ts` (Kunden-Vokabular) ·
`keineSeitenleisten.test.ts` · `motionTokens.test.ts` / `chartMotion.test.ts` ·
`fieldBorder.test.ts` (rechnet den Kontrast NACH) · `focusRing.test.ts` ·
`erloeseSkala.test.ts` / `erloeseKontrast.test.ts` / `erloeseMobil.test.ts` ·
`messlatte.test.ts` (Giftzahl durch jede Kundenfläche) · `begruendung.test.ts` ·
`bootSkeleton.test.ts` · `pwaShell.test.ts` · `shell/healthGreen.test.ts` ·
`agentsMdBudget.test.ts`. **Sie lesen die AUSGELIEFERTEN Dateien und sind
mutationsgeprüft** — wer eine Regel ergänzt, ergänzt ihren Wächter und trägt neue Blätter in
dessen Tabelle ein. Eine Ratschen-Zahl wird nur KLEINER.

## Abnahme im echten Browser

Jede Flächen-Änderung wird bei **1440 und 375** durchgespielt: **0 px horizontaler Überlauf,
0 überstehende Elemente, keine Konsolenmeldungen**. Werkzeug: `chrome-devtools-axi`.

## Themen-Index (der ausgelagerte Bestand)

Jede Zeile ist ein frueherer Abschnitt DIESER Datei. Der Text ist unveraendert, er
wohnt nur woanders. **Alle Pfade unten sind relativ zu `../../docs/agents/portal/`.**
**Nicht ganze Dateien in den Kontext lesen - greppen.** Inhaltsverzeichnis aller
Bereiche: `../../docs/agents/README.md`.

- **Die Speicher-Kachel nennt ihre QUELLE (P6 Speiser-Bindung)** — die ausdrückliche Frage „wozu gehört diese Batterie?“ im Assistenten und „Ladestand von: <Batterie>“ auf Kachel und Geräteseite · `die-speicher-kachel-nennt-ihre-quelle-p6.md`
- **Der BATTERIE-ASSISTENT (P5d): Anschluss, Zuordnung, Kurve — und die Herkunft des Ladestands** — die Fläche des BMS-unabhängigen Anschlusses; `soc_source_code` als EIN Wort auf Cockpit, Geräteseite und Fahrplan · `der-batterie-assistent-p5d-anschluss-zuo.md`
- **Notizen vor dem ersten Abschnitt (AGENTS.md)** — This file is the project's committed home for … · `notizen-vor-dem-ersten-abschnitt-agents/README.md`
- **Build & test** — npm run build = tsc && vite build (the type-check is … · `build-test/README.md`
- **Anzeige-Ehrlichkeit: Daten-Alter, die gemessene Null, der behauptete Verkauf** — Drei Regeln aus der Herzogau-Untersuchung (Reports … · `anzeige-ehrlichkeit-daten-alter-die-geme.md`
- **Der Register-Drawer wählt seit Stufe 2 ZUERST das ZIEL** — components/RegisterWriteDrawer.tsx über der reinen … · `der-register-drawer-waehlt-seit-stufe-2.md`
- **Stufe 3 „Bis zum Endkunden": der Kunde fährt DIESELBE Register-Strecke** — root AGENTS.md „Register schreiben über das Portal … · `stufe-3-bis-zum-endkunden-der-kunde-faeh.md`
- **Ladepark-Lastmanagement: die Ladepunkt-Flächen (Lastmanagement Stufe 3)** — Die abgenommenen Mockups (data/vp-ocpp-mockups-r5) als … · `ladepark-lastmanagement-die-ladepunkt-fl.md`
- **Der Anbinde-Assistent einer Ladesäule (Geräteseiten Stufe 3, E1)** — Aus drei erklärenden Sätzen ist ein geführter Weg … · `der-anbinde-assistent-einer-ladesaeule-g.md`
- **Die HEBEL des Verbindungstests (Geräteseiten Stufe 3, NACHTRAG 2)** — Der Test sagte seit PR 456 ehrlich, WAS gelesen wurde … · `die-hebel-des-verbindungstests-geraetese.md`
- **Geräteseiten Stufe 0: EIN Rückweg, und der Katalog gehört dem GERÄT** — Zwei gemeldete Defekte, ein PR (Konzept … · `geraeteseiten-stufe-0-ein-rueckweg-und-d.md`
- **Geräteseiten Stufe 3a: „Beobachtete Register" — die Messbibliothek, richtig herum** — es auch für HTTP/OCPP-Geräte · D5a) · `geraeteseiten-stufe-3a-beobachtete-regis.md`
- **Geräteseiten Stufe 1: DER RAHMEN, durch den JEDE Geräteseite fährt** — D2a Standard offen = Jetzt + Befehle) · `geraeteseiten-stufe-1-der-rahmen-durch-d.md`
- **Geräteseiten Stufe 4: DIE NEUN BLÄTTER — je Gerätetyp genau das, was er braucht** — Wärmepumpe = schaltbarer Verbraucher (Hilfetext, nie … · `geraeteseiten-stufe-4-die-neun-blaetter.md`
- **VpPicker: EIN Picker fuer die ganze Plattform - kein natives `<select>` mehr** — Picker … eigene Komponenten erstellen wo man drin … · `vppicker-ein-picker-fuer-die-ganze-platt.md`
- **Cockpit anpassen: die Fläche des Layout-Speichers (Anwendungs-Programm Stufe 3)** — Die Portal-Hälfte des Layout-Speichers (Backend, Schema … · `cockpit-anpassen-die-flaeche-des-layout.md`
- **Eigene Auswertung: die Fläche der Kunden-Kennzahl (Anwendungs-Programm Stufe 5)** — Der Kunde baut sich aus einem Messwert seiner Anlage … · `eigene-auswertung-die-flaeche-der-kunden.md`
- **Das PORTFOLIO-COCKPIT: die Flotten-Fläche (Stufe 4, **Revision 2**)** — der Revision 2 (Scout data/vp-portfolio-konzept-r2 … · `das-portfolio-cockpit-die-flotten-flaech.md`
- **Steuerung Stufen 1+2: die Jetzt-Zone und die Regel-Karten** — Reine Portal-Arbeit auf bestehenden Endpunkten — es … · `steuerung-stufen-1-2-die-jetzt-zone-und.md`
- **Steuerung Stufe 5: die Betriebsmodell-Zone ist eine RADIOGRUPPE** — Zone ③ der Steuerung (Konzept data/vp-steuerung-konzept … · `steuerung-stufe-5-die-betriebsmodell-zon.md`
- **Steuerung Stufe 4: die Jetzt-Zone kann eingreifen** — Die Portal-Hälfte der Handeingriffe (Konzept … · `steuerung-stufe-4-die-jetzt-zone-kann-ei.md`
- **Steuerung Stufe 3 (A6): die Vorrang-Texte drehen** — Die Portal-Hälfte von „Vorrang technisch" (Konzept … · `steuerung-stufe-3-a6-die-vorrang-texte-d.md`
- **Steuerung Stufen 8+9: die Umzüge im Portal** — Die Fläche der Abschluss-Stufen (Regeln, Katalog und … · `steuerung-stufen-8-9-die-umzuege-im-port.md`
- **Verbraucher im Cockpit (Phase 0): die Aufschlüsselung hinter der Haus-Zeile** — reine Anzeige aus vorhandenen Endpunkten: kein Backend … · `verbraucher-im-cockpit-phase-0-die-aufsc.md`
- **Die Kachel „Laden" (Verbraucher im Cockpit, Phase 0 PR 2)** — Sie beantwortet ohne Klick, · `die-kachel-laden-verbraucher-im-cockpit.md`
- **Der Knoten „Laden" im Energiefluss + die Heute-kWh (Phase 0 PR 3, Phase 0 KOMPLETT)** — E7 Abnahme am Simulator) · `der-knoten-laden-im-energiefluss-die-heu.md`
- **Cockpit Phase 1: die Ladepunkt-kW kommen ueber die ENTITAET, und ein alter Messwert liest nie als aktuell** — Cloud-/Edge-Seite: root CLAUDE.md „Cockpit Phase 1 / … · `cockpit-phase-1-die-ladepunkt-kw-kommen.md`
- **Der Anbinde-Dialog fragt, WO die Saeule haengt (Cockpit Phase 1 / C1)** — Repo-weite Regeln und die Sicherheits-Asymmetrie in … · `der-anbinde-dialog-fragt-wo-die-saeule-h.md`
- **Der eigene Anschluss ist eine eigene GRUPPE und ein eigener KNOTEN (Cockpit Phase 1 / C2)** — Vektoren stehen in ../../AGENTS.md „Cockpit Phase 1 / … · `der-eigene-anschluss-ist-eine-eigene-gru.md`
- **Verbrauchsmanagement v1 / P3a: „Jetzt voll laden" steht, wo eingegriffen wird** — angenommen 31.08.2026) · `verbrauchsmanagement-v1-p3a-jetzt-voll-l.md`
- **Verbrauchsmanagement v1 · P1: die Verbraucher-ZONE, und die Jetzt-Zone zeigt jeden Ladepunkt** — Die Steuerung hat seit P1 VIER Zonen in dieser … · `verbrauchsmanagement-v1-p1-die-verbrauch.md`
- **⚠ Der FELDRAND ist ABGELEITET — wer `--vp-text-gray` anfasst, verschiebt ihn mit** — --vp-field-border ist kein eigener Farbwert, sondern · `der-feldrand-ist-abgeleitet-wer-vp-text.md`
- **⚠ Ein Haus-Token ist fuer SEINE Flaeche bemessen — P7 der Erloese-Seite** — Der Browser-Beweis des letzten Erloese-Pakets (P7 … · `ein-haus-token-ist-fuer-seine-flaeche-be.md`
- **Verbrauchsmanagement v1 · P2: der STEUERART-DIALOG** — Die Zeile der Verbraucher-Zone ÖFFNET seit P2 einen … · `verbrauchsmanagement-v1-p2-der-steuerart.md`
- **Verbrauchsmanagement v1 · P5: die Ladepark-KAPSEL ist entfallen, der RAHMEN steht** — Portal-Hälfte des größten Pakets (Regeln, Verträge und … · `verbrauchsmanagement-v1-p5-die-ladepark.md`
- **Verbrauchsmanagement v1 · P7: die FAHRZEUGE (je Ladekarte eine Steuerart)** — Modell, Kontrakt und die Box-Hälfte stehen im … · `verbrauchsmanagement-v1-p7-die-fahrzeuge.md`
- **Die STEUERUNGS-AUSSAGE: die Kundenansicht misst gegen einen STUREN Speicher (`speicherAussage.ts`)** — „Das ist doch Quatsch, du musst Anlage immer mit … · `die-steuerungs-aussage-die-kundenansicht.md`
- **Erlöse „Neu modern" (Variante C) · P0 — das Fundament für die ganze Fläche** — E12 = Pilot fürs ganze Portal, E5 Typo-Skala, E6 Chips … · `erloese-neu-modern-variante-c-p0-das-fun.md`
- **Erlöse „Neu modern" (Variante C) · P3+P4 — das CHROME der Welt-Seiten** — Die Erlöse-Seite ist der Pilot fürs ganze Portal · `erloese-neu-modern-variante-c-p3-p4-das.md`
- **Erlöse „Neu modern" (Variante C) · P5 — die COCKPIT-Erlöskarte** — Leseprinzipien gelten auch für die Cockpit-Karte), E11 … · `erloese-neu-modern-variante-c-p5-die-coc.md`
- **Erlöse „Neu modern" (Variante C) · P6 — Portfolio › Erlöse in derselben Grammatik** — Leseprinzipien gelten auch fürs Portfolio), E3 (der … · `erloese-neu-modern-variante-c-p6-portfol.md`
- **Erlöse „Neu modern" (Variante C) · P7 — die ABNAHME, und was sie gelehrt hat** — Der Browser-Beweis über den gemergten Gesamtstand … · `erloese-neu-modern-variante-c-p7-die-abn.md`
- **Verlauf-Sprache P1: EIN Chrome für alle sechs Reiter des Verlaufs** — Messwerte · Erlöse · Marktpreise · Lastspitzen · … · `verlauf-sprache-p1-ein-chrome-fuer-alle.md`
- **Verlauf-Sprache P2b: EIN Aufklapper, und Zustände, die ihren Platz reservieren** — restlichen GETEILTEN Bausteine des Bereichs — die … · `verlauf-sprache-p2b-ein-aufklapper-und-z.md`
- **Verlauf-Sprache P8: die Portfolio-Zwillinge, und die Tabelle als LISTE** — Portfolio-Zwillinge") und §6 E6 a („am Telefon immer … · `verlauf-sprache-p8-die-portfolio-zwillin.md`
- **Keine Seitenleisten: jede Aufgabenfläche ist das zentrierte `Modal`** — „search for sidebars · `keine-seitenleisten-jede-aufgabenflaeche.md`
- **Bewegung (Motion-Programm P0–P7)** — jedes Paket im Detail: Tokens, Chart-Hebel, Minis/Fluss, Start, Seitenwechsel, Overlays, Feinschliff · `bewegung.md`
- **Maintaining this file** — Keep this file for knowledge useful to almost every … · `maintaining-this-file.md`

## Maintaining this file

**Größen-Budget (seit 05.09.2026, hart bewacht):** `AGENTS.md` ≤ 60 KB,
`frontend/portal/AGENTS.md` ≤ 45 KB, `edge-app/AGENTS.md` ≤ 45 KB. Wächter:
`bash tools/agents-md-budget.sh` (Matrix-Leg `agents-md` in `.forgejo/workflows/deploy.yaml`),
im Portal zusätzlich `npm run test:agents-md`. **Die Zahl wird nur KLEINER, nie größer** —
wer sie anhebt, hat den Wächter abgeschafft, nicht bestanden.

Der Grund: Claude Code lädt `CLAUDE.md` → diese Datei bei JEDEM Sitzungsstart. Am 05.09.2026
waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB angewachsen und haben Worker binnen
Minuten an der Kontextgrenze sterben lassen.

**Die Regel daraus: hier steht ein POINTER, das Detail wohnt in `docs/agents/`.** Ein neuer
Abschnitt wird `docs/agents/<bereich>/<slug>.md` und bekommt hier EINE Index-Zeile
(`**Thema** — ein Satz Kern · \`<slug>.md\``). In den Wegweiser gehört nur, was FAST JEDE
Sitzung braucht: Aufbau, Befehle, die harten Hausregeln. Was der Code schon zeigt, gehört
gar nicht hierher — dann reicht der Verweis auf Datei, Befehl oder Test.

Der Umbau ist wiederholbar: `python3 tools/agents-md-split.py` erzeugt aus dem Kern
(`tools/agents-md-kern/<bereich>.md`) plus dem Bestand denselben Zustand, `--verify` beweist
die Byte-Gleichheit jedes ausgelagerten Abschnitts.

## Bewegung (Motion-Programm P0–P7, abgeschlossen 05.09.2026)

**Spec-Quelle:** firstmate `data/vp-motion-konzept-m1/report.md` (Captain-Entscheid 04.09.2026, E1–E10 = a). **Das Detail jedes Pakets:** `../../docs/agents/portal/bewegung.md` — greppen, nicht ganz lesen.

- **EINE Familie, EIN Schalter.** Alle Dauern und Kurven stehen als `@property`-Token in `designsystem/tokens/effects.css` (`--vp-motion-fast|base|enter|exit|page|chart|chart-update|stagger`, `--vp-ease-out|in|inout`), jede rechnet `calc(<ms> * var(--vp-motion-scale))`, und `--vp-motion-scale: 0` wird an GENAU EINER Stelle gesetzt: dem `prefers-reduced-motion`-Block am ENDE von `src/index.css` (die Lage ist gemessen, nicht Geschmack). `src/motionPresets.ts` trägt dieselben Zahlen für TS.
- **Zwei Verbote, beide auf null.** Kein `transition: all`, keine nackte Dauer — eine Zahl ausserhalb der Familie entzieht sich dem Schalter. Eine Dauer-Animation braucht eine AUSSAGE (busy, lädt, Leistung, Login-Bühne); sie behält ihr Tempo nur als benannter Eintrag in `LOOP_AUSNAHMEN` und muss trotzdem unter reduzierter Bewegung stehenbleiben.
- **Diagramme: die Form baut sich auf, der WERT steht.** Alles läuft durch `src/useEChart.ts` + `src/chartMotion.ts`; gezeichnet wird mit `animation: false`, aufgedeckt wird die Fläche per CSS-Maske, genau einmal beim Sichtbarwerden. **Ein Balken wächst nie aus der Null** — das wäre ein lesbarer Falschwert. Gemorpht wird nur zwischen zwei ECHTEN Zuständen (Zeitraumwechsel, Live-Punkt), über `replaceMerge` mit stabilen Serien-`id`s; `clear()` ist im Repo nirgends erlaubt. Wer selbst `animation: false` setzt, bleibt still.
- **Zahlen und Fluss.** `components/SwapNumber.tsx` ist DER Zahlenwechsel (blendet durch, zählt nie); `flowTempo(kW)` in `src/live.ts` ist die EINE Tempo-Wahrheit des Energieflusses und wird als `playbackRate` gesetzt, nie als `animation-duration`. Minis und Preisleiste werden aufgedeckt, nicht hochgefahren.
- **Seitenwechsel: EINE Hülle.** Jeder Routenwechsel läuft durch `commit()` in `src/App.tsx` → `src/pageTransition.ts`; `nav.transitionKind` sagt wohin, `src/index.css` sagt wie. Telefon schiebt, **der Rechner blendet** — die Schiebe-Regel gilt nur bis 720 px, der Haus-Grenze. Ohne `startViewTransition` gibt es den Schnitt von heute, kein Ersatz.
- **Überlagerungen und Listen.** `designsystem/components/shell/ausblenden.js` hält Modal/Sheet/Picker im Baum, bis sie ausgeblendet sind — **wer die Ausblendung will, steuert `open` und unmontiert nicht**. `.vp-stagger` + `src/staffel.ts` staffeln nur beim ERSTEN Besuch, Deckel als Selektor. Skelett → Inhalt blendet über (`Blende` in `components/Lazy.tsx`) im reservierten Rahmen.
- **⚠ EIN SPÄTER BLOCK DARF NICHTS VERSCHIEBEN.** Was erst mit den Daten kommt, bekommt seinen Platz VORHER — notfalls von einem unsichtbaren Zwilling, der sich selbst misst (`.vp-anlage-chipzeile`, P7). Der teuerste gemessene Start-Sprung des Programms kam genau daher: ein 30 px hoher Chip, der den halben Bildschirm schob (CLS 0,308).
- **Wächter, und wie man sie grün hält:** `src/motionTokens.test.ts` (Familie · CSS ≡ `motionPresets.ts` · EIN reduced-Block und seine Lage · beide Ratschen auf 0 · jeder Loop benannt UND angehalten · kein `motion`-Import vom Einstieg aus), `src/chartMotion.test.ts` · `useEChart.test.tsx` · `chartFamilien.test.ts` · `staffel.test.ts` · `swapNumber.test.ts`, und `npm run test:bundle` (Einstieg ≤ 230 kB gz, kein Motion darin). **Neues Gewicht gehört in ein Lazy-Stück, neue Dauer auf ein Token, ein neuer Loop mit Grund in die Liste** — jede dieser drei Zeilen ist einmal teuer gelernt worden.
- **Beweis im Browser** (jsdom sieht weder Maske noch Frames noch View Transitions): `e2e/motion-p0` (Token/Kaskade) · `motion-lab` (angehaltene Aufdeck-Frames + `analyze-frames.py`, der Ehrlichkeits-Wächter) · `motion-p3.html` (Fluss-Lastfälle) · `motion-p4` (Start) · `motion-p5` (Seitenwechsel) · **`motion-p7` (die Gesamtmessung: EIN Aufruf, alle Flächen, 18 Zeilen — siehe sein README)**.

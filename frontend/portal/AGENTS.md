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

## Bewegung (Motion-Programm P0 · P1 · P3 · P4 · P6)

**Spec-Quelle:** firstmate `data/vp-motion-konzept-m1/report.md` §4 (Captain-Entscheid 04.09.2026, E1–E10 = a).

- **EINE Familie** in `designsystem/tokens/effects.css`, per `@property` als `<time>` registriert (damit `getComputedStyle` die AUFGELÖSTE Dauer liefert — die Bedingung dafür, dass ECharts sie ab P1 lesen kann): `--vp-motion-fast` 120 · `-base` 200 · `-enter` 260 · `-exit` 160 · `-page` 300 · `-chart` 400 · `-chart-update` 300 · `-stagger` 30 ms, `--vp-motion-distance` 8 px, Kurven `--vp-ease-out/-in/-inout` (`--vp-ease` = Alias von `-inout`). `--vp-c-motion` ist Alias von `--vp-motion-base`.
- **EIN Schalter:** jede Dauer rechnet `calc(<ms> * var(--vp-motion-scale))`. `--vp-motion-scale: 0` wird an GENAU EINER Stelle gesetzt — dem `@media (prefers-reduced-motion: reduce)`-Block **am ENDE** von `src/index.css`. ⚠ Das Ende ist keine Kosmetik: eine Media-Query erhöht die Spezifität nicht, und weiter oben verlor der Block gegen `.vp-auth-flow .spoke` (im Browser gemessen). Derselbe Block nullt zusätzlich die benannten `infinite`-Animationen — eine Loop mit 0 ms wäre ein stehendes Bild. **Wer eine neue Loop einführt, trägt sie dort ein.** Einzige Ausnahme ausserhalb: der Skelett-Schimmer in `designsystem/components/core/core.css` (Begründung dort).
- **Zwei Verbote:** kein `transition: all` (`--vp-transition`/`--vp-transition-fast` sind ersatzlos entfallen; Nachfolger ist `--vp-motion-chrome` = Farbe/Fläche/Rand/Schatten) und **keine nackte Dauer** — eine Zahl, die nicht aus der Familie kommt, entzieht sich dem Schalter. Ein `var(--token, 200ms)`-Rückfall zählt nicht als nackt.
- **`src/motionPresets.ts`** trägt dieselben Zahlen als TS-Konstanten und importiert NICHTS aus `motion` (es liegt im Einstieg). **Motion 13.2.0 lebt nur in Lazy-Stücken** (E10 a, gemessen: voll im Einstieg +45,1 kB gz, lazy +0,07): `src/motionFeatures.ts` ist das dynamische Ziel, `components/MotionRoot.tsx` der Wirt (`LazyMotion strict`).
- **P4 · Das Boot-Skelett wird nicht mehr entfernt, sondern verabschiedet.** `removeBootSkeleton()` (`components/Boot.tsx`) setzt `.vp-bs-leaving`, wartet die Ausblendung ab und entfernt DANACH — die Regel „entfernt wird es GENAU EINMAL in `BootErrorBoundary.componentDidMount`" bleibt. **⚠ Der Zeitgeber ist die Wahrheit, `transitionend` nur die Abkürzung**: ein verschluckter Frame (Hintergrund-Tab, jsdom, `--vp-motion-scale: 0`) liesse das Skelett sonst für immer über dem fertigen Bild stehen. Seine Ausblend-Regel wohnt INLINE im `<style>` des Skeletts in `index.html` — es lebt vor dem CSS-Bündel und liest die Token deshalb nur mit Rückfall (`var(--vp-motion-exit, 160ms)`).
- **P4 · Das erste Bild staffelt über DIESELBE Klasse wie P6** (`.vp-stagger` + `useStaffel`) — Cockpit-Stapel, Portfolio-Tabelle und -Karten. Zwei Regelsätze für eine Bewegung wären zwei Wahrheiten; P4 trägt dort nur seinen einen Vorbehalt ein (`data-vp-no-stagger` am Kopf, der nicht mitkommen soll). Die Login-Karte (`.vp-auth-card`) benutzt dasselbe Keyframe; die Laufpunkte der Bühne bleiben (E7 a, benannte Ausnahme), laufen aber im **Ruhetempo 1,8 s** des Energieflusses, damit das Portal EINE Uhr hat.
- **⚠ P4 · DIE STAFFEL BEGINNT SICHTBAR (`opacity: .6`), UND DAS IST EINE MESSUNG.** Chrome nimmt ein vollständig durchsichtiges Element nicht als LCP-Kandidaten an: mit `opacity: 0` wurde der grösste Inhalt erst gezählt, wenn seine Karte an der Reihe war, und der gemessene Start verschob sich um den ganzen Versatz (paarweise am Produktions-Build, `e2e/motion-p4/proof.mjs`, 9 Paare in EINER Sitzung: **LCP 272 → 520 ms**, FCP und CLS dabei unverändert; ein Diagnose-Arm ohne Deckkraft holte die Zahl zurück). Seit dem Firstmate-Entscheid 04.09.2026 — die Start-Staffel ist **kein** Signaturmoment, E9 a nennt Fluss, Chart-Einstieg und Kennzahl — beginnt sie bei 0,6: die Karte steht vom ersten Frame an da, die restlichen 40 % plus die 8 px sind die Ankunft. **Wer dort auf 0 zurückgeht, verschiebt den gemessenen Start jeder Fläche, die staffelt** (`staffel.test.ts` nagelt „grösser als 0" fest, die Begründung steht am Keyframe).
- **P6 · Überlagerungen blenden IMMER aus, und zwar OHNE Motion.** `designsystem/components/shell/ausblenden.js` (`useAusblenden`) hält Modal, Bottom-Sheet und Picker-Blatt nach dem Schliessen so lange im Baum, wie ihre Ausblendung dauert; sie tragen dabei `is-closing`, und erst danach fallen Scroll-Sperre und Fokus zurück. Die Wartezeit wird an `--vp-motion-exit` GEMESSEN, also nullt der EINE Schalter sie mit — und was sich nicht als schlichte Zeit lesen lässt (jsdom `''`, Safari < 16.4 `calc(…)`), wird nicht gewartet: in jsdom schliesst jede Fläche synchron wie vor P6. **⚠ Wer die Ausblendung will, steuert das Modal über `open` und unmontiert es nicht** — ein `{offen && <Dialog/>}` oder ein `if (!open) return null` VOR dem `<Modal>` nimmt ihm genau die Frames, in denen es geht (deshalb reichen `ConfirmDialog` und `NeueRegelDialog` ihr `open` durch). Sheets federn über `--vp-ease-feder` herein (der CSS-Zwilling von `SHEET_SPRING`) und gehen ohne Feder wieder — verlassen wippt nicht.
- **P6 · Listen staffeln nur beim ERSTEN Besuch.** `.vp-stagger` am Behälter (Block „Bewegung · P6" in `index.css`) blendet jedes Kind 260 ms ein, das i-te um `i × --vp-motion-stagger` verzögert, **Deckel als Selektor** (`:nth-child(n + 9)`) statt als Rechnung. Zwei Zusagen schenkt CSS dabei: beim Nachladen staffelt nur die NEUE Zeile, und niemand muss einen Index durch TSX reichen. Was CSS nicht weiss — „diese Liste kenne ich schon" — entscheidet `useStaffel` (`src/staffel.ts`) über ein modulweites `Set`: kein `localStorage` (die Erinnerung gilt der SITZUNG), und der Eintrag passiert im EFFEKT, die Entscheidung im Render (ein `Set.add` beim Rendern wäre unter `StrictMode` die abgeschaltete Staffel).
- **P6 · Zustandswechsel haben zwei Stufen, und die Grenze ist der Auslöser.** Was ein ZEIGER auslöst (Chip-Farbe, Link, Kachel-Rahmen, Hover-Lift) ist Feedback und läuft 120 ms über die benannte Liste `--vp-motion-chrome`; was das SYSTEM umlegt (Schalter, `.vp-stale`, Chevron) ist ein Zustand und läuft 200 ms `--vp-motion-base` mit `--vp-ease-inout`. Am Telefon gibt es statt Hover den Druck (`@media (hover: none)`, `scale .98`, ohne Verzögerung hinein) — es geht um das Eingabegerät, nicht um die Fensterbreite.
- **P6 · Skelett → Inhalt blendet über, im reservierten Rahmen.** `Blende` (`src/components/Lazy.tsx`) legt das gehende Skelett `position: absolute` über den Inhalt, der vom ersten Frame an die Höhe bestimmt — gemessen CLS 0. **⚠ Am Suspense-Rand geht das nicht**: React tauscht Platzhalter und Inhalt im selben Commit. Dort bleibt die halbe Zusage (die Zustands-Flächen aus `States.tsx` tragen `.vp-blende` und erscheinen, statt zu springen); ein echtes Überblenden braucht einen Aufrufer, dem beide Seiten gehören.
- **Wächter:** `src/motionTokens.test.ts` (Familie, CSS ≡ `motionPresets.ts`, EIN Block + seine Lage, die zwei Ratschen, der statische Import-Graph ab `main.tsx`) und `npm run test:bundle` (`test/bundle-smoke.sh`: Einstieg ≤ 232 kB gz, kein Motion-Modul in den `sources` des Einstiegs-Chunks — ein Namens-`grep` reicht dafür nicht, der Minifizierer benennt um). Browser-Beweis: `e2e/motion-p0/` (jsdom sieht weder `@property` noch Kaskade).

### P1 — der EINE Chart-Hebel

- **Jede ECharts-Fläche des Portals geht durch `src/useEChart.ts`**, also sitzt die Bewegung DORT: kein einziger der 16 Konsumenten wurde dafür angefasst, und ein neuer Chart bekommt sie automatisch. Der Haken legt seine Optionen mit `mergeMotion()` **UNTER** die des Konsumenten — **wer selbst `animation: false` setzt, bleibt still** (3 Flächen tun das bewusst).
- **⚠ EINSTIEG IST NIE ECHARTS-WACHSTUM (die Ehrlichkeitsregel).** Gezeichnet wird mit `animation: false` — jeder Balken steht ab Bild 1 auf seinem wahren Wert —, aufgebaut wird nur die FORM: eine CSS-Maske von links am Container (`.vp-chart-motion.is-entering` + `@keyframes vp-chart-reveal`, Banner „Bewegung · P1" am ENDE von `src/index.css`). Werkseitig wächst ECharts aus der Null, und ein Balken auf halber Höhe ist ein **lesbarer Falschwert**. **Morph gibt es nur zwischen zwei ECHTEN Zuständen** (Update-Phase: Zeitraumwechsel, neuer Live-Punkt) — dort ist der Zwischenwert die Interpolation zweier gemessener Zustände.
- **Aufgedeckt wird GENAU EINMAL**, beim ersten Sichtbarwerden (IntersectionObserver, erst wenn gezeichnet UND `clientWidth > 0`): ein Chart im zugeklappten Aufklapper wartet aufs Öffnen, ein sichtbares deckt sofort auf, ein Resize löst KEIN zweites Aufdecken aus. **Die Phase hängt am Aufdecken, nicht an einem Zähler** — sonst wäre der Sprung von Breite 0 auf volle Breite ein Morph aus einem entarteten Zustand, also wieder Balken aus der Null.
- **`chartMotion()` liest die Tokens EINMAL je Aufruf** aus dem `:root` (Canvas kennt kein `var()`; das `chartTheme()`-Muster) und merkt sie bewusst **NICHT** — der Schalter hängt an `prefers-reduced-motion` und darf mitten in der Sitzung umgelegt werden. `scale === 0` ⇒ keine Klasse, keine Dauer, das Bild steht; deshalb braucht P1 keinen zweiten reduced-motion-Block.
- **Der Anker ist `.vp-chart-motion`** (setzt `useEChart` selbst), nicht `.vp-chart` — nicht jeder Behälter trägt die Layout-Klasse, und ihr `height: clamp(...)` mitzuerben wäre ein Höhenstreit in einem Lazy-Stück. **Aufgeräumt wird per Frist, nie über `animationend`** (ein Tabwechsel liefert das Ereignis nie, und `both` liesse die Maske stehen).
- **Wächter:** `src/chartMotion.test.ts` + `src/useEChart.test.tsx`; Browser-Beweis `e2e/motion-lab/` (jsdom sieht weder Maske noch angehaltene Frames — `shoot.mjs` hält die Aufdeckung an und `analyze-frames.py` misst je Frame, ob jede aufgedeckte Spalte schon ihre ENDGÜLTIGE Höhe hat).

### P3 — Minis, Ringe, Zahlenwechsel, Energiefluss (§5 E–H)

- **`components/SwapNumber.tsx` ist DER Zahlenwechsel des Portals** (HTML `SwapNumber`, SVG `SwapText`; Regel rein in `src/swapNumber.ts`). Alt blendet nach oben aus, neu von unten ein — **es wird nie gezählt**, der Text steht immer als fertiger Wert im DOM, der Vorgänger trägt `aria-hidden`. Reines CSS, damit er im EINSTIEG liegen darf (`motion` wäre dort 45 kB gz). Wer eine Zahl einbaut, die sich ändert, nimmt ihn — nicht eine eigene Animation.
- **`flowTempo(kW)` in `src/live.ts` ist die EINE Tempo-Wahrheit** des Energieflusses (`clamp(0,45 s; 1,8 s/(1+kW/2); 1,8 s)`; unter `DEADBAND_KW` = 0,05 kW gibt es gar keine Punktlinie, also Ruhe durch Abwesenheit). ⚠ **Gesetzt wird sie als `Animation.playbackRate`** (`components/useFlowTempo.ts`), NIE als `animation-duration`: eine Dauer-Änderung behält die verstrichene Zeit und setzt damit die Phase um — die Punkte springen zurück (im Browser gemessen). Die CSS-Regel behält ihre Referenz-Dauer 0,9 s (= das Tempo bei 2 kW, Rate 1).
- **Minis und Preiskurve WACHSEN NICHT, sie werden AUFGEDECKT** (`vp-reveal-x`, definiert im P3-Block von `src/index.css`, angewandt in `MiniChart.css` und `StrompreisStrip.css`). Ein Balken, der von 0 hochfährt, zeigt in jedem Zwischenframe einen Wert, den die Anlage nie hatte. Der Übergang zwischen zwei WAHREN Zuständen darf dagegen morphen (`top`/`height` 200 ms). ⚠ Die Maske füllt `backwards` und schneidet senkrecht nie: ein bleibender `inset(0 0 0 0)` kappte den Fokus-Ring von `.vp-mini` und die überstehende Linie von `.vp-mini-line`.
- **Unter reduzierter Bewegung stehen die Fluss-Punkte, also muss die RICHTUNG woanders stehen:** `components/FlowArrow.tsx` erscheint AUSSCHLIESSLICH dort (`.vp-flow-arrow { display: none }` im Normalbetrieb). Das Dash-Muster ist symmetrisch und `aria-label` nennt nur die vier Rollen — ohne die Spitze wäre die Richtung ungesagt.
- **Browser-Beweis: `e2e/motion-p3.html/.tsx`** — die Demo-Anlagen zeigen KEINEN Energiefluss (Bericht §2.2), der Signaturmoment ist am laufenden Portal also nicht zu prüfen. Das Harness stellt drei Lastfälle plus den Sprung 2 → 8 kW bereit.

### P5 — Seitenwechsel: Telefon schiebt, Rechner blendet (§6, E5 a)

Captain-Antwort 8 wörtlich: „Handy wie eine App — Blätter schieben; Rechner nur blenden."

- **EINE Hülle, drei Orte.** JEDER Routenwechsel läuft durch `commit()` in `src/App.tsx` → `pageTransition.runPageTransition` (`document.startViewTransition` + `flushSync`). **Wer eine neue Navigationsart einführt, ruft `commit` — nie ein zweites `setRoute` daneben**, sonst hätte das Portal zwei Übergänge für dieselbe Sache. Die zwei Ausnahmen sind bewusst: die beiden Start-Umleitungen ERSETZEN die Adresse (das Ankommen der Anwendung gehört P4). Die Arbeit ist geteilt: `nav.transitionKind` sagt WOHIN (rein, testbar), `App.tsx` sagt DASS es genau einmal geschieht, der Block „Bewegung · P5" in `src/index.css` sagt WIE es aussieht — sie kennen einander nur über die Klasse `vp-vt-push|pop|fade` am `<html>`.
- **Die Richtung kommt aus der TIEFE, das Zurück aus dem VERLAUF.** `routeDepth` (0 Flotte · 1 Anlage · 2 Reiter · 3 Geräte-/Box-Seite) entscheidet push/pop/fade; **`back` wird NIE am Hash geraten**, es ist der sinkende Verlaufs-Index aus `navigationBlocker.ts` (wer über die Brotkrume hochgeht und dann Browser-Zurück drückt, landet tiefer — die Tiefe sagt push, der Kunde erlebt ein Zurück).
- **Telefon schiebt, Rechner blendet — an der HAUS-Grenze 720 px** (dieselbe Zahl wie `PHONE_MAX_PX`). Gemessen: 375 push = neu von +375 px in 300 ms, alt weicht auf −28 % und dunkelt ab; pop umgekehrt; **1440 bewegt sich in X um exakt 0 px**, jede Richtung blendet (160/200 ms, 4 px). Ein Geschwister-Reiter blendet auf BEIDEN Breiten. Die Schale (`.vp-sidebar`/`.vp-topbar`/`.vp-bottombar`) trägt einen eigenen `view-transition-name`, ist damit aus dem Wurzelbild herausgelöst und steht still. ⚠ Ein Name darf je Bild GENAU EINMAL vorkommen — ein Doppelname bricht den ganzen Übergang ab (deshalb hat der Reiter-Unterstrich zwei Namen, und er trägt sie nur unter `.vp-vt-fade`).
- **Ohne `document.startViewTransition` gibt es KEIN Ersatz-Blenden** (E5) — Chrome < 111, Safari < 18, Firefox < 144 und jsdom bekommen den Schnitt von heute; jeder bestehende Test bleibt deshalb synchron. Und **jede Dauer rechnet über `--vp-motion-*`**, also verstummt der Seitenwechsel über den EINEN Schalter (gemessen: alle Animationen 0 ms) — inklusive der UA-Gruppe `::view-transition-group(root)`, die sonst ihre 250-ms-Vorgabe behielte.
- **⚠ Die 230-kB-Ratsche des Einstiegs hat P5 auf 232 gehoben** (Captain-Entscheid 04.09.2026, Option A) — die Hülle ist per E5 (a) EINSTIEGS-Code (Browser-API, kein Motion) und kostet gemessene +1,13 kB gz. Sie ist nicht drückbar: eine P5-Variante mit KOMPLETT entferntem Rumpf liegt bei 230,28 kB, weil mains Kopfraum (158 B) kleiner war als die Vorlade-Grenze plus die `view-transition-name`-Attribute. Der Verlauf steht im Kopf von `test/bundle-smoke.sh`; **nach oben nur mit Grund im PR, nach unten jederzeit.**
- **Erst holen, dann schieben.** Fast jede Seite ist ein Lazy-Stück; ohne Vorladen fotografierte der Browser als „neues Bild" das SKELETT. `pageTransition.awaitRouteChunk` holt es mit einem Deckel von 300 ms, danach läuft der Übergang eben auf das Skelett (P6 blendet Skelett → Inhalt). **`src/pageChunks.ts` ist die EINE Schnitt-Grenze** — ein zweites `import()` derselben Adresse kostet gemessene ~1 kB gz im Einstieg; `pageTransition.test.ts` hält beide Enden (rendern + vorladen) gegen sie.
- **Browser-Beweis: `e2e/motion-p5/`** (jsdom kennt die API nicht). Er misst die Richtung über `document.getAnimations()` am `ready`-Zeitpunkt — Name, Pseudo, aufgelöste Dauer und Keyframes —, nicht über ein Standbild: `vp-vt-kommt-von-rechts` gegen `vp-vt-kommt-von-links` ist exakt und umbenennungsfest (dieselbe Begründung wie „Sourcemap statt `grep`“ beim Bündel-Wächter). Gemessen: 375 push/pop = ±100 % in 300 ms, 1440 **|X| = 0 px in JEDEM Schritt**, reduced = neun Dauern à 0 ms, ohne die API null Übergänge, zwei Wechsel 60 ms auseinander landen auf der ZWEITEN Route mit null offenen Animationen. Die Long Tasks des Nachladens sind vorher wie nachher 3–4 (Report §7.2) — P5 fügt keinen hinzu.

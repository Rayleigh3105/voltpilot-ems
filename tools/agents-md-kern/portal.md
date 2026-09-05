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

# ⚠ Ein Haus-Token ist fuer SEINE Flaeche bemessen — P7 der Erloese-Seite

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 31).


Der Browser-Beweis des letzten Erloese-Pakets (P7, Konzept
`vp-erloese-seite-konzept-e2` §3.9/§3.12, gemessen bei 375/768/1440 ueber alle
15 Fixtures) hat VIER Kontrast-Verstoesse gefunden — und alle vier hatten
DIESELBE Ursache: ein Haus-Token stand auf einer anderen Flaeche als der, fuer
die sein Wert bemessen ist.

| Stelle | Token | stand auf | vorher | nachher |
|---|---|---|---|---|
| `.vp-spb-still` / `.vp-spb-satz` | `--vp-text-gray` (fuer WEISS bemessen) | `--vp-flow-batt-soft` (gruen) | 4,45 | 5,06 |
| `.vp-spb-ton-warn .vp-spb-wert` | `--vp-warn-ink` | derselbe gruene Grund | 4,49 | 5,13 |
| `.vp-ez-chip-warn` | `--vp-warn-ink` | ein Grund, den der Chip sich AUS demselben Token mischt | 4,38 | 4,69 |
| `.vp-ez-t-minus` | `--vp-chart-discharge` (eine CHART-Farbe) | 16-px-Betrag = Normaltext | 4,23 | 5,07 |

- **Die REGEL daraus:** wer ein Text-Token auf eine getoente Flaeche setzt,
  rechnet den Kontrast dort NACH. `--vp-text-gray` haelt AA auf `--vp-surface`
  und reisst ihn auf `--vp-flow-batt-soft`; das ist kein Fehler des Tokens.
- **Der FIX ist immer eine Mischung AUS den Haus-Tokens**
  (`color-mix(in srgb, var(--tok) N%, var(--vp-text))`), nie ein neuer Farbwert
  und nie eine Aenderung am geteilten Token: `--vp-chart-discharge` steht als
  Text in sechs weiteren Dateien, und §3.9 weist es dem Netzbezug ausdruecklich
  zu. Die Rot-Identitaet bleibt, sie steht nur eine Stufe tiefer.
- **⚠ Die GROESSE entscheidet die Stufe:** die Hero-Zahl (`clamp(2rem, 6vw, …)`)
  ist WCAG-„large" und braucht nur 3:1 — sie behaelt deshalb die reine
  Haus-Rotfarbe, waehrend der 16-px-Betrag direkt darunter sie nicht behalten
  darf. Wer beide gleich behandelt, dunkelt entweder zu viel nach oder zu wenig.
- **Wachhund:** `src/erloeseKontrast.test.ts` RECHNET die Verhaeltnisse aus den
  Token-Dateien und den ausgelieferten Stylesheets nach (das
  `fieldBorder.test.ts`-Muster) — inklusive der nicht-vakuumen Gegenprobe, dass
  das unvermischte Token die Grenze wirklich reisst — und verbietet jeden Hex,
  der nicht Rueckfall eines `var(--vp-…)` ist. Er hat dabei zwei weitere harte
  Hex gefunden, die kein Auge sah: `#fff3e0` und `#4b5563` in `Erloese.css`.
- **Trefferflaechen:** `src/erloeseMobil.test.ts` haelt die drei §3.9-Regeln
  fest, die statisch pruefbar sind (44-px-Ziel ueber das `::before`-Muster,
  `min-width: 0` an den Flex-Kindern, `white-space: nowrap` an den Betraegen).
  Gemessen bei 375: der einzige Verstoss war der inline-`<a>`
  `.vp-spb-chip-link` mit 152 x **21** px.
- **⚠ Das Portal hat KEIN Dunkel-Thema** (siehe den Feldrand-Abschnitt) — die
  „Dark + Light"-Abnahme eines Konzepts ist hier also EIN Token-Satz, zweimal
  gemessen. Eine Emulation von `prefers-color-scheme: dark` aendert nachweislich
  keinen einzigen berechneten Wert; wer sie faehrt, darf sie nicht als zweiten
  Beweis ausgeben.
- **⚠ Und eine Messfalle, die zweimal fast eine falsche Zahl in einen Bericht
  geschrieben haette:** `getComputedStyle` gibt eine `color-mix`-Flaeche als
  `color(srgb 0.98 0.96 0.95)` zurueck — Werte von 0..1 —, waehrend ein
  gewoehnlicher Hintergrund `rgb(231, 246, 236)` liefert. Wer beide durch
  denselben Zahlen-Regex schickt, misst eine helle Flaeche als fast schwarz.
- **Das Textbudget (§3.12) wird AUS DEM GERENDERTEN HTML gezaehlt**, nicht aus
  einer nachgebauten Wortliste. Die Harness `e2e/erloese-proof.tsx` tat bis P7
  das Zweite und meldete fuer JEDE der 15 Fixtures 23 Woerter — ein Budget, das
  nie greifen konnte. Jetzt zaehlt `domWoerter()` den Kartentext mit
  geschlossenen `<details>` (Ebene 1/2 haben ihr eigenes Budget); gemessen
  30…47 gegen 38…52.


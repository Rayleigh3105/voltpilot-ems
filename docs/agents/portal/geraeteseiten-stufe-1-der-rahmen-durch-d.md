# Geräteseiten Stufe 1: DER RAHMEN, durch den JEDE Geräteseite fährt

> ⚠ **Abgelöst** durch [den Kern „Ein Blick, eine Antwort"](geraeteseiten-kern-ein-blick-eine-antwort.md)
> (25.09.2026): statt neun Sektionen mit Sprungleiste und Klapp-Zustand gibt es fünf Bausteine
> und die eigene Ansicht „Technik & Diagnose". Weiter gültig sind die Regeln „nie ein `#anker`",
> „höchstens EIN Kopf-Hinweis" und „kein Befund wird neu formuliert"; die alten `?abschnitt=`-
> Adressen bleiben als Lesezeichen gültig.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 11).


Konzept `data/vp-geraeteseite-rahmen-r2` §4 (Captain-Entscheide **D1a** Brotkrume ·
**D2a** Standard offen = Jetzt + Befehle). Der behobene Befund war ZUSCHNITT, nicht
fehlende Gestaltung: eine Geräteseite warf elf bis zwölf gleich laute Blöcke in EIN
`auto-fit`-Raster, das nach BREITE ordnete statt nach Bedeutung (bei 1440 px standen
Befehle und Komponenten nebeneinander, bei 1100 px rutschte die Zuordnung),
einklappen ließ sich nichts außer Diagnose und Plattform-Sicht, eine
Sprungnavigation gab es nicht, und die DREI Sektionen, die alle die Steuerung
erklären, standen an drei Orten. **Rein Portal — kein Endpunkt, keine Migration.**

- **⚠ Die REGELN liegen rein in `src/geraetRahmen.ts`, die Fläche in
  `components/GeraetRahmen.tsx`** (der `geraetSeite.ts`/`geraetGesicht.ts`-Präzedenzfall).
  Welche Sektionen es gibt, in welcher Reihenfolge sie stehen, welche offen beginnt
  und was mit einer leeren passiert, entscheidet ausschließlich die reine Datei —
  deshalb können Wechselrichter-, Box- und Ladesäulen-Seite über dieselbe Sektion
  nichts Verschiedenes behaupten. **Sie formuliert KEINEN Befund neu:** Kurzfassung,
  Kopf-Hinweis und der Grund einer entfallenen Sektion kommen wörtlich aus ihren
  geteilten Ableitungen (`controlStrip`, `exportGuardView`, `deviceLimitLine`,
  `OHNE_REGISTER_SATZ`).
- **`SEKTIONS_ORDNUNG` ist FEST** (Jetzt · Befehle · Steuerung & Grenzen · Komponenten ·
  Register · Verbindung · Software · Diagnose (technisch) · Plattform-Sicht (Admin)):
  1–2 sind die 5-Sekunden-Fragen und das tägliche Nachsehen, 3–4 erklären das Jetzt,
  5–7 sind Werkzeug und Technik, die man AUFSUCHT, 8–9 sind Support und Betreiber.
  **`rahmen(angebote)` sortiert IMMER kanonisch, nie in Aufrufer-Reihenfolge** — ein
  Blatt LÄSST AUS, was sein Typ nicht hat, sortiert aber nie um. `titel` überschreibt
  nur das WORT (D3: „Register" ist an einer Säule das falsche Wort, „Messwerte" das
  richtige — die Fähigkeit ist dieselbe).
- **⚠ Gesprungen wird über `id` + `scrollIntoView` + `focus({preventScroll:true})` —
  NIE über einen `#anker`.** Die App ist hash-geroutet, ein zweites `#` läse der
  Router als Route (der dokumentierte OCPP-Präzedenzfall). `springeZuAbschnitt(id)`
  ist derselbe Weg für einen Aufrufer AUSSERHALB einer `RahmenSektion` (die
  Hauptaktion der Ladesäule zeigt in ihren Befehls-Abschnitt) — sie setzt
  `details.open` direkt, das native `toggle` feuert auch bei einer programmatischen
  Änderung, also übernimmt der Rahmen den Zustand über sein `onToggle`; es gibt keine
  zweite Zustands-Wahrheit.
- **Der Klapp-Zustand lebt je GERÄT und je Tab-Sitzung in `sessionStorage`**
  (`sektionKey`, das `useChartDetail`-Muster); `localStorage` bleibt portalweit
  verboten. Ein Klick in der Sprungnavigation und ein Deep-Link (`?abschnitt=register`,
  ein PARAMETER im Hash — das `historieHash`/`settingsNav`-Muster) KLAPPEN AUF und
  springen dann: ein Sprung in eine geschlossene Klappe landete auf ihrem Deckel.
- **Zwei Sprungnavigationen, EINE Ableitung:** ab **1280 px tatsächlicher
  RAHMENBREITE** die klebende Anker-Spalte links (Name · Zustandspunkt ·
  Klapp-Zustand, Scroll-Spy nach dem `AnlageTechnik`-Muster), darunter die
  waagerecht scrollende Chip-Leiste unter dem Kopf (`.vp-seg`-Kleid, klebend bei
  `top: 68px` wie die Zeit-Leiste der Historie). **⚠ Das ist absichtlich eine
  Container Query auf `.vp-rahmen`, KEINE Viewport-Media-Query:** die globale
  Portal-Navigation nimmt schon Breite weg; bei einem großen Viewport kann die
  eigentliche Geräteseite trotzdem nur rund 1100 px haben. Der Viewport-Schalter
  erzeugte dort genau die versetzten Kopf-/Navigations-/Karten-Achsen.
  **⚠ Die Leiste scrollt in IHREM eigenen Container** (`overflow-x: auto`,
  `width: max-content`) — die Seite selbst darf nie waagerecht scrollen; ihre Chips
  sind 44 px hoch (die Leiste ist am Telefon der einzige Sprungweg).
- **⚠ Die Sektionen stehen EINSPALTIG** (`.vp-rahmen-sektionen`) — das frühere
  `auto-fit`-Raster ist als SEKTIONS-Hülle ersatzlos entfallen (`.vp-geraet-sec[.breit]`
  und `.vp-geraet-sec-head` hatten danach keinen Aufrufer mehr, der
  `roleLabel`-Präzedenzfall). `.vp-geraet-grid` LEBT weiter, aber nur noch als
  KACHEL-Raster INNERHALB einer Sektion (die Karten der Plattform-Sicht) — „Kacheln
  innerhalb einer Sektion dürfen weiterhin rastern".
- **⚠ Nichts steht ZWEIMAL: eine LEERE Sektion nennt ihren Grund im KÖRPER, nie
  zusätzlich in der Kurzfassung.** Die geschlossene Zeile trägt sonst denselben Satz
  wie der Inhalt dahinter (im Test als „Found multiple elements" aufgefallen). Ohne
  belegte Kurzfassung steht dort die FRAGE der Sektion (`SEKTION_FRAGE`), nie ein „—".
- **§4.6 hat ZWEI Leer-Arten:** strukturell leer ⇒ die Sektion ENTFÄLLT und ihr Grund
  wandert in „Diagnose" (`rahmen(...).entfallen`, damit keine still verschwindet);
  situativ leer ⇒ die Sektion BLEIBT und sagt ihren Grund. Ein `entfaellt` ohne
  `grund` verschwindet wortlos — richtig für eine Sektion, deren Inhalt anderswo auf
  DERSELBEN Seite steht (die Box führt „Verbindung"/„Software" als Held-Kacheln, sie
  ein zweites Mal zu führen wäre dieselbe Aussage zweimal).
- **Der Kopf trägt HÖCHSTENS EINEN Hinweis** (`kopfHinweis`): der schlimmste Befund,
  Rangfolge `verbindung > ruecklesen > waechter > grenze`, mit einem Sprung in SEINE
  Sektion — und ohne diese Sektion ohne Sprung (nie ein Knopf ins Leere, die
  `registerZugang`-Regel). Der Zustands-Pill ist bewusst KEIN Hinweis: er steht schon
  daneben.
- **`RahmenSektion` trägt `data-testid="sektion-{id}"`** — die eine Test-Naht (ein
  zweites `data-abschnitt` daneben wäre die Doppelung, die das Haus nicht mag).
  **⚠ jsdom stellt das `toggle`-Ereignis eines `<details>` ASYNCHRON zu**: die
  `open`-Marke steht sofort, der Handler (und damit der `sessionStorage`-Schreibvorgang)
  läuft danach — wer die Sitzung prüft, `waitFor`t auf den Schlüssel aus `sektionKey`.
- **Die DREI Wirte teilen sich den Rahmen, nicht seinen Inhalt:**
  `pages/GeraetSeiteSection.tsx` (jede Gattung außer Ladepunkt; die vier früheren
  Sektionen „Grenzen dieses Geräts" · „Einspeise-Begrenzung" · „Ausfall-Schutz" ·
  „Diese Säule im Ladepark" sind Unter-Blöcke von „Steuerung & Grenzen" geworden,
  `.vp-rahmen-block`), `pages/BoxSeiteSection.tsx` (ohne Register/Verbindung/Software,
  mit den Titel-Überschreibungen „Schutz & Grenzen" und „Geräte an dieser Box"; die
  Gefahrenzone gehört KEINER Sektion und steht unter dem Stapel) und
  `pages/OcppWallboxPage.tsx` (der frühere Sammel-Aufklapper „Service & Diagnose" samt
  seiner eigenen Abschnitts-Navigation ist darin AUFGEGANGEN — ein zweites
  Navigations-System neben dem Rahmen wäre genau die Doppelung, die er beendet).
- **⚠ Ein Bauteil bringt sein Stylesheet SELBST mit** (die RegelKarten-Lehre, hier zum
  zweiten Mal): `GeraetSeiteSection` rendert den Schnell-Chip `.vp-bf-chip`, dessen
  Regeln in `pages/Befehle.css` wohnen — ohne den Import stand er als nackter Knopf
  da, sobald ein Kunde DIREKT auf einer Geräteseite ankam (im Browser gefunden, im
  Test unsichtbar).
- **Beweise:** `geraetRahmen.test.ts` (44, rein: Ordnung, Standard-offen, beide
  Leer-Arten, Kopf-Hinweis, Deep-Link-Rundlauf, Rollen-Tor) · je Wirt ein
  `describe`-Block in `GeraetSeiteSection.test.tsx` / `BoxSeiteSection.test.tsx` /
  `OcppWallboxPage.test.tsx` (kanonische Ordnung, D2a, Sprung ohne Hash-Änderung,
  Klapp-Zustand über die Tab-Sitzung, `?abschnitt=`). Im echten Chrome bei **1440 und
  375** an Hybrid, Box und Wallbox durchgespielt: 0 px horizontaler Überlauf, 0
  überstehende Elemente (die zwei waagerecht scrollenden Leisten bleiben in ihrem
  eigenen Container), Chips 44 px, keine Konsolenmeldungen.


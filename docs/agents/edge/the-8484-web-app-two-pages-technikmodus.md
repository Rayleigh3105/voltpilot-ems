# The `:8484` web app: TWO pages + Technikmodus (concept `data/vp-edge-ux-concept/concept.html`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 16).


The device page is **`Betrieb`** (start page, customer-grade - for a plant with
no cloud link this IS the plant view) and **`Einrichten`** (everything you set
up, one job on one page). There is no third page: `inverter.html` and
`einstellungen.html` survive ONLY as redirects into an area anchor of
`einrichten.html`, so bookmarks and printed install sheets never 404.

- **Technikmodus** (`static/technik.js`, `#techToggle` in the header of BOTH
  pages, persisted in `localStorage["vp.edge.technik"]`, default OFF) REVEALS,
  it does not AUTHORIZE. Nothing is gated by it: calibration mutations keep
  their own admin token (`calGuard` in `web.go`) and the data purge stays
  red-bordered + type-to-confirm in both modes. Technical blocks are `.tech-only`
  and sit AT THE PLACE THEY BELONG (registers under the control state, raw
  source values under the flow), never in a separate dump.
  Visibility rule: `html:not(.tech-on) .tech-only { display:none !important }` -
  a plain `.tech-only{display:none}` LOSES the cascade to any later
  single-class rule that sets a display (`.area-title{display:flex}` leaked a
  technical heading in normal mode exactly that way).
- **THE load-bearing rule: hidden content must never hide a CAUSE.** Two pure
  functions own every plain-German verdict, and each returns a `cause` string
  that is rendered in NORMAL mode - Technikmodus only ever adds detail beneath
  it: `static/status.js` `VPStatus.derive(state, nowMs)` (the Betrieb status
  hero) and `static/control.js` `VPControl.deriveState(state)` (the control
  sentence; its branch order - no inverter → uncertified → kill-switch off →
  `blocked`+`reason` → waiting → readback - is the pre-rebuild logic verbatim).
  `static/commissioning.js` `VPCommissioning.derive(state, sourceCount, nowMs)`
  applies the same rule to the four guided steps. Adding a new verdict means
  adding its cause.
- **Einrichten is FOUR accordion groups** (rework `data/vp-einrichten-rework/
  concept.html`, 2026-07-28): ① Anlage ② Steuerung ③ Datenfreigabe ④ Erweitert,
  each ONE `<button class="acc-head">` row (dot + title + summary,
  aria-expanded/-controls). THE rule: big what needs an action, one line for
  what is finished, folded away what is rare. NO accordion memory - healthy =
  all closed every visit; a group with a NEW non-OK state opens itself and
  nothing auto-closes (pure layer `static/groups.js` `VPGroups`: the four
  summaries + `shouldAutoOpen(prevKey, key)` + `groupForAnchor` - the legacy
  anchors `#wechselrichter`/`#quellen`/`#messwerte`/`#datenfreigabe`/… open
  their group via `revealHash` in einrichten.js, so the retired-page redirects
  keep landing). The register evidence table lives ONLY on Betrieb under
  Technikmodus (the calibration card links to `index.html#controlCard` via
  `#calRegisterLink` while armed/running); empty source categories are
  per-category "+ hinzufügen" rows (`erzAdd`/`netzAdd`/`verbAdd`, role
  preselected in the drawer - the global add CTA is gone); the Netzmessung
  expert exception lives in ④ Erweitert. Page-wide warning rule: ONE message,
  once, in its owning group, with the stable "seit HH:MM" stamp
  (control.js `trackStateSince`); the group row carries only the dot.
- **The guided commissioning flow** (Einrichten, four steps ending at "Daten
  kommen an"; releasing CONTROL is deliberately its OWN block below it) is
  DERIVED from the existing APIs - no new endpoint, no persisted wizard
  progress. Once all four are done it DISAPPEARS entirely (no green banner -
  Betrieb's status hero is the single health voice) and returns only when a
  step regresses. The Portal-Kopplung card follows the pairing itself: visible
  while unpaired, `.tech-only` once paired (the reference then lives in the
  Technikmodus identity block, next to the version).
- **Design tokens are a COPY.** `static/tokens.css` duplicates
  `frontend/portal/designsystem/tokens/*` + the portal's `--vp-flow-*` hues
  because the edge has no build step and cannot import from the portal bundle -
  keep them in sync. `dashboard.css` derives its own aliases from them;
  `shell.css` owns the shell (top bar, page nav, Technikmodus, status hero,
  guided steps, `.pill`). NO webfont import: the device may have no internet.
- **Tests:** `internal/web/jstest/ui.test.js` (`node --test`, vm-realm loading
  like `nodered/flows-sync.test.js`) unit-tests the three pure derivations +
  the Technikmodus store; `jsunit_test.go` runs it inside `go test ./...`.
  Go page-structure tests pin the //go:embed contract, the retired-URL
  redirects, and that a `reason`-carrying refusal renders outside any
  `.tech-only` block.
- **DER PICKER DER BOX: `static/vppicker.js` + `pickerregeln.js` + `vppicker.css`**
  (Welle 3 des Konzepts `data/vp-picker-system`, Captain: „alle Picker … eigene
  Komponenten erstellen wo man drin suchen kann. Ich will nichts
  Browser-Standard-Zeug."). Die leichtgewichtige Zwillings-Fassung des
  Portal-VpPicker: **kein React, keine Abhängigkeit** — die Box liefert
  `static/*` direkt aus `//go:embed` und hat keine Bau-Kette.
  - **Seit Welle 3 trägt KEINE `:8484`-Seite ein natives `<select>`** und kein
    Skript baut eines zur Laufzeit; der Wächter dafür ist der Testfall „Die
    Einrichten-Seite trägt KEIN natives Auswahlfeld mehr" in `jstest/ui.test.js`
    (mutationsgeprüft in beide Richtungen). Ersetzt sind: Marke
    (Wechselrichter-Formular), Marke + Modell (Quellen-Drawer), Testleistung
    (Kalibrierung) und JEDES Verbindungsfeld vom Katalog-Typ `select`.
  - **⚠ Die REGELN wohnen rein in `pickerregeln.js`** (`window.VPPickerRegeln`,
    das `VPModellSuche`/`VPControl`-Muster): Filtern, Gruppieren, die
    Tastatur-Arithmetik (`naechster`/`ersteAktive`/`tippSprung`) und die
    Ansage. „Der Eigenbau darf dem nativen Select in NICHTS nachstehen" ist nur
    prüfbar, wenn die Bewegung eine FUNKTION ist — deshalb ohne DOM.
  - **⚠ Die SUCH-TOLERANZ kommt aus `modellsuche.js`, nie ein zweites Mal.**
    Zwei Toleranzen auf einer Seite fänden dieselbe Eingabe verschieden. Die
    Suche blendet sich unter `SUCHE_AB` (8) Zeilen von selbst aus — darunter ist
    sie Ballast; darüber (die 47 Deye-Modelle) ist sie der Weg.
  - **⚠ Das Panel hängt an `document.body` mit FESTEN Koordinaten** (Kollisions-
    Umschlag nach oben, waagerecht geklemmt, `MIN_PANEL_PX` 240) — nie
    `absolute` im Feld: `.card`, `.drawer-body` und die Gruppen tragen Scroll-
    und Überlauf-Grenzen, dort wäre es abgeschnitten. `platziere` ist nach
    aussen gelegt, damit die Geometrie ohne Browser prüfbar ist.
  - **Am Telefon (≤ 640 px) ist es ein BOTTOM-SHEET** mit Verdunkelung, Griff
    und Wisch-Schliessen (`WISCH_ZU_PX` 90 — ein kurzer Zupfer schliesst NICHT,
    sonst fiele es bei jedem Scroll-Versuch zu), 52-px-Zeilen und 16-px-Suchfeld
    (kein iOS-Zoom).
  - **⚠ KEIN verstecktes natives Element als Krücke.** Der Wert wohnt im Griff
    (`.wert()`) und — für die Formular-Sammlung der Verbindungsfelder — im
    `data-value` des Wirts; `collect()` liest ihn dort statt aus `.value`.
  - **⚠ Ohne gesetzten Wert steht die ERSTE Zeile** (`ohneVorwahl: true` ist das
    ausdrückliche Opt-out): genau das tut ein `<select>`, sobald es seine
    Optionen bekommt, und `onBrandChange` fände sonst gar keine Marke.
  - **⚠ Die Beschriftung wird ERST beim Montieren verknüpft** (`labelEl` bzw.
    `labelledBy` → `label.htmlFor`). Ein `for` im Markup zeigte bis dahin ins
    Leere (Chrome: „Incorrect use of `<label for=…>`", Klick fokussiert nichts —
    dieselbe Falle wie im Portal-`VpPanel`), und die Beschriftung eines dynamisch
    gebauten Feldes hängt beim Montieren noch gar nicht im Dokument. Aus dem
    zweiten Grund werden die zwei Drawer-Picker SCHON BEIM LADEN gebaut, nicht
    erst beim Öffnen.
  - **⚠ Nicht zu verwechseln mit der always-open Modell-Liste** (`.picker*` in
    `inverter.css`, siehe den nächsten Punkt): die bleibt, was sie ist — der
    dauerhaft offene primäre Weg zum Modell. Beide teilen Tokens und Optik,
    nicht die Klassen (`.vpp*` gegen `.picker*`).
- **Die MODELL-SUCHE ist der PRIMÄRE Weg zum Wechselrichter** (Geräteseiten
  Stufe 2, Scout `data/vp-geraeteseite-rev-b8` NACHTRAG 5; die Regeln stehen in
  der Root-`AGENTS.md`). Ihre reine Hälfte ist `static/modellsuche.js`
  (`window.VPModellSuche`, das `VPControl`/`VPStatus`-Muster), `inverter.js`
  zeichnet nur.
  - **Sie sucht über ALLE Marken** und gruppiert nach Marke — wer den Namen vom
    Typenschild abtippt, muss die Katalog-Marke nicht raten („Fronius" oder
    „Fronius (Modbus / SunSpec)"?). Das Marken-Stufenmenü darüber BLEIBT der
    Stöber-Weg, und beide schöpfen aus demselben `GET /api/inverter`-Katalog.
  - **⚠ Ein Treffer einer ANDEREN Marke stellt erst die MARKE um, dann das
    Modell** (`waehleUeberMarken`): die Marke entscheidet Anbindung und
    Verbindungsfelder — ohne den ersten Schritt stünde unter dem gewählten
    Modell das Formular der vorigen Marke.
  - **⚠ Der frühere `SEARCH_THRESHOLD` ist ERSATZLOS entfallen** (Suchzeile erst
    ab 7 Modellen EINER Marke). Sie ist der primäre Weg, nicht die Hilfe für
    lange Listen; die Zeile steht immer.
  - **⚠ Verglichen wird normalisiert, hervorgehoben im ORIGINAL.** Der alte
    Filter verglich ROH und fand „sun 30k"/„sun30k" nicht, obwohl das Gerät im
    Katalog stand.
- `static/*` is `//go:embed`-ed — **rebuild the core binary after any edit**.

